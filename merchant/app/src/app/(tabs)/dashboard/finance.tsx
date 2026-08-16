import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { LineChart } from '@/components/charts';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { Btn, Card, Chip, Empty, Icon, IconName, Pill, Row, Screen, SectionTitle, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { api } from '@/api/client';
import type { ExpenseCategory, PaymentAccount, PaymentHistoryItem, PaymentHistoryStatus, PaymentQr, PaymentQrProvider, RevenueComposition, WithdrawalStatus } from '@/api/types';
import { weeklyTrend } from '@/lib/analytics';
import { fullTime, mmss, tzs } from '@/lib/format';
import { useFinanceStore } from '@/store/finance';
import { useMessageStore } from '@/store/messages';
import { useOrderStore } from '@/store/orders';
import { hasPerm, useSessionStore } from '@/store/session';
import type { TransactionType } from '@/types';

type Filter = 'all' | 'income' | 'expense';

const TX_ICONS: Record<TransactionType, IconName> = {
  order: 'add-circle-outline',
  commission: 'receipt-outline',
  withdraw: 'arrow-up-circle-outline',
  refund: 'return-down-back-outline',
};

const WD_TONE: Record<WithdrawalStatus, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = {
  pending: 'warning',
  processing: 'info',
  paid: 'success',
  failed: 'danger',
  exception: 'danger',
};

const WD_LABEL: Record<WithdrawalStatus, I18nKey> = {
  pending: 'fin.wdPending',
  processing: 'fin.wdProcessing',
  paid: 'fin.wdPaid',
  failed: 'fin.wdFailed',
  exception: 'fin.wdException',
};

/* P5: expense categories (contract /finance/expenses enum) in sheet order. */
const EXPENSE_CATEGORY_KEYS: readonly ExpenseCategory[] = [
  'ingredients', 'delivery', 'packaging', 'platform_fees',
  'rent', 'utilities', 'staff', 'marketing', 'equipment', 'other',
];

const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, I18nKey> = {
  ingredients: 'fin.catIngredients',
  delivery: 'fin.catDelivery',
  packaging: 'fin.catPackaging',
  platform_fees: 'fin.catPlatformFees',
  rent: 'fin.catRent',
  utilities: 'fin.catUtilities',
  staff: 'fin.catStaff',
  marketing: 'fin.catMarketing',
  equipment: 'fin.catEquipment',
  other: 'fin.catOther',
};

/* Earnings pass (gap-09): collection QR providers (contract /payments/qr). */
const QR_PROVIDERS: readonly PaymentQrProvider[] = ['mpesa', 'tigo_pesa', 'airtel_money'];
const QR_PROVIDER_LABEL: Record<PaymentQrProvider, I18nKey> = {
  mpesa: 'common.mpesa',
  tigo_pesa: 'common.tigoPesa',
  airtel_money: 'common.airtel',
};

/* Earnings pass (gap-09): payment history status pills (contract /payments/history). */
const PAY_STATUS_LABEL: Record<PaymentHistoryStatus, I18nKey> = {
  created: 'fin.payStatusCreated',
  pending: 'fin.wdPending',
  paid: 'fin.paid',
  failed: 'fin.wdFailed',
  refunded: 'fin.payStatusRefunded',
  reversed: 'fin.payStatusReversed',
};

const PAY_STATUS_TONE: Record<PaymentHistoryStatus, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = {
  created: 'neutral',
  pending: 'warning',
  paid: 'success',
  failed: 'danger',
  refunded: 'info',
  reversed: 'neutral',
};

const PAY_METHOD_LABEL: Record<string, I18nKey> = {
  mpesa: 'common.mpesa',
  tigo_pesa: 'common.tigoPesa',
  airtel_money: 'common.airtel',
  ezy_pesa: 'fin.methodEzyPesa',
  halotel: 'fin.methodHalotel',
  card: 'common.bankCard',
  cod: 'common.cod',
  bank: 'common.bankCard',
};

export default function FinanceScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const balance = useFinanceStore((s) => s.balance);
  const pendingSettlement = useFinanceStore((s) => s.pendingSettlement);
  const transactions = useFinanceStore((s) => s.transactions);
  const settlements = useFinanceStore((s) => s.settlements);
  const invoices = useFinanceStore((s) => s.invoices);
  const wallet = useFinanceStore((s) => s.wallet);
  const withdrawals = useFinanceStore((s) => s.withdrawals);
  const payouts = useFinanceStore((s) => s.payouts);
  const bankCards = useFinanceStore((s) => s.bankCards);
  const expenses = useFinanceStore((s) => s.expenses);
  const financeInvoices = useFinanceStore((s) => s.financeInvoices);
  const payments = useFinanceStore((s) => s.payments);
  const reconciliation = useFinanceStore((s) => s.reconciliation);
  const disputeHolds = useFinanceStore((s) => s.disputeHolds);
  const loading = useFinanceStore((s) => s.loading);
  const error = useFinanceStore((s) => s.error);
  const requestWithdrawal = useFinanceStore((s) => s.requestWithdrawal);
  const runSettlement = useFinanceStore((s) => s.runSettlement);
  const payout = useFinanceStore((s) => s.payout);
  const issueInvoice = useFinanceStore((s) => s.issueInvoice);
  const hydratePayouts = useFinanceStore((s) => s.hydratePayouts);
  const hydrateBankCards = useFinanceStore((s) => s.hydrateBankCards);
  const hydrateExpenses = useFinanceStore((s) => s.hydrateExpenses);
  const hydrateInvoices = useFinanceStore((s) => s.hydrateInvoices);
  const hydratePayments = useFinanceStore((s) => s.hydratePayments);
  const hydrateReconciliation = useFinanceStore((s) => s.hydrateReconciliation);
  const hydrateDisputeHolds = useFinanceStore((s) => s.hydrateDisputeHolds);
  const retry = useFinanceStore((s) => s.retry);
  const addBankCard = useFinanceStore((s) => s.addBankCard);
  const setDefaultBankCard = useFinanceStore((s) => s.setDefaultBankCard);
  const removeBankCard = useFinanceStore((s) => s.removeBankCard);
  const addExpense = useFinanceStore((s) => s.addExpense);
  const removeExpense = useFinanceStore((s) => s.removeExpense);
  const createInvoice = useFinanceStore((s) => s.createInvoice);
  const downloadInvoice = useFinanceStore((s) => s.downloadInvoice);
  const reversePayment = useFinanceStore((s) => s.reversePayment);
  const pushMessage = useMessageStore((s) => s.push);
  const orders = useOrderStore((s) => s.orders);
  /* Earnings pass (gap-09): run/payout/reversal CTAs are finance-role only —
   * the server 403s anyway; the UI gates the CTAs and surfaces no-permission. */
  const perms = useSessionStore((s) => s.perms);
  const canFinance = hasPerm(perms, 'finance:view');
  const [filter, setFilter] = useState<Filter>('all');
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [amount, setAmount] = useState('');
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [account, setAccount] = useState<PaymentAccount | null>(null);
  const [withdrawMsg, setWithdrawMsg] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [settling, setSettling] = useState(false);
  const [composition, setComposition] = useState<RevenueComposition | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [cardBank, setCardBank] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardMsg, setCardMsg] = useState('');
  const [addingCard, setAddingCard] = useState(false);
  const [showExpense, setShowExpense] = useState(false);
  const [expCategory, setExpCategory] = useState<ExpenseCategory | null>(null);
  const [expAmount, setExpAmount] = useState('');
  const [expNote, setExpNote] = useState('');
  const [expMsg, setExpMsg] = useState('');
  const [addingExpense, setAddingExpense] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [invAmount, setInvAmount] = useState('');
  const [invMsg, setInvMsg] = useState('');
  const [addingInvoice, setAddingInvoice] = useState(false);

  /* Earnings pass (gap-09): collection QR state machine (provider picker →
   * generating → QR card → expired banner with regenerate → error + retry). */
  const [qrProvider, setQrProvider] = useState<PaymentQrProvider>('mpesa');
  const [qrMode, setQrMode] = useState<'fixed' | 'variable'>('fixed');
  const [qrAmount, setQrAmount] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrMsg, setQrMsg] = useState('');
  const [qr, setQr] = useState<PaymentQr | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copiedQr, setCopiedQr] = useState(false);
  /* Payments history: methods chips + reversal sheet (finance-role only). */
  const [methods, setMethods] = useState<{ method: string; available: boolean }[]>([]);
  const [revTarget, setRevTarget] = useState<PaymentHistoryItem | null>(null);
  const [revReason, setRevReason] = useState('');
  const [revMsg, setRevMsg] = useState('');
  const [revBusy, setRevBusy] = useState(false);

  useEffect(() => {
    void hydratePayouts();
    void hydrateBankCards();
    void hydrateExpenses();
    void hydrateInvoices();
    void hydratePayments();
    void hydrateReconciliation();
    void hydrateDisputeHolds();
  }, [hydratePayouts, hydrateBankCards, hydrateExpenses, hydrateInvoices, hydratePayments, hydrateReconciliation, hydrateDisputeHolds]);

  useEffect(() => {
    const load = () => {
      api
        .get<RevenueComposition>('/finance/revenue-composition?days=7', { retries: 1 })
        .then(setComposition)
        .catch(() => setComposition(null));
    };
    load();
    const unsub = useFinanceStore.subscribe((s, prev) => {
      if (s.loaded && !prev.loaded) load();
    });
    return unsub;
  }, []);

  useEffect(() => {
    api
      .get<{ method: string; available: boolean }[]>('/payments/methods', { retries: 1 })
      .then(setMethods)
      .catch(() => setMethods([]));
  }, []);

  /* Live clock: drives the collection-QR expiry countdown and the payout-cycle
   * date without impure Date.now() calls during render. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!showWithdraw) return;
    api
      .get<{ accounts: PaymentAccount[] }>('/payment-accounts?storeId=s_demo', { retries: 1 })
      .then((r) => {
        const active = r.accounts.filter((a) => a.status === 'active');
        setAccounts(active);
        setAccount(active[0] ?? null);
      })
      .catch(() => setAccounts([]));
  }, [showWithdraw]);

  const filtered = transactions.filter((tx) =>
    filter === 'income' ? tx.amount > 0 : filter === 'expense' ? tx.amount < 0 : true,
  );

  /* Earnings pass (gap-09): the net-7 chart no longer recomputes money
   * client-side — it renders the server revenue series directly; the
   * commission rate is rendered from the API value (wallet.commissionRateBps). */
  const revWeekly = weeklyTrend(orders).map((d) => ({ label: d.label, value: Math.round(d.revenue) }));
  const commissionBps = wallet?.commissionRateBps ?? null;
  const cycleDays = wallet?.payoutCycleDays ?? 3;
  const nextPayout = now + cycleDays * 86400000;

  const withdrawable = wallet?.withdrawableTZS ?? Math.round(balance);
  const amountTZS = Number(amount);
  const amountInvalid = !Number.isInteger(amountTZS) || amountTZS < 1 || amountTZS > withdrawable;

  const openWithdraw = () => {
    setAmount('');
    setWithdrawMsg('');
    setShowWithdraw(true);
  };

  const doWithdraw = async () => {
    if (amountInvalid) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setWithdrawing(true);
    setWithdrawMsg('');
    const res = await requestWithdrawal(amountTZS);
    setWithdrawing(false);
    if (res.ok) {
      setShowWithdraw(false);
      setAmount('');
      pushMessage({ type: 'system', title: t('fin.submitted'), body: t('fin.wdSubmittedSub', { a: tzs(amountTZS) }) });
    } else {
      setWithdrawMsg(res.message ?? t('fin.errWithdraw'));
    }
  };

  /* ---- Earnings pass (gap-09): collection QR ---- */
  const qrAmountTZS = Number(qrAmount);
  const qrFixedValid = qrMode === 'variable' || (Number.isInteger(qrAmountTZS) && qrAmountTZS >= 1);
  const qrExpired = qr ? now >= qr.expiresAt : false;
  const qrRemaining = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0;

  const doGenerateQr = async () => {
    if (!qrFixedValid || qrBusy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setQrBusy(true);
    setQrMsg('');
    setCopiedQr(false);
    try {
      const created = await api.post<PaymentQr>('/payments/qr', {
        provider: qrProvider,
        amountTZS: qrMode === 'fixed' ? qrAmountTZS : null,
      });
      setQr(created);
      setNow(Date.now());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setQrMsg((e as { message?: string }).message ?? t('fin.qrError'));
    } finally {
      setQrBusy(false);
    }
  };

  const copyQr = async () => {
    if (!qr) return;
    await Clipboard.setStringAsync(qr.qrPayload);
    setCopiedQr(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  /* ---- Earnings pass (gap-09): payment reversal (finance role, confirm + reason) ---- */
  const openReverse = (p: PaymentHistoryItem) => {
    setRevTarget(p);
    setRevReason('');
    setRevMsg('');
  };

  const doReverse = async () => {
    if (!revTarget) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRevBusy(true);
    setRevMsg('');
    const res = await reversePayment(revTarget.id, revReason.trim());
    setRevBusy(false);
    if (res.ok) {
      setRevTarget(null);
      pushMessage({ type: 'system', title: t('fin.payReversed'), body: t('fin.payReversedSub', { a: tzs(revTarget.amountTZS) }) });
    } else {
      setRevMsg(res.message ?? t('fin.payErrReverse'));
    }
  };

  /* ---- P5: bank cards ---- */
  const cardBankName = cardBank.trim();
  const cardValid = cardBankName.length > 0 && /^\d{4}$/.test(cardLast4.trim());
  const cardTouched = cardBankName.length > 0 || cardLast4.length > 0;

  const openCardSheet = () => {
    setCardBank('');
    setCardLast4('');
    setCardHolder('');
    setCardMsg('');
    setShowCard(true);
  };

  const doAddCard = async () => {
    if (!cardValid) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAddingCard(true);
    setCardMsg('');
    const res = await addBankCard({
      bankName: cardBankName,
      last4: cardLast4.trim(),
      accountHolderName: cardHolder.trim() || undefined,
    });
    setAddingCard(false);
    if (res.ok) {
      setShowCard(false);
      pushMessage({ type: 'system', title: t('fin.bcAdded'), body: t('fin.bcAddedSub', { bank: cardBankName, last4: cardLast4.trim() }) });
    } else {
      setCardMsg(res.message ?? t('fin.errBankCard'));
    }
  };

  const doSetDefault = async (id: string, last4: string) => {
    if (await setDefaultBankCard(id)) {
      pushMessage({ type: 'system', title: t('fin.bcDefaultSet'), body: t('fin.bcDefaultSetSub', { last4 }) });
    }
  };

  const doRemoveCard = async (id: string, last4: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (await removeBankCard(id)) {
      pushMessage({ type: 'system', title: t('fin.bcRemoved'), body: t('fin.bcRemovedSub', { last4 }) });
    }
  };

  /* ---- P5: expenses ---- */
  const expAmountTZS = Number(expAmount);
  const expValid = expCategory !== null && Number.isInteger(expAmountTZS) && expAmountTZS >= 1;

  const openExpenseSheet = () => {
    setExpCategory(null);
    setExpAmount('');
    setExpNote('');
    setExpMsg('');
    setShowExpense(true);
  };

  const doAddExpense = async () => {
    if (!expValid || !expCategory) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAddingExpense(true);
    setExpMsg('');
    const res = await addExpense({ category: expCategory, amountTZS: expAmountTZS, note: expNote.trim() || undefined });
    setAddingExpense(false);
    if (res.ok) {
      setShowExpense(false);
      pushMessage({
        type: 'system',
        title: t('fin.expAdded'),
        body: t('fin.expAddedSub', { category: t(EXPENSE_CATEGORY_LABEL[expCategory]), a: tzs(expAmountTZS) }),
      });
    } else {
      setExpMsg(res.message ?? t('fin.errExpense'));
    }
  };

  const doRemoveExpense = async (id: string, amountTZS: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (await removeExpense(id)) {
      pushMessage({ type: 'system', title: t('fin.expRemoved'), body: t('fin.expRemovedSub', { a: tzs(amountTZS) }) });
    }
  };

  /* ---- P5: invoices (request + download) ---- */
  const invAmountTZS = Number(invAmount);
  const invValid = Number.isInteger(invAmountTZS) && invAmountTZS >= 1;

  const doCreateInvoice = async () => {
    if (!invValid) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAddingInvoice(true);
    setInvMsg('');
    const res = await createInvoice({ amountTZS: invAmountTZS });
    setAddingInvoice(false);
    if (res.ok) {
      setShowInvoice(false);
      pushMessage({ type: 'system', title: t('fin.invRequested'), body: t('fin.invRequestedSub', { a: tzs(invAmountTZS) }) });
    } else {
      setInvMsg(res.message ?? t('fin.errInvoice'));
    }
  };

  const doDownload = async (id: string) => {
    const res = await downloadInvoice(id);
    if (!res.ok || !res.download) {
      pushMessage({ type: 'system', title: t('fin.errDownload'), body: res.message ?? '' });
      return;
    }
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = res.download.downloadUrl;
      a.target = '_blank';
      a.click();
    } else {
      Linking.openURL(res.download.downloadUrl).catch(() => undefined);
    }
    pushMessage({ type: 'system', title: t('fin.invDownloaded'), body: t('fin.invDownloadedSub') });
  };

  const holdsTotal = disputeHolds.reduce((s, h) => s + h.amountTZS, 0);

  return (
    <Screen scroll>
      {error ? (
        <Card style={[styles.errorBanner, { marginBottom: Spacing.md }]}>
          <Row style={{ justifyContent: 'space-between', gap: Spacing.md }}>
            <Text style={{ color: Colors.danger, fontSize: FontSize.xs, flex: 1, lineHeight: 17 }}>
              {t('fin.errFinance')}
            </Text>
            <Btn label={t('common.refresh')} size="sm" variant="outline" onPress={() => void retry()} loading={loading} />
          </Row>
        </Card>
      ) : null}
      {loading && !error ? (
        <Card style={{ padding: Spacing.lg, marginBottom: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.loading')}</Text>
        </Card>
      ) : null}

      <Card style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>{t('fin.balance')}</Text>
        <Text style={styles.balance}>{tzs(balance)}</Text>
        <Row style={{ marginTop: Spacing.lg, gap: Spacing.md }}>
          <Btn label={t('fin.withdraw')} variant="primary" onPress={openWithdraw} style={{ flex: 1 }} />
          <Btn
            label={t('fin.download')}
            variant="ghost"
            onPress={() => pushMessage({ type: 'system', title: t('fin.exported'), body: t('fin.exportedSub') })}
            style={{ flex: 1 }}
          />
        </Row>
      </Card>

      <Card style={{ marginTop: Spacing.md, flexDirection: 'row' }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.settleLabel}>{t('fin.pending')}</Text>
          <Text style={styles.settleValue}>{tzs(pendingSettlement)}</Text>
        </View>
        <View style={styles.vDivider} />
        <View style={{ flex: 1 }}>
          <Text style={styles.settleLabel}>{t('fin.withdrawable')}</Text>
          <Text style={styles.settleValue}>{tzs(withdrawable)}</Text>
        </View>
        <View style={styles.vDivider} />
        <View style={{ flex: 1 }}>
          <Text style={styles.settleLabel}>{t('fin.commission')}</Text>
          <Text style={styles.settleValue}>{commissionBps !== null ? `${(commissionBps / 100).toFixed(2)}%` : '—'}</Text>
        </View>
      </Card>

      {/* Earnings pass (gap-09): payout cadence from the API value — never hardcoded. */}
      <Card style={{ marginTop: Spacing.md, paddingVertical: Spacing.sm }}>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
          {t('fin.cycleNext', { when: fullTime(nextPayout), n: cycleDays })}
        </Text>
      </Card>

      <Card style={{ marginTop: Spacing.md }}>
        <Text style={styles.chartTitle}>{t('fin.rev7')}</Text>
        <LineChart data={revWeekly} height={130} color={Colors.success} valueSuffix="TZS " />
      </Card>

      {/* Earnings pass (gap-09): dispute holds card (EARNINGS.md held amount). */}
      <SectionTitle title={t('fin.holdsTitle')} icon="shield-checkmark-outline" />
      <Card style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
        {disputeHolds.length === 0 ? (
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.holdsEmpty')}</Text>
        ) : (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.danger }}>{t('fin.holdsSub')}</Text>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.danger }}>{tzs(holdsTotal)}</Text>
            </Row>
            {disputeHolds.map((h) => (
              <Row key={h.id} style={{ justifyContent: 'space-between', gap: Spacing.sm }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1 }} numberOfLines={1}>
                  {t('fin.holdsReason', { order: h.orderId, reason: h.reason ?? '' })}
                </Text>
                <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: Colors.text }}>{tzs(h.amountTZS)}</Text>
              </Row>
            ))}
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
              {t('fin.holdsTotal', { a: tzs(holdsTotal), n: disputeHolds.length })}
            </Text>
          </>
        )}
      </Card>

      {/* Earnings pass (gap-09): collection QR (contract POST /payments/qr). */}
      <SectionTitle title={t('fin.qrTitle')} icon="qr-code-outline" />
      <Card style={{ gap: Spacing.md }}>
        <View style={{ gap: Spacing.xs }}>
          <Text style={styles.fieldLabel}>{t('fin.qrProvider')}</Text>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {QR_PROVIDERS.map((p) => (
              <Chip
                key={p}
                label={t(QR_PROVIDER_LABEL[p])}
                selected={qrProvider === p}
                onPress={() => {
                  setQrProvider(p);
                  setQrMsg('');
                }}
                tone="info"
              />
            ))}
          </Row>
        </View>
        <Row gap={8}>
          <Chip label={t('fin.qrFixed')} selected={qrMode === 'fixed'} onPress={() => { setQrMode('fixed'); setQrMsg(''); }} tone="info" />
          <Chip label={t('fin.qrVariable')} selected={qrMode === 'variable'} onPress={() => { setQrMode('variable'); setQrMsg(''); }} tone="info" />
        </Row>
        {qrMode === 'fixed' ? (
          <TextInput
            value={qrAmount}
            onChangeText={(v) => {
              setQrAmount(v.replace(/[^0-9]/g, ''));
              setQrMsg('');
            }}
            placeholder="0"
            placeholderTextColor={Colors.textTertiary}
            keyboardType="number-pad"
            style={styles.amountInput}
          />
        ) : (
          <Text style={styles.tip}>{t('fin.qrVariableHint')}</Text>
        )}
        {qrMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{qrMsg}</Text> : null}
        <Btn label={t('fin.qrGenerate')} onPress={doGenerateQr} disabled={!qrFixedValid} loading={qrBusy} />
      </Card>
      {qr ? (
        <Card style={{ marginTop: Spacing.md, gap: Spacing.sm, borderColor: qrExpired ? Colors.danger : Colors.border }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{t('fin.qrCardTitle')}</Text>
            <Text style={{ fontSize: FontSize.xs, color: qrExpired ? Colors.danger : Colors.textTertiary }}>
              {qrExpired ? t('fin.qrExpired') : t('fin.qrExpires', { s: mmss(qrRemaining) })}
            </Text>
          </Row>
          <View style={styles.qrPayloadBox}>
            <Text selectable style={styles.qrPayload}>{qr.qrPayload}</Text>
          </View>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.qrRef', { ref: qr.merchantRef })}</Text>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: Colors.text }}>
              {qr.amountTZS ? tzs(qr.amountTZS) : t('fin.qrVariable')}
            </Text>
          </Row>
          <Row gap={Spacing.sm}>
            <Btn label={copiedQr ? t('fin.qrCopied') : t('fin.qrCopy')} variant="outline" size="sm" style={{ flex: 1 }} onPress={copyQr} />
            <Btn label={t('fin.qrRegenerate')} variant="subtle" size="sm" style={{ flex: 1 }} onPress={doGenerateQr} />
          </Row>
        </Card>
      ) : null}

      {/* Earnings pass (gap-09): payments — methods chips + history + reversal. */}
      <SectionTitle title={t('fin.payments')} icon="cash-outline" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {methods.length ? (
          <View style={styles.invoiceBox}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' }}>{t('fin.payMethods')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {methods.map((m) => (
                <Chip key={m.method} label={t(PAY_METHOD_LABEL[m.method] ?? 'common.bankCard')} tone={m.available ? 'success' : 'neutral'} />
              ))}
            </Row>
          </View>
        ) : null}
        {payments.length === 0 ? (
          <View style={{ padding: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.payEmpty')}</Text>
          </View>
        ) : null}
        {payments.map((p) => (
          <View key={p.id} style={styles.wdRow}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text }}>{tzs(p.amountTZS)}</Text>
              <Pill label={t(PAY_STATUS_LABEL[p.status])} tone={PAY_STATUS_TONE[p.status]} />
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: 4, gap: Spacing.sm }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }} numberOfLines={1}>
                {t('fin.payMeta', { method: t(PAY_METHOD_LABEL[p.method] ?? 'common.bankCard'), when: fullTime(p.createdAt) })}
              </Text>
              {p.reference ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }} numberOfLines={1}>
                  {t('fin.payRef', { ref: p.reference })}
                </Text>
              ) : null}
            </Row>
            {canFinance && p.status !== 'reversed' && p.status !== 'refunded' ? (
              <Row style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                <Btn label={t('fin.payReverse')} size="sm" variant="ghost" onPress={() => openReverse(p)} />
              </Row>
            ) : null}
          </View>
        ))}
      </Card>

      {/* Earnings pass (gap-09): reconciliation — contract summary + per-day rows. */}
      <SectionTitle title={t('fin.reconcileTitle')} icon="git-compare-outline" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {!reconciliation ? (
          <View style={{ padding: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.loading')}</Text>
          </View>
        ) : (
          <>
            {reconciliation.exceptions > 0 ? (
              <View style={{ padding: Spacing.md, gap: Spacing.sm, backgroundColor: Colors.dangerSoft }}>
                <Text style={{ color: Colors.danger, fontSize: FontSize.xs, lineHeight: 17 }}>{t('fin.recExceptionBanner')}</Text>
                <Row gap={Spacing.sm}>
                  <Btn label={t('fin.recSupport')} size="sm" variant="danger" style={{ flex: 1 }} onPress={() => router.push('/dashboard/support')} />
                  <Btn label={t('common.refresh')} size="sm" variant="ghost" style={{ flex: 1 }} onPress={() => void hydrateReconciliation()} />
                </Row>
              </View>
            ) : null}
            <View style={styles.settleRow}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>
                  {t('fin.recTotal', { a: tzs(reconciliation.orderTotalTZS), b: tzs(reconciliation.paymentTotalTZS) })}
                </Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('fin.recRange', { from: reconciliation.from, to: reconciliation.to })}
                </Text>
              </Row>
              <Row style={{ marginTop: 6, gap: Spacing.sm }}>
                <Pill label={t('fin.recMatched', { n: reconciliation.matched })} tone="success" />
                <Pill
                  label={t('fin.recExceptions', { n: reconciliation.exceptions })}
                  tone={reconciliation.exceptions > 0 ? 'danger' : 'neutral'}
                />
              </Row>
            </View>
            {reconciliation.days.map((d) => (
              <View key={d.day} style={styles.settleRow}>
                <Row style={{ justifyContent: 'space-between', gap: Spacing.sm }}>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.text, flex: 1 }} numberOfLines={1}>
                    {t('fin.recRow', { day: d.day, a: tzs(d.ledgerGross), b: tzs(d.settlementGross) })}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: d.ok ? Colors.success : Colors.danger }}>
                    {t('fin.recDiff', { a: tzs(d.diff) })}
                  </Text>
                  <Pill label={t(d.ok ? 'fin.recOk' : 'fin.recMiss')} tone={d.ok ? 'success' : 'danger'} />
                </Row>
              </View>
            ))}
          </>
        )}
      </Card>

      <SectionTitle title={t('fin.withdrawals')} icon="arrow-up-circle" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {withdrawals.length === 0 ? (
          <View style={{ padding: Spacing.lg, gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.wdEmpty')}</Text>
            <Btn label={t('fin.wdRequest')} size="sm" onPress={openWithdraw} />
          </View>
        ) : null}
        {withdrawals.map((w) => (
          <View key={w.id} style={styles.wdRow}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text }}>{tzs(w.amountTZS)}</Text>
              <Pill label={t(WD_LABEL[w.status])} tone={WD_TONE[w.status]} />
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                {t('fin.wdMeta', { method: w.method ?? 'bank', when: fullTime(w.createdAt) })}
              </Text>
              {w.feeTZS ? <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.wdFee', { a: tzs(w.feeTZS) })}</Text> : null}
            </Row>
            {w.status === 'failed' && w.reason ? (
              <Text style={{ fontSize: FontSize.xs, color: Colors.danger, marginTop: 4 }}>{w.reason}</Text>
            ) : null}
          </View>
        ))}
      </Card>

      <SectionTitle title={t('fin.settlements')} icon="receipt" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {settlements.length === 0 ? (
          <View style={{ padding: Spacing.lg, gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
              {t('fin.empty')}
            </Text>
            {canFinance ? (
              <Btn label={t('fin.runSettlement')} size="sm" loading={settling} onPress={async () => { setSettling(true); await runSettlement(); setSettling(false); }} />
            ) : (
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.noPermission')}</Text>
            )}
          </View>
        ) : null}
        {settlements.map((s) => (
          <View key={s.id} style={styles.settleRow}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>
                {s.batchNo} <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '400' }}>{t('fin.ordersCount', { n: s.orderCount })}</Text>
              </Text>
              <Pill label={s.payoutStatus === 'paid' ? t('fin.paid') : t('fin.pendingPayout')} tone={s.payoutStatus === 'paid' ? 'success' : 'warning'} />
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 4 }}>
              {t('fin.grossNet', { a: tzs(s.gross), b: tzs(s.commission), c: tzs(s.tax) })}
            </Text>
            <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text }}>{t('fin.net', { a: tzs(s.net) })}</Text>
              {s.payoutStatus === 'pending' && canFinance ? (
                <Btn label={t('fin.payout')} size="sm" variant="success" onPress={() => payout(s.id)} />
              ) : null}
            </Row>
          </View>
        ))}
        {invoices.length || financeInvoices.length ? (
          <View style={styles.invoiceBox}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' }}>{t('fin.einvoices')}</Text>
              <Btn
                label={t('fin.invRequest')}
                size="sm"
                variant="ghost"
                onPress={() => {
                  setInvAmount('');
                  setInvMsg('');
                  setShowInvoice(true);
                }}
              />
            </Row>
            {invoices.map((inv) => (
              <Row key={inv.id} style={{ justifyContent: 'space-between', paddingVertical: 6, gap: Spacing.sm }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.text }} numberOfLines={1}>
                  {inv.no} <Text style={{ color: Colors.textTertiary }}>{t('fin.vat', { a: tzs(inv.amount), b: tzs(inv.taxAmount) })}</Text>
                </Text>
                <Row gap={6}>
                  {inv.status === 'draft' ? (
                    <Btn label={t('fin.issue')} size="sm" variant="ghost" onPress={() => issueInvoice(inv.id)} />
                  ) : (
                    <Pill label={t('fin.issued')} tone="success" />
                  )}
                  <Btn label={t('fin.download')} size="sm" variant="ghost" onPress={() => doDownload(inv.id)} />
                </Row>
              </Row>
            ))}
            {financeInvoices.map((inv) => (
              <Row key={inv.id} style={{ justifyContent: 'space-between', paddingVertical: 6, gap: Spacing.sm }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.text }} numberOfLines={1}>
                  {inv.number} <Text style={{ color: Colors.textTertiary }}>{tzs(inv.amountTZS)}</Text>
                </Text>
                <Row gap={6}>
                  <Pill label={inv.status === 'issued' ? t('fin.issued') : t('fin.requested')} tone={inv.status === 'issued' ? 'success' : 'info'} />
                  <Btn label={t('fin.download')} size="sm" variant="ghost" onPress={() => doDownload(inv.id)} />
                </Row>
              </Row>
            ))}
          </View>
        ) : null}
      </Card>

      <SectionTitle title={t('fin.payouts')} icon="cash-outline" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {payouts.length === 0 ? (
          <View style={{ padding: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.poEmpty')}</Text>
          </View>
        ) : null}
        {payouts.map((p) => (
          <View key={p.id} style={styles.settleRow}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text }}>{tzs(p.amountTZS)}</Text>
              <Pill label={t(WD_LABEL[p.status])} tone={WD_TONE[p.status]} />
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 4 }}>
              {t('fin.wdMeta', { method: p.method ?? 'bank', when: fullTime(p.createdAt) })}
            </Text>
          </View>
        ))}
      </Card>

      <SectionTitle title={t('fin.bankCards')} icon="card-outline" action={t('fin.bcAdd')} onAction={openCardSheet} />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {bankCards.length === 0 ? (
          <View style={{ padding: Spacing.lg, gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.bcEmpty')}</Text>
            <Btn label={t('fin.bcAdd')} size="sm" onPress={openCardSheet} />
          </View>
        ) : null}
        {bankCards.map((c) => (
          <View key={c.id} style={styles.settleRow}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>
                {c.bankName} · ****{c.last4}
              </Text>
              {c.isDefault ? <Pill label={t('fin.bcDefault')} tone="success" /> : null}
            </Row>
            {c.accountHolderName ? (
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>{c.accountHolderName}</Text>
            ) : null}
            <Row style={{ marginTop: 6, gap: Spacing.sm }}>
              {!c.isDefault ? (
                <Btn label={t('fin.bcSetDefault')} size="sm" variant="ghost" onPress={() => doSetDefault(c.id, c.last4)} />
              ) : null}
              <Btn label={t('fin.bcDelete')} size="sm" variant="ghost" onPress={() => doRemoveCard(c.id, c.last4)} />
            </Row>
          </View>
        ))}
      </Card>

      <SectionTitle title={t('fin.expenses')} icon="receipt-outline" action={t('fin.expAdd')} onAction={openExpenseSheet} />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {expenses.length === 0 ? (
          <View style={{ padding: Spacing.lg, gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('fin.expEmpty')}</Text>
            <Btn label={t('fin.expAdd')} size="sm" onPress={openExpenseSheet} />
          </View>
        ) : null}
        {expenses.map((e) => (
          <View key={e.id} style={styles.settleRow}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t(EXPENSE_CATEGORY_LABEL[e.category])}</Text>
              <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.danger }}>{tzs(e.amountTZS)}</Text>
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: 4, gap: Spacing.sm }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }} numberOfLines={1}>
                {e.note ? `${e.note} · ` : ''}{fullTime(e.incurredAt)}
              </Text>
              <Btn label={t('fin.bcDelete')} size="sm" variant="ghost" onPress={() => doRemoveExpense(e.id, e.amountTZS)} />
            </Row>
          </View>
        ))}
      </Card>

      {composition ? (
        <>
          <SectionTitle title={t('fin.composition')} icon="pie-chart" />
          <Card style={{ paddingVertical: Spacing.md, gap: Spacing.md }}>
            <View style={{ gap: 12 }}>
              {composition.channels.map((c) => (
                <View key={c.key} style={{ gap: 6 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{c.label}</Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {t('fin.compRow', { a: tzs(c.amount), n: c.orders, pct: c.share })}
                    </Text>
                  </Row>
                  <View style={styles.miniTrack}>
                    <View style={[styles.miniFill, { width: `${Math.min(100, c.share)}%`, backgroundColor: Colors.primary }]} />
                  </View>
                </View>
              ))}
            </View>
            <View style={styles.compositionDivider} />
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' }}>{t('fin.byMethod')}</Text>
              {composition.methods.map((mm) => (
                <Row key={mm.method} style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.text }}>{mm.label}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {tzs(mm.amount)} · {mm.share}%
                  </Text>
                </Row>
              ))}
            </View>
          </Card>
        </>
      ) : null}

      <View style={{ marginTop: Spacing.lg }}>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { key: 'all', label: t('fin.all') },
            { key: 'income', label: t('fin.income') },
            { key: 'expense', label: t('fin.expense') },
          ]}
        />
      </View>

      <Card style={{ marginTop: Spacing.md, paddingVertical: Spacing.sm }}>
        {filtered.length === 0 ? <Empty icon="wallet-outline" title={t('fin.noRecords')} /> : null}
        {filtered.map((tx) => (
          <Row key={tx.id} style={{ paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg, gap: 10 }}>
            <View style={styles.txIcon}>
              <Icon name={TX_ICONS[tx.type]} size={17} color={tx.type === 'withdraw' || tx.type === 'refund' ? Colors.danger : Colors.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: FontSize.md, color: Colors.text, fontWeight: '600' }} numberOfLines={1}>{tx.title}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>{fullTime(tx.ts)}</Text>
            </View>
            {tx.status === 'pending' ? <Pill label={t('fin.processing')} tone="warning" /> : null}
            <Text
              style={{
                fontSize: FontSize.md,
                fontWeight: '800',
                color: tx.amount >= 0 ? Colors.success : Colors.danger,
              }}>
              {tx.amount >= 0 ? '+' : ''}{tzs(tx.amount)}
            </Text>
          </Row>
        ))}
      </Card>

      <SheetModal visible={showWithdraw} onClose={() => setShowWithdraw(false)} title={t('fin.withdraw')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.amount')}</Text>
            <TextInput
              value={amount}
              onChangeText={(v) => {
                setAmount(v.replace(/[^0-9]/g, ''));
                setWithdrawMsg('');
              }}
              placeholder="0"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              style={styles.amountInput}
            />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.destination')}</Text>
            {accounts.length ? (
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                {accounts.map((a) => (
                  <Chip
                    key={a.id}
                    label={`${a.name} ${a.accountMasked}`}
                    selected={account?.id === a.id}
                    onPress={() => setAccount(a)}
                  />
                ))}
              </Row>
            ) : (
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 }}>{t('fin.wdNoAccounts')}</Text>
            )}
          </View>
          {amountInvalid && amount !== '' ? (
            <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{t('fin.wdInvalid')}</Text>
          ) : null}
          {withdrawMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{withdrawMsg}</Text> : null}
          <Btn label={t('fin.confirmWithdraw')} onPress={doWithdraw} disabled={amountInvalid} size="lg" loading={withdrawing} />
          <Text style={styles.tip}>{t('fin.available', { a: tzs(withdrawable) })}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={showCard} onClose={() => setShowCard(false)} title={t('fin.bcAdd')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.bcBankName')}</Text>
            <TextInput
              value={cardBank}
              onChangeText={(v) => {
                setCardBank(v);
                setCardMsg('');
              }}
              placeholder="NMB Bank"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
            />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.bcLast4')}</Text>
            <TextInput
              value={cardLast4}
              onChangeText={(v) => {
                setCardLast4(v.replace(/[^0-9]/g, '').slice(0, 4));
                setCardMsg('');
              }}
              placeholder="0000"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              style={styles.input}
            />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.bcHolder')}</Text>
            <TextInput
              value={cardHolder}
              onChangeText={setCardHolder}
              placeholder="Juma Mwenda"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
            />
          </View>
          {cardTouched && !cardValid ? (
            <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{t('fin.bcInvalid')}</Text>
          ) : null}
          {cardMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{cardMsg}</Text> : null}
          <Btn label={t('fin.bcAdd')} onPress={doAddCard} disabled={!cardValid} size="lg" loading={addingCard} />
        </View>
      </SheetModal>

      <SheetModal visible={showExpense} onClose={() => setShowExpense(false)} title={t('fin.expAdd')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.expCategory')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {EXPENSE_CATEGORY_KEYS.map((key) => (
                <Chip
                  key={key}
                  label={t(EXPENSE_CATEGORY_LABEL[key])}
                  selected={expCategory === key}
                  onPress={() => {
                    setExpCategory(key);
                    setExpMsg('');
                  }}
                />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.amount')}</Text>
            <TextInput
              value={expAmount}
              onChangeText={(v) => {
                setExpAmount(v.replace(/[^0-9]/g, ''));
                setExpMsg('');
              }}
              placeholder="0"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              style={styles.amountInput}
            />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.expNote')}</Text>
            <TextInput
              value={expNote}
              onChangeText={(v) => {
                setExpNote(v);
                setExpMsg('');
              }}
              placeholder={t('fin.expNote')}
              placeholderTextColor={Colors.textTertiary}
              maxLength={500}
              style={styles.input}
            />
          </View>
          {expMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{expMsg}</Text> : null}
          <Btn label={t('fin.expAdd')} onPress={doAddExpense} disabled={!expValid} size="lg" loading={addingExpense} />
        </View>
      </SheetModal>

      <SheetModal visible={showInvoice} onClose={() => setShowInvoice(false)} title={t('fin.invRequest')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('fin.amount')}</Text>
            <TextInput
              value={invAmount}
              onChangeText={(v) => {
                setInvAmount(v.replace(/[^0-9]/g, ''));
                setInvMsg('');
              }}
              placeholder="0"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              style={styles.amountInput}
            />
          </View>
          {invMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{invMsg}</Text> : null}
          <Btn label={t('fin.invRequest')} onPress={doCreateInvoice} disabled={!invValid} size="lg" loading={addingInvoice} />
          <Text style={styles.tip}>{t('fin.invTip')}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={revTarget !== null} onClose={() => setRevTarget(null)} title={t('fin.payReverseTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.tip}>{t('fin.payReverseHint')}</Text>
          <TextInput
            value={revReason}
            onChangeText={(v) => {
              setRevReason(v);
              setRevMsg('');
            }}
            placeholder={t('fin.payReverseReason')}
            placeholderTextColor={Colors.textTertiary}
            maxLength={500}
            style={styles.input}
            multiline
          />
          {revMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{revMsg}</Text> : null}
          <Btn
            label={t('fin.payReverse')}
            onPress={doReverse}
            disabled={!revReason.trim()}
            size="lg"
            loading={revBusy}
            variant="danger"
          />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  balanceCard: {
    backgroundColor: Colors.black,
  },
  balanceLabel: { color: 'rgba(255,255,255,0.6)', fontSize: FontSize.xs },
  balance: { color: Colors.white, fontSize: 34, fontWeight: '800', marginTop: 6, letterSpacing: 0.5 },
  settleLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  settleValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginTop: 4 },
  vDivider: { width: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  chartTitle: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600', marginBottom: Spacing.md },
  wdRow: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  settleRow: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  invoiceBox: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: 4,
  },
  compositionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  miniTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: Colors.surface, overflow: 'hidden' },
  miniFill: { height: 6, borderRadius: 3 },
  txIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  amountInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    fontSize: 24,
    fontWeight: '700',
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  tip: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' },
  errorBanner: {
    borderWidth: 1,
    borderColor: Colors.dangerSoft,
    backgroundColor: Colors.dangerSoft,
  },
  qrPayloadBox: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    padding: Spacing.md,
  },
  qrPayload: {
    fontSize: FontSize.xs,
    color: Colors.text,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
});
