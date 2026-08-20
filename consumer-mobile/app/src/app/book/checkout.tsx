import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, PriceBreakdown, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getBookingsRepository, getPaymentsRepository, type PaymentMethodRecord } from '@/repos';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { BookingDetail, OrderCreatePaymentMethod, PaymentIntentCreateMethod } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { idempotencyKey } from '@/lib/idempotency';
import { pickDefaultMethod } from '@/lib/payments';
import { formatTZS } from '@/lib/format';

const FALLBACK_METHODS: PaymentMethodRecord[] = [
  { id: 'pm_mpesa', method: 'mpesa', label: t('payments.mpesa') },
  { id: 'pm_tigo', method: 'tigo_pesa', label: t('payments.tigoPesa') },
  { id: 'pm_airtel', method: 'airtel_money', label: t('payments.airtelMoney') },
  { id: 'pm_card', method: 'card', label: t('payments.card') },
  { id: 'pm_cod', method: 'cod', label: t('payments.cod') },
];

type MethodKey = PaymentIntentCreateMethod | OrderCreatePaymentMethod;

type BookingWithPayment = BookingDetail & {
  intentId?: string;
  paymentMethod?: string;
};

export default function BookCheckoutScreen() {
  const router = useRouter();
  const { bookingId } = useLocalSearchParams<{ bookingId?: string }>();

  if (!bookingId) {
    return (
      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('checkout.title')}</Text>
        </Row>
        <View style={{ alignItems: 'center', marginBottom: Spacing.md }}>
          <View style={styles.typeChip}>
            <Text style={styles.typeChipText}>{t('checkout.type.booking')}</Text>
          </View>
        </View>
        <EmptyState icon="receipt-outline" title={t('checkout.fromDetail')} actionLabel={t('common.back')} onAction={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('checkout.title')}</Text>
      </Row>
      <View style={{ alignItems: 'center', marginBottom: Spacing.md }}>
        <View style={styles.typeChip}>
          <Text style={styles.typeChipText}>{t('checkout.type.booking')}</Text>
        </View>
      </View>
      <BookingCheckoutShell bookingId={bookingId} />
    </Screen>
  );
}

function BookingCheckoutShell({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [booking, setBooking] = useState<BookingWithPayment | null>(null);
  const [loadError, setLoadError] = useState('');
  const [methods, setMethods] = useState<PaymentMethodRecord[] | null>(null);
  const [method, setMethod] = useState<MethodKey>('mpesa');
  const [blockedMethods, setBlockedMethods] = useState<Set<string>>(new Set());
  const [pendingIntentId, setPendingIntentId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);

  useEffect(() => {
    getBookingsRepository()
      .get(bookingId)
      .then((b) => setBooking(b as BookingWithPayment))
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? t('booking.notFound') : t('common.error')));
    getPaymentsRepository()
      .getPaymentMethods()
      .then((list) => {
        if (list.length > 0) {
          setMethods(list);
          const preferred = pickDefaultMethod(list);
          if (preferred) setMethod(preferred.method as MethodKey);
        }
      })
      .catch(() => setMethods(FALLBACK_METHODS));
  }, [bookingId]);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const pay = async (retryIntentId?: string) => {
    if (!booking) return;
    setPayError('');
    setRetryAfter(0);
    setPaying(true);
    try {
      const intent = retryIntentId
        ? { id: retryIntentId, status: 'created' as const, amountTZS: booking.price?.totalTZS ?? 0, method }
        : booking.intentId
          ? { id: booking.intentId, status: 'created' as const, amountTZS: booking.price?.totalTZS ?? 0, method: (booking.paymentMethod ?? method) as MethodKey }
          : await getPaymentsRepository().createIntent(booking.id, method, idempotencyKey(user?.id ?? 'customer', 'booking.intent'));
      setPendingIntentId(intent.id);
      const paid = await getPaymentsRepository().confirm(intent.id, idempotencyKey(user?.id ?? 'customer', 'booking.confirm'));
      if (paid.status === 'paid') {
        toast(t('checkout.paymentSuccess'));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/booking/${booking.id}`);
        return;
      }
      setPayError(t('common.error'));
    } catch (e) {
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'PAYMENT_PROVIDER_ERROR': {
            const seconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 10;
            setRetryAfter(seconds);
            setPayError(t('checkout.paymentFailed', { s: seconds }));
            break;
          }
          case 'PAYMENT_ALREADY_PAID':
            router.replace(`/booking/${booking.id}`);
            break;
          case 'PAYMENT_INTENT_NOT_FOUND':
            setPendingIntentId(null);
            setPayError(t('common.error'));
            break;
          case 'PAYMENT_METHOD_UNSUPPORTED':
            setBlockedMethods((prev) => new Set(prev).add(method));
            setPayError('');
            break;
          default:
            setPayError(t('common.error'));
        }
      } else {
        setPayError(t('common.error'));
      }
    } finally {
      setPaying(false);
    }
  };

  if (loadError) {
    return <ErrorState message={loadError} onRetry={() => { setLoadError(''); setBooking(null); }} />;
  }
  if (!booking) {
    return (
      <View style={{ gap: Spacing.md }}>
        <SkeletonCard rows={3} />
        <SkeletonCard rows={4} />
      </View>
    );
  }

  const price = booking.price;
  const priceRows = price
    ? [
        { label: t('breakdown.subtotal'), amountTZS: price.subtotalTZS },
        { label: t('breakdown.delivery'), amountTZS: price.deliveryFeeTZS },
        { label: t('breakdown.platform'), amountTZS: price.platformFeeTZS },
        { label: t('breakdown.tax'), amountTZS: price.taxTZS },
        { label: t('breakdown.discount'), amountTZS: price.discountTZS, signed: true as const },
      ]
    : [];
  const totalTZS = price?.totalTZS ?? 0;

  return (
    <>
      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.payment')}</Text>
        {methods === null ? (
          <SkeletonCard rows={3} />
        ) : (
          <View style={{ gap: Spacing.sm }}>
            {methods.map((m) => {
              const blocked = blockedMethods.has(m.method);
              return (
                <Pressable
                  key={m.id}
                  onPress={blocked ? undefined : () => setMethod(m.method as MethodKey)}
                  disabled={blocked}
                  accessibilityRole="button"
                  accessibilityState={{ selected: method === m.method, disabled: blocked }}
                  style={[styles.methodRow, method === m.method && styles.methodSelected, blocked && { opacity: 0.4, borderColor: Colors.borderStrong }]}>
                  <Text style={[styles.value, { flex: 1 }, blocked && { color: Colors.textFaint }]}>{m.label}</Text>
                  <Icon name={method === m.method ? 'radio-button-on' : 'radio-button-off'} size={18} color={method === m.method ? Colors.primary : Colors.borderStrong} />
                </Pressable>
              );
            })}
          </View>
        )}
      </Card>

      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.reviewTotal')}</Text>
        <PriceBreakdown rows={priceRows} totalTZS={totalTZS} totalLabel={t('breakdown.total')} />
      </Card>

      {booking.status !== 'pending_payment' ? (
        <EmptyState icon="checkmark-circle-outline" title={t('checkout.fromDetail')} actionLabel={t('common.view')} onAction={() => router.replace(`/booking/${booking.id}`)} />
      ) : (
        <>
          {payError ? <ErrorState message={payError} /> : null}
          {paying ? (
            <Card style={[styles.section, { backgroundColor: Colors.primarySoft }]}>
              <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center' }}>
                {t('checkout.stkPush', { method: method.toUpperCase().replace('_', ' ') })}
              </Text>
            </Card>
          ) : null}
          <Btn
            label={paying ? '…' : retryAfter > 0 ? t('checkout.paymentFailed', { s: retryAfter }) : t('booking.pay', { amount: formatTZS(totalTZS) })}
            onPress={paying ? undefined : () => pay(pendingIntentId ?? undefined)}
            size="lg"
            loading={paying}
            disabled={retryAfter > 0 || totalTZS <= 0}
            style={{ marginTop: Spacing.md }}
          />
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  typeChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  typeChipText: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  section: { marginBottom: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
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
