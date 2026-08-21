import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getRedPacketRepository, getWalletRepository } from '@/repos';
import type { RedPacket, WalletPayoutDestination } from '@/repos';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import { track } from '@/lib/analytics';
import type { TopUpMyWalletBodyMethod, Wallet, WalletTransaction } from '@hudumika/contract';
import { ReportTransactionIssueBodyIssueType, TopUpMyWalletBodyMethod as TopUpMethods } from '@hudumika/contract';

const TOP_UP_PRESETS = [10000, 20000, 30000, 50000];
const WITHDRAW_PRESETS = [10000, 20000, 30000, 50000];
/** Percentage-of-balance quick picks (25/50/100% of the withdrawable). */
const WITHDRAW_PERCENTS = [0.25, 0.5, 1] as const;
const TOP_UP_METHODS = Object.values(TopUpMethods);
const ISSUE_TYPES = Object.values(ReportTransactionIssueBodyIssueType);
/** Mobile-money payout methods take a Tanzanian phone destination; the
 * contract's bank/card take an account reference (TopUpMyWalletBodyMethod). */
const MOBILE_MONEY_METHODS = new Set<string>(['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel']);

/** Data-driven label: 'tigo_pesa' → 'Tigo Pesa' (contract enum values only). */
function prettyLabel(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function WalletScreen() {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[] | null>(null);
  const [redPackets, setRedPackets] = useState<RedPacket[]>([]);
  const [error, setError] = useState('');

  // Top-up sheet
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [amountTZS, setAmountTZS] = useState<number | null>(null);
  const [method, setMethod] = useState<TopUpMyWalletBodyMethod>('mpesa');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Withdraw sheet
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmountTZS, setWithdrawAmountTZS] = useState<number | null>(null);
  const [withdrawDestination, setWithdrawDestination] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');
  const [payout, setPayout] = useState<WalletPayoutDestination | null>(null);

  // Report-issue sheet
  const [reportTx, setReportTx] = useState<WalletTransaction | null>(null);
  const [issueType, setIssueType] = useState<(typeof ReportTransactionIssueBodyIssueType)[keyof typeof ReportTransactionIssueBodyIssueType]>('amount_mismatch');
  const [issueDescription, setIssueDescription] = useState('');
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [w, tx] = await Promise.all([
        getWalletRepository().getWallet(),
        getWalletRepository().getTransactions(),
      ]);
      setWallet(w);
      setTransactions(tx);
    } catch {
      setError(t('common.error'));
    }
    // Red packets (P6c) are a secondary surface: a failure to load them must
    // never break the wallet (a live backend that has not adopted the
    // mock-only-until-adopted paths errors here — the card degrades to the
    // empty/zero state).
    try {
      setRedPackets(await getRedPacketRepository().listReceived());
    } catch {
      setRedPackets([]);
    }
    // The payout destination is mock-only until the contract ships the
    // endpoint (the live repo returns null) — the withdraw sheet degrades to
    // omitting the destination note.
    try {
      setPayout(await getWalletRepository().getPayoutDestination());
    } catch {
      setPayout(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const confirmTopUp = async () => {
    if (!amountTZS || amountTZS < 1) {
      setFormError(t('wallet.topup.amountError'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      track({ name: 'payment_started', method });
      const user = useSessionStore.getState().user;
      const key = idempotencyKey(user?.id ?? 'customer', 'wallet-topup');
      await getWalletRepository().topUp({ amountTZS, method }, key);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('wallet.topup.success', { amount: formatTZS(amountTZS) }));
      setTopUpOpen(false);
      setAmountTZS(null);
      setMethod('mpesa');
      load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmWithdraw = async () => {
    if (!withdrawAmountTZS || withdrawAmountTZS < 1) {
      setWithdrawError(t('wallet.topup.amountError'));
      return;
    }
    const destination = withdrawDestination.trim();
    if (!destination) {
      setWithdrawError(t('wallet.destinationInvalid'));
      return;
    }
    setWithdrawing(true);
    setWithdrawError('');
    try {
      const user = useSessionStore.getState().user;
      const key = idempotencyKey(user?.id ?? 'customer', 'wallet-withdraw');
      // destination/method are mock-only extensions until the contract ships
      // them on RequestWithdrawalBody (the generated body carries amountTZS
      // only) — the method defaults to the linked payout method.
      await getWalletRepository().withdraw(
        { amountTZS: withdrawAmountTZS, destination, method: payout?.method ?? 'mpesa' },
        key,
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('wallet.withdrawn', { amount: formatTZS(withdrawAmountTZS) }));
      setWithdrawOpen(false);
      setWithdrawAmountTZS(null);
      setWithdrawDestination('');
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'WALLET_INSUFFICIENT_BALANCE') {
        setWithdrawError(t('wallet.insufficient'));
      } else {
        setWithdrawError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setWithdrawing(false);
    }
  };

  const submitReport = async () => {
    if (!reportTx) return;
    const description = issueDescription.trim();
    if (!description || description.length > 500) {
      setReportError(t('wallet.report.descriptionError'));
      return;
    }
    setReporting(true);
    setReportError('');
    try {
      const user = useSessionStore.getState().user;
      const key = idempotencyKey(user?.id ?? 'customer', 'tx-issue');
      await getWalletRepository().reportIssue(reportTx.id, { issueType, description }, key);
      toast(t('wallet.report.submitted'));
      setReportTx(null);
      setIssueType('amount_mismatch');
      setIssueDescription('');
    } catch (e) {
      setReportError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setReporting(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!wallet || !transactions) {
    return (
      <Screen>
        <SkeletonCard rows={2} />
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  const refunded = transactions.filter((tx) => tx.type === 'refund');
  const txLabel = (tx: WalletTransaction): string =>
    tx.type === 'adjustment' && tx.referenceType === 'topup'
      ? t('wallet.topup.title')
      : tx.type === 'adjustment' && tx.referenceType === 'red_packet'
        ? t('redPackets.title')
        : tx.type;

  const now = Date.now();
  const claimableRedPackets = redPackets.filter((p) => !p.claimed && new Date(p.expiresAt).getTime() > now).length;

  return (
    <Screen>
      <FlatList
        data={transactions}
        keyExtractor={(tx) => tx.id}
        onRefresh={load}
        refreshing={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
        ListHeaderComponent={
          <View>
            <Text style={styles.title}>{t('wallet.title')}</Text>
            <Card style={[styles.balanceCard, { backgroundColor: Colors.primaryDeep }]}>
              <Text style={{ color: Colors.gold, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold }}>{t('wallet.balance')}</Text>
              <Text style={{ color: Colors.white, fontSize: 30, fontFamily: Fonts.displayBold, marginTop: 4, fontVariant: NumberStyle.fontVariant }}>
                {formatTZS(wallet.totalTZS ?? 0)}
              </Text>
              <Row gap={Spacing.md} style={{ marginTop: Spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sans, opacity: 0.75 }}>{t('wallet.withdrawAvailable')}</Text>
                  <Text style={{ color: Colors.white, fontSize: FontSize.md, fontFamily: Fonts.sansBold, marginTop: 2, fontVariant: NumberStyle.fontVariant }}>{formatTZS(wallet.withdrawableTZS ?? 0)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sans, opacity: 0.75 }}>{t('status.pending')}</Text>
                  <Text style={{ color: Colors.white, fontSize: FontSize.md, fontFamily: Fonts.sansBold, marginTop: 2, fontVariant: NumberStyle.fontVariant }}>{formatTZS(wallet.pendingTZS ?? 0)}</Text>
                </View>
              </Row>
              <Row style={{ justifyContent: 'flex-end', marginTop: Spacing.md }} gap={Spacing.sm}>
                <Btn label={t('wallet.withdraw')} onPress={() => setWithdrawOpen(true)} size="sm" variant="ghost" icon="arrow-down-outline" />
                <Btn label={t('wallet.topup')} onPress={() => setTopUpOpen(true)} size="sm" variant="success" icon="add" />
              </Row>
            </Card>

            {refunded.length > 0 ? (
              <Card style={[styles.refundCard, { backgroundColor: Colors.successSoft, marginTop: Spacing.md }]}>
                <Row gap={Spacing.sm}>
                  <Icon name="return-down-back" size={16} color={Colors.success} />
                  <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, flex: 1 }}>
                    {refunded.map((r) => t('wallet.refunded', { amount: formatTZS(Math.abs(r.amountTZS)) })).join(' · ')}
                  </Text>
                </Row>
              </Card>
            ) : null}

            <Card
              style={[styles.redPacket, { marginTop: Spacing.md }]}
              onPress={() => router.push('/red-packets')}
              accessibilityLabel={t('redPackets.title')}>
              <Row gap={Spacing.md}>
                <View style={styles.rpIcon}>
                  <Icon name="gift" size={18} color={Colors.gold} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text }}>{t('redPackets.title')}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 }}>
                    {claimableRedPackets > 0
                      ? t('redPackets.claimable', { n: claimableRedPackets })
                      : t('redPackets.noneClaimable')}
                  </Text>
                </View>
                <Text style={{ fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansBold }}>{t('redPackets.open')}</Text>
                <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
              </Row>
            </Card>

            <Card
              style={[styles.withdrawalsCard, { marginTop: Spacing.md }]}
              onPress={() => router.push('/withdrawals')}
              accessibilityLabel={t('wallet.withdrawals')}>
              <Row gap={Spacing.md}>
                <View style={styles.wdIcon}>
                  <Icon name="cash-outline" size={18} color={Colors.success} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text }}>{t('wallet.withdrawals')}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 }}>
                    {t('wallet.withdrawDestination')} {payout ? `${prettyLabel(payout.method)} · ${payout.maskedAccount}` : '—'}
                  </Text>
                </View>
                <Text style={{ fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansBold }}>{t('common.view')}</Text>
                <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
              </Row>
            </Card>

            <Card
              style={[styles.invoicesCard, { marginTop: Spacing.md }]}
              onPress={() => router.push('/invoices')}
              accessibilityLabel={t('invoices.entry')}>
              <Row gap={Spacing.md}>
                <View style={styles.invIcon}>
                  <Icon name="receipt-outline" size={18} color={Colors.info} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text }}>{t('invoices.entry')}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 }}>
                    {t('invoices.noInvoicesSub')}
                  </Text>
                </View>
                <Text style={{ fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansBold }}>{t('common.view')}</Text>
                <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
              </Row>
            </Card>

            <Text style={styles.section}>{t('wallet.transactions')}</Text>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="wallet-outline" title={t('wallet.empty')} />}
        renderItem={({ item }) => (
          <Row style={[styles.txRow, { justifyContent: 'space-between' }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.txType}>{txLabel(item)}</Text>
              <Text style={styles.txMeta}>{dateISO(item.createdAt)}</Text>
            </View>
            <Pressable
              onPress={() => {
                setIssueType('amount_mismatch');
                setIssueDescription('');
                setReportError('');
                setReportTx(item);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('wallet.report')}
              style={({ pressed }) => [styles.reportBtn, pressed && { opacity: 0.6 }]}>
              <Icon name="flag-outline" size={16} color={Colors.textTertiary} />
            </Pressable>
            <Text style={[styles.txAmount, item.amountTZS < 0 ? { color: Colors.danger } : { color: Colors.success }, { fontVariant: NumberStyle.fontVariant, textAlign: 'right', minWidth: 110 }]}>
              {item.amountTZS < 0 ? '−' : '+'}{formatTZS(Math.abs(item.amountTZS))}
            </Text>
          </Row>
        )}
      />

      <SheetModal visible={topUpOpen} onClose={() => setTopUpOpen(false)} title={t('wallet.topup.title')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.sheetLabel}>{t('wallet.topup.amount')}</Text>
          <View style={styles.chipWrap}>
            {TOP_UP_PRESETS.map((a) => (
              <Pressable
                key={a}
                onPress={() => setAmountTZS(a)}
                accessibilityRole="button"
                accessibilityState={{ selected: amountTZS === a }}
                style={[styles.choiceChip, amountTZS === a && styles.choiceSelected]}>
                <Text style={[styles.choiceText, amountTZS === a && styles.choiceSelectedText]}>{formatTZS(a)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.sheetLabel}>{t('wallet.topup.method')}</Text>
          <View style={styles.chipWrap}>
            {TOP_UP_METHODS.map((m) => (
              <Pressable
                key={m}
                onPress={() => setMethod(m)}
                accessibilityRole="button"
                accessibilityState={{ selected: method === m }}
                style={[styles.choiceChip, method === m && styles.choiceSelected]}>
                <Text style={[styles.choiceText, method === m && styles.choiceSelectedText]}>{prettyLabel(m)}</Text>
              </Pressable>
            ))}
          </View>
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <Btn label={t('wallet.topup.confirm')} onPress={confirmTopUp} loading={submitting} size="lg" />
        </View>
      </SheetModal>

      <SheetModal visible={withdrawOpen} onClose={() => setWithdrawOpen(false)} title={t('wallet.withdrawTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.sheetLabel}>{t('wallet.withdrawAvailable')}</Text>
          <Text style={{ fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text }}>
            {formatTZS(wallet.withdrawableTZS ?? 0)}
          </Text>
          <Text style={styles.sheetLabel}>{t('wallet.withdrawAmount')}</Text>
          <View style={styles.chipWrap}>
            {WITHDRAW_PRESETS.map((a) => (
              <Pressable
                key={a}
                onPress={() => setWithdrawAmountTZS(a)}
                accessibilityRole="button"
                accessibilityState={{ selected: withdrawAmountTZS === a }}
                style={[styles.choiceChip, withdrawAmountTZS === a && styles.choiceSelected]}>
                <Text style={[styles.choiceText, withdrawAmountTZS === a && styles.choiceSelectedText]}>{formatTZS(a)}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.chipWrap}>
            {WITHDRAW_PERCENTS.map((p) => {
              const value = Math.floor((wallet.withdrawableTZS ?? 0) * p);
              if (value < 1) return null;
              return (
                <Pressable
                  key={p}
                  onPress={() => setWithdrawAmountTZS(value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: withdrawAmountTZS === value }}
                  style={[styles.choiceChip, withdrawAmountTZS === value && styles.choiceSelected]}>
                  <Text style={[styles.choiceText, withdrawAmountTZS === value && styles.choiceSelectedText]}>{`${Math.round(p * 100)}%`}</Text>
                </Pressable>
              );
            })}
          </View>
          <Field
            label={t('wallet.withdrawDestination')}
            value={withdrawDestination}
            onChangeText={setWithdrawDestination}
            placeholder={MOBILE_MONEY_METHODS.has(payout?.method ?? 'mpesa') ? t('wallet.destinationPhone') : t('wallet.destinationAccount')}
            hint={MOBILE_MONEY_METHODS.has(payout?.method ?? 'mpesa') ? '+2557XXXXXXXX' : undefined}
            keyboardType={MOBILE_MONEY_METHODS.has(payout?.method ?? 'mpesa') ? 'phone-pad' : 'numeric'}
            maxLength={MOBILE_MONEY_METHODS.has(payout?.method ?? 'mpesa') ? 13 : 32}
          />
          {payout ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans }}>
              {t('wallet.withdrawDestination')} {prettyLabel(payout.method)} · {payout.maskedAccount}
            </Text>
          ) : null}
          {withdrawError ? <Text style={styles.error}>{withdrawError}</Text> : null}
          <Btn label={t('wallet.withdrawConfirm')} onPress={confirmWithdraw} loading={withdrawing} size="lg" />
        </View>
      </SheetModal>

      <SheetModal visible={!!reportTx} onClose={() => setReportTx(null)} title={t('wallet.report.title')}>
        {reportTx ? (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.sheetLabel}>{t('wallet.report.type')}</Text>
            <View style={styles.chipWrap}>
              {ISSUE_TYPES.map((it) => (
                <Pressable
                  key={it}
                  onPress={() => setIssueType(it)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: issueType === it }}
                  style={[styles.choiceChip, issueType === it && styles.choiceSelected]}>
                  <Text style={[styles.choiceText, issueType === it && styles.choiceSelectedText]}>{prettyLabel(it)}</Text>
                </Pressable>
              ))}
            </View>
            <Field
              label={t('wallet.report.description')}
              value={issueDescription}
              onChangeText={setIssueDescription}
              multiline
              maxLength={500}
            />
            {reportError ? <Text style={styles.error}>{reportError}</Text> : null}
            <Btn label={t('wallet.report.submit')} onPress={submitReport} loading={reporting} size="lg" />
          </View>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  balanceCard: { padding: Spacing.xl, borderRadius: Radius.lg },
  refundCard: { padding: Spacing.md },
  redPacket: { padding: Spacing.md },
  withdrawalsCard: { padding: Spacing.md },
  invoicesCard: { padding: Spacing.md },
  rpIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: Colors.goldSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  invIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wdIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: Colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  txRow: { paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  txType: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
  txMeta: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, marginTop: 2 },
  txAmount: { fontSize: FontSize.sm, fontFamily: Fonts.displayBold, fontVariant: NumberStyle.fontVariant },
  reportBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.sm,
  },
  sheetLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  choiceChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  choiceSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  choiceText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  choiceSelectedText: { color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
});
