import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  PriceBreakdown,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { getConversationsRepository, getMembershipsRepository, getOrdersRepository, getPaymentsRepository, type OrderPaymentIntent } from '@/repos';
import { useCartStore } from '@/store/cart';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { OrderDetail } from '@hudumika/contract';
import { RequestOrderModificationBodyType, TipRiderBodyMethod } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { formatTZS } from '@/lib/format';
import { isActiveOrder, isCancellable, isReviewable, isRushable } from '@/lib/order';
import { buildSharePayload, shareContent } from '@/lib/share';

/** Contract RequestOrderModificationBody.type values, in UI order. */
const MODIFY_TYPES: RequestOrderModificationBodyType[] = [
  RequestOrderModificationBodyType.change_address,
  RequestOrderModificationBodyType.change_time,
  RequestOrderModificationBodyType.add_item,
  RequestOrderModificationBodyType.remove_item,
  RequestOrderModificationBodyType.other,
];

/** Quick tip presets — the sheet also accepts a custom amount. */
const TIP_AMOUNTS = [1000, 2000, 5000, 10000];

/** Contract TipRiderBodyMethod values — validated server-side; the UI renders
 * the enum exactly (422 VALIDATION_FAILED for anything else). */
const TIP_METHODS: TipRiderBodyMethod[] = Object.values(TipRiderBodyMethod);

/** Method label — i18n where the payments namespace has the label, else the
 * enum pretty-printed ('tigo_pesa' → 'Tigo Pesa', wallet → 'Wallet'). */
const METHOD_LABELS: Record<TipRiderBodyMethod, string> = {
  mpesa: t('payments.mpesa'),
  tigo_pesa: t('payments.tigoPesa'),
  airtel_money: t('payments.airtelMoney'),
  ezy_pesa: t('payments.ezyPesa'),
  halotel: t('payments.halotel'),
  card: t('payments.card'),
  cod: t('payments.cod'),
  wallet: 'Wallet',
};
function tipMethodLabel(method: TipRiderBodyMethod): string {
  return METHOD_LABELS[method];
}

export default function OrderDetailScreen() {
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [intent, setIntent] = useState<OrderPaymentIntent | null>(null);
  const [error, setError] = useState('');
  const [cancelSheet, setCancelSheet] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [actionError, setActionError] = useState('');
  const [modifySheet, setModifySheet] = useState(false);
  const [modifyType, setModifyType] = useState<RequestOrderModificationBodyType | null>(null);
  const [modifyNote, setModifyNote] = useState('');
  const [modifyError, setModifyError] = useState('');
  const [modifying, setModifying] = useState(false);
  // Tip sheet — amount chips + custom field, method chips, optional note.
  const [tipSheet, setTipSheet] = useState(false);
  const [tipAmount, setTipAmount] = useState<number | null>(null);
  const [tipCustom, setTipCustom] = useState('');
  const [tipMethod, setTipMethod] = useState<TipRiderBodyMethod>('wallet');
  const [tipNote, setTipNote] = useState('');
  const [tipError, setTipError] = useState('');
  const [tipping, setTipping] = useState(false);
  // Points earned on this order (P6d, docs/CONTRACT-ADDITIONS.md #28): the
  // mock awards 1 pt per TZS 1,000 on paid orders; the pill renders on
  // delivered/completed orders when the accrual engine recorded an award.
  const [earnedPoints, setEarnedPoints] = useState<number | null>(null);
  const user = useSessionStore((s) => s.user);

  const load = useCallback(async () => {
    setError('');
    let detail: OrderDetail | null = null;
    try {
      detail = await getOrdersRepository().get(orderId);
      setOrder(detail);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setError(t('order.title'));
      } else {
        setError(t('common.error'));
      }
      return;
    }
    // Earn pill is best-effort — the getter is mock-only (the live repo
    // returns null until the contract ships the accrual surface).
    if (detail && (detail.status === 'delivered' || detail.status === 'completed')) {
      try {
        const earnings = await getMembershipsRepository().earningsFor(detail.id);
        setEarnedPoints(earnings?.points ?? null);
      } catch {
        setEarnedPoints(null);
      }
    } else {
      setEarnedPoints(null);
    }
    // Intent lookup is best-effort — the order itself already rendered.
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

  const cancel = async () => {
    setCancelError('');
    try {
      await getOrdersRepository().cancel(orderId, cancelReason.trim(), idempotencyKey(user?.id ?? 'customer', 'cancel'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCancelSheet(false);
      load();
    } catch (e) {
      setCancelError(e instanceof ApiError ? e.message : t('common.error'));
      load(); // 409 → refetch (server state wins)
    }
  };

  const rush = async () => {
    setActionError('');
    try {
      await getOrdersRepository().rush(orderId, idempotencyKey(user?.id ?? 'customer', 'rush'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ORDER_RUSH_NOT_ALLOWED') {
        setActionError(t('common.error'));
        load();
      } else {
        setActionError(t('common.error'));
      }
    }
  };

  const requestModify = async () => {
    setModifyError('');
    if (!modifyType) {
      setModifyError(t('order.modify.needType'));
      return;
    }
    setModifying(true);
    try {
      await getOrdersRepository().modifyRequest(
        orderId,
        { type: modifyType, note: modifyNote.trim() },
        idempotencyKey(user?.id ?? 'customer', 'modify-request'),
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('order.modify.success'));
      setModifySheet(false);
      setModifyType(null);
      setModifyNote('');
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ORDER_MODIFICATION_NOT_ALLOWED') {
        setModifyError(t('order.modify.notAllowed'));
        load(); // 409 → refetch (server state wins)
      } else if (e instanceof ApiError && e.code === 'ORDER_MODIFICATION_PENDING') {
        setModifyError(t('order.modify.pending'));
      } else if (e instanceof ApiError && e.code === 'INTERNAL_ERROR') {
        setModifyError(t('error.generic'));
      } else {
        setModifyError(t('order.modify.failed'));
      }
    } finally {
      setModifying(false);
    }
  };

  const sendTip = async () => {
    const custom = Number(tipCustom.trim());
    const amountTZS = tipCustom.trim() ? custom : tipAmount;
    if (!amountTZS || !Number.isInteger(amountTZS) || amountTZS < 1) {
      setTipError(t('order.tipAmountRequired'));
      return;
    }
    setTipping(true);
    setTipError('');
    try {
      await getOrdersRepository().tip(
        orderId,
        { amountTZS, method: tipMethod, note: tipNote.trim() || undefined },
        idempotencyKey(user?.id ?? 'customer', 'tip'),
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('order.tipSent', { amount: formatTZS(amountTZS) }));
      setTipSheet(false);
      setTipAmount(null);
      setTipCustom('');
      setTipMethod('wallet');
      setTipNote('');
      load();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'TIP_NOT_ALLOWED' || e.code === 'CONFLICT')) {
        toast(t('order.tipUnavailable'));
        load(); // 409 → refetch (server state wins)
      } else {
        setTipError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setTipping(false);
    }
  };

  const reorder = () => {
    if (!order) return;
    const merchantId = order.merchantId;
    const merchantName = t('common.merchant');
    const cart = useCartStore.getState();
    for (const item of order.items ?? []) {
      // The cart preview carries the paid line price (options included); at
      // checkout only catalogueItemId+quantity+options are sent, so the
      // server validates against the BASE catalogue price (ORDER_PRICE_CHANGED)
      // and reprices options from the catalogue.
      cart.addItem(
        { merchantId, merchantName },
        { catalogueItemId: item.catalogueItemId, name: item.name, unitPriceTZS: item.unitPriceTZS, quantity: item.quantity },
      );
    }
    router.push('/cart');
  };

  const openChat = async () => {
    if (!order) return;
    try {
      const conversation = await getConversationsRepository().create(
        {
          merchantId: order.merchantId,
          orderId: order.id,
          subject: `${t('order.title')} ${order.no ?? order.id} ${t('support.create').toLowerCase()}`.slice(0, 160),
          initialMessage: t('order.chat'),
        },
        idempotencyKey(user?.id ?? 'customer', 'conv'),
      );
      router.push(`/messages/${conversation.id}`);
    } catch {
      setActionError(t('common.error'));
    }
  };

  // Share sheet (#138): message + hudumika://order/{id} deep link; on web it
  // copies to the clipboard, and if no share surface exists the button
  // reports failure (the link is already visible on the screen).
  const shareOrder = async () => {
    if (!order) return;
    const shared = await shareContent(
      buildSharePayload({
        kind: 'order',
        id: order.id,
        title: order.no ?? order.id,
        detail: `${t(`status.${order.status}` as I18nKey)} · ${formatTZS(order.totals.totalTZS)}`,
      }),
    );
    if (!shared) toast(t('share.failed'));
  };

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
          <SkeletonCard rows={2} />
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  const isActive = isActiveOrder(order.status);
  const reviewable = isReviewable(order.status);
  const rushable = isRushable(order.status);
  const canCancel = isCancellable(order.status);
  // Contract Order.tipTZS — set once a tip is recorded (the UI hides the CTA
  // and renders the confirmed state instead; the server rejects a second tip).
  const tipTZS = order.tipTZS ?? 0;
  const tipped = tipTZS > 0;
  const intentRefunded = intent?.status === 'refunded' || intent?.status === 'partially_refunded';
  const partiallyRefunded = intent?.status === 'partially_refunded';
  // Refund card: refunded orders, or cancelled/others with a refunded intent.
  const refunded = order.status === 'refunded' || intentRefunded;
  const refundAmountTZS = intent?.amountTZS ?? order.totals.totalTZS;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Row gap={Spacing.sm}>
            <StatusPill status={order.status} />
            <Btn label={t('share.order')} onPress={shareOrder} variant="subtle" size="sm" icon="share-social-outline" />
          </Row>
        </Row>

        {order.status === 'disputed' ? (
          <Card style={[styles.banner, { backgroundColor: Colors.warningSoft }]}>
            <Row gap={Spacing.sm}>
              <Icon name="shield-checkmark" size={16} color={Colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: Colors.warning, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>
                  {t('order.disputedBanner')}
                </Text>
                <Pressable
                  onPress={() => router.push('/disputes')}
                  accessibilityRole="button"
                  accessibilityLabel={t('order.disputedCta')}
                  hitSlop={8}>
                  <Text style={{ color: Colors.warning, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, marginTop: 4, textDecorationLine: 'underline' }}>
                    {t('order.disputedCta')}
                  </Text>
                </Pressable>
              </View>
            </Row>
          </Card>
        ) : null}

        {order.rejectReason ? (
          <Card style={[styles.banner, { backgroundColor: Colors.dangerSoft }]}>
            <Row gap={Spacing.sm}>
              <Icon name="alert-circle" size={16} color={Colors.danger} />
              <Text style={{ color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>{order.rejectReason}</Text>
            </Row>
          </Card>
        ) : null}

        {order.fulfillmentSource === 'warehouse' ? (
          <Card style={[styles.banner, { backgroundColor: Colors.primarySoft }]}>
            <Row gap={Spacing.sm}>
              <Icon name="cube" size={16} color={Colors.primaryDeep} />
              <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>
                {t('order.warehouseChip')}
              </Text>
            </Row>
          </Card>
        ) : null}

        <Card>
          <Text style={styles.orderNo}>{order.no ?? order.id}</Text>
          <Text style={styles.meta}>{dateISO(order.createdAt)}</Text>
          {order.scheduledAt ? (
            <Text style={styles.meta}>{t('order.scheduled', { t: dateISO(order.scheduledAt) })}</Text>
          ) : null}
          {order.rushRequestedAt ? (
            <Text style={styles.meta}>{t('order.rushed')} · {dateISO(order.rushRequestedAt)}</Text>
          ) : null}
          {order.fulfillmentType === 'intercity' ? (
            <Row gap={4} style={{ marginTop: Spacing.sm }}>
              <Pill label={order.fulfillmentType} tone="info" />
              {order.waybillNumber ? <Text style={styles.meta}>{order.waybillNumber}</Text> : null}
            </Row>
          ) : null}
        </Card>

        {/* Timeline from events[] */}
        <Text style={styles.section}>{t('track.phases')}</Text>
        <Card style={{ gap: Spacing.md }}>
          {(order.events ?? []).length === 0 ? (
            <EmptyState icon="time-outline" title={t('track.noPhases')} />
          ) : (
            [...(order.events ?? [])]
              .slice()
              .reverse()
              .map((ev, i) => (
                <Row key={`${ev.status}-${i}`} gap={Spacing.md}>
                  <View style={[styles.dot, i === 0 && { backgroundColor: Colors.primary }]} />
                  <View style={{ flex: 1 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <StatusPill status={ev.status} />
                      <Text style={styles.meta}>{dateISO(ev.at)}</Text>
                    </Row>
                    {ev.note ? <Text style={styles.meta}>{ev.note}</Text> : null}
                    {ev.by ? <Text style={styles.meta}>{t('common.by', { actor: ev.by })}</Text> : null}
                  </View>
                </Row>
              ))
          )}
        </Card>

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
          {refunded ? (
            <Card style={{ backgroundColor: Colors.successSoft, marginTop: Spacing.sm }}>
              <Row gap={Spacing.sm}>
                <Icon name="checkmark-circle" size={16} color={Colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansBold }}>
                    {t(partiallyRefunded ? 'order.refundedPartially' : 'order.refunded', { amount: formatTZS(refundAmountTZS) })}
                  </Text>
                  {intent?.providerReference ? (
                    <Text style={styles.meta}>{t('order.refundReference', { ref: intent.providerReference })}</Text>
                  ) : null}
                  {intent?.paidAt ? (
                    <Text style={styles.meta}>{t('order.refundedOn', { t: dateISO(intent.paidAt) })}</Text>
                  ) : null}
                </View>
              </Row>
            </Card>
          ) : null}
        </Card>

        {/* Address */}
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

        {/* Actions */}
        {isActive ? (
          <Btn label={t('order.track')} onPress={() => router.push(`/order/${order.id}/tracking`)} size="lg" icon="navigate" style={{ marginTop: Spacing.lg }} />
        ) : null}
        {order.fulfillmentType === 'intercity' || order.fulfillmentType === 'relay' ? (
          <Btn label={t('shipment.details')} onPress={() => router.push(`/shipment/${order.id}`)} variant="outline" icon="cube-outline" style={{ marginTop: Spacing.md }} />
        ) : null}
        {rushable && !order.rushRequestedAt ? (
          <Btn label={t('order.rush')} onPress={rush} variant="outline" icon="flash" style={{ marginTop: Spacing.md }} />
        ) : null}
        {isActive ? (
          <Btn label={t('order.modify')} onPress={() => setModifySheet(true)} variant="outline" icon="create-outline" style={{ marginTop: Spacing.md }} />
        ) : null}
        {canCancel ? (
          <Btn label={t('order.cancel')} onPress={() => setCancelSheet(true)} variant="danger" style={{ marginTop: Spacing.md }} />
        ) : null}
        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

        {/* Tip — after delivery only; the confirmed state replaces the CTA
            once tipTZS is recorded (server is the authority). */}
        {reviewable ? (
          tipped ? (
            <Card style={[styles.tipCard, { backgroundColor: Colors.successSoft }]}>
              <Row gap={Spacing.sm}>
                <Icon name="heart" size={16} color={Colors.success} />
                <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, flex: 1 }}>
                  {t('order.tipSent', { amount: formatTZS(tipTZS) })}
                </Text>
              </Row>
            </Card>
          ) : (
            <Btn label={t('order.tip')} onPress={() => setTipSheet(true)} variant="outline" icon="heart-outline" style={{ marginTop: Spacing.md }} />
          )
        ) : null}

        {/* Points earned (P6d) — rendered when the mock's accrual engine
            recorded an award for this delivered/completed order (the live
            repo returns null until the contract ships the surface). */}
        {reviewable && earnedPoints !== null && earnedPoints > 0 ? (
          <Card style={[styles.tipCard, { backgroundColor: Colors.successSoft }]}>
            <Row gap={Spacing.sm}>
              <Icon name="ribbon" size={16} color={Colors.success} />
              <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, flex: 1 }}>
                {t('order.pointsEarned', { n: earnedPoints })}
              </Text>
            </Row>
          </Card>
        ) : null}

        <Row style={{ gap: Spacing.md, marginTop: Spacing.lg }}>
          <Btn label={t('order.chat')} onPress={openChat} variant="ghost" style={{ flex: 1 }} />
          <Btn label={t('order.reorder')} onPress={reorder} variant="ghost" style={{ flex: 1 }} />
        </Row>
        <Row style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          <Btn label={t('order.support')} onPress={() => router.push({ pathname: '/support', params: { orderId: order.id } })} variant="subtle" style={{ flex: 1 }} />
          {reviewable ? (
            <Btn label={t('order.review')} onPress={() => router.push({ pathname: '/review', params: { orderId: order.id } })} variant="subtle" style={{ flex: 1 }} />
          ) : null}
        </Row>
      </ScrollView>

      <SheetModal visible={cancelSheet} onClose={() => setCancelSheet(false)} title={t('order.cancelConfirm')}>
        <TextInput
          value={cancelReason}
          onChangeText={setCancelReason}
          placeholder={t('order.cancelReason')}
          placeholderTextColor={Colors.textFaint}
          maxLength={500}
          style={styles.input}
          accessibilityLabel={t('order.cancelReason')}
        />
        {cancelError ? <Text style={styles.actionError}>{cancelError}</Text> : null}
        <Btn label={t('order.cancel')} onPress={cancel} variant="danger" size="lg" />
      </SheetModal>

      <SheetModal visible={modifySheet} onClose={() => setModifySheet(false)} title={t('order.modify.title')}>
        <Text style={styles.sheetLabel}>{t('order.modify.type')}</Text>
        <View style={{ gap: Spacing.xs }}>
          {MODIFY_TYPES.map((type) => {
            const selected = modifyType === type;
            return (
              <Pressable
                key={type}
                onPress={() => setModifyType(type)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.modifyOption, selected && { borderColor: Colors.primary, backgroundColor: Colors.primarySoft }]}>
                <Text style={[styles.modifyOptionText, selected && { color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold }]}>
                  {t(`order.modify.type.${type}`)}
                </Text>
                {selected ? <Icon name="checkmark-circle" size={18} color={Colors.primaryDeep} /> : null}
              </Pressable>
            );
          })}
        </View>
        <TextInput
          value={modifyNote}
          onChangeText={setModifyNote}
          placeholder={t('order.modify.notePlaceholder')}
          placeholderTextColor={Colors.textFaint}
          maxLength={500}
          multiline
          style={[styles.input, { minHeight: 72, textAlignVertical: 'top', marginTop: Spacing.md }]}
          accessibilityLabel={t('order.modify.note')}
        />
        {modifyError ? <Text style={styles.actionError}>{modifyError}</Text> : null}
        <Btn label={t('order.modify.submit')} onPress={requestModify} size="lg" loading={modifying} style={{ marginTop: Spacing.md }} />
      </SheetModal>

      <SheetModal visible={tipSheet} onClose={() => setTipSheet(false)} title={t('order.tipTitle')}>
        <Text style={styles.sheetLabel}>{t('order.tipAmount')}</Text>
        <View style={styles.chipWrap}>
          {TIP_AMOUNTS.map((a) => {
            const selected = tipAmount === a && !tipCustom.trim();
            return (
              <Pressable
                key={a}
                onPress={() => {
                  setTipAmount(a);
                  setTipCustom('');
                  setTipError('');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.choiceChip, selected && styles.choiceSelected]}>
                <Text style={[styles.choiceText, selected && styles.choiceSelectedText]}>{formatTZS(a)}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          value={tipCustom}
          onChangeText={(v) => {
            setTipCustom(v);
            setTipError('');
          }}
          placeholder={t('order.tipCustomAmount')}
          placeholderTextColor={Colors.textFaint}
          keyboardType="number-pad"
          maxLength={9}
          style={[styles.input, { marginTop: Spacing.sm }]}
          accessibilityLabel={t('order.tipCustomAmount')}
        />
        <Text style={[styles.sheetLabel, { marginTop: Spacing.md }]}>{t('order.tipMethod')}</Text>
        <View style={styles.chipWrap}>
          {TIP_METHODS.map((m) => {
            const selected = tipMethod === m;
            return (
              <Pressable
                key={m}
                onPress={() => setTipMethod(m)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.choiceChip, selected && styles.choiceSelected]}>
                <Text style={[styles.choiceText, selected && styles.choiceSelectedText]}>{tipMethodLabel(m)}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          value={tipNote}
          onChangeText={setTipNote}
          placeholder={t('order.tipNotePlaceholder')}
          placeholderTextColor={Colors.textFaint}
          maxLength={200}
          style={[styles.input, { marginTop: Spacing.md }]}
          accessibilityLabel={t('order.tipNote')}
        />
        {tipError ? <Text style={styles.actionError}>{tipError}</Text> : null}
        <Btn label={t('order.tipSend')} onPress={sendTip} size="lg" loading={tipping} style={{ marginTop: Spacing.md }} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  orderNo: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.borderStrong },
  banner: { marginBottom: Spacing.md },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
  },
  actionError: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  sheetLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
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
  tipCard: { padding: Spacing.md, marginTop: Spacing.md },
  modifyOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
  },
  modifyOptionText: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
});
