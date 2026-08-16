/* LIVE DEALS ZONE (神抢手-lite) — scheduled flash-sale sessions with
 * countdowns (GET /marketing/live-deals). The richer sibling of the home
 * flash rail: live session first (ticking countdown to endsAt), scheduled
 * sessions with a "Starts in …" countdown to startsAt, ended sessions greyed.
 * Each session card opens its LIVE STREAMING-LITE broadcast screen
 * (/live/{sessionId}) — hero with the video placeholder + live chat.
 *
 * This is the SESSIONS zone — NOT video livestreaming. Video playback is a
 * native-phase concern with no contract surface yet; the honest note below
 * says exactly that, and nothing here implies a stream exists.
 *
 * Every render comes from the contract payload: session status is
 * server-derived (scheduled | live | ended), money is integer TZS via
 * formatTZS(), and the countdowns are pure client display of startsAt/endsAt.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { DealCard } from '@/components/DealCard';
import { DealCountdownPill, useDealClock } from '@/components/DealCountdown';
import { Btn, Card, EmptyState, ErrorState, Pill, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { countdownISO } from '@/lib/dates';
import { getMarketingRepository } from '@/repos';
import type { LiveDealSession } from '@hudumika/contract';
import { LiveDealSessionStatus } from '@hudumika/contract';

export default function LiveDealsScreen() {
  const router = useRouter();
  const now = useDealClock();
  const [sessions, setSessions] = useState<LiveDealSession[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      const { sessions: list } = await getMarketingRepository().listLiveDeals();
      setSessions(list);
    } catch {
      if (!silent) setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('liveDeals.title')}</Text>
          <View style={{ width: 40 }} />
        </Row>
      </View>
      {error ? (
        <ErrorState message={error} onRetry={() => load()} />
      ) : !sessions ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : sessions.length === 0 ? (
        <EmptyState icon="flash-outline" title={t('liveDeals.noDeals')} />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          onRefresh={onRefresh}
          refreshing={refreshing}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          ListHeaderComponent={
            <View style={styles.videoNote}>
              <Text style={styles.videoNoteText}>{t('liveDeals.videoNote')}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const live = item.status === LiveDealSessionStatus.live;
            const ended = item.status === LiveDealSessionStatus.ended;
            const deals = item.deals ?? [];
            return (
              <Card
                style={styles.sessionBlock}
                onPress={() => router.push(`/live/${item.id}`)}
                accessibilityRole="link"
                accessibilityLabel={item.title}>
                <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
                  <Text style={styles.sessionTitle} numberOfLines={1}>{item.title}</Text>
                  {live ? (
                    <Pill label={t('liveDeals.liveNow')} tone="danger" />
                  ) : ended ? (
                    <Pill label={t('liveDeals.ended')} tone="neutral" />
                  ) : (
                    <Pill label={t('liveDeals.startsIn', { t: countdownISO(item.startsAt) })} tone="info" />
                  )}
                </Row>
                {live ? (
                  <View style={styles.countdownRow}>
                    <DealCountdownPill endsAt={item.endsAt} now={now} />
                  </View>
                ) : null}
                {deals.length === 0 ? (
                  <Text style={styles.meta}>{t('liveDeals.noDeals')}</Text>
                ) : (
                  deals.map((d) => (
                    <DealCard
                      key={`${item.id}-${d.merchantId}-${d.title}`}
                      deal={d}
                      session={item}
                    />
                  ))
                )}
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  videoNote: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  videoNoteText: { color: Colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.sans, lineHeight: 16 },
  sessionBlock: { marginBottom: Spacing.lg },
  sessionTitle: { flex: 1, fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, paddingRight: Spacing.sm },
  countdownRow: { marginBottom: Spacing.sm },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
});
