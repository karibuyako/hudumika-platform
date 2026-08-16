/* AI Assistant (Xiaomei-lite) — chat-style screen for POST /assistant/chat.
 *
 * Thread model mirrors the messages screen: optimistic user bubble → send →
 * server reply bubble with tappable suggestion chips (tapping one sends it
 * as the next message). Send failure rolls the user bubble back and restores
 * the draft; the error renders inline under the composer. Reply text is
 * SERVER copy (rendered verbatim, never i18n) — only the UI chrome around it
 * uses t().
 *
 * First open: the greeting bubble is seeded from the mock's server-owned
 * greeting data (same pattern as MOCK_ATTACHMENT_URLS on the messages
 * screen) — its suggestions act as quick-start chips. There is no list
 * load: chat is send-driven, so only the send failure state exists.
 *
 * Typing indicator is an animated dots strip that falls back to a static
 * ellipsis when the OS reports reduce-motion (store/ui.ts reducedMotion). */
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, Chip, Icon, Row, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getAssistantRepository } from '@/repos';
import { ASSISTANT_GREETING } from '@/repos/mock/assistant';
import { ApiError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

const MESSAGE_MAX_LENGTH = 1000;

interface ThreadEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  suggestions?: string[];
}

let entrySeq = 0;
const entryId = (prefix: string) => `${prefix}-${Date.now()}-${entrySeq++}`;

function greetingEntry(): ThreadEntry {
  return { id: entryId('greet'), role: 'assistant', text: ASSISTANT_GREETING.reply, suggestions: ASSISTANT_GREETING.suggestions };
}

function TypingIndicator() {
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setTick((n) => n + 1), 350);
    return () => clearInterval(timer);
  }, [reducedMotion]);
  const dots = reducedMotion ? '…' : '.'.repeat((tick % 3) + 1);
  return (
    <View style={styles.typingBubble} accessibilityLabel={t('assistant.typing')}>
      <Text style={styles.typingText}>{dots}</Text>
    </View>
  );
}

export default function AssistantScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [entries, setEntries] = useState<ThreadEntry[]>(() => [greetingEntry()]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError('');
    const optimistic: ThreadEntry = { id: entryId('usr'), role: 'user', text: body };
    setEntries((prev) => [...prev, optimistic]);
    setDraft('');
    try {
      // App-local context bag (contract AssistantChatBodyContext): the server
      // may use the user's identity/role to personalize the reply.
      const context: Record<string, unknown> = {
        ...(user?.id ? { userId: user.id } : {}),
        ...(user?.fullName ? { fullName: user.fullName } : {}),
        ...(user?.activeRole ? { role: user.activeRole } : {}),
      };
      const reply = await getAssistantRepository().chat(body, context);
      setEntries((prev) => [
        ...prev,
        { id: entryId('asst'), role: 'assistant', text: reply.reply, suggestions: reply.suggestions },
      ]);
    } catch (e) {
      // Rollback the optimistic bubble; the draft (and the failed text) survive.
      setEntries((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(body);
      setSendError(e instanceof ApiError ? e.message : t('assistant.error'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <View style={styles.avatar}>
              <Icon name="sparkles" size={18} color={Colors.primaryDeep} />
            </View>
            <Text style={styles.title}>{t('assistant.title')}</Text>
          </View>
          <View style={{ width: 70 }} />
        </Row>

        <Card style={{ gap: Spacing.md }}>
          {entries.map((m) => (
            <View key={m.id} style={m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant}>
              <Text style={m.role === 'user' ? styles.bubbleTextUser : styles.bubbleTextAssistant}>{m.text}</Text>
              {m.role === 'assistant' && m.suggestions && m.suggestions.length > 0 ? (
                <View style={styles.suggestions}>
                  {m.suggestions.map((s) => (
                    <Chip key={s} label={s} onPress={() => send(s)} />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
          {sending ? (
            <View key="typing">
              <TypingIndicator />
            </View>
          ) : null}
        </Card>

        <Row gap={Spacing.sm} style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor={Colors.textFaint}
            multiline
            maxLength={MESSAGE_MAX_LENGTH}
            accessibilityLabel={t('assistant.placeholder')}
            style={styles.input}
          />
          <Btn label={t('assistant.send')} onPress={() => send(draft)} size="sm" loading={sending} disabled={!draft.trim()} />
        </Row>
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  title: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: Colors.primary,
    borderBottomRightRadius: 4,
    padding: Spacing.md,
    borderRadius: Radius.md,
    maxWidth: '85%',
  },
  bubbleAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.surface,
    borderBottomLeftRadius: 4,
    padding: Spacing.md,
    borderRadius: Radius.md,
    maxWidth: '85%',
  },
  bubbleTextUser: { fontSize: FontSize.sm, color: Colors.white, fontFamily: Fonts.sans },
  bubbleTextAssistant: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sans, lineHeight: 18 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  typingBubble: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderBottomLeftRadius: 4,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  typingText: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, minWidth: 20 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm, marginTop: Spacing.lg },
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
});
