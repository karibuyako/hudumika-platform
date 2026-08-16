import { Stack, useLocalSearchParams, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { t, onLocaleChange } from '@/i18n';
import { Btn, Icon } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { clock } from '@/lib/format';
import { useChatStore, type ChatMessageLocal, type ChatThreadRow } from '@/store/chat';
import { useSessionStore } from '@/store/session';

const QUICK_REPLIES = ['On it now', 'Yes, sure!', 'About 15–20 min', 'No problem at all'];
const MAX_TEXT = 2000;
const MAX_ATTACHMENTS = 4;

type DraftAttachment = { mediaType: 'image' | 'document' | 'voice' | 'location'; url: string };

export default function ChatDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id } = useLocalSearchParams<{ id: string }>();
  const thread = useChatStore((s) => s.threads.find((t) => t.id === id)) as ChatThreadRow | undefined;
  const send = useChatStore((s) => s.send);
  const retryFailed = useChatStore((s) => s.retryFailed);
  const markRead = useChatStore((s) => s.markRead);
  const archive = useChatStore((s) => s.archive);
  const block = useChatStore((s) => s.block);
  const pendingSends = useChatStore((s) => s.pendingSends);
  const failedSends = useChatStore((s) => s.failedSends);
  const perms = useSessionStore((s) => s.perms);
  const canBlock = perms.includes('*') || perms.includes('support');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [blockMode, setBlockMode] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<{ code?: string; message?: string; retryAfterSeconds?: number } | null>(null);
  const [rateLimitUntil, setRateLimitUntil] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (thread) markRead(thread.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [thread?.messages.length]);

  useEffect(() => {
    if (rateLimitUntil <= Date.now()) return;
    const timer = setTimeout(() => setRateLimitUntil(0), Math.max(0, rateLimitUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [rateLimitUntil]);

  if (!thread) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg }}>
        <Icon name="alert-circle-outline" size={28} color={Colors.textTertiary} />
        <Text style={{ color: Colors.textSecondary, marginTop: Spacing.sm, textAlign: 'center' }}>{t('imd.unavailable')}</Text>
        <Text style={{ color: Colors.textTertiary, fontSize: FontSize.sm, marginTop: 4, textAlign: 'center' }}>{t('imd.unavailableSub')}</Text>
      </SafeAreaView>
    );
  }

  const status = thread.status ?? 'open';
  const readOnly = status === 'blocked' || status === 'archived';
  const pending = !!pendingSends[thread.id];
  const failedDraft = failedSends[thread.id];
  /* rateLimitUntil is reset by the countdown effect exactly at the deadline,
   * so `> 0` is the active-window flag (no Date.now() in render). */
  const rateLimited = rateLimitUntil > 0;

  const submit = async (bodyOverride?: string) => {
    const textVal = (bodyOverride ?? text).trim();
    if (!textVal || readOnly || pending || rateLimited) return;
    setWriteError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const res = await send(thread.id, textVal, attachments);
    if (res.ok) {
      setText('');
      setAttachments([]);
    } else {
      /* MESSAGES.md §Send — failure keeps the draft and offers retry. */
      if (res.code === 'MESSAGE_RATE_LIMITED' && res.retryAfterSeconds) {
        setRateLimitUntil(Date.now() + res.retryAfterSeconds * 1000);
        setWriteError(res);
      } else {
        setWriteError(res);
      }
    }
  };

  const retry = () => {
    if (failedDraft) {
      retryFailed(thread.id);
      setWriteError(null);
    }
  };

  const addAttachment = () => {
    if (attachments.length >= MAX_ATTACHMENTS) return;
    /* Mock attachment picker — the app does not ship an image picker
     * dependency; the placeholder object exercises the contract
     * attachments[] path (MESSAGE_ATTACHMENT_INVALID server-side). */
    setAttachments((a) => [...a, { mediaType: 'image', url: `file:///mock/attachment-${a.length + 1}.jpg` }]);
  };

  const doArchive = async () => {
    setBusy(true);
    await archive(thread.id);
    setBusy(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const doBlock = async () => {
    const reason = blockReason.trim();
    if (!reason) return;
    setBusy(true);
    const res = await block(thread.id, reason);
    setBusy(false);
    if (res.ok) {
      setBlockMode(false);
      setBlockReason('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else if (res.code === 'CONVERSATION_FORBIDDEN') {
      Alert.alert(t('imd.block'), t('imd.blockForbidden'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
          <Text style={styles.topTitle}>{thread.customerName}</Text>
          <Text style={styles.topSub} numberOfLines={1}>{thread.context}</Text>
        </View>
        {status === 'open' ? (
          <Row gap={4}>
            <Pressable onPress={doArchive} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('imd.archive')} style={{ opacity: busy ? 0.5 : 1 }}>
              <Icon name="archive-outline" size={20} color={Colors.info} />
            </Pressable>
            {canBlock ? (
              <Pressable onPress={() => setBlockMode((v) => !v)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('imd.block')} style={{ opacity: busy ? 0.5 : 1 }}>
                <Icon name="ban-outline" size={20} color={Colors.danger} />
              </Pressable>
            ) : null}
          </Row>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      {status === 'blocked' ? (
        <View style={styles.stateBannerBlocked}>
          <Icon name="ban-outline" size={15} color={Colors.white} />
          <Text style={styles.stateBannerText}>
            {t('imd.blockedReason', { reason: thread.blockReason ?? '' })}
          </Text>
        </View>
      ) : null}
      {status === 'archived' ? (
        <View style={styles.stateBannerArchived}>
          <Icon name="archive-outline" size={15} color={Colors.primaryDark} />
          <Text style={[styles.stateBannerText, { color: Colors.primaryDark }]}>{t('imd.archived')}</Text>
        </View>
      ) : null}

      {blockMode ? (
        <View style={styles.blockPanel}>
          <TextInput
            value={blockReason}
            onChangeText={setBlockReason}
            placeholder={t('imd.blockPh')}
            placeholderTextColor={Colors.textTertiary}
            style={styles.blockInput}
            maxLength={500}
          />
          <Row gap={8}>
            <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setBlockMode(false)} />
            <Btn label={t('imd.confirmBlock')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} disabled={!blockReason.trim()} onPress={doBlock} />
          </Row>
        </View>
      ) : null}

      {writeError ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle-outline" size={15} color={Colors.white} />
          <Text style={styles.errorBannerText}>
            {writeError.code === 'MESSAGE_RATE_LIMITED' && writeError.retryAfterSeconds
              ? t('imd.rateLimited', { n: writeError.retryAfterSeconds })
              : writeError.code === 'CONVERSATION_ARCHIVED'
                ? t('imd.writeArchived')
                : writeError.code === 'CONVERSATION_BLOCKED'
                  ? t('imd.writeBlocked')
                  : t('imd.sendFailed')}
          </Text>
          <Pressable onPress={() => setWriteError(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <Icon name="close" size={14} color={Colors.white} />
          </Pressable>
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: Spacing.lg, gap: 8, paddingBottom: 16 }}
          showsVerticalScrollIndicator={false}>
          <Text style={styles.dayLabel}>
            {t('imd.today', { n: thread.messages.length })}
          </Text>
          {thread.messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
        </ScrollView>

        {!readOnly ? (
          <>
            <View style={styles.quickRow}>
              {QUICK_REPLIES.map((q) => (
                <Pressable key={q} onPress={() => setText(q)} style={styles.quickChip}>
                  <Text style={styles.quickText}>{q}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.inputBar}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={t('imd.placeholder')}
                placeholderTextColor={Colors.textTertiary}
                style={styles.input}
                multiline
                maxLength={MAX_TEXT}
              />
              <Pressable
                onPress={addAttachment}
                style={[styles.attachBtn, attachments.length >= MAX_ATTACHMENTS && { opacity: 0.4 }]}
                disabled={attachments.length >= MAX_ATTACHMENTS}
                accessibilityRole="button"
                accessibilityLabel={t('imd.attach')}>
                <Icon name="attach" size={18} color={Colors.primary} />
              </Pressable>
              <Pressable
                onPress={() => submit()}
                style={[styles.sendBtn, (!text.trim() || pending || rateLimited) && { opacity: 0.4 }]}
                disabled={!text.trim() || pending || rateLimited}
                accessibilityRole="button"
                accessibilityLabel={t('imd.send')}>
                {pending ? <Text style={styles.sendPending}>…</Text> : <Icon name="send" size={18} color={Colors.white} />}
              </Pressable>
            </View>

            <View style={styles.composerMeta}>
              <Text style={styles.metaText}>
                {attachments.length > 0 ? t('imd.attachMax') : ''}
              </Text>
              <Text style={[styles.metaText, text.length >= MAX_TEXT && styles.metaTextLimit]}>{t('imd.charCount', { n: text.length })}</Text>
            </View>

            {attachments.length > 0 ? (
              <View style={styles.attachmentRow}>
                {attachments.map((a, i) => (
                  <View key={`${a.url}_${i}`} style={styles.attachmentChip}>
                    <Icon name="image-outline" size={13} color={Colors.primaryDark} />
                    <Text style={styles.attachmentText} numberOfLines={1}>{t('imd.attachImage')}</Text>
                    <Pressable
                      onPress={() => setAttachments((list) => list.filter((_, idx) => idx !== i))}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('imd.removeAttachment')}>
                      <Icon name="close" size={12} color={Colors.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}

            {failedDraft ? (
              <View style={styles.failedRow}>
                <Icon name="alert-circle-outline" size={14} color={Colors.danger} />
                <Text style={styles.failedText} numberOfLines={1}>{t('imd.sendFailed')}</Text>
                <Btn label={t('imd.retry')} size="sm" variant="outline" onPress={retry} />
              </View>
            ) : null}
          </>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bubble({ m }: { m: ChatMessageLocal }) {
  if (m.pending || m.failed) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowMine, { opacity: m.failed ? 0.7 : 0.8 }]}>
        <View style={[styles.bubble, styles.bubbleMine]}>
          <Text style={[styles.bubbleText, { color: Colors.white }]}>{m.text}</Text>
        </View>
        <View style={styles.bubbleState}>
          <Icon name={m.failed ? 'alert-circle-outline' : 'time-outline'} size={12} color={m.failed ? Colors.danger : Colors.textTertiary} />
          <Text style={styles.bubbleStateText}>{m.failed ? t('imd.sendFailed') : t('imd.sending')}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.bubbleRow, m.from === 'merchant' && styles.bubbleRowMine]}>
      <View style={[styles.bubble, m.from === 'merchant' ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[styles.bubbleText, m.from === 'merchant' && { color: Colors.white }]}>{m.text}</Text>
        {(m as { attachments?: { mediaType: string }[] }).attachments?.map((_a, i) => (
          <View key={i} style={styles.bubbleAttach}>
            <Icon name="image-outline" size={12} color={m.from === 'merchant' ? Colors.white : Colors.primaryDark} />
            <Text style={[styles.bubbleAttachText, m.from === 'merchant' && { color: Colors.white }]}>{t('imd.attachImage')}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.bubbleTime}>{clock(m.ts)}</Text>
    </View>
  );
}

function Row({ children, gap = 8 }: { children: ReactNode; gap?: number }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>{children}</View>;
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  topSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  dayLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', marginBottom: 8 },
  bubbleRow: { alignItems: 'flex-start', gap: 4 },
  bubbleRowMine: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.lg,
  },
  bubbleMine: { backgroundColor: Colors.primary, borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: Colors.card, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: Colors.border },
  bubbleText: { fontSize: FontSize.sm, color: Colors.text, lineHeight: 20 },
  bubbleTime: { fontSize: FontSize.xs, color: Colors.textTertiary, marginHorizontal: 4 },
  bubbleState: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  bubbleStateText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  bubbleAttach: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  bubbleAttachText: { fontSize: FontSize.xs, color: Colors.primaryDark, fontWeight: '600' },
  quickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 8,
  },
  quickChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primarySoft,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  quickText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primaryDark },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.surface,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  attachBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendPending: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  composerMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: 6,
    paddingBottom: 8,
    backgroundColor: Colors.card,
  },
  metaText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  metaTextLimit: { color: Colors.danger, fontWeight: '700' },
  attachmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 10,
    backgroundColor: Colors.card,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primarySoft,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  attachmentText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primaryDark, maxWidth: 90 },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    backgroundColor: Colors.dangerSoft,
  },
  failedText: { flex: 1, fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600' },
  stateBannerBlocked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    backgroundColor: Colors.danger,
  },
  stateBannerArchived: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    backgroundColor: Colors.successSoft,
  },
  stateBannerText: { color: Colors.white, fontSize: FontSize.xs, fontWeight: '700', flex: 1 },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    backgroundColor: Colors.danger,
  },
  errorBannerText: { color: Colors.white, fontSize: FontSize.xs, fontWeight: '700', flex: 1 },
  blockPanel: {
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  blockInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.surface,
  },
});
