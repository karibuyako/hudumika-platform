import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { LedgerRow } from '@/components/LedgerRow';
import { Btn, Card, Divider, Empty, ErrorCard, Field, Icon, Pill, Row, Screen, SectionTitle, SheetModal } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { hapticSuccess } from '@/lib/motion';
import { isDisputeHeld } from '@/lib/booking';
import { capitalize, dateISO } from '@/lib/format';
import { getEarningsRepository } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import type { LedgerStatement, PayoutSummary, PayoutSummaryStatus, Wallet } from '@hudumika/contract';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PAYOUT_TONE: Record<PayoutSummaryStatus, 'warning' | 'info' | 'success' | 'danger'> = {
  pending: 'warning',
  processing: 'info',
  paid: 'success',
  failed: 'danger',
  exception: 'danger',
};

const PAYOUT_LABEL: Record<PayoutSummaryStatus, I18nKey> = {
  pending: 'earnings.pending',
  processing: 'earnings.processing',
  paid: 'earnings.paid',
  failed: 'earnings.failed',
  exception: 'earnings.exception',
};

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthStart(): string {
  const now = new Date();
  return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
}

function weekStartIso(): string {
  const now = new Date();
  const mondayOffset = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset, 0, 0, 0, 0);
  return monday.toISOString();
}

function endOfTodayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
}

function sumBookingEarnings(stmt: LedgerStatement): number {
  let sum = 0;
  for (const entry of stmt.entries) {
    if (entry.type === 'booking_earning' && entry.amountTZS > 0) sum += entry.amountTZS;
  }
  return sum;
}

export default function EarningsScreen() {
  const incoming = useJobsStore((s) => s.incoming);
  const active = useJobsStore((s) => s.active);
  const completed = useJobsStore((s) => s.completed);
  const cancelled = useJobsStore((s) => s.cancelled);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [weekEarned, setWeekEarned] = useState(0);
  const [statement, setStatement] = useState<LedgerStatement | null>(null);
  const [payouts, setPayouts] = useState<PayoutSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState('');
  const [payoutsError, setPayoutsError] = useState('');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(() => ymd(new Date()));

  const [withdrawVisible, setWithdrawVisible] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawError, setWithdrawError] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  const statementSeq = useRef(0);

  const fetchStatement = useCallback(async (fromVal: string, toVal: string) => {
    const seq = ++statementSeq.current;
    setStatementLoading(true);
    setStatementError('');
    try {
      const stmt = await getEarningsRepository().getStatement(fromVal, toVal);
      if (seq !== statementSeq.current) return;
      setStatement(stmt);
    } catch (e) {
      if (seq !== statementSeq.current) return;
      setStatementError(e instanceof ApiError ? e.message : 'Could not load the statement');
    } finally {
      if (seq === statementSeq.current) setStatementLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [walletRes, weekStmt, payoutsRes, stmtRes] = await Promise.all([
        getEarningsRepository().getWallet(),
        getEarningsRepository().getStatement(weekStartIso(), endOfTodayIso()),
        getEarningsRepository().listPayouts(),
        getEarningsRepository().getStatement(from, to),
      ]);
      setWallet(walletRes);
      setWeekEarned(sumBookingEarnings(weekStmt));
      setPayouts(payoutsRes);
      setStatement(stmtRes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load earnings');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const refreshWalletAndPayouts = useCallback(async () => {
    try {
      const [walletRes, weekStmt, payoutsRes] = await Promise.all([
        getEarningsRepository().getWallet(),
        getEarningsRepository().getStatement(weekStartIso(), endOfTodayIso()),
        getEarningsRepository().listPayouts(),
      ]);
      setWallet(walletRes);
      setWeekEarned(sumBookingEarnings(weekStmt));
      setPayouts(payoutsRes);
      setPayoutsError('');
    } catch (e) {
      setPayoutsError(e instanceof ApiError ? e.message : 'Could not load payouts');
    }
  }, []);

  const onRangeChange = (key: 'from' | 'to', value: string) => {
    if (key === 'from') setFrom(value);
    else setTo(value);
    const next = key === 'from' ? value : from;
    const other = key === 'from' ? to : value;
    if (DATE_RE.test(next) && DATE_RE.test(other) && !Number.isNaN(Date.parse(next)) && !Number.isNaN(Date.parse(other))) {
      fetchStatement(next, other);
    }
  };

  const available = wallet?.withdrawableTZS ?? 0;

  const openWithdraw = () => {
    setWithdrawAmount(String(Math.max(0, available)));
    setWithdrawError('');
    setWithdrawVisible(true);
  };

  const submitWithdraw = async () => {
    const amount = Number(withdrawAmount.replace(/\D/g, ''));
    if (!Number.isInteger(amount) || amount <= 0) {
      setWithdrawError(t('earnings.validAmount'));
      return;
    }
    setWithdrawing(true);
    setWithdrawError('');
    try {
      await getEarningsRepository().requestPayout(amount);
      hapticSuccess();
      setWithdrawVisible(false);
      await refreshWalletAndPayouts();
      fetchStatement(from, to);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_BALANCE') {
        setWithdrawError(t('earnings.insufficientBalance'));
      } else {
        setWithdrawError(e instanceof ApiError ? e.message : 'Could not request the payout');
      }
    } finally {
      setWithdrawing(false);
    }
  };

  const hasDispute = [...incoming, ...active, ...completed, ...cancelled].some((b) => isDisputeHeld(b.status));

  const balance = wallet?.totalTZS ?? statement?.closingBalanceTZS ?? 0;

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error && !wallet) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('misc.retry')} variant="ghost" onPress={load} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Text style={styles.heading}>{t('tab.earnings')}</Text>

      {/* Balance */}
      <Card style={{ gap: Spacing.xs, backgroundColor: Colors.ink }}>
        <Text style={styles.cardLabelOnDark}>{t('earnings.balance')}</Text>
        <Text style={styles.balanceValue}>{formatTZS(balance)}</Text>
        <Row gap={Spacing.lg} style={{ marginTop: Spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardLabelOnDark}>{t('earnings.pendingAmount')}</Text>
            <Text style={styles.cardSubOnDark}>{formatTZS(wallet?.pendingTZS ?? 0)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardLabelOnDark}>{t('earnings.settledThisWeek')}</Text>
            <Text style={styles.cardSubOnDark}>{formatTZS(weekEarned)}</Text>
          </View>
        </Row>
      </Card>

      <View style={{ marginTop: Spacing.md }}>
        <Btn
          label={t('earnings.withdraw')}
          variant="dark"
          icon="arrow-up"
          size="lg"
          onPress={openWithdraw}
          disabled={available <= 0}
        />
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : null}

      {/* Dispute hold */}
      {hasDispute ? (
        <View style={styles.disputeBox}>
          <Icon name="alert-circle-outline" size={15} color={Colors.warning} />
          <Text style={styles.disputeText}>{t('earnings.disputeHold')}</Text>
        </View>
      ) : null}

      {/* Statement */}
      <SectionTitle title={t('earnings.statement')} icon="receipt-outline" />
      <Row gap={Spacing.sm} style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Field
            label={t('earnings.from')}
            value={from}
            onChangeText={(v) => onRangeChange('from', v)}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label={t('earnings.to')}
            value={to}
            onChangeText={(v) => onRangeChange('to', v)}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
          />
        </View>
      </Row>
      <View style={{ marginTop: Spacing.md }}>
        {statementLoading ? (
          <View style={styles.sectionCenter}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : statementError ? (
          <ErrorCard message={statementError} onRetry={() => fetchStatement(from, to)} />
        ) : !statement || statement.entries.length === 0 ? (
          <Empty icon="receipt-outline" title={t('earnings.noEntries')} sub={t('earnings.noEntriesSub')} />
        ) : (
          <Card flat style={{ padding: 0 }}>
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>{t('earnings.openingBalance')}</Text>
              <Text style={styles.balanceValueSm}>{formatTZS(statement.openingBalanceTZS ?? 0)}</Text>
            </View>
            <Divider />
            {/* Virtualized ledger — statement entries are immutable and can run long. */}
            <FlatList
              data={statement.entries}
              keyExtractor={(entry) => entry.id}
              renderItem={({ item }) => <LedgerRow entry={item} />}
              scrollEnabled={false}
              removeClippedSubviews
            />
            <Divider />
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>{t('earnings.closingBalance')}</Text>
              <Text style={styles.balanceValueSm}>{formatTZS(statement.closingBalanceTZS ?? 0)}</Text>
            </View>
          </Card>
        )}
      </View>

      {/* Payouts */}
      <SectionTitle title={t('earnings.payouts')} icon="wallet-outline" />
      {payoutsError ? (
        <ErrorCard message={payoutsError} onRetry={refreshWalletAndPayouts} />
      ) : payouts.length === 0 ? (
        <Empty icon="wallet-outline" title={t('earnings.noPayouts')} sub={t('earnings.noPayoutsSub')} />
      ) : (
        <Card flat style={{ padding: 0 }}>
          {payouts.map((p, i) => (
            <View key={p.id} style={[styles.payoutRow, i > 0 && styles.payoutRowBorder]}>
              <View style={{ flex: 1, paddingRight: Spacing.sm }}>
                <Text style={styles.payoutTitle}>
                  {formatTZS(p.amountTZS)}
                  {p.method ? ` · ${capitalize(p.method)}` : ''}
                </Text>
                <Text style={styles.payoutSub}>{dateISO(p.createdAt)}</Text>
                {p.status === 'paid' && p.paidAt ? (
                  <Text style={styles.payoutSub}>
                    {t('earnings.paidOn')} {dateISO(p.paidAt)}
                  </Text>
                ) : null}
                {p.status === 'exception' ? (
                  <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm, alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.exceptionSub}>{t('earnings.exceptionSub')}</Text>
                    </View>
                    <Btn label={t('onboard.contactSupport')} variant="ghost" size="sm" onPress={() => router.push('/profile/support')} />
                  </Row>
                ) : null}
              </View>
              <Pill label={t(PAYOUT_LABEL[p.status]).toUpperCase()} tone={PAYOUT_TONE[p.status]} />
            </View>
          ))}
        </Card>
      )}

      {/* Withdraw sheet */}
      <SheetModal visible={withdrawVisible} onClose={() => setWithdrawVisible(false)} title={t('earnings.withdraw')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.sheetHint}>
            {t('earnings.balance')}: {formatTZS(available)}
          </Text>
          <Field
            label={t('earnings.withdrawAmount')}
            value={withdrawAmount}
            onChangeText={(v) => setWithdrawAmount(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
          />
          {withdrawError ? <Text style={styles.error}>{withdrawError}</Text> : null}
          <Btn
            label={t('earnings.withdraw')}
            icon="arrow-up"
            onPress={submitWithdraw}
            loading={withdrawing}
            disabled={!withdrawAmount}
            size="lg"
          />
          <Btn
            label={t('misc.cancel')}
            variant="ghost"
            onPress={() => setWithdrawVisible(false)}
            disabled={withdrawing}
          />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.text, marginBottom: Spacing.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  sectionCenter: { alignItems: 'center', paddingVertical: Spacing.xl * 1.5 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  errorBox: {
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  cardLabelOnDark: { fontSize: FontSize.xs, color: Colors.textFaint, fontWeight: '600' },
  cardSubOnDark: {
    fontSize: FontSize.xs,
    color: Colors.white,
    fontWeight: '600',
    marginTop: 2,
    fontVariant: NumberStyle.fontVariant,
  },
  balanceValue: { fontSize: 32, fontWeight: '900', color: Colors.white, fontVariant: NumberStyle.fontVariant, marginTop: 2 },
  disputeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  disputeText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, fontWeight: '700' },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  balanceLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  balanceValueSm: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  payoutRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, padding: Spacing.lg },
  payoutRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  payoutTitle: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  payoutSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  exceptionSub: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600', marginTop: 4, lineHeight: 16 },
  sheetHint: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' },
});
