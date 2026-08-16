import { Stack, useLocalSearchParams, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Divider, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { DineInOrder, PriceBreakdown, TableRow } from '@/api/types';
import { useDineInStore } from '@/store/dine-in';
import { useSessionStore } from '@/store/session';
import { fullTime, tzs } from '@/lib/format';

const STATUS_TONE: Record<DineInOrder['status'], 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  open: 'warning',
  billing: 'danger',
  paid: 'info',
  closed: 'neutral',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<DineInOrder['status'], I18nKey> = {
  open: 'din.open',
  billing: 'din.billing',
  paid: 'din.paid',
  closed: 'din.closed',
  cancelled: 'ui.status.cancelled',
};

const TOTAL_ROWS: { key: keyof PriceBreakdown; label: I18nKey; emphasized?: boolean }[] = [
  { key: 'subtotalTZS', label: 'din.subtotal' },
  { key: 'deliveryFeeTZS', label: 'din.deliveryFee' },
  { key: 'platformFeeTZS', label: 'din.platformFee' },
  { key: 'taxTZS', label: 'din.tax' },
  { key: 'discountTZS', label: 'din.discount' },
  { key: 'totalTZS', label: 'din.total', emphasized: true },
];

/* confirm-payment evidence (PAYMENTS.md): the cashier records the method —
 * provider-verified for mobile money, COD for cash receipt. */
const PAY_METHODS = ['mpesa', 'airtel_money', 'cod'] as const;

export default function BillDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id } = useLocalSearchParams<{ id: string }>();
  const billId = String(id ?? '');
  const { confirmPayment, closeBill, requestBill } = useDineInStore();
  const sessionPerms = useSessionStore((s) => s.perms);
  const [bill, setBill] = useState<DineInOrder | null>(null);
  const [tableName, setTableName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [payMethod, setPayMethod] = useState<(typeof PAY_METHODS)[number] | ''>('');
  const [paidBy, setPaidBy] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Dual-screen POS role gate (DINE-IN.md): billing actions are cashier-only;
   * other roles see STAFF_ROLE_FORBIDDEN instead of the buttons. */
  const canBill = sessionPerms.includes('*') || sessionPerms.includes('dine_in:billing');

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setConflict('');
    try {
      const res = await api.get<{ bill: DineInOrder }>(`/dine-in/orders/${billId}`, { retries: 1 });
      setBill(res.bill);
      try {
        const tables = await api.get<{ tables: TableRow[] }>(`/dine-in/tables?storeId=s_demo`, { retries: 1 });
        const row = tables.tables.find((tb) => tb.id === res.bill.tableId);
        setTableName(row?.name ?? t('din.table'));
      } catch {
        setTableName(t('din.table'));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('din.errLoad'));
    } finally {
      setLoading(false);
    }
  }, [billId]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => {
      clearTimeout(t);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [load]);

  const runMutation = async (fn: () => Promise<DineInOrder>, okToast: I18nKey) => {
    setBusy(true);
    setConflict('');
    try {
      await fn();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(t(okToast));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(e.message);
        await load();
      } else {
        setError(e instanceof ApiError ? e.message : t('din.errLoad'));
      }
    } finally {
      setBusy(false);
    }
  };

  const billable = bill !== null && (bill.status === 'open' || bill.status === 'billing');
  const closable = bill !== null && bill.status === 'paid';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{bill ? t('din.billNo', { id: bill.id.slice(-6) }) : t('din.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {loading ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.lg }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.skeleton} />
            ))}
          </View>
        ) : null}

        {!loading && error ? (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
            <Text style={styles.error}>{error}</Text>
            <Btn label={t('common.retry')} variant="outline" size="sm" onPress={load} />
          </View>
        ) : null}

        {!loading && !error && bill ? (
          <View style={{ gap: Spacing.md }}>
            {conflict ? (
              <View style={styles.conflictBanner}>
                <Icon name="alert-circle" size={16} color={Colors.danger} />
                <Text style={styles.conflictText}>{conflict}</Text>
              </View>
            ) : null}
            {toast ? (
              <View style={styles.toastBanner}>
                <Icon name="checkmark-circle" size={16} color={Colors.success} />
                <Text style={styles.toastText}>{toast}</Text>
              </View>
            ) : null}

            <Card style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.tableName}>{tableName}</Text>
                <Pill label={t(STATUS_LABEL[bill.status]).toUpperCase()} tone={STATUS_TONE[bill.status]} />
              </Row>
              <Text style={styles.meta}>{t('din.opened', { time: fullTime(bill.createdAt) })}</Text>
              {bill.paidAt ? <Text style={styles.meta}>{t('din.paidAt', { time: fullTime(bill.paidAt) })}</Text> : null}
              {bill.paymentMethod || bill.paidBy ? (
                <Text style={styles.meta}>
                  {t('din.paidVia', {
                    method: bill.paymentMethod ?? '—',
                    by: bill.paidBy ?? '—',
                  })}
                </Text>
              ) : null}
            </Card>

            <View>
              <Text style={styles.sectionLabel}>{t('din.itemsTitle')}</Text>
              <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
                {bill.items.map((it, i) => (
                  <View key={it.catalogueItemId}>
                    {i > 0 ? <Divider style={{ marginLeft: Spacing.lg }} /> : null}
                    <View style={styles.itemRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.itemName} numberOfLines={1}>{it.name}</Text>
                        <Text style={styles.itemQty}>{t('din.qty', { qty: it.quantity, price: tzs(it.unitPriceTZS) })}</Text>
                      </View>
                      <Text style={styles.itemTotal}>{tzs(it.unitPriceTZS * it.quantity)}</Text>
                    </View>
                  </View>
                ))}
              </Card>
            </View>

            <View>
              <Text style={styles.sectionLabel}>{t('din.totals')}</Text>
              <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
                {TOTAL_ROWS.map((row, i) => (
                  <View key={row.key}>
                    {i > 0 ? <Divider style={{ marginLeft: Spacing.lg }} /> : null}
                    <View style={[styles.itemRow, row.emphasized && styles.totalRow]}>
                      <Text style={[styles.itemName, row.emphasized && styles.totalLabel]}>{t(row.label)}</Text>
                      <Text style={[styles.itemTotal, row.emphasized && styles.totalLabel]}>{tzs(bill.totals[row.key])}</Text>
                    </View>
                  </View>
                ))}
              </Card>
            </View>

            <View style={{ gap: Spacing.sm }}>
              {!canBill ? (
                <View style={styles.forbiddenBanner}>
                  <Icon name="lock-closed-outline" size={16} color={Colors.danger} />
                  <Text style={styles.forbiddenText}>{t('din.roleForbidden')}</Text>
                </View>
              ) : null}
              {bill.status === 'open' ? (
                <Btn
                  label={t('din.requestBill')}
                  icon="receipt-outline"
                  variant="outline"
                  size="lg"
                  loading={busy}
                  onPress={() => runMutation(() => requestBill(bill.id), 'din.billRequested')}
                />
              ) : null}
              {billable && canBill ? (
                <View style={{ gap: Spacing.sm }}>
                  <Text style={styles.fieldLabel}>{t('din.payMethod')}</Text>
                  <Row gap={6} style={{ flexWrap: 'wrap' }}>
                    {PAY_METHODS.map((m) => (
                      <Chip
                        key={m}
                        label={m}
                        selected={payMethod === m}
                        onPress={() => setPayMethod(payMethod === m ? '' : m)}
                      />
                    ))}
                  </Row>
                  <TextInput
                    value={paidBy}
                    onChangeText={setPaidBy}
                    placeholder={t('din.paidByPh')}
                    placeholderTextColor={Colors.textTertiary}
                    style={styles.input}
                    maxLength={40}
                  />
                </View>
              ) : null}
              <Btn
                label={t('din.confirmPayment')}
                icon="cash-outline"
                size="lg"
                loading={busy}
                disabled={!billable || !canBill}
                onPress={() => runMutation(() => confirmPayment(bill.id, { method: payMethod || undefined, paidBy: paidBy.trim() || undefined }), 'din.confirmed')}
              />
              <Btn
                label={t('din.closeBill')}
                variant="dark"
                size="lg"
                loading={busy}
                disabled={!closable || !canBill}
                onPress={() => runMutation(() => closeBill(bill.id), 'din.closedToast')}
              />
            </View>
          </View>
        ) : null}
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  skeleton: {
    height: 90,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    opacity: 0.6,
  },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  conflictBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.dangerSoft,
    borderWidth: 1,
    borderColor: `${Colors.danger}44`,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  conflictText: { flex: 1, color: Colors.danger, fontSize: FontSize.sm, lineHeight: 18 },
  toastBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.successSoft,
    borderWidth: 1,
    borderColor: `${Colors.success}44`,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  toastText: { flex: 1, color: Colors.success, fontSize: FontSize.sm, fontWeight: '700' },
  forbiddenBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.dangerSoft,
    borderWidth: 1,
    borderColor: `${Colors.danger}44`,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  forbiddenText: { flex: 1, color: Colors.danger, fontSize: FontSize.sm, lineHeight: 18 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  tableName: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: '700',
    marginBottom: Spacing.sm,
    marginTop: Spacing.xs,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  itemName: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  itemQty: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  itemTotal: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  totalRow: { backgroundColor: Colors.surface },
  totalLabel: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
});