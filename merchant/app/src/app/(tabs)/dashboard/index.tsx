import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BarChart } from '@/components/charts';
import { MerchantHeader } from '@/components/merchant-header';
import { Btn, Card, Empty, Icon, IconName, Pill, Row, Screen, SectionTitle, StatusPill } from '@/components/ui';
import { Colors, fonts, FontSize, Radius, Spacing, shadow } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { timeAgo, tzs, fullTime } from '@/lib/format';
import { computeStats, orderByHour } from '@/lib/analytics';
import { api, ApiError } from '@/api/client';
import type { Reservation } from '@/api/types';
import { useAnalyticsStore } from '@/store/analytics';
import { useChatStore } from '@/store/chat';
import { useSessionStore } from '@/store/session';
import { useMessageStore } from '@/store/messages';
import { useOrderStore } from '@/store/orders';
import { useStoreStore } from '@/store/store';
import type { MessageType } from '@/types';

const MESSAGE_ICONS: Record<MessageType, IconName> = {
  order: 'receipt-outline',
  review: 'star-outline',
  system: 'megaphone-outline',
};

const QUICK_ACTIONS: { label: I18nKey; icon: IconName; route: string; tint: string }[] = [
  { label: 'dashboard.addItem', icon: 'add-circle-outline', route: '/products/editor', tint: Colors.success },
  { label: 'dashboard.promo', icon: 'pricetag-outline', route: '/marketing/builder', tint: Colors.info },
  { label: 'dashboard.redemption', icon: 'qr-code-outline', route: '/dashboard/coupon', tint: Colors.warning },
  { label: 'dashboard.analytics', icon: 'stats-chart-outline', route: '/dashboard/analytics', tint: 'Colors.violet' },
  { label: 'dashboard.finance', icon: 'wallet-outline', route: '/dashboard/finance', tint: Colors.primaryDark },
  { label: 'dashboard.reviews', icon: 'chatbubble-ellipses-outline', route: '/dashboard/reviews', tint: 'Colors.rose' },
  { label: 'dashboard.reports', icon: 'document-text-outline', route: '/dashboard/reports', tint: Colors.primary },
  { label: 'dashboard.journeys', icon: 'git-branch-outline', route: '/dashboard/journeys', tint: Colors.info },
  { label: 'dashboard.exports', icon: 'download-outline', route: '/dashboard/exports', tint: Colors.warning },
];

export default function DashboardScreen() {
  const store = useStoreStore((s) => s.store);
  const toggleOpen = useStoreStore((s) => s.toggleOpen);
  const orders = useOrderStore((s) => s.orders);
  const messages = useMessageStore((s) => s.messages);
  const chatUnread = useChatStore((s) => s.unreadTotal);
  const merchantStatus = useSessionStore((s) => s.me?.merchant.status);
  const serverOverview = useAnalyticsStore((s) => s.overview);
  const localStats = computeStats(orders);
  const stats = serverOverview ?? localStats;
  useSyncExternalStore(onLocaleChange, () => 0);
  const [pendingRsv, setPendingRsv] = useState<Reservation[]>([]);
  const [rsvBusy, setRsvBusy] = useState('');
  const [rsvError, setRsvError] = useState('');

  /* Pending reservations (DINE-IN.md): merchant confirms/cancels from the
   * dashboard; the list comes from the reservations mock. */
  const loadPendingRsv = async () => {
    try {
      const res = await api.get<Reservation[]>('/reservations/me', { retries: 1 });
      setPendingRsv(res.filter((r) => r.status === 'pending'));
      setRsvError('');
    } catch (e) {
      setRsvError(e instanceof ApiError ? e.message : t('rsv.errLoad'));
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPendingRsv();
  }, []);

  const confirmRsv = async (r: Reservation) => {
    setRsvBusy(r.id);
    setRsvError('');
    try {
      await api.post(`/dine-in/reservations/${r.id}/confirm`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadPendingRsv();
    } catch (e) {
      setRsvError(e instanceof ApiError ? e.message : t('rsv.errLoad'));
    } finally {
      setRsvBusy('');
    }
  };

  const cancelRsv = async (r: Reservation) => {
    setRsvBusy(r.id);
    setRsvError('');
    try {
      await api.post(`/reservations/${r.id}/cancel`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadPendingRsv();
    } catch (e) {
      setRsvError(e instanceof ApiError ? e.message : t('rsv.errCancel'));
    } finally {
      setRsvBusy('');
    }
  };
    // eslint-disable-next-line react-hooks/purity
  const trend = orderByHour(orders.filter((o) => o.createdAt >= Date.now() - 86400000));
  const todayNew = serverOverview ? orders.filter((o) => o.status === 'new').length : localStats.todayNew;
  const todayCmp = Math.round(((stats.todayRevenue - stats.prevRevenue) / Math.max(stats.prevRevenue, 1)) * 100);
  const refundCount = orders.filter((o) => o.refund?.status === 'requested').length;
  const toAccept = orders.filter((o) => o.status === 'new').length;

  return (
    <Screen scroll>
      <MerchantHeader />

      {merchantStatus === 'pending' ? (
        <Pressable onPress={() => router.push('/profile/verification')} accessibilityRole="button" accessibilityLabel={t('dashboard.underReview')}>
          <Card style={styles.pendingCard}>
            <Icon name="hourglass-outline" size={18} color={Colors.warning} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('dashboard.underReview')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                {t('dashboard.reviewNote')}
              </Text>
            </View>
            <Icon name="chevron-forward" size={16} color={Colors.textTertiary} />
          </Card>
        </Pressable>
      ) : null}

      <View style={{ flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.lg }}>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            toggleOpen();
          }}
          accessibilityRole="switch"
          accessibilityLabel={t('dashboard.storeStatus')}
          accessibilityState={{ checked: store.open }}
          style={{ flex: 1 }}>
          <Card style={{ ...styles.statusCard, backgroundColor: store.open ? Colors.primary : Colors.black }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View>
                <Text style={[styles.statusLabel, { color: store.open ? Colors.text : Colors.white }]}>{t('dashboard.storeStatus')}</Text>
                <Text style={[styles.statusValue, { color: store.open ? Colors.text : Colors.white }]}>
                  {t(store.open ? 'dashboard.open' : 'dashboard.closed')}
                </Text>
              </View>
              <View style={[styles.switchBox, { backgroundColor: store.open ? Colors.ink : Colors.white }]}>
                <View style={[styles.switchThumb, { alignSelf: store.open ? 'flex-end' : 'flex-start' }]} />
              </View>
            </Row>
          </Card>
        </Pressable>
        <Card style={styles.statusCard}>
          <Text style={styles.statusLabel}>{t('dashboard.hours')}</Text>
          <Text style={styles.statusValue}>{store.hours.open}</Text>
          <Text style={styles.statusSub}>~ {store.hours.close}</Text>
        </Card>
      </View>

      <Card style={styles.revenueCard} onPress={() => router.push('/dashboard/revenue-detail')}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.cardLabel}>{t('dashboard.todayRevenue')}</Text>
          {todayCmp !== 0 ? (
            <Pill label={`${todayCmp >= 0 ? '▲' : '▼'} ${Math.abs(todayCmp)}%`} tone={todayCmp >= 0 ? 'success' : 'danger'} />
          ) : (
            <Pill label="—" tone="neutral" />
          )}
        </Row>
        <Text style={styles.bigNumber}>{tzs(stats.todayRevenue)}</Text>
        <Row style={{ gap: Spacing.lg, marginTop: Spacing.md }}>
          <Stat label={t('dashboard.orders')} value={`${stats.todayOrders}`} />
          <Stat label={t('dashboard.toAccept')} value={`${todayNew}`} accent={Colors.danger} />
          <Stat label={t('dashboard.aov')} value={`${tzs(stats.aov)}`} />
          <Stat label={t('dashboard.conv')} value={`${stats.conversion}%`} />
        </Row>
        <View style={styles.chevron}>
          <Icon name="chevron-forward" size={16} color={Colors.textFaint} />
        </View>
      </Card>

      {(refundCount > 0 || chatUnread > 0) ? (
        <View style={{ flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.md }}>
          {refundCount > 0 ? (
            <Pressable
              onPress={() => router.push('/orders')}
              accessibilityRole="button"
              accessibilityLabel={t('dashboard.refunds')}
              style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.8 }]}>
              <Card style={styles.attentionCard}>
                <View style={[styles.attentionIcon, { backgroundColor: Colors.warningSoft }]}>
                  <Icon name="return-down-back-outline" size={18} color={Colors.warning} />
                </View>
                <Text style={styles.attentionValue}>{refundCount}</Text>
                <Text style={styles.attentionLabel}>{t('dashboard.refunds')}</Text>
              </Card>
            </Pressable>
          ) : null}
          {chatUnread > 0 ? (
            <Pressable
              onPress={() => router.push('/dashboard/im')}
              accessibilityRole="button"
              accessibilityLabel={t('dashboard.chats')}
              style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.8 }]}>
              <Card style={styles.attentionCard}>
                <View style={[styles.attentionIcon, { backgroundColor: Colors.infoSoft }]}>
                  <Icon name="chatbubbles-outline" size={18} color={Colors.info} />
                </View>
                <Text style={styles.attentionValue}>{chatUnread}</Text>
                <Text style={styles.attentionLabel}>{t('dashboard.chats')}</Text>
              </Card>
            </Pressable>
          ) : null}
          {toAccept > 0 ? (
            <Pressable
              onPress={() => router.push('/orders')}
              accessibilityRole="button"
              accessibilityLabel={t('dashboard.toAccept')}
              style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.8 }]}>
              <Card style={styles.attentionCard}>
                <View style={[styles.attentionIcon, { backgroundColor: Colors.dangerSoft }]}>
                  <Icon name="timer-outline" size={18} color={Colors.danger} />
                </View>
                <Text style={styles.attentionValue}>{toAccept}</Text>
                <Text style={styles.attentionLabel}>{t('dashboard.toAccept')}</Text>
              </Card>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <SectionTitle title={t('dashboard.liveAlerts')} icon="notifications" action={t('dashboard.allMessages')} onAction={() => router.push('/dashboard/messages')} />
      <Card style={{ gap: Spacing.sm, paddingVertical: Spacing.sm }}>
        {messages.length === 0 ? (
          <Empty icon="notifications-outline" title={t('msg.empty')} />
        ) : (
          messages.slice(0, 3).map((m) => (
          <Pressable
            key={m.id}
            onPress={() => (m.orderId ? router.push(`/orders/${m.orderId}`) : router.push('/dashboard/messages'))}
            accessibilityRole="button"
            accessibilityLabel={`${m.title}. ${m.body}`}
            style={({ pressed }) => [styles.msgRow, pressed && { opacity: 0.7 }]}>
            <View style={styles.msgIcon}>
              <Icon name={MESSAGE_ICONS[m.type]} size={17} color={Colors.textSecondary} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Row gap={6}>
                <Text style={styles.msgTitle} numberOfLines={1}>{m.title}</Text>
                {m.type === 'order' && m.orderId ? <StatusPill status="new" /> : null}
                {!m.read ? <View style={styles.unreadDot} /> : null}
              </Row>
              <Text style={styles.msgBody} numberOfLines={1}>{m.body}</Text>
            </View>
            <Text style={styles.msgTime}>{timeAgo(m.ts)}</Text>
          </Pressable>
        ))
        )}
      </Card>

      <SectionTitle title={t('dashboard.pendingReservations')} icon="calendar-outline" />
      <Card style={{ gap: Spacing.sm, paddingVertical: Spacing.sm }}>
        {rsvError ? <Text style={{ fontSize: FontSize.xs, color: Colors.danger }}>{rsvError}</Text> : null}
        {pendingRsv.length === 0 ? (
          <Empty icon="calendar-outline" title={t('rsv.empty')} sub={t('dashboard.noPendingRsv')} />
        ) : (
          pendingRsv.map((r) => (
            <View key={r.id} style={styles.rsvRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.msgTitle} numberOfLines={1}>{t('rsv.partyFor', { n: String(r.partySize), when: fullTime(r.scheduledFor) })}</Text>
                {r.note ? <Text style={styles.msgBody} numberOfLines={1}>{r.note}</Text> : null}
              </View>
              <Row gap={6}>
                <Btn label={t('rsv.confirm')} size="sm" loading={rsvBusy === r.id} onPress={() => confirmRsv(r)} />
                <Btn label={t('rsv.decline')} variant="ghost" size="sm" disabled={rsvBusy === r.id} onPress={() => cancelRsv(r)} />
              </Row>
            </View>
          ))
        )}
      </Card>

      <SectionTitle title={t('dashboard.quickActions')} icon="flash" />
      <View style={styles.quickGrid}>
        {QUICK_ACTIONS.map((q) => (
          <Pressable
            key={q.label}
            onPress={() => router.push(q.route as never)}
            accessibilityRole="button"
            accessibilityLabel={t(q.label)}
            style={({ pressed }) => [styles.quickItem, pressed && { opacity: 0.7 }]}>
            <View style={[styles.quickIcon, { backgroundColor: `${q.tint}1A` }]}>
              <Icon name={q.icon} size={21} color={q.tint} />
            </View>
            <Text style={styles.quickLabel}>{t(q.label)}</Text>
          </Pressable>
        ))}
      </View>

      <SectionTitle title={t('dashboard.peakHours')} icon="time" action={t('dashboard.fullAnalytics')} onAction={() => router.push('/dashboard/analytics')} />
      <Card>
        <BarChart data={trend} height={110} colors={[Colors.primary]} />
      </Card>
    </Screen>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusCard: {
    paddingVertical: 14,
    minHeight: 86,
    justifyContent: 'center',
  },
  statusLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  statusValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginTop: 2 },
  statusSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },
  switchBox: {
    width: 42,
    height: 24,
    borderRadius: 12,
    padding: 2,
    justifyContent: 'center',
  },
  switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: Colors.primary },
  revenueCard: {
    marginTop: Spacing.md,
    position: 'relative',
  },
  cardLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  bigNumber: {
    fontSize: 34,
    fontFamily: fonts.display700,
    color: Colors.text,
    marginTop: Spacing.sm,
    letterSpacing: 0.5,
  },
  statValue: { fontSize: FontSize.md, fontFamily: fonts.display700, color: Colors.text },
  statLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  chevron: { position: 'absolute', right: 14, top: 14 },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: Spacing.sm,
  },
  msgIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  msgTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  msgBody: { fontSize: FontSize.xs, color: Colors.textTertiary },
  msgTime: { fontSize: FontSize.xs, color: Colors.textTertiary },
  unreadDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: Colors.danger },
  rsvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: Spacing.sm,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
  },
  quickItem: {
    width: '30.6%',
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    gap: 8,
    ...shadow.card,
  },
  quickIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  pendingCard: {
    marginTop: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.warningSoft,
    borderWidth: 1,
    borderColor: `${Colors.warning}55`,
  },
  attentionCard: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: Spacing.md,
  },
  attentionIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attentionValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  attentionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
});