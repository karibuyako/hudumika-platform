import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SectionTitle, SheetModal, Spinner } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { dateISO, minutesLabel } from '@/lib/format';
import { capitalize } from '@/lib/order';
import { getEarningsRepository, getRiderRepository, getSupportRepository } from '@/repos';
import type { LedgerEntry, LedgerEntryType, RiderMission } from '@hudumika/contract';

type PayoutStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'exception';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const EARNINGS_TYPES: LedgerEntryType[] = ['order_earning', 'booking_earning', 'delivery_fee', 'bonus', 'tip'];
const EARNING_ORDER_TYPES: LedgerEntryType[] = ['order_earning', 'delivery_fee'];

const LEDGER_META: Record<LedgerEntryType, { label: string; icon: 'cash-outline' | 'briefcase-outline' | 'gift-outline' | 'sparkles' | 'arrow-up-circle-outline' | 'swap-horizontal-outline' }> = {
  order_earning: { label: t('earnings.ledgerOrderEarning'), icon: 'cash-outline' },
  booking_earning: { label: t('earnings.ledgerBookingEarning'), icon: 'briefcase-outline' },
  delivery_fee: { label: t('earnings.ledgerDeliveryFee'), icon: 'cash-outline' },
  commission: { label: t('earnings.ledgerCommission'), icon: 'swap-horizontal-outline' },
  adjustment: { label: t('earnings.ledgerAdjustment'), icon: 'swap-horizontal-outline' },
  payout: { label: t('earnings.ledgerPayout'), icon: 'arrow-up-circle-outline' },
  refund: { label: t('earnings.ledgerRefund'), icon: 'swap-horizontal-outline' },
  bonus: { label: t('earnings.ledgerBonus'), icon: 'gift-outline' },
  tip: { label: t('earnings.ledgerTip'), icon: 'sparkles' },
};

const PAYOUT_META: Record<PayoutStatus, { label: string; tone: 'warning' | 'info' | 'success' | 'danger' }> = {
  pending: { label: t('earnings.payoutPending'), tone: 'warning' },
  processing: { label: t('earnings.payoutProcessing'), tone: 'info' },
  paid: { label: t('earnings.payoutPaid'), tone: 'success' },
  failed: { label: t('earnings.payoutFailed'), tone: 'danger' },
  exception: { label: t('earnings.payoutException'), tone: 'danger' },
};

// Ledger rows were previously one rounded Card; per-row borders/radii keep that look inside the FlatList.
const LedgerRow = memo(function LedgerRow({ entry, isFirst, isLast }: { entry: LedgerEntry; isFirst: boolean; isLast: boolean }) {
  const meta = LEDGER_META[entry.type] ?? { label: entry.type, icon: 'swap-horizontal-outline' as const };
  const positive = entry.amountTZS >= 0;
  return (
    <View
      style={[
        styles.ledgerRow,
        isFirst && styles.ledgerRowFirst,
        !isFirst && styles.ledgerRowBorder,
        isLast && styles.ledgerRowLast,
      ]}>
      <View style={styles.ledgerIcon}>
        <Icon name={meta.icon} size={15} color={positive ? Colors.success : Colors.textTertiary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.ledgerTitle}>{meta.label}</Text>
        <Text style={styles.cardSub}>{dateISO(entry.createdAt)}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[styles.ledgerAmount, { color: positive ? Colors.success : Colors.textSecondary }]}>
          {positive ? '+' : ''}{formatTZS(entry.amountTZS)}
        </Text>
        <Text style={styles.balanceText}>
          {t('earnings.balance')} {formatTZS(entry.balanceTZS)}
        </Text>
      </View>
    </View>
  );
});

export default function EarningsScreen() {
  const [today, setToday] = useState<{ earningsTZS: number; deliveries: number; onlineMinutes: number } | null>(null);
  const [week, setWeek] = useState<{ earningsTZS: number; deliveries: number } | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [missions, setMissions] = useState<RiderMission[]>([]);
  const [availableTZS, setAvailableTZS] = useState(0);
  const [payouts, setPayouts] = useState<{ id: string; status: PayoutStatus; amountTZS: number; method: string; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [claimed, setClaimed] = useState<string[]>([]);
  const [withdrawing, setWithdrawing] = useState(false);

  const [ticketVisible, setTicketVisible] = useState(false);
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketBody, setTicketBody] = useState('');
  const [ticketSending, setTicketSending] = useState(false);
  const [ticketError, setTicketError] = useState('');
  const [ticketSent, setTicketSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const weekStart = new Date(Date.now() - WEEK_MS).toISOString();
      const [summary, stmt, missions, wallet, payouts] = await Promise.all([
        getEarningsRepository().getTodaySummary(),
        getEarningsRepository().getStatement(),
        getRiderRepository().listMissions(),
        getEarningsRepository().getWallet(),
        getEarningsRepository().listPayouts(),
      ]);
      let weekEarnings = 0;
      let weekDeliveries = 0;
      for (const entry of stmt) {
        if (entry.createdAt < weekStart) continue;
        if (EARNINGS_TYPES.includes(entry.type)) weekEarnings += entry.amountTZS;
        if (EARNING_ORDER_TYPES.includes(entry.type)) weekDeliveries += 1;
      }
      setToday(summary);
      setWeek({ earningsTZS: weekEarnings, deliveries: weekDeliveries });
      setLedger(stmt);
      setMissions(missions);
      setAvailableTZS(wallet.availableTZS);
      setPayouts(payouts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('earnings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const loadPayouts = useCallback(async () => {
    try {
      const [wallet, payouts] = await Promise.all([
        getEarningsRepository().getWallet(),
        getEarningsRepository().listPayouts(),
      ]);
      setAvailableTZS(wallet.availableTZS);
      setPayouts(payouts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('earnings.payoutsLoadFailed'));
    }
  }, []);

  const onWithdraw = async () => {
    if (availableTZS <= 0) return;
    setWithdrawing(true);
    try {
      await getEarningsRepository().requestPayout(availableTZS);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadPayouts();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('earnings.withdrawFailed'));
    } finally {
      setWithdrawing(false);
    }
  };

  const onClaim = (mission: RiderMission) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setClaimed((c) => [...c, mission.id]);
  };

  const openPayoutTicket = (payoutId: string) => {
    setTicketSubject(t('earnings.payoutIssueSubject', { payoutId }));
    setTicketBody('');
    setTicketError('');
    setTicketSent(false);
    setTicketVisible(true);
  };

  const submitTicket = async () => {
    if (!ticketSubject.trim() || !ticketBody.trim()) return;
    setTicketSending(true);
    setTicketError('');
    try {
      await getSupportRepository().createTicket(ticketSubject.trim(), ticketBody.trim(), 'payment');
      setTicketSent(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setTicketError(e instanceof ApiError ? e.message : t('earnings.ticketFailed'));
    } finally {
      setTicketSending(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error && !today) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="ghost" onPress={load} />
        </View>
      </Screen>
    );
  }

  const renderLedgerItem = ({ item, index }: ListRenderItemInfo<LedgerEntry>) => (
    <LedgerRow entry={item} isFirst={index === 0} isLast={index === ledger.length - 1} />
  );

  const header = (
    <>
      <Text style={styles.heading}>{t('tab.earnings')}</Text>

      {/* Today */}
      <Card style={{ gap: Spacing.xs, backgroundColor: Colors.ink }}>
        <Text style={styles.cardLabelOnDark}>{t('earnings.today')}</Text>
        <Text style={styles.todayValue}>{today ? formatTZS(today.earningsTZS) : '—'}</Text>
        <Row gap={Spacing.lg} style={{ marginTop: Spacing.sm }}>
          <Text style={styles.cardSubOnDark}>{t('earnings.deliveriesCount', { n: today?.deliveries ?? 0 })}</Text>
          <Text style={styles.cardSubOnDark}>{today ? t('earnings.onlineLabel', { time: minutesLabel(today.onlineMinutes) }) : '—'}</Text>
        </Row>
      </Card>

      {/* Week */}
      <Card style={{ gap: Spacing.xs }}>
        <Text style={styles.cardLabel}>{t('earnings.week')}</Text>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={styles.weekValue}>{week ? formatTZS(week.earningsTZS) : '—'}</Text>
          <Text style={styles.cardSub}>{t('earnings.deliveriesCount', { n: week?.deliveries ?? 0 })}</Text>
        </Row>
      </Card>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={load} style={{ marginTop: Spacing.sm }} />
        </View>
      ) : null}

      {/* Missions */}
      <SectionTitle title={t('earnings.missions')} icon="gift-outline" />
      {missions.length === 0 ? (
        <Empty icon="gift-outline" title={t('earnings.missionsEmpty')} sub={t('earnings.missionsEmptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {missions.map((mission) => {
            const done = mission.completedDeliveries ?? 0;
            const pct = Math.min(1, mission.targetDeliveries > 0 ? done / mission.targetDeliveries : 0);
            const isClaimed = claimed.includes(mission.id) || mission.claimed === true;
            return (
              <Card key={mission.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text numberOfLines={1} style={styles.missionTitle}>{mission.title}</Text>
                  <Pill
                    label={mission.status.toUpperCase()}
                    tone={mission.status === 'active' ? 'info' : mission.status === 'completed' ? 'success' : 'neutral'}
                  />
                </Row>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
                </View>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.cardSub}>
                    {t('earnings.missionProgress', { done, target: mission.targetDeliveries })}
                  </Text>
                  <Text style={styles.rewardText}>{formatTZS(mission.rewardTZS)}</Text>
                </Row>
                {mission.canClaim && !isClaimed ? (
                  <Btn label={t('earnings.claim')} size="sm" onPress={() => onClaim(mission)} icon="gift" />
                ) : isClaimed ? (
                  <Pill label={t('earnings.claimed')} tone="success" />
                ) : null}
              </Card>
            );
          })}
        </View>
      )}

      {/* Ledger */}
      <SectionTitle title={t('earnings.ledger')} icon="receipt-outline" />
    </>
  );

  const footer = (
    <>
      {/* Payouts */}
      <SectionTitle title={t('earnings.payouts')} icon="wallet-outline" />
      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <Text style={styles.cardLabel}>{t('earnings.available')}</Text>
            <Text style={styles.payoutValue}>{formatTZS(availableTZS)}</Text>
          </View>
          <Btn
            label={t('earnings.withdraw')}
            variant="dark"
            onPress={onWithdraw}
            loading={withdrawing}
            disabled={availableTZS <= 0}
            icon="arrow-up"
            size="sm"
          />
        </Row>
        {payouts.length > 0 ? (
          <View style={{ gap: Spacing.sm }}>
            {payouts.map((p) => {
              const meta = PAYOUT_META[p.status];
              const actionable = p.status === 'failed' || p.status === 'exception';
              return (
                <View key={p.id} style={{ gap: Spacing.xs }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View style={{ flex: 1, paddingRight: Spacing.sm }}>
                      <Text style={styles.ledgerTitle}>{formatTZS(p.amountTZS)} · {capitalize(p.method)}</Text>
                      <Text style={styles.cardSub}>{dateISO(p.createdAt)}</Text>
                    </View>
                    <Pill label={meta.label} tone={meta.tone} />
                  </Row>
                  {actionable ? (
                    <Btn
                      label={t('earnings.contactSupport')}
                      variant="outline"
                      size="sm"
                      icon="chatbubble-ellipses-outline"
                      onPress={() => openPayoutTicket(p.id)}
                      style={{ alignSelf: 'flex-start' }}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
      </Card>
    </>
  );

  return (
    <Screen>
      <FlatList
        data={ledger}
        keyExtractor={(entry) => entry.id}
        renderItem={renderLedgerItem}
        ListHeaderComponent={header}
        ListEmptyComponent={<Empty icon="receipt-outline" title={t('earnings.ledgerEmpty')} />}
        ListFooterComponent={footer}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      {/* Support ticket sheet */}
      <SheetModal visible={ticketVisible} onClose={() => setTicketVisible(false)} title={t('earnings.contactSupport')}>
        <View style={{ gap: Spacing.md }}>
          {ticketSent ? (
            <View style={styles.ticketSentBox}>
              <Icon name="checkmark-circle" size={20} color={Colors.success} />
              <Text style={styles.ticketSentText}>{t('earnings.ticketSent')}</Text>
            </View>
          ) : (
            <>
              <Field
                label={t('earnings.ticketSubject')}
                value={ticketSubject}
                onChangeText={setTicketSubject}
                maxLength={160}
              />
              <Field
                label={t('earnings.ticketBody')}
                value={ticketBody}
                onChangeText={setTicketBody}
                multiline
                maxLength={4000}
              />
              {ticketError ? <Text style={styles.error}>{ticketError}</Text> : null}
              <Btn
                label={t('earnings.ticketSend')}
                icon="paper-plane-outline"
                onPress={submitTicket}
                loading={ticketSending}
                disabled={!ticketSubject.trim() || !ticketBody.trim()}
                size="lg"
              />
            </>
          )}
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.text, marginBottom: Spacing.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  errorBox: {
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  cardLabelOnDark: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  cardLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  cardSubOnDark: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  cardSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  todayValue: { fontSize: 32, fontWeight: '900', color: Colors.white, fontVariant: NumberStyle.fontVariant, marginTop: 2 },
  weekValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  payoutValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant, marginTop: 2 },
  missionTitle: { flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  progressTrack: { height: 8, borderRadius: Radius.pill, backgroundColor: Colors.surface, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: Radius.pill, backgroundColor: Colors.primary },
  rewardText: { fontSize: FontSize.md, fontWeight: '800', color: Colors.primaryDeep, fontVariant: NumberStyle.fontVariant },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    backgroundColor: Colors.card,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderLeftColor: Colors.border,
    borderRightColor: Colors.border,
  },
  ledgerRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  ledgerRowFirst: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
  },
  ledgerRowLast: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    borderBottomLeftRadius: Radius.lg,
    borderBottomRightRadius: Radius.lg,
  },
  ledgerIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ledgerTitle: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  ledgerAmount: { fontSize: FontSize.sm, fontWeight: '800', fontVariant: NumberStyle.fontVariant },
  balanceText: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  ticketSentBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.successSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
  },
  ticketSentText: { flex: 1, color: Colors.success, fontSize: FontSize.sm, fontWeight: '700' },
});
