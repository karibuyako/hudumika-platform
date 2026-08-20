/* Split payment summary (docs/CONTRACT-ADDITIONS.md #22, mock-first until the
 * contract ships a split-payment resource).
 *
 * ONE order, multiple payers: the initiator defines the shares at checkout,
 * pays their own share through the normal intent flow, then lands here — the
 * split summary. Each share row shows label / amount / paid status; MY share
 * carries "Pay my share" while unpaid, and once every share is covered the
 * split can be completed (the order settles then). Honest scope note: the
 * co-payer flow needs the app too — the mock simulates their shares as
 * PRE-PAID. Entry: checkout with the split toggle ON → /splits/{id}; the
 * share link (hudumika://split/{id}) is on the deep-link allow-list. This
 * screen refetches on mount (deep-link entry included — 404 renders "not
 * visible").
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  Btn,
  Card,
  Divider,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { idempotencyKey } from '@/lib/idempotency';
import { pickDefaultMethod } from '@/lib/payments';
import { getOrdersRepository, getPaymentsRepository, getSplitPaymentsRepository, type PaymentMethodRecord, type SplitPlan, type SplitStatus } from '@/repos';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { PaymentIntentCreateMethod } from '@hudumika/contract';

// Fallback only while GET /payments/methods is unreachable — the server list wins.
const FALLBACK_METHODS: PaymentMethodRecord[] = [
  { id: 'pm_mpesa', method: 'mpesa', label: t('payments.mpesa') },
  { id: 'pm_tigo', method: 'tigo_pesa', label: t('payments.tigoPesa') },
  { id: 'pm_airtel', method: 'airtel_money', label: t('payments.airtelMoney') },
  { id: 'pm_card', method: 'card', label: t('payments.card') },
  { id: 'pm_cod', method: 'cod', label: t('payments.cod') },
];

const STATUS_TONE: Record<SplitStatus, 'info' | 'warning' | 'success' | 'neutral'> = {
  open: 'info',
  paying: 'warning',
  paid: 'success',
  completed: 'success',
};

export default function SplitScreen() {
  const router = useRouter();
  const { splitId } = useLocalSearchParams<{ splitId: string }>();
  const user = useSessionStore((s) => s.user);

  const [plan, setPlan] = useState<SplitPlan | null>(null);
  const [orderRef, setOrderRef] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [methods, setMethods] = useState<PaymentMethodRecord[] | null>(null);
  const [method, setMethod] = useState<PaymentIntentCreateMethod>('mpesa');
  const [methodSheet, setMethodSheet] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const current = await getSplitPaymentsRepository().getSplit(splitId);
      setPlan(current);
      // Order ref is display-only — the split still renders if it is missing.
      try {
        const order = await getOrdersRepository().get(current.orderId);
        setOrderRef(order.no ?? current.orderId);
      } catch {
        setOrderRef(current.orderId);
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('split.notFound') : t('common.error'));
    }
  }, [splitId]);

  useEffect(() => {
    load();
    getPaymentsRepository()
      .getPaymentMethods()
      .then((list) => {
        if (list.length > 0) {
          setMethods(list);
          const preferred = pickDefaultMethod(list);
          if (preferred) setMethod(preferred.method as PaymentIntentCreateMethod);
        }
      })
      .catch(() => setMethods(FALLBACK_METHODS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payMyShare = async () => {
    if (!plan) return;
    setPaying(true);
    try {
      const updated = await getSplitPaymentsRepository().payMyShare(
        plan.id,
        method,
        idempotencyKey(user?.id ?? 'customer', 'split-pay'),
      );
      setPlan(updated);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('checkout.paymentSuccess'));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'CONFLICT' || e.code === 'ORDER_NOT_PAYABLE')) load();
      else if (e instanceof ApiError) toast(e.message, 'error');
      else toast(t('common.error'), 'error');
    } finally {
      setPaying(false);
    }
  };

  const completeSplit = async () => {
    if (!plan) return;
    setCompleting(true);
    try {
      const updated = await getSplitPaymentsRepository().completeSplit(
        plan.id,
        idempotencyKey(user?.id ?? 'customer', 'split-complete'),
      );
      setPlan(updated);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('split.completed'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') load();
      else toast(t('common.error'), 'error');
    } finally {
      setCompleting(false);
    }
  };

  const shareLink = async () => {
    if (!plan) return;
    try {
      await Share.share({ title: t('split.shareLink'), message: `hudumika://split/${plan.id}` });
    } catch {
      toast(t('groupOrder.shareFailed'), 'error');
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!plan) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  const mine = plan.shares.find((s) => s.id === plan.myShareId);
  const allPaid = plan.shares.every((s) => s.status === 'paid');

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title} numberOfLines={1}>{t('split.title')}</Text>
        <Pill label={t(`split.${plan.status}` as I18nKey)} tone={STATUS_TONE[plan.status]} />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>{t('split.orderRef')}</Text>
          <Text style={styles.value} numberOfLines={1}>{orderRef ?? plan.orderId}</Text>
        </Row>
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>{t('breakdown.total')}</Text>
          <MoneyText amountTZS={plan.totalTZS} size={FontSize.lg} bold />
        </Row>
        <Btn label={t('split.shareLink')} onPress={shareLink} variant="ghost" size="sm" icon="share-social-outline" />
      </Card>

      <Text style={styles.sectionLabel}>{t('split.shares')}</Text>
      {plan.shares.map((share) => {
        const isMine = share.id === plan.myShareId;
        return (
          <Card key={share.id} style={{ marginBottom: Spacing.md, gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Row gap={Spacing.xs}>
                  <Text style={styles.name} numberOfLines={1}>{share.label}</Text>
                  {isMine ? (
                    <Text style={[styles.meta, { color: Colors.primaryDeep }]}>{t('split.yourShare')}</Text>
                  ) : null}
                </Row>
              </View>
              <MoneyText amountTZS={share.amountTZS} size={FontSize.sm} bold />
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta} numberOfLines={1}>{share.status === 'paid' ? t('split.paid') : t('split.pending')}</Text>
              <Pill label={t(share.status === 'paid' ? 'split.paid' : 'split.pending')} tone={share.status === 'paid' ? 'success' : 'neutral'} />
            </Row>
          </Card>
        );
      })}

      {mine?.status === 'pending' ? (
        <Card style={{ marginBottom: Spacing.md, gap: Spacing.md }}>
          <Text style={styles.sectionLabel}>{t('split.yourShare')}</Text>
          <Pressable onPress={() => setMethodSheet(true)} accessibilityRole="button">
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{t('checkout.payment')}</Text>
              <Text style={styles.value}>{methods?.find((m) => m.method === method)?.label ?? t('checkout.payment')} ›</Text>
            </Row>
          </Pressable>
          <Btn label={t('split.payMyShare')} onPress={payMyShare} size="lg" loading={paying} />
        </Card>
      ) : null}

      {allPaid && plan.status !== 'completed' ? (
        <Card style={{ marginBottom: Spacing.md, gap: Spacing.md }}>
          <Text style={styles.meta}>
            {t('split.paid')} — {t('split.complete')}
          </Text>
          <Btn label={t('split.complete')} onPress={completeSplit} size="lg" variant="success" loading={completing} />
        </Card>
      ) : null}

      {plan.status === 'completed' ? (
        <Card style={{ marginBottom: Spacing.md, backgroundColor: Colors.successSoft }}>
          <Row gap={Spacing.md}>
            <Icon name="checkmark-circle-outline" size={18} color={Colors.success} />
            <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>
              {t('split.completed')}
            </Text>
          </Row>
        </Card>
      ) : null}

      <Card style={{ marginBottom: Spacing.md }}>
        <Row gap={Spacing.md}>
          <Icon name="information-circle-outline" size={18} color={Colors.textTertiary} />
          <Text style={styles.note}>{t('split.copayerNote')}</Text>
        </Row>
      </Card>

      <SheetModal visible={methodSheet} onClose={() => setMethodSheet(false)} title={t('checkout.payment')}>
        {(methods ?? FALLBACK_METHODS).map((m) => (
          <Pressable
            key={m.id}
            onPress={() => {
              setMethod(m.method as PaymentIntentCreateMethod);
              setMethodSheet(false);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: method === m.method }}
            style={[styles.methodRow, method === m.method && styles.methodSelected]}>
            <Text style={[styles.value, { flex: 1 }]}>{m.label}</Text>
            <Icon name={method === m.method ? 'radio-button-on' : 'radio-button-off'} size={18} color={method === m.method ? Colors.primary : Colors.borderStrong} />
          </Pressable>
        ))}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  note: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, flex: 1, lineHeight: 16 },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginVertical: Spacing.sm },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  methodSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
});
