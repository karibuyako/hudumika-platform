import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  PriceBreakdown,
  Row,
  Screen,
  Segmented,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { getBookingsRepository, getCouponsRepository, getHotelsRepository, getOrdersRepository, getPaymentsRepository, getSplitPaymentsRepository, type PaymentMethodRecord } from '@/repos';
import { useAddressesStore } from '@/store/addresses';
import { useCartStore } from '@/store/cart';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { BookingDetail, Coupon, HotelBooking, Order, OrderCreatePaymentMethod, PaymentIntentCreateMethod } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { getTransactionType, type TransactionType } from '@/lib/checkout';
import { dateISO, fullTimeISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { pickDefaultMethod } from '@/lib/payments';
import { track } from '@/lib/analytics';
import { formatTZS } from '@/lib/format';

// Fallback only while GET /payments/methods is unreachable — the server list wins.
const FALLBACK_METHODS: PaymentMethodRecord[] = [
  { id: 'pm_mpesa', method: 'mpesa', label: t('payments.mpesa') },
  { id: 'pm_tigo', method: 'tigo_pesa', label: t('payments.tigoPesa') },
  { id: 'pm_airtel', method: 'airtel_money', label: t('payments.airtelMoney') },
  { id: 'pm_card', method: 'card', label: t('payments.card') },
  { id: 'pm_cod', method: 'cod', label: t('payments.cod') },
];

// Quick scheduled slots — ISO timestamps rendered as local time chips
// (ORDER-FLOW "Schedule for later" toggle; the server enforces the window).
function scheduleSlots(): { key: string; label: string; iso: string }[] {
  const slots = [
    { key: '1h', label: t('checkout.slotIn', { h: 1 }) },
    { key: '3h', label: t('checkout.slotIn', { h: 3 }) },
    { key: 'tom10', label: t('checkout.slotTomorrow', { t: '10:00' }) },
    { key: 'tom18', label: t('checkout.slotTomorrow', { t: '18:00' }) },
  ];
  const base = new Date(Date.now() + 2 * 60_000);
  const at = (h: number) => new Date(base.getTime() + h * 3600_000).toISOString();
  const tomorrow = (h: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { ...slots[0], iso: at(1) },
    { ...slots[1], iso: at(3) },
    { ...slots[2], iso: tomorrow(10) },
    { ...slots[3], iso: tomorrow(18) },
  ];
}

type MethodKey = PaymentIntentCreateMethod | OrderCreatePaymentMethod;

// Universal checkout shell (MASTER-BLUEPRINT §12): the header chip labels the
// dispatched transaction type; non-commerce shells render below it.
const TYPE_LABEL: Record<TransactionType, I18nKey> = {
  commerce: 'checkout.type.commerce',
  delivery: 'checkout.type.delivery',
  service: 'checkout.type.service',
  booking: 'checkout.type.booking',
  reservation: 'checkout.type.reservation',
  hotel: 'checkout.type.hotel',
};

// Booking detail on the mock wire may carry the linked payment intent
// id/method (contract types only expose status) — live responses omit them.
type BookingWithPayment = BookingDetail & {
  intentId?: string;
  paymentMethod?: string;
};

// WALLET-COUPONS.md: the checkout coupon selector ships behind a feature flag.
// Mock-first (docs/CONTRACT-ADDITIONS.md #10): the mock now honors couponId on
// order create (server-side validation + discount), so the selector is ON by
// default. The live contract still has no couponId on OrderCreate — the live
// repo passes it through and a backend that has not shipped the field ignores
// it (no discount), so the selector stays safe against a live backend.
const COUPON_CHECKOUT_ENABLED = process.env.EXPO_PUBLIC_FEATURE_COUPON_CHECKOUT !== 'false';

/** Even split of a total across n payers (integer TZS): floor each share and
 * give the remainder to the FIRST share (the initiator's own — the mock
 * marks the first share as mine). */
function evenShares(totalTZS: number, n: number): { label: string; amountTZS: number }[] {
  const base = Math.floor(totalTZS / n);
  const remainder = totalTZS - base * n;
  return Array.from({ length: n }, (_, i) => ({
    label: i === 0 ? t('split.you') : t('split.person', { n: i }),
    amountTZS: base + (i === 0 ? remainder : 0),
  }));
}

export default function CheckoutScreen() {
  const router = useRouter();
  const { merchantId, transactionType: transactionTypeParam, bookingId, hotelBookingId } = useLocalSearchParams<{
    merchantId?: string;
    transactionType?: string;
    bookingId?: string;
    hotelBookingId?: string;
  }>();
  // Universal checkout shell: the transactionType query param (blueprint §2
  // typed route /checkout/:transactionType) dispatches the shell; absent or
  // unknown values default to the commerce order flow below, unchanged.
  const transactionType = getTransactionType(transactionTypeParam);
  const groups = useCartStore((s) => s.groups);
  const clearGroup = useCartStore((s) => s.clearGroup);
  const addresses = useAddressesStore((s) => s.addresses);
  const selectedAddressId = useAddressesStore((s) => s.selectedId);
  const user = useSessionStore((s) => s.user);

  const [addressSheet, setAddressSheet] = useState(false);
  const [couponSheet, setCouponSheet] = useState(false);
  const [methods, setMethods] = useState<PaymentMethodRecord[] | null>(null);
  const [method, setMethod] = useState<MethodKey>('mpesa');
  const [blockedMethods, setBlockedMethods] = useState<Set<string>>(new Set());
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [appliedCoupon, setAppliedCoupon] = useState<Coupon | null>(null);
  const [couponError, setCouponError] = useState('');
  // SMART COUPONS (MASTER-BLUEPRINT §16, docs/CONTRACT-ADDITIONS.md #26): the
  // best applicable wallet coupon suggested by the server for this cart —
  // advisory only (loading/errors are silent; the chip hides when nothing
  // applies or the suggestion is already the applied coupon).
  const [suggestedCoupon, setSuggestedCoupon] = useState<Coupon | null>(null);
  const [error, setError] = useState('');
  const [refundBanner, setRefundBanner] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [pendingIntentId, setPendingIntentId] = useState<string | null>(null);
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState('');
  // Split payment (mock-first, CONTRACT-ADDITIONS.md #22): the toggle opens
  // the share-definition sheet; the draft is applied to the order at
  // placement (createSplit + payMyShare), then the flow lands on /splits/{id}.
  const [splitOn, setSplitOn] = useState(false);
  const [splitSheet, setSplitSheet] = useState(false);
  const [splitMode, setSplitMode] = useState<'people' | 'custom'>('people');
  const [splitPeople, setSplitPeople] = useState(2);
  const [customShares, setCustomShares] = useState<{ label: string; amount: string }[]>([
    { label: t('split.you'), amount: '' },
    { label: '', amount: '' },
  ]);
  const [splitDraft, setSplitDraft] = useState<{ label: string; amountTZS: number }[] | null>(null);
  const [splitSheetError, setSplitSheetError] = useState('');

  const selectedAddress = addresses.find((a) => a.id === selectedAddressId) ?? addresses[0];
  // Checkout operates on exactly one merchant group (each group becomes its
  // own order); other groups stay in the cart untouched.
  const merchant = merchantId ? (groups.find((g) => g.merchantId === merchantId) ?? null) : null;

  const loadCoupons = useCallback(async () => {
    try {
      const list = await getCouponsRepository().list('claimed');
      setCoupons(list.filter((c) => c.status === 'claimed'));
    } catch {
      setCoupons([]);
    }
  }, []);

  // Payment methods come from the server (§15 PAYMENTS.md) with a local fallback.
  useEffect(() => {
    if (COUPON_CHECKOUT_ENABLED) loadCoupons();
    getPaymentsRepository()
      .getPaymentMethods()
      .then((list) => {
        if (list.length > 0) {
          setMethods(list);
          // Smart default (§37): pre-select the server default (isDefault)
          // instead of the hardcoded 'mpesa'; the customer can still override.
          const preferred = pickDefaultMethod(list);
          if (preferred) setMethod(preferred.method as MethodKey);
        }
      })
      .catch(() => setMethods(FALLBACK_METHODS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PAYMENT_PROVIDER_ERROR retry countdown (PAYMENTS.md) — never an instant
  // hammer on the provider.
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const subtotal = merchant
    ? merchant.items.reduce((acc, i) => acc + (i.unitPriceTZS + (i.optionsPriceTZS ?? 0)) * i.quantity, 0)
    : 0;

  // Advisory preview only — the server recomputes every row at order time.
  // Coupon discount is only previewed behind the feature flag (the contract
  // has no couponId on OrderCreate yet, so the server never discounts).
  const preview = {
    subtotalTZS: subtotal,
    deliveryFeeTZS: 2500,
    platformFeeTZS: 800,
    taxTZS: 0,
    discountTZS: COUPON_CHECKOUT_ENABLED ? (appliedCoupon?.discountTZS ?? 0) : 0,
  };
  const previewTotal = Math.max(0, preview.subtotalTZS + preview.deliveryFeeTZS + preview.platformFeeTZS + preview.taxTZS - preview.discountTZS);

  const applyCoupon = (c: Coupon) => {
    if (preview.subtotalTZS < (c.minimumSpendTZS ?? 0)) {
      setCouponError(t('coupons.minSpend', { amount: formatTZS(c.minimumSpendTZS ?? 0) }));
      return;
    }
    setCouponError('');
    setAppliedCoupon(c);
    setCouponSheet(false);
  };

  // SMART COUPONS suggestion (mock-first, CONTRACT-ADDITIONS.md #26): re-rank
  // the loaded wallet coupons for the current cart whenever the cart, the
  // merchant or the wallet changes. Non-blocking: a failure (or a live
  // backend without the mock-only POST /coupons/suggest path) silently hides
  // the chip — the manual selector below stays the source of truth.
  useEffect(() => {
    if (!COUPON_CHECKOUT_ENABLED || !merchant || merchant.items.length === 0 || coupons.length === 0) {
      setSuggestedCoupon(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const applicable = coupons.filter((c) => (c.minimumSpendTZS ?? 0) <= subtotal);
        if (applicable.length === 0) {
          if (!cancelled) setSuggestedCoupon(null);
          return;
        }
        const best = await getCouponsRepository().suggestForCart({
          merchantId: merchant.merchantId,
          subtotalTZS: subtotal,
          couponIds: applicable.map((c) => c.id),
        });
        if (!cancelled) setSuggestedCoupon(best);
      } catch {
        if (!cancelled) setSuggestedCoupon(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [merchant, subtotal, coupons]);

  // Split sheet live validation: every custom share needs a non-empty label,
  // an integer amount ≥ 1, and the shares must sum EXACTLY to the order
  // total (the server enforces the same rules on createSplit — 422).
  const splitDraftError = (): string => {
    if (splitMode === 'people') return '';
    if (customShares.length < 2) return t('split.totalMustMatch');
    if (customShares.some((s) => s.label.trim().length === 0)) return t('split.labelRequired');
    const amounts = customShares.map((s) => Number(s.amount.trim()));
    if (amounts.some((a) => !Number.isInteger(a) || a < 1)) return t('split.amountRequired');
    const sum = amounts.reduce((acc, a) => acc + a, 0);
    if (sum !== previewTotal) return t('split.totalMustMatch');
    return '';
  };
  const splitSum = splitMode === 'people' ? previewTotal : customShares.reduce((acc, s) => acc + (Number(s.amount.trim()) || 0), 0);
  const confirmSplitDraft = () => {
    const err = splitDraftError();
    setSplitSheetError(err);
    if (err) return;
    setSplitDraft(
      splitMode === 'people'
        ? evenShares(previewTotal, splitPeople)
        : customShares.map((s) => ({ label: s.label.trim(), amountTZS: Number(s.amount.trim()) })),
    );
    setSplitSheet(false);
  };
  const updateCustomShare = (i: number, patch: Partial<{ label: string; amount: string }>) => {
    setCustomShares((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setSplitSheetError('');
  };
  const addCustomShare = () => {
    setCustomShares((rows) => [...rows, { label: '', amount: '' }]);
    setSplitSheetError('');
  };
  const removeCustomShare = (i: number) => {
    setCustomShares((rows) => rows.filter((_, idx) => idx !== i));
    setSplitSheetError('');
  };

  const placeOrder = async (retryIntentId?: string) => {
    if (!merchant) return;
    if (!selectedAddress) {
      setError(t('checkout.noAddress'));
      return;
    }
    track({ name: 'checkout_started', merchantId: merchant.merchantId });
    setError('');
    setScheduleError('');
    setRefundBanner(false);
    setRetryAfter(0);
    setSubmitting(true);
    const attemptKey = idempotencyKey(user?.id ?? 'customer', 'order');
    // Intent → confirm, with a single PAYMENT_INTENT_NOT_FOUND recovery:
    // recreate the intent and refetch the order (PAYMENTS.md) instead of
    // erroring out or reloading coupons.
    const runPayment = async (order: Order, intentId: string | undefined, depth: number): Promise<void> => {
      setProcessing(true);
      try {
        const intent = intentId
          ? { id: intentId, status: 'created' as const, amountTZS: order.totals.totalTZS, method }
          : await getPaymentsRepository().createIntent(order.id, method, idempotencyKey(user?.id ?? 'customer', 'intent'));
        setPendingIntentId(intent.id);
        const paid = await getPaymentsRepository().confirm(intent.id, idempotencyKey(user?.id ?? 'customer', 'confirm'));
        if (paid.status === 'paid') {
          toast(t('checkout.paymentSuccess'));
          clearGroup(merchant.merchantId);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.replace(`/order/confirmation/${order.id}`);
          return;
        }
        setError(t('common.error'));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'PAYMENT_INTENT_NOT_FOUND' && depth === 0) {
          const fresh = await getOrdersRepository().get(order.id);
          setPlacedOrder(fresh);
          await runPayment(fresh, undefined, 1);
          return;
        }
        throw e;
      } finally {
        setProcessing(false);
      }
    };
    try {
      const order = await getOrdersRepository().create(
        {
          merchantId: merchant.merchantId,
          items: merchant.items.map((i) => ({
            catalogueItemId: i.catalogueItemId,
            quantity: i.quantity,
            // Option keys = choice labels + addon names; the server prices
            // them from the catalogue (unitPriceTZS sent is the BASE price).
            options: [...(i.options ?? []).map((o) => o.choice).filter((c): c is string => !!c), ...(i.addons ?? [])],
          })),
          paymentMethod: method,
          deliveryAddress: selectedAddress,
          note: merchant.items.map((i) => i.note).find(Boolean),
          scheduledAt: scheduleOn ? scheduledAt : null,
          // Mock-first (CONTRACT-ADDITIONS.md #10): couponId rides OrderCreate;
          // the mock validates + applies it server-side, a live backend that
          // has not shipped the field ignores it.
          couponId: appliedCoupon?.id,
        },
        attemptKey,
      );
      setPlacedOrder(order);
      track({ name: 'order_created', orderId: order.id, status: order.status });
      toast(scheduleOn ? t('checkout.orderScheduled') : t('checkout.orderPlaced'));
      // Split payment (mock-first, CONTRACT-ADDITIONS.md #22): the split is
      // created AFTER the order with the order id, then MY share is paid via
      // the normal intent flow (payMyShare drives create → confirm → webhook
      // server-side, scoped to the share amount). Success lands on the split
      // summary — co-payer shares are pre-paid in the mock (simulated
      // payers), so the split can complete there.
      if (splitOn && splitDraft && method !== 'cod') {
        const splitRepo = getSplitPaymentsRepository();
        const plan = await splitRepo.createSplit(
          { orderId: order.id, shares: splitDraft },
          idempotencyKey(user?.id ?? 'customer', 'split'),
        );
        setProcessing(true);
        try {
          await splitRepo.payMyShare(plan.id, method, idempotencyKey(user?.id ?? 'customer', 'split-pay'));
        } finally {
          setProcessing(false);
        }
        toast(t('checkout.paymentSuccess'));
        clearGroup(merchant.merchantId);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/splits/${plan.id}`);
        return;
      }
      if (method === 'cod') {
        clearGroup(merchant.merchantId);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/order/confirmation/${order.id}`);
        return;
      }
      // POST /payments/intent → provider flow (STK push wait state) → confirm.
      await runPayment(order, retryIntentId, 0);
    } catch (e) {
      setSubmitting(false);
      setProcessing(false);
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'ORDER_MERCHANT_CLOSED':
            setError(t('merchant.closed'));
            break;
          case 'ORDER_SCHEDULED_IN_PAST':
            setScheduleError(t('checkout.scheduledInPast'));
            setScheduleOn(true);
            break;
          case 'ORDER_ITEM_UNAVAILABLE':
          case 'ORDER_PRICE_CHANGED':
            // Server state wins — refresh the catalogue and let the customer adjust.
            setError(e.code === 'ORDER_ITEM_UNAVAILABLE' ? t('cart.unavailable') : t('cart.priceChanged'));
            useCartStore.getState().clearGroup(merchant.merchantId);
            break;
          case 'ORDER_EMPTY':
            // Nothing to check out — drop the (empty) group; the empty-cart
            // state renders.
            useCartStore.getState().clearGroup(merchant.merchantId);
            break;
          case 'PAYMENT_ALREADY_PAID':
            clearGroup(merchant.merchantId);
            if (placedOrder) router.replace(`/order/confirmation/${placedOrder.id}`);
            break;
          case 'PAYMENT_PROVIDER_ERROR': {
            const seconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 10;
            setRetryAfter(seconds);
            setError(t('checkout.paymentFailed', { s: seconds }));
            break;
          }
          case 'PAYMENT_INTENT_NOT_FOUND':
            // Recreate + refetch happened inside runPayment; a second miss is
            // genuinely broken — surface the generic error.
            setError(t('common.error'));
            break;
          case 'PAYMENT_AMOUNT_MISMATCH':
            setError(t('cart.priceChanged'));
            break;
          case 'PAYMENT_METHOD_UNSUPPORTED':
            // Disable this method chip; switch to the next supported one.
            setBlockedMethods((prev) => new Set(prev).add(method));
            setError('');
            break;
          case 'PAYMENT_REFUND_PENDING':
            setRefundBanner(true);
            setError('');
            break;
          case 'PAYMENT_SIGNATURE_INVALID':
            setError(t('checkout.signatureInvalid'));
            break;
          case 'COUPON_MINIMUM_SPEND_NOT_MET':
            // Server authority on the spend rule — clear the coupon so the
            // selector re-offers the valid ones (WALLET-COUPONS.md).
            setAppliedCoupon(null);
            setError(t('coupons.minSpend', { amount: formatTZS(appliedCoupon?.minimumSpendTZS ?? 0) }));
            break;
          case 'COUPON_EXPIRED':
          case 'COUPON_ALREADY_USED':
            setAppliedCoupon(null);
            setError(t('checkout.couponUnavailable'));
            break;
          default:
            setError(t('common.error'));
        }
      } else {
        setError(t('common.error'));
      }
    }
  };

  // UNIVERSAL CHECKOUT SHELL (MASTER-BLUEPRINT §12): non-commerce transaction
  // types dispatch here — the shared header + a thin per-type shell. Each
  // shell reuses the entity's existing pay path (or honestly defers to the
  // entity detail when no pay path exists); the order flow below is untouched.
  if (transactionType !== 'commerce') {
    return (
      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('checkout.title')}</Text>
        </Row>
        <View style={{ alignItems: 'center', marginBottom: Spacing.md }}>
          <View style={styles.typeChip}>
            <Text style={styles.typeChipText}>{t(TYPE_LABEL[transactionType])}</Text>
          </View>
        </View>
        {transactionType === 'booking' || transactionType === 'service' ? (
          bookingId ? (
            <BookingCheckoutShell bookingId={bookingId} />
          ) : (
            <EmptyState icon="receipt-outline" title={t('checkout.fromDetail')} actionLabel={t('common.back')} onAction={() => router.back()} />
          )
        ) : transactionType === 'hotel' ? (
          hotelBookingId ? (
            <HotelCheckoutShell hotelBookingId={hotelBookingId} />
          ) : (
            <EmptyState icon="receipt-outline" title={t('checkout.fromDetail')} actionLabel={t('common.back')} onAction={() => router.back()} />
          )
        ) : (
          <EmptyState icon="receipt-outline" title={t('checkout.fromDetail')} actionLabel={t('common.back')} onAction={() => router.back()} />
        )}
      </Screen>
    );
  }

  if (!merchant || merchant.items.length === 0) {
    return (
      <Screen>
        <EmptyState icon="cart-outline" title={t('cart.empty')} actionLabel={t('cart.browse')} onAction={() => router.replace('/cart')} />
      </Screen>
    );
  }

  const breakdownRows = [
    { label: t('breakdown.subtotal'), amountTZS: preview.subtotalTZS },
    { label: t('breakdown.delivery'), amountTZS: preview.deliveryFeeTZS },
    { label: t('breakdown.platform'), amountTZS: preview.platformFeeTZS },
    { label: t('breakdown.tax'), amountTZS: preview.taxTZS },
    { label: t('breakdown.discount'), amountTZS: preview.discountTZS, signed: true },
  ];

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('checkout.title')}</Text>
      </Row>

      {/* Address */}
      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.address')}</Text>
        {selectedAddress ? (
          <Pressable onPress={() => setAddressSheet(true)} accessibilityRole="button">
            <Row gap={Spacing.md}>
              <Icon name="location" size={18} color={Colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>{selectedAddress.label} — {selectedAddress.lines}</Text>
                <Text style={styles.meta}>{selectedAddress.landmark}</Text>
              </View>
              <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
            </Row>
          </Pressable>
        ) : (
          <Btn label={t('checkout.noAddress')} onPress={() => router.push('/addresses')} variant="ghost" size="sm" />
        )}
      </Card>

      {/* Payment method — list comes from GET /payments/methods */}
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

      {/* Split payment (mock-first, CONTRACT-ADDITIONS.md #22): one order,
          multiple payers. The toggle opens the share-definition sheet; the
          split is created after the order and MY share is paid through the
          normal intent flow. Hidden for COD — cash cannot be split. */}
      {method !== 'cod' ? (
        <Card style={styles.section}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: Spacing.lg }}>
              <Text style={styles.sectionLabel}>{t('split.enable')}</Text>
              <Text style={styles.meta}>{t('split.copayerNote')}</Text>
            </View>
            <Switch
              value={splitOn}
              onValueChange={(v) => {
                setSplitOn(v);
                setSplitSheetError('');
                if (v) setSplitSheet(true);
              }}
              trackColor={{ false: Colors.borderStrong, true: Colors.primary }}
              thumbColor={Colors.white}
              accessibilityLabel={t('split.enable')}
            />
          </Row>
          {splitOn ? (
            <Pressable onPress={() => setSplitSheet(true)} accessibilityRole="button">
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
                <Text style={styles.value}>{t('split.title')}</Text>
                <Text style={styles.meta}>{splitDraft ? splitDraft.length.toString() : t('split.people')} ›</Text>
              </Row>
            </Pressable>
          ) : null}
        </Card>
      ) : null}

      {/* Schedule for later (ORDER-FLOW) — server enforces the window */}
      <Card style={styles.section}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1, paddingRight: Spacing.lg }}>
            <Text style={styles.sectionLabel}>{t('checkout.scheduleTitle')}</Text>
            <Text style={styles.meta}>{t('checkout.scheduleHint')}</Text>
          </View>
          <Switch
            value={scheduleOn}
            onValueChange={(v) => {
              setScheduleOn(v);
              setScheduleError('');
              if (!v) setScheduledAt(null);
            }}
            trackColor={{ false: Colors.borderStrong, true: Colors.primary }}
            thumbColor={Colors.white}
            accessibilityLabel={t('checkout.scheduleTitle')}
          />
        </Row>
        {scheduleOn ? (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
              {scheduleSlots().map((slot) => (
                <Pressable
                  key={slot.key}
                  onPress={() => {
                    setScheduledAt(slot.iso);
                    setScheduleError('');
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: scheduledAt === slot.iso }}
                  style={[styles.slotChip, scheduledAt === slot.iso && styles.slotChipSelected]}>
                  <Text style={[styles.slotChipText, scheduledAt === slot.iso && { color: Colors.white, fontFamily: Fonts.sansBold }]}>{slot.label}</Text>
                </Pressable>
              ))}
            </View>
            {scheduledAt ? <Text style={styles.meta}>{t('checkout.scheduledFor', { t: fullTimeISO(scheduledAt) })}</Text> : null}
            {scheduleError ? <Text style={styles.errorText}>{scheduleError}</Text> : null}
          </View>
        ) : null}
      </Card>

      {/* Coupon — mock-first selector (CONTRACT-ADDITIONS.md #10): the mock
          honors couponId on order create (server-side validation + discount);
          a live backend ignores the field until the contract ships it. The
          suggestion chip above it is the SMART COUPONS hint (#26): the server
          picks the best applicable wallet coupon for this cart; tapping it
          applies the same coupon the selector would (reuses applyCoupon). */}
      {COUPON_CHECKOUT_ENABLED ? (
        <Card style={styles.section}>
          {suggestedCoupon && suggestedCoupon.id !== appliedCoupon?.id ? (
            <Pressable
              onPress={() => applyCoupon(suggestedCoupon)}
              accessibilityRole="button"
              accessibilityLabel={t('coupons.applySuggested')}
              style={styles.suggestChip}>
              <Icon name="pricetag" size={14} color={Colors.primaryDeep} />
              <Text style={styles.suggestChipText}>
                {t('coupons.suggested', { title: suggestedCoupon.title ?? suggestedCoupon.code, amount: formatTZS(suggestedCoupon.discountTZS ?? 0) })}
              </Text>
              <Text style={styles.suggestChipApply}>{t('coupons.applySuggested')}</Text>
            </Pressable>
          ) : null}
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.sectionLabel}>{t('checkout.coupon')}</Text>
            <Pressable onPress={() => setCouponSheet(true)} hitSlop={8} accessibilityRole="button">
              <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansBold }}>
                {appliedCoupon ? appliedCoupon.title ?? appliedCoupon.code : coupons.length > 0 ? `${coupons.length} ${t('coupons.title')}` : ''}
              </Text>
            </Pressable>
          </Row>
          {appliedCoupon ? (
            <Text style={styles.meta}>
              {appliedCoupon.code} — {t('breakdown.discount')} {formatTZS(appliedCoupon.discountTZS ?? 0)}
            </Text>
          ) : null}
          {couponError ? <Text style={styles.errorText}>{couponError}</Text> : null}
        </Card>
      ) : null}

      {/* Review total — PriceBreakdown rendered before every confirm */}
      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.reviewTotal')}</Text>
        <PriceBreakdown rows={breakdownRows} totalTZS={previewTotal} totalLabel={t('breakdown.total')} />
      </Card>

      {error ? <ErrorState message={error} /> : null}

      {refundBanner ? (
        <Card style={[styles.section, { backgroundColor: Colors.infoSoft }]}>
          <Row gap={Spacing.md}>
            <Icon name="sync-circle-outline" size={18} color={Colors.info} />
            <Text style={{ color: Colors.info, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>
              {t('checkout.refundPending')}
            </Text>
          </Row>
        </Card>
      ) : null}

      {processing && method !== 'cod' ? (
        <Card style={[styles.section, { backgroundColor: Colors.primarySoft }]}>
          <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center' }}>
            {t('checkout.stkPush', { method: method.toUpperCase().replace('_', ' ') })}
          </Text>
        </Card>
      ) : null}
      <Btn
        label={processing ? '…' : retryAfter > 0 ? t('checkout.paymentFailed', { s: retryAfter }) : t('checkout.pay', { amount: formatTZS(previewTotal) })}
        onPress={processing ? undefined : () => placeOrder(pendingIntentId ?? undefined)}
        size="lg"
        loading={submitting || processing}
        disabled={!selectedAddress || subtotal <= 0 || retryAfter > 0 || (scheduleOn && !scheduledAt)}
        style={{ marginTop: Spacing.md }}
      />

      <SheetModal visible={addressSheet} onClose={() => setAddressSheet(false)} title={t('checkout.address')}>
        {addresses.length === 0 ? (
          <EmptyState icon="location-outline" title={t('addresses.empty')} />
        ) : (
          addresses.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => {
                useAddressesStore.getState().select(a.id);
                setAddressSheet(false);
              }}
              style={[styles.methodRow, a.id === selectedAddress?.id && styles.methodSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: a.id === selectedAddress?.id }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>{a.label} — {a.lines}</Text>
                <Text style={styles.meta}>{a.landmark}</Text>
              </View>
              <Icon name={a.id === selectedAddress?.id ? 'radio-button-on' : 'radio-button-off'} size={18} color={a.id === selectedAddress?.id ? Colors.primary : Colors.borderStrong} />
            </Pressable>
          ))
        )}
        <Btn label={t('addresses.add')} onPress={() => router.push('/addresses')} variant="ghost" />
      </SheetModal>

      <SheetModal visible={couponSheet} onClose={() => setCouponSheet(false)} title={t('checkout.coupon')}>
        {coupons.length === 0 ? (
          <EmptyState icon="pricetag-outline" title={t('checkout.noCoupons')} />
        ) : (
          coupons.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => applyCoupon(c)}
              style={[styles.methodRow, appliedCoupon?.id === c.id && styles.methodSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: appliedCoupon?.id === c.id }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>{c.title ?? c.code}</Text>
                <Text style={styles.meta}>{t('coupons.validUntil', { t: dateISO(c.expiresAt) })}</Text>
              </View>
              <MoneyText amountTZS={c.discountTZS ?? 0} size={FontSize.sm} />
            </Pressable>
          ))
        )}
      </SheetModal>

      {/* Split payment sheet — define the shares: even split across 2/3/4
          people, or custom rows (label + amount). Live validation: labels
          non-empty, amounts integer ≥ 1, and the shares must sum to the
          order total (the mock re-validates server-side at createSplit). */}
      <SheetModal visible={splitSheet} onClose={() => setSplitSheet(false)} title={t('split.title')}>
        <Segmented<'people' | 'custom'>
          options={[
            { key: 'people', label: t('split.people') },
            { key: 'custom', label: t('split.custom') },
          ]}
          value={splitMode}
          onChange={(m) => {
            setSplitMode(m);
            setSplitSheetError('');
          }}
        />
        {splitMode === 'people' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
            {([2, 3, 4] as const).map((n) => (
              <Pressable
                key={n}
                onPress={() => {
                  setSplitPeople(n);
                  setSplitSheetError('');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: splitPeople === n }}
                style={[styles.slotChip, splitPeople === n && styles.slotChipSelected]}>
                <Text style={[styles.slotChipText, splitPeople === n && { color: Colors.white, fontFamily: Fonts.sansBold }]}>{n}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <>
            <View style={{ gap: Spacing.sm }}>
              {customShares.map((share, i) => (
                <Row key={i} style={{ gap: Spacing.sm }}>
                  <View style={{ flex: 2 }}>
                    <TextInput
                      value={share.label}
                      onChangeText={(v) => updateCustomShare(i, { label: v })}
                      placeholder={t('split.shareLabel')}
                      placeholderTextColor={Colors.textFaint}
                      accessibilityLabel={`${t('split.shareLabel')} ${i + 1}`}
                      style={styles.splitInput}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <TextInput
                      value={share.amount}
                      onChangeText={(v) => updateCustomShare(i, { amount: v.replace(/[^0-9]/g, '') })}
                      placeholder={t('split.shareAmount')}
                      placeholderTextColor={Colors.textFaint}
                      keyboardType="number-pad"
                      accessibilityLabel={`${t('split.shareAmount')} ${i + 1}`}
                      style={styles.splitInput}
                    />
                  </View>
                  {customShares.length > 2 ? (
                    <Pressable
                      onPress={() => removeCustomShare(i)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('split.removeShare')}
                      style={styles.splitRemove}>
                      <Icon name="trash-outline" size={15} color={Colors.danger} />
                    </Pressable>
                  ) : null}
                </Row>
              ))}
            </View>
            <Btn label={t('split.addShare')} onPress={addCustomShare} variant="ghost" size="sm" icon="add" />
          </>
        )}
        <Card style={styles.section}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('breakdown.total')}</Text>
            <MoneyText amountTZS={previewTotal} size={FontSize.sm} />
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('split.shares')}</Text>
            <MoneyText amountTZS={splitSum} size={FontSize.sm} />
          </Row>
          {splitSheetError ? <Text style={styles.errorText}>{splitSheetError}</Text> : null}
        </Card>
        <Btn
          label={t('common.done')}
          onPress={confirmSplitDraft}
          disabled={splitSum !== previewTotal || splitDraftError() !== ''}
        />
      </SheetModal>
    </Screen>
  );
}

/* UNIVERSAL CHECKOUT SHELL — booking/service dispatch. Renders the shared
 * payment-method section + the booking's own server-side price breakdown,
 * then pays through the same intent → confirm path as the booking detail
 * "Pay now" and book.tsx: the booking was created pending_payment with a
 * linked intent, and createIntent is idempotent (returns that intent). On
 * success we land on the booking detail, where the server state shows. */
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
          // Smart default (§37): pre-select the server default (isDefault).
          const preferred = pickDefaultMethod(list);
          if (preferred) setMethod(preferred.method as MethodKey);
        }
      })
      .catch(() => setMethods(FALLBACK_METHODS));
  }, [bookingId]);

  // PAYMENT_PROVIDER_ERROR retry countdown (PAYMENTS.md) — never an instant
  // hammer on the provider.
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  // Intent → confirm with the same recovery vocabulary as the booking detail
  // pay: a linked intent rides the wire (mock-only); otherwise createIntent is
  // idempotent. PAYMENT_INTENT_NOT_FOUND clears the cached id so the next
  // attempt recreates it (PAYMENTS.md).
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
            // The server says this booking is settled — land on its detail.
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
        { label: t('breakdown.discount'), amountTZS: price.discountTZS, signed: true },
      ]
    : [];
  const totalTZS = price?.totalTZS ?? 0;

  return (
    <>
      {/* Payment method — same list as the order flow (GET /payments/methods) */}
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

      {/* Review total — the booking's own server-side price (advisory preview) */}
      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.reviewTotal')}</Text>
        <PriceBreakdown rows={priceRows} totalTZS={totalTZS} totalLabel={t('breakdown.total')} />
      </Card>

      {booking.status !== 'pending_payment' ? (
        // Not awaiting payment (paid/cancelled/…): the detail screen owns the
        // state — point there instead of offering a stale pay button.
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

/* UNIVERSAL CHECKOUT SHELL — hotel dispatch. Hotel bookings have no payment
 * surface in the app yet (the contract ships no hotel payment endpoint), so
 * the shell resolves the booking and honestly points at its detail screen
 * instead of inventing a pay flow. */
function HotelCheckoutShell({ hotelBookingId }: { hotelBookingId: string }) {
  const router = useRouter();
  const [booking, setBooking] = useState<HotelBooking | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    setBooking(null);
    try {
      const mine = await getHotelsRepository().listMyBookings();
      const found = mine.find((b) => b.id === hotelBookingId);
      if (!found) {
        setLoadError(t('hotels.bookingNotFound'));
        return;
      }
      setBooking(found);
    } catch {
      setLoadError(t('common.error'));
    }
  }, [hotelBookingId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!booking) {
    return (
      <View style={{ gap: Spacing.md }}>
        <SkeletonCard rows={2} />
        <SkeletonCard rows={2} />
      </View>
    );
  }

  return (
    <>
      {/* Review total — the hotel booking's server-side total */}
      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.reviewTotal')}</Text>
        <PriceBreakdown
          rows={[{ label: `${booking.hotelName ?? booking.hotelId} — ${t('hotels.nights', { n: booking.nights ?? 1 })}`, amountTZS: booking.totalTZS }]}
          totalTZS={booking.totalTZS}
          totalLabel={t('breakdown.total')}
        />
      </Card>
      <EmptyState
        icon="bed-outline"
        title={t('checkout.fromDetail')}
        actionLabel={t('common.view')}
        onAction={() => router.push(`/hotel-bookings/${booking.id}`)}
      />
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
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  slotChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  slotChipSelected: { borderColor: Colors.ink, backgroundColor: Colors.ink },
  slotChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  // SMART COUPONS suggestion chip (MASTER-BLUEPRINT §16): advisory pill above
  // the coupon selector — the server's best applicable coupon for this cart.
  suggestChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  suggestChipText: { flex: 1, fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold },
  suggestChipApply: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  splitInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    fontSize: FontSize.sm,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
  },
  splitRemove: { width: 34, height: 34, borderRadius: 17, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
});
