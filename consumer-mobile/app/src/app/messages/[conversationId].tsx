import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, Chip, EmptyState, ErrorState, Icon, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { toast } from '@/store/ui';
import { getConversationsRepository } from '@/repos';
import { MOCK_ATTACHMENT_URLS, mergeOlderMessages, nextMessagesCursor } from '@/repos/mock/conversations';
import { useSessionStore } from '@/store/session';
import type { ChatMessage, ChatMessageCreateAttachmentsItem, ConversationDetail } from '@hudumika/contract';
import { ConversationStatus } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';

const ATTACHMENT_MAX = 4;

const attachmentFileName = (url: string) => url.split('/').pop() ?? url;

export default function ConversationScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const user = useSessionStore((s) => s.user);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatMessageCreateAttachmentsItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState('');
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  // Chat pagination (CHAT.md): cursor of the older page above the loaded
  // messages (null = nothing older to load).
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [detail, history] = await Promise.all([
        getConversationsRepository().get(conversationId),
        getConversationsRepository().listMessages(conversationId),
      ]);
      setConversation(detail);
      setMessages(history);
      setOlderCursor(nextMessagesCursor(history));
      setOlderError(false);
      if (detail.unreadCount > 0) {
        await getConversationsRepository().markRead(conversationId);
        setConversation({ ...detail, unreadCount: 0 });
      }
    } catch {
      setError(t('common.error'));
    }
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  // MESSAGE_RATE_LIMITED countdown (CHAT.md) — never an instant hammer on send.
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const toggleAttachment = (url: string) => {
    setAttachments((prev) => {
      if (prev.some((a) => a.url === url)) return prev.filter((a) => a.url !== url);
      if (prev.length >= ATTACHMENT_MAX) return prev;
      return [...prev, { mediaType: 'image', url }];
    });
  };

  const send = async () => {
    if (!draft.trim()) return;
    setSending(true);
    setSendError('');
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      conversationId,
      authorRole: 'customer',
      body: draft,
      ...(attachments.length ? { attachments } : {}),
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    try {
      const sent = await getConversationsRepository().send(
        conversationId,
        optimistic.body,
        idempotencyKey(user?.id ?? 'customer', 'msg'),
        attachments.length ? attachments : undefined,
      );
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? sent : m)));
      setAttachments([]);
      setPickerOpen(false);
    } catch (e) {
      // Rollback optimistic send on failure; the draft (and attachments) survive.
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(optimistic.body);
      if (e instanceof ApiError) {
        if (e.code === 'CONVERSATION_BLOCKED') setSendError(t('messages.blocked'));
        else if (e.code === 'CONVERSATION_ARCHIVED') setSendError(t('messages.archive'));
        else if (e.code === 'MESSAGE_RATE_LIMITED') {
          const seconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 5;
          setRetryAfter(seconds);
          setSendError(t('messages.rateLimited'));
        } else setSendError(e.message);
      } else {
        setSendError(t('common.error'));
      }
    } finally {
      setSending(false);
    }
  };

  const archive = async () => {
    await getConversationsRepository().archive(conversationId);
    toast(t('messages.archived'));
    router.back();
  };

  const loadOlder = async () => {
    if (loadingOlder || !olderCursor) return;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await getConversationsRepository().listMessages(conversationId, olderCursor);
      setMessages((prev) => mergeOlderMessages(prev, page));
      setOlderCursor(nextMessagesCursor(page, olderCursor));
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!conversation) {
    return (
      <Screen>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  const blocked = conversation.status === ConversationStatus.blocked;
  const archived = conversation.status === ConversationStatus.archived;
  const merchant = conversation.participants.find((p) => p.role === 'merchant_staff');

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={styles.title} numberOfLines={1}>{merchant?.displayName ?? conversation.subject}</Text>
            <Text style={styles.meta}>{merchant?.maskedPhone ?? ''}</Text>
          </View>
          {!blocked && !archived ? (
            <Btn label={t('messages.archive')} onPress={archive} variant="subtle" size="sm" />
          ) : null}
        </Row>

        {blocked ? (
          <Card style={[styles.banner, { backgroundColor: Colors.dangerSoft }]}>
            <Row gap={Spacing.sm}>
              <Icon name="lock-closed" size={15} color={Colors.danger} />
              <Text style={{ color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>{t('messages.blocked')}</Text>
            </Row>
          </Card>
        ) : null}

        <Card style={{ gap: Spacing.lg }}>
          {messages.length === 0 ? (
            <EmptyState icon="chatbubble-ellipses-outline" title={t('messages.noMessages')} />
          ) : (
            <>
              {olderCursor !== null || loadingOlder || olderError ? (
                <View style={styles.loadOlder}>
                  {olderError ? (
                    <Row gap={Spacing.sm} style={{ justifyContent: 'center' }}>
                      <Text style={styles.loadOlderError}>{t('common.error')}</Text>
                      <Btn label={t('common.retry')} onPress={loadOlder} variant="subtle" size="sm" />
                    </Row>
                  ) : (
                    <Btn label={t('messages.loadOlder')} onPress={loadOlder} loading={loadingOlder} variant="subtle" size="sm" icon="chevron-up" />
                  )}
                </View>
              ) : null}
              {messages.map((m) => {
              if (m.authorRole === 'system') {
                // System notices (e.g. conversation blocked) render as centered text.
                return (
                  <View key={m.id} style={styles.systemNotice}>
                    <Text style={styles.systemText}>{m.body}</Text>
                  </View>
                );
              }
              const mine = m.authorRole === 'customer';
              return (
                <View key={m.id} style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={[styles.bubbleText, mine && { color: Colors.white }]}>{m.body}</Text>
                  {m.attachments && m.attachments.length > 0 ? (
                    <View style={styles.bubbleAttachRow}>
                      {m.attachments.map((a) => (
                        <View key={a.url} style={[styles.bubbleAttach, mine && styles.bubbleAttachMine]}>
                          <Icon name="image-outline" size={12} color={mine ? Colors.white : Colors.textTertiary} />
                          <Text numberOfLines={1} style={[styles.bubbleAttachText, mine && { color: Colors.white }]}>{attachmentFileName(a.url)}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <Text style={[styles.bubbleMeta, mine && { color: Colors.gold }]}>
                    {dateISO(m.createdAt)}
                    {m.readAt && mine ? ` · ${t('messages.read')}` : ''}
                  </Text>
                </View>
              );
            })}
            </>
          )}
        </Card>

        {!blocked && !archived ? (
          <View>
            <Row gap={Spacing.sm} style={styles.composer}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={t('messages.placeholder')}
                placeholderTextColor={Colors.textFaint}
                multiline
                maxLength={2000}
                accessibilityLabel={t('messages.placeholder')}
                style={styles.input}
              />
              <Btn
                label={retryAfter > 0 ? t('messages.retryIn', { s: retryAfter }) : t('messages.send')}
                onPress={send}
                size="sm"
                loading={sending}
                disabled={retryAfter > 0}
              />
            </Row>
            <Row gap={Spacing.sm} style={styles.attachBar}>
              <Btn
                label={t('messages.attach')}
                onPress={() => setPickerOpen((p) => !p)}
                variant="subtle"
                size="sm"
                icon="attach"
                disabled={attachments.length >= ATTACHMENT_MAX}
              />
              {attachments.map((a) => (
                <View key={a.url} style={styles.attachChip}>
                  <Icon name="image-outline" size={13} color={Colors.textSecondary} />
                  <Text numberOfLines={1} style={styles.attachChipText}>{attachmentFileName(a.url)}</Text>
                  <Pressable
                    onPress={() => setAttachments((prev) => prev.filter((x) => x.url !== a.url))}
                    accessibilityRole="button"
                    accessibilityLabel={t('messages.removeAttachment')}
                    hitSlop={8}
                  >
                    <Icon name="close-circle" size={14} color={Colors.textTertiary} />
                  </Pressable>
                </View>
              ))}
            </Row>
            {pickerOpen && attachments.length < ATTACHMENT_MAX ? (
              <View style={styles.picker}>
                {MOCK_ATTACHMENT_URLS.map((url) => {
                  const selected = attachments.some((a) => a.url === url);
                  return (
                    <Chip
                      key={url}
                      label={attachmentFileName(url)}
                      selected={selected}
                      onPress={selected ? undefined : () => toggleAttachment(url)}
                    />
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  banner: { marginBottom: Spacing.md },
  systemNotice: { alignSelf: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg },
  systemText: { color: Colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.sansMedium, textAlign: 'center' },
  bubble: { padding: Spacing.md, borderRadius: Radius.md, maxWidth: '85%' },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: Colors.primary, borderBottomRightRadius: 4 },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: Colors.surface, borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sans },
  bubbleAttachRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginTop: Spacing.sm },
  bubbleAttach: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    maxWidth: 160,
  },
  bubbleAttachMine: { backgroundColor: 'rgba(255, 255, 255, 0.18)' },
  bubbleAttachText: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, flexShrink: 1 },
  bubbleMeta: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, marginTop: 4 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm, marginTop: Spacing.lg },
  attachBar: { marginTop: Spacing.sm, flexWrap: 'wrap' },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    maxWidth: 160,
  },
  attachChipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, flexShrink: 1 },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
    maxHeight: 90,
  },
  error: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  loadOlder: { alignItems: 'center', paddingBottom: Spacing.xs },
  loadOlderError: { color: Colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.sansMedium },
});
