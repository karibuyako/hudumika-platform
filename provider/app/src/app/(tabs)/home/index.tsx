import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Switch, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { AvailabilityWeek } from '@/components/AvailabilityWeek';
import { BookingCard } from '@/components/BookingCard';
import { Btn, Card, Empty, ErrorCard, Icon, Kpi, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { hapticSuccess } from '@/lib/motion';
import { ACTIVE_STATUSES } from '@/lib/booking';
import { getAvailabilityRepository, getEarningsRepository } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import { useSessionStore } from '@/store/session';
import type { AvailabilityWindow, Booking } from '@hudumika/contract';

const TODAY_LIMIT = 3;

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function todayBounds(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function HomeScreen() {
  const provider = useSessionStore((s) => s.provider);
  const incoming = useJobsStore((s) => s.incoming);
  const active = useJobsStore((s) => s.active);
  const completed = useJobsStore((s) => s.completed);
  const cancelled = useJobsStore((s) => s.cancelled);
  const jobsLoading = useJobsStore((s) => s.loading);
  const jobsError = useJobsStore((s) => s.error);
  const refreshBookings = useJobsStore((s) => s.refreshBookings);

  const [windows, setWindows] = useState<AvailabilityWindow[]>(provider?.availability ?? []);
  const [availabilityError, setAvailabilityError] = useState('');
  const [toggling, setToggling] = useState(false);
  const [todayEarned, setTodayEarned] = useState<number | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadAvailability = useCallback(async () => {
    try {
      const fetched = await getAvailabilityRepository().getAvailability();
      setWindows(fetched);
      setAvailabilityError('');
      const p = useSessionStore.getState().provider;
      if (p) useSessionStore.getState().applyProvider({ ...p, availability: fetched });
    } catch (e) {
      setAvailabilityError(e instanceof ApiError ? e.message : 'Could not load availability');
    }
  }, []);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      const { from, to } = todayBounds();
      const stmt = await getEarningsRepository().getStatement(from, to);
      let earned = 0;
      for (const entry of stmt.entries) {
        if (entry.type === 'booking_earning' && entry.amountTZS > 0) earned += entry.amountTZS;
      }
      setTodayEarned(earned);
    } catch (e) {
      setStatsError(e instanceof ApiError ? e.message : 'Could not load today stats');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadAvailability();
      loadStats();
      refreshBookings();
    }, [loadAvailability, loadStats, refreshBookings]),
  );

  const saveAvailability = useCallback(async (next: AvailabilityWindow[]) => {
    setToggling(true);
    setAvailabilityError('');
    try {
      await getAvailabilityRepository().putAvailability(next);
      const fetched = await getAvailabilityRepository().getAvailability();
      setWindows(fetched);
      const p = useSessionStore.getState().provider;
      if (p) useSessionStore.getState().applyProvider({ ...p, availability: fetched });
      hapticSuccess();
    } catch (e) {
      setAvailabilityError(e instanceof ApiError ? e.message : 'Could not save availability');
    } finally {
      setToggling(false);
    }
  }, []);

  const onToggleAccepting = useCallback(
    (online: boolean) => {
      saveAvailability(windows.map((w) => ({ ...w, active: online })));
    },
    [saveAvailability, windows],
  );

  const onToggleWindow = useCallback(
    (win: AvailabilityWindow) => {
      saveAvailability(
        windows.map((w) =>
          w.dayOfWeek === win.dayOfWeek && w.startTime === win.startTime ? { ...w, active: win.active ?? true } : w,
        ),
      );
    },
    [saveAvailability, windows],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadAvailability(), loadStats(), refreshBookings()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadAvailability, loadStats, refreshBookings]);

  const isAccepting = windows.some((w) => w.active);
  const now = new Date();
  const jobsDone = completed.filter((b) => isSameDay(new Date(b.scheduledFor), now)).length;

  const seen = new Set<string>();
  const todays: Booking[] = [];
  for (const b of [...incoming, ...active, ...completed, ...cancelled]) {
    if (seen.has(b.id)) continue;
    if (isSameDay(new Date(b.scheduledFor), now) || ACTIVE_STATUSES.includes(b.status)) {
      seen.add(b.id);
      todays.push(b);
    }
  }
  todays.sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : 1));
  const shown = todays.slice(0, TODAY_LIMIT);

  const verified = provider?.verification === 'approved';

  return (
    <Screen>
      <FlatList
        data={shown}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.heading}>{t('tab.home')}</Text>

            {/* Availability */}
            <SectionTitle title={t('home.availability')} icon="calendar-outline" />
            <Card style={{ gap: Spacing.md }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={Spacing.md}>
                  <View style={[styles.dot, { backgroundColor: isAccepting ? Colors.success : Colors.borderStrong }]} />
                  <View>
                    <Text style={[styles.statusTitle, { color: isAccepting ? Colors.success : Colors.textSecondary }]}>
                      {isAccepting ? t('home.accepting') : t('home.paused')}
                    </Text>
                    <Text style={styles.statusSub}>
                      {isAccepting ? t('home.acceptingSub') : t('home.pausedSub')}
                    </Text>
                  </View>
                </Row>
                <Switch
                  value={isAccepting}
                  onValueChange={onToggleAccepting}
                  disabled={toggling || windows.length === 0}
                  accessibilityLabel={isAccepting ? t('home.paused') : t('home.accepting')}
                  accessibilityState={{ checked: isAccepting }}
                  trackColor={{ false: Colors.borderStrong, true: Colors.success }}
                  thumbColor={Colors.white}
                  ios_backgroundColor={Colors.borderStrong}
                />
              </Row>
              <AvailabilityWeek windows={windows} onToggle={onToggleWindow} disabled={toggling} />
              {availabilityError ? (
                <View style={{ gap: Spacing.sm }}>
                  <Text style={styles.error}>{availabilityError}</Text>
                  <Btn label={t('misc.retry')} variant="ghost" size="sm" onPress={loadAvailability} />
                </View>
              ) : null}
            </Card>

            {/* Verification notice */}
            {!verified ? (
              <View style={styles.noticeBox}>
                <Icon name="lock-closed" size={14} color={Colors.warning} />
                <Text style={styles.noticeText}>{t('home.verificationNotice')}</Text>
              </View>
            ) : null}

            {/* KPI row */}
            {statsError ? (
              <ErrorCard message={statsError} onRetry={loadStats} />
            ) : statsLoading && todayEarned === null ? (
              <View style={{ paddingVertical: Spacing.xl }}>
                <ActivityIndicator color={Colors.primary} />
              </View>
            ) : (
              <Row gap={Spacing.md}>
                <Kpi label={t('home.todayJobs')} value={formatTZS(todayEarned ?? 0)} icon="cash-outline" />
                <Kpi label={t('home.jobsDone')} value={String(jobsDone)} icon="receipt-outline" />
                <Kpi label={t('home.rating')} value={provider?.rating != null ? provider.rating.toFixed(1) : '—'} icon="star-outline" />
              </Row>
            )}

            {/* Today's jobs */}
            <SectionTitle
              title={t('home.todayJobsSection')}
              icon="flash"
              action={t('home.viewAll')}
              onAction={() => router.push('/jobs')}
            />
          </View>
        }
        ListEmptyComponent={
          jobsLoading && shown.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : jobsError && shown.length === 0 ? (
            <ErrorCard message={jobsError} onRetry={refreshBookings} />
          ) : (
            <Empty icon="calendar-outline" title={t('home.noJobsToday')} sub={t('home.noJobsTodaySub')} />
          )
        }
        renderItem={({ item }) => <BookingCard booking={item} onPress={() => router.push(`/jobs/${item.id}`)} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md },
  heading: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.text, marginBottom: Spacing.lg },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusTitle: { fontSize: FontSize.lg, fontWeight: '800' },
  statusSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  noticeText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, fontWeight: '700' },
  center: { alignItems: 'center', paddingVertical: 80 },
});
