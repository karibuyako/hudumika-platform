/* LIVE STREAMING-LITE — the live-deals broadcast surface
 * (src/app/live/[sessionId].tsx): a session "broadcast" screen with a hero
 * video PLACEHOLDER (dark branded panel + a static LIVE dot + the honest
 * "video stream arrives with the native build" note), the session countdown,
 * the same deal cards as the list (DealCard) and a mock-first live CHAT
 * (GET/POST /marketing/live-deals/{id}/chat — mock-only-until-adopted,
 * docs/CONTRACT-ADDITIONS.md #22, parity harness allow-list).
 *
 * NO video playback dependency: the hero is a branded panel and nothing here
 * implies a stream exists — video streaming is a native-phase concern
 * (bandwidth) with no contract surface yet. The LIVE dot is static (no
 * animation), so it is reduced-motion safe by construction.
 *
 * The chat is repo-driven (no event bus — src/store/events.ts untouched):
 * the seeded viewer messages arrive from fetchLiveChat, and the composer
 * mirrors the conversations thread pattern ([conversationId].tsx): optimistic
 * append → server echo replaces the temp message; failure rolls back and
 * restores the draft. Loading/empty/error/retry on every surface.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DealCard } from '@/components/DealCard';
import { DealCountdownPill, useDealClock } from '@/components/DealCountdown';
import { Btn, Card, EmptyState, ErrorState, Icon, Pill, Row, Screen, SectionTitle, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { clockISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';
import { getMarketingRepository } from '@/repos';
import type { LiveChatMessage } from '@/repos';
import type { LiveDealSession } from '@hudumika/contract';
import { LiveDealSessionStatus } from '@hudumika/contract';

const CHAT_MAX_LENGTH = 280;

export default function LiveSessionScreen() {
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const now = useDealClock();
  const user = useSessionStore((s) => s.user);
  const [session, setSession] = useState<LiveDealSession | null>(null);
  const [messages, setMessages] = useState<LiveChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [{ sessions }, chat] = await Promise.all([
        getMarketingRepository().listLiveDeals(),
        getMarketingRepository().fetchLiveChat(sessionId),
      ]);
      const found = sessions.find((s) => s.id === sessionId);
      if (!found) {
        setError(t('liveDeals.notFound'));
        return;
      }
      setSession(found);
      setMessages(chat);
    } catch {
      setError(t('common.error'));
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async () => {
    if (!draft.trim()) return;
    setSending(true);
    setSendError('');
    // Optimistic append (conversations pattern): the temp message renders
    // immediately; the server echo replaces it, and a failure rolls back and
    // restores the draft so nothing the user typed is lost.
    const optimistic: LiveChatMessage = {
      id: `tmp-${Date.now()}`,
      authorName: user?.fullName ?? '',
      body: draft,
      at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    try {
      const sent = await getMarketingRepository().postLiveChat(
        sessionId,
        optimistic.body,
        idempotencyKey(user?.id ?? 'customer', 'live-chat'),
      );
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? sent : m)));
      toast(t('liveDeals.chatSent'));
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(optimistic.body);
      setSendError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSending(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!session) {
    return (
      <Screen>
        <View style={{ padding: Spacing.lg }}>
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  const live = session.status === LiveDealSessionStatus.live;
  const ended = session.status === LiveDealSessionStatus.ended;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title} numberOfLines={1}>{t('liveDeals.title')}</Text>
          <View style={{ width: 40 }} />
        </Row>

        {/* Hero — the video placeholder: dark branded panel, static LIVE dot
         * (no animation — reduced-motion safe), countdown, and the honest
         * note that the video stream is a native-phase concern. */}
        <View style={styles.hero}>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            {live ? (
              <Row gap={Spacing.sm}>
                <View style={styles.liveDot} />
                <Text style={styles.liveLabel}>{t('liveDeals.live')}</Text>
              </Row>
            ) : ended ? (
              <Pill label={t('liveDeals.ended')} tone="neutral" />
            ) : (
              <Pill label={t('liveDeals.startsIn', { t: clockISO(session.startsAt) })} tone="info" />
            )}
            {live ? <DealCountdownPill endsAt={session.endsAt} now={now} /> : null}
          </Row>
          <Text style={styles.heroTitle}>{session.title}</Text>
          <Row gap={Spacing.sm} style={styles.videoNote}>
            <Icon name="videocam-outline" size={14} color={Colors.gold} />
            <Text style={styles.videoNoteText}>{t('liveDeals.videoSoon')}</Text>
          </Row>
        </View>

        {(session.deals ?? []).map((d) => (
          <DealCard key={`${session.id}-${d.merchantId}-${d.title}`} deal={d} session={session} />
        ))}

        <SectionTitle title={t('liveDeals.liveChat')} icon="chatbubbles-outline" />

        <Card style={{ gap: Spacing.lg }}>
          {messages.length === 0 ? (
            <EmptyState icon="chatbubbles-outline" title={t('liveDeals.chatEmpty')} />
          ) : (
            messages.map((m) => (
              <View key={m.id} style={styles.chatRow}>
                <Row style={{ justifyContent: 'space-between', marginBottom: 2 }}>
                  <Text style={styles.chatAuthor} numberOfLines={1}>{m.authorName}</Text>
                  <Text style={styles.chatTime}>{clockISO(m.at)}</Text>
                </Row>
                <Text style={styles.chatBody}>{m.body}</Text>
              </View>
            ))
          )}
        </Card>

        <Row gap={Spacing.sm} style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('liveDeals.chatPlaceholder')}
            placeholderTextColor={Colors.textFaint}
            maxLength={CHAT_MAX_LENGTH}
            accessibilityLabel={t('liveDeals.chatPlaceholder')}
            style={styles.input}
          />
          <Btn
            label={t('messages.send')}
            onPress={send}
            size="sm"
            loading={sending}
            disabled={!draft.trim()}
          />
        </Row>
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  hero: {
    backgroundColor: Colors.ink,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.danger,
  },
  liveLabel: { color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold, letterSpacing: 0.4 },
  heroTitle: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.white, marginBottom: Spacing.md },
  videoNote: { backgroundColor: 'rgba(255, 255, 255, 0.08)', borderRadius: Radius.md, padding: Spacing.md },
  videoNoteText: { color: Colors.gold, fontSize: FontSize.xs, fontFamily: Fonts.sansMedium, lineHeight: 16, flex: 1 },
  chatRow: { paddingBottom: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  chatAuthor: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansBold, paddingRight: Spacing.sm },
  chatTime: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, fontVariant: NumberStyle.fontVariant },
  chatBody: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sans, lineHeight: 19 },
  composer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md },
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
  },
  error: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
});
