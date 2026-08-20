/* Order confirmation — shown right after placement (checkout success path).
 * GET /orders/{id} for the order number/totals/items/ETA, plus the linked
 * payment intent (GET /payments/history, orderId linkage) for the method row.
 * Loading skeleton + error/retry states; Track order → /order/[orderId]/tracking. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  ErrorState,
  Icon,
  MoneyText,
  PriceBreakdown,
  Row,
  Screen,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { getOrdersRepository, getPaymentsRepository, type OrderPaymentIntent } from '@/repos';
import type { OrderDetail } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { dateISO } from '@/lib/dates';

const PAYMENT_METHOD_LABEL: Record<string, I18nKey> = {
  mpesa: 'payments.mpesa',
  tigo_pesa: 'payments.tigoPesa',
  airtel_money: 'payments.airtelMoney',
  card: 'payments.card',
  cod: 'payments.cod',
};

export default function OrderConfirmationScreen() {
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [intent, setIntent] = useState<OrderPaymentIntent | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setOrder(await getOrdersRepository().get(orderId));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setError(t('order.title'));
      } else {
        setError(t('common.error'));
      }
      return;
    }
    // Payment method row is best-effort — the order itself already rendered.
    try {
      const history = await getPaymentsRepository().getHistory();
      setIntent(history.find((i) => i.orderId === orderId) ?? null);
    } catch {
      setIntent(null);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!order) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={1} />
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  const methodLabel = intent?.method ? PAYMENT_METHOD_LABEL[intent.method] : null;

  return (
    <Screen scroll>
      {/* Success header */}
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Icon name="checkmark" size={30} color={Colors.white} />
        </View>
        <Text style={styles.title}>{t('confirmation.title')}</Text>
        <Text style={styles.orderNo}>{order.no ?? order.id}</Text>
        <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm }}>
          <StatusPill status={order.status} />
          {order.deliveryEtaMin ? (
            <Text style={styles.eta}>{t('confirmation.eta')} · {t('order.estimated', { m: order.deliveryEtaMin })}</Text>
          ) : null}
        </Row>
        {order.createdAt ? <Text style={styles.meta}>{dateISO(order.createdAt)}</Text> : null}
      </View>

      {/* Items */}
      <Text style={styles.section}>{t('cart.title')}</Text>
      <Card style={{ gap: Spacing.sm }}>
        {(order.items ?? []).map((item, index) => (
          <Row key={`${item.catalogueItemId}-${index}`} style={{ justifyContent: 'space-between' }}>
            <Text style={styles.value} numberOfLines={1}>
              {item.quantity}× {item.name}
            </Text>
            <MoneyText amountTZS={item.unitPriceTZS * item.quantity} size={FontSize.sm} />
          </Row>
        ))}
        <Divider />
        <PriceBreakdown
          rows={[
            { label: t('breakdown.subtotal'), amountTZS: order.totals.subtotalTZS },
            { label: t('breakdown.delivery'), amountTZS: order.totals.deliveryFeeTZS },
            { label: t('breakdown.platform'), amountTZS: order.totals.platformFeeTZS },
            { label: t('breakdown.tax'), amountTZS: order.totals.taxTZS },
            ...(order.totals.discountTZS > 0 ? [{ label: t('breakdown.discount'), amountTZS: order.totals.discountTZS, signed: true }] : []),
          ]}
          totalTZS={order.totals.totalTZS}
          totalLabel={t('breakdown.total')}
        />
      </Card>

      {/* Delivery address */}
      <Text style={styles.section}>{t('checkout.address')}</Text>
      <Card>
        <Row gap={Spacing.md}>
          <Icon name="location" size={16} color={Colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.value}>{order.deliveryAddress.label} — {order.deliveryAddress.lines}</Text>
            <Text style={styles.meta}>{order.deliveryAddress.landmark}</Text>
          </View>
        </Row>
      </Card>

      {/* Payment method — read from the linked intent (never guessed) */}
      {methodLabel ? (
        <>
          <Text style={styles.section}>{t('checkout.payment')}</Text>
          <Card>
            <Row gap={Spacing.md}>
              <Icon name="card-outline" size={16} color={Colors.primary} />
              <Text style={styles.value}>{t(methodLabel)}</Text>
            </Row>
          </Card>
        </>
      ) : null}

      <Btn
        label={t('confirmation.track')}
        onPress={() => router.replace(`/order/${order.id}/tracking`)}
        size="lg"
        icon="navigate"
        style={{ marginTop: Spacing.lg }}
      />
      <Btn
        label={t('confirmation.home')}
        onPress={() => router.replace('/home')}
        variant="ghost"
        size="lg"
        style={{ marginTop: Spacing.md }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: Spacing.xl, gap: 2 },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text, textAlign: 'center' },
  orderNo: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.textSecondary, marginTop: 2 },
  eta: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansMedium },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2, textAlign: 'center' },
});
