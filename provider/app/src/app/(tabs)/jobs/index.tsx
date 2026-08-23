import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { BookingCard } from '@/components/BookingCard';
import { CountdownPill } from '@/components/CountdownPill';
import { Btn, Empty, ErrorCard, Field, Icon, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { announce } from '@/lib/motion';
import { DECLINE_REASONS } from '@/lib/format';
import { ApiError } from '@/api/client';
import { STALE_OFFER_CODES } from '@/lib/booking';
import { getBookingsRepository } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import type { Booking } from '@hudumika/contract';

type Tab = 'incoming' | 'active' | 'completed' | 'cancelled';

const TABS: { key: Tab; labelKey: I18nKey }[] = [
  { key: 'incoming', labelKey: 'jobs.tab.incoming' },
  { key: 'active', labelKey: 'jobs.tab.active' },
  { key: 'completed', labelKey: 'jobs.tab.completed' },
  { key: 'cancelled', labelKey: 'jobs.tab.cancelled' },
];

const EMPTY_KEYS: Record<Tab, I18nKey> = {
  incoming: 'jobs.none.incoming',
  active: 'jobs.none.active',
  completed: 'jobs.none.completed',
  cancelled: 'jobs.none.cancelled',
};

const EMPTY_ICONS: Record<Tab, 'file-tray-outline' | 'briefcase-outline' | 'checkmark-circle-outline' | 'close-circle-outline'> = {
  incoming: 'file-tray-outline',
  active: 'briefcase-outline',
  completed: 'checkmark-circle-outline',
  cancelled: 'close-circle-outline',
};

const POLL_MS = 15000;

const RESPONDABLE = ['offered', 'provider_requested'];

function IncomingBookingRow({ booking }: { booking: Booking }) {
  const marketplace = useJobsStore((s) => s.marketplace);
  const acceptOffer = useJobsStore((s) => s.acceptOffer);
  const declineOffer = useJobsStore((s) => s.declineOffer);
  const refreshBookings = useJobsStore((s) => s.refreshBookings);

  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState('');
  const [declineVisible, setDeclineVisible] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const onExpire = useCallback(() => {
    void refreshBookings();
  }, [refreshBookings]);

  const onAccept = async () => {
    setBusy(true);
    setRowError('');
    try {
      if (booking.status === 'offered') {
        await acceptOffer(booking.id);
      } else {
        await getBookingsRepository().accept(booking.id);
      }
      await refreshBookings();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (STALE_OFFER_CODES as readonly string[]).includes(e.code)) {
        setRowError(e.message);
        void refreshBookings();
      } else {
        setRowError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onDecline = async () => {
    setDeclining(true);
    setRowError('');
    try {
      await declineOffer(booking.id, reason.trim() || undefined);
      setDeclineVisible(false);
      setReason('');
      await refreshBookings();
    } catch (e) {
      setRowError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setDeclining(false);
    }
  };

  const offer = booking.status === 'offered' ? marketplace.find((j) => j.bookingId === booking.id) : undefined;
  const countdown = offer?.expiresAt ? (
    <CountdownPill expiresAt={offer.expiresAt} dangerUnder={120} onExpire={onExpire} />
  ) : (
    <View style={styles.windowPill}>
      <Icon name="timer" size={14} color={Colors.textTertiary} />
      <Text style={styles.windowText}>
        {t('jobs.acceptWindow')} · 05:00
      </Text>
    </View>
  );

  return (
    <View style={{ gap: Spacing.sm }}>
      <BookingCard booking={booking} onPress={() => router.push(`/jobs/${booking.id}`)} />
      <Row gap={Spacing.sm} style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>{countdown}</View>
        <Row gap={Spacing.sm}>
          <Btn label={t('jobs.accept')} size="sm" icon="checkmark-circle" onPress={onAccept} loading={busy} disabled={declining} />
          <Btn label={t('jobs.decline')} variant="outline" size="sm" onPress={() => setDeclineVisible(true)} disabled={busy || declining} />
        </Row>
      </Row>
      {rowError ? <Text style={styles.rowError}>{rowError}</Text> : null}

      <SheetModal visible={declineVisible} onClose={() => setDeclineVisible(false)} title={t('jobs.decline')}>
        <Text style={styles.sheetSub}>{t('jobs.declinedSub')}</Text>
        {DECLINE_REASONS.map((r) => (
          <Pressable
            key={r}
            onPress={() => setReason(r)}
            accessibilityRole="button"
            accessibilityLabel={r}
            style={({ pressed }) => [styles.reasonRow, reason === r && styles.reasonRowActive, pressed && { opacity: 0.7 }]}>
            <Text style={styles.reasonText}>{r}</Text>
            {reason === r ? <Icon name="checkmark-circle" size={16} color={Colors.primaryDeep} /> : null}
          </Pressable>
        ))}
        <Field
          label={`${t('booking.declineReason')} (${t('misc.optional')})`}
          value={reason}
          onChangeText={setReason}
          maxLength={500}
          hint={t('booking.declineReasonMax')}
        />
        {rowError ? <Text style={styles.rowError}>{rowError}</Text> : null}
        <Btn label={t('jobs.decline')} variant="danger" onPress={onDecline} loading={declining} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setDeclineVisible(false)} disabled={declining} />
      </SheetModal>
    </View>
  );
}

export default function JobsIndexScreen() {
  const [tab, setTab] = useState<Tab>('active');
  const [refreshing, setRefreshing] = useState(false);
  const incoming = useJobsStore((s) => s.incoming);
  const active = useJobsStore((s) => s.active);
  const completed = useJobsStore((s) => s.completed);
  const cancelled = useJobsStore((s) => s.cancelled);
  const loading = useJobsStore((s) => s.loading);
  const error = useJobsStore((s) => s.error);
  const refreshBookings = useJobsStore((s) => s.refreshBookings);

  // Screen-reader announcement when a new incoming request lands while polling.
  const incomingCount = useJobsStore((s) => s.incoming.length);
  const prevCountRef = useRef(incomingCount);
  useEffect(() => {
    if (incomingCount > prevCountRef.current) {
      announce(t('jobs.announceIncoming'));
    }
    prevCountRef.current = incomingCount;
  }, [incomingCount]);

  useFocusEffect(
    useCallback(() => {
      refreshBookings();
      // Incoming offers carry expiry windows — keep the tab fresh while focused.
      const iv = setInterval(refreshBookings, POLL_MS);
      return () => clearInterval(iv);
    }, [refreshBookings]),
  );

  const counts: Record<Tab, number> = { incoming: incoming.length, active: active.length, completed: completed.length, cancelled: cancelled.length };
  const list = tab === 'incoming' ? incoming : tab === 'active' ? active : tab === 'completed' ? completed : cancelled;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshBookings();
    setRefreshing(false);
  }, [refreshBookings]);

  // Hoisted renderItem (M6 perf) — no inline list render functions.
  const renderBooking = useCallback(
    ({ item }: { item: Booking }) =>
      RESPONDABLE.includes(item.status) ? (
        <IncomingBookingRow booking={item} />
      ) : (
        <BookingCard booking={item} onPress={() => router.push(`/jobs/${item.id}`)} />
      ),
    [],
  );

  return (
    <Screen>
      <View style={styles.segmentWrap}>
        <Segmented
          options={TABS.map((tb) => ({ key: tb.key, label: t(tb.labelKey), count: counts[tb.key] }))}
          value={tab}
          onChange={setTab}
          equal
        />
      </View>

      <FlatList
        data={list}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Text style={styles.title}>{t('jobs.section.myJobs')}</Text>
            <Row gap={Spacing.md}>
              <Pressable
                onPress={() => router.push('/jobs/marketplace')}
                accessibilityRole="button"
                accessibilityLabel={t('jobs.section.marketplace')}
                hitSlop={8}>
                <Text style={styles.link}>{t('jobs.section.marketplace')} ›</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/jobs/calendar')}
                accessibilityRole="button"
                accessibilityLabel={t('jobs.section.calendar')}
                hitSlop={8}>
                <Text style={styles.link}>{t('jobs.section.calendar')} ›</Text>
              </Pressable>
            </Row>
          </Row>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && list.length === 0 ? (
            <ErrorCard message={error} onRetry={refreshBookings} />
          ) : (
            <Empty icon={EMPTY_ICONS[tab]} title={t(EMPTY_KEYS[tab])} sub={t('jobs.noneSub')} />
          )
        }
        renderItem={renderBooking}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentWrap: { padding: Spacing.md, paddingBottom: Spacing.sm, backgroundColor: Colors.bg },
  list: { padding: Spacing.lg, paddingTop: Spacing.md, paddingBottom: 120, gap: Spacing.md },
  center: { alignItems: 'center', paddingVertical: 80 },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, letterSpacing: 0.2 },
  link: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  windowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: 999,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  windowText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  rowError: { color: Colors.danger, fontSize: FontSize.xs, fontWeight: '600' },
  sheetSub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 19 },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  reasonRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  reasonText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
});
