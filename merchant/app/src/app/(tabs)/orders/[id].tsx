import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderTimer } from '@/components/order-timer';
import { Btn, Card, Chip, Icon, Pill, Row, SheetModal, StatusPill } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { CANCEL_REASONS, clock, fullTime, preorderIn, timeAgo, tzs } from '@/lib/format';
import { api, ApiError } from '@/api/client';
import type { DamageClaimBody, OrderTimelineEventDto, Rider, RouteSegmentDto, TrackingEventDto, WaybillDto } from '@/api/types';
import { useCatalogStore } from '@/store/catalog';
import { useMessageStore } from '@/store/messages';
import { useOrderStore } from '@/store/orders';
import type { Order, OrderStatus } from '@/types';

function toneColor(tone: 'danger' | 'warning' | 'success' | 'info'): string {
  return tone === 'danger' ? Colors.danger : tone === 'warning' ? Colors.warning : tone === 'success' ? Colors.success : Colors.info;
}

const STEPS: { key: OrderStatus; label: I18nKey }[] = [
  { key: 'new', label: 'od.stepPlaced' },
  { key: 'merchant_accepted', label: 'ui.status.merchant_accepted' },
  { key: 'preparing', label: 'od.stepPreparing' },
  { key: 'ready', label: 'od.stepReady' },
  { key: 'completed', label: 'od.stepDone' },
];

const DAMAGE_TYPES: { key: DamageClaimBody['type']; label: I18nKey }[] = [
  { key: 'spilled', label: 'od.damageType.spilled' },
  { key: 'missing', label: 'od.damageType.missing' },
  { key: 'wrong_item', label: 'od.damageType.wrong_item' },
  { key: 'damaged_packaging', label: 'od.damageType.damaged_packaging' },
  { key: 'quality', label: 'od.damageType.quality' },
];

const RUSH_PRESETS_MIN = [5, 10, 15, 20, 30, 45];

const SOURCE_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  app: 'info',
  web: 'success',
  phone: 'warning',
  pos: 'neutral',
};

export default function OrderDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id, action } = useLocalSearchParams<{ id: string; action?: string }>();
  const orders = useOrderStore((s) => s.orders);
  const acceptOrder = useOrderStore((s) => s.acceptOrder);
  const rejectOrder = useOrderStore((s) => s.rejectOrder);
  const startPreparing = useOrderStore((s) => s.startPreparing);
  const markReady = useOrderStore((s) => s.markReady);
  const completeOrder = useOrderStore((s) => s.completeOrder);
  const replyRush = useOrderStore((s) => s.replyRush);
  const decideRefund = useOrderStore((s) => s.decideRefund);
  const markSeen = useOrderStore((s) => s.markSeen);
  const cancelOrder = useOrderStore((s) => s.cancelOrder);
  const holdOrder = useOrderStore((s) => s.holdOrder);
  const unholdOrder = useOrderStore((s) => s.unholdOrder);
  const rescheduleOrder = useOrderStore((s) => s.rescheduleOrder);
  const transferOrder = useOrderStore((s) => s.transferOrder);
  const addTip = useOrderStore((s) => s.addTip);
  const addItems = useOrderStore((s) => s.addItems);
  const damageOrder = useOrderStore((s) => s.damageOrder);
  const hydrateOrderTimeline = useOrderStore((s) => s.hydrateOrderTimeline);
  const trackOrder = useOrderStore((s) => s.trackOrder);
  const fetchWaybill = useOrderStore((s) => s.fetchWaybill);
  const fetchRoute = useOrderStore((s) => s.fetchRoute);
  const products = useCatalogStore((s) => s.products);
  const order = orders.find((o) => o.id === id) as (Order & { deliveryEtaMin?: number; freeDelivery?: boolean }) | undefined;
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState('OTHER');
  const [rejectReasons, setRejectReasons] = useState<{ code: string; label: string }[] | null>(null);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [called, setCalled] = useState(false);
  const [refundReasonLabels, setRefundReasonLabels] = useState<Record<string, string>>({});
  const [payment, setPayment] = useState<{ method: string; provider: string; status: string; capturedAt?: number; refundedAmount: number } | null>(null);
  /* P2: timeline / tracking / ops sheets + conflict banner */
  const [timeline, setTimeline] = useState<OrderTimelineEventDto[]>([]);
  const [track, setTrack] = useState<TrackingEventDto | null>(null);
  const [waybill, setWaybill] = useState<WaybillDto | null>(null);
  const [routeLegs, setRouteLegs] = useState<RouteSegmentDto[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [cancelSheet, setCancelSheet] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [reschedSheet, setReschedSheet] = useState(false);
  const [tipSheet, setTipSheet] = useState(false);
  const [tipAmount, setTipAmount] = useState('');
  const [itemsSheet, setItemsSheet] = useState(false);
  const [itemsReason, setItemsReason] = useState('');
  const [itemPicks, setItemPicks] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [acceptBlocked, setAcceptBlocked] = useState(false);
  /* Rush reply sheet */
  const [rushSheet, setRushSheet] = useState(false);
  const [rushText, setRushText] = useState('');
  const [rushBusy, setRushBusy] = useState(false);
  const [rushDone, setRushDone] = useState(false);
  /* Damage claim sheet */
  const [damageSheet, setDamageSheet] = useState(false);
  const [damageType, setDamageType] = useState<DamageClaimBody['type'] | null>(null);
  const [damageDesc, setDamageDesc] = useState('');
  const [damagePhotos, setDamagePhotos] = useState<string[]>([]);
  const [damageBusy, setDamageBusy] = useState(false);
  const [damagePill, setDamagePill] = useState<'open' | null>(null);

  useEffect(() => {
    if (order) {
      markSeen(order.id);
      useMessageStore.getState().markAllRead();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (action === 'reject' && order?.status === 'new') setCancelOpen(true);
  }, [action, order?.status]);

  useEffect(() => {
    if (!id) return;
    api.get<{ order: { payment?: typeof payment } }>(`/orders/${id}`, { retries: 0 })
      .then((r) => r.order.payment && setPayment(r.order.payment))
      .catch(() => undefined);
    api.get<{ reasons: { code: string; label: string }[] }>('/orders/reject-reasons', { retries: 1 })
      .then((r) => setRejectReasons(r.reasons))
      .catch(() => undefined);
    api.get<{ reasons: { code: string; label: string }[] }>('/refunds/reasons', { retries: 1 })
      .then((r) => setRefundReasonLabels(Object.fromEntries(r.reasons.map((x) => [x.code, x.label]))))
      .catch(() => undefined);
    api.get<{ riders: Rider[] }>('/riders', { retries: 1 })
      .then((r) => setRiders(r.riders))
      .catch(() => undefined);
    hydrateOrderTimeline(id)
      .then(setTimeline)
      .catch(() => undefined);
    trackOrder(id).then(setTrack);
    fetchWaybill(id).then(setWaybill);
    fetchRoute(id).then(setRouteLegs);
  }, [id, hydrateOrderTimeline, trackOrder, fetchWaybill, fetchRoute]);

  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setConflict(null);
    try {
      await fn();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('od.actionFailed', { msg: '—' });
      setConflict(msg);
      // OF-03/OF-04: after a conflict the accept CTA must never stay enabled —
      // refetch and render the updated state.
      if (e instanceof ApiError && ['VERSION_CONFLICT', 'ORDER_STATUS_CONFLICT', 'ORDER_AUTO_CANCELLED'].includes(e.code)) {
        setAcceptBlocked(true);
      }
      useOrderStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  if (!order) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: Colors.textTertiary }}>{t('od.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.key === order.status);
  const cancelled = order.status === 'cancelled';
  const terminal = order.status === 'refunded' || order.status === 'failed' || order.status === 'disputed';
  const reasonOptions = rejectReasons ?? CANCEL_REASONS.map((r) => ({ code: 'OTHER', label: r }));
  const rider = riders.find((r) => r.id === order.riderId);
  const refundLabel = order.refund ? Object.values(refundReasonLabels).find((l) => l === order.refund?.reason) ?? order.refund.reason : '';
  const events: { label: string; ts?: number; done: boolean; tone?: 'danger' | 'warning' | 'success' | 'info' }[] = [
    { label: t('od.evPlaced'), ts: order.createdAt, done: true },
    { label: t('ui.status.merchant_accepted'), ts: order.acceptedAt, done: !!order.acceptedAt },
    { label: t('od.evReady'), ts: order.readyAt, done: !!order.readyAt },
    { label: t('od.evCompleted'), ts: order.completedAt, done: !!order.completedAt },
  ];
  const EXTRA_EVENTS: Record<string, { label: string; tone: 'danger' | 'warning' | 'success' | 'info' }> = {
    'rush-requested': { label: t('od.evRushed'), tone: 'danger' },
    'rush-replied': { label: t('od.evReplied'), tone: 'success' },
    'refund-requested': { label: t('od.evRefundReq'), tone: 'warning' },
    'refund-approved': { label: t('od.evRefundApproved'), tone: 'success' },
    'refund-declined': { label: t('od.evRefundDeclined'), tone: 'danger' },
    cancelled: { label: t('od.evCancelled'), tone: 'danger' },
  };
  (order.timeline ?? []).forEach((ev) => {
    const meta = EXTRA_EVENTS[ev.event];
    if (meta) events.push({ label: meta.label, ts: ev.ts, done: true, tone: meta.tone });
  });

  const confirmReject = () => {
    if (!reason) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    rejectOrder(order.id, reason, reasonCode);
    setCancelOpen(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ title: t('od.title', { no: order.no }) }} />

      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 140, gap: Spacing.md }} showsVerticalScrollIndicator={false}>
        {conflict ? (
          <View style={styles.conflictBanner}>
            <Icon name="alert-circle-outline" size={16} color={Colors.danger} />
            <Text style={styles.conflictText}>{conflict}</Text>
          </View>
        ) : null}
        <Row gap={6} style={{ flexWrap: 'wrap' }}>
          {order.source ? <Pill label={t(`orders.source.${order.source}` as I18nKey)} tone={SOURCE_TONE[order.source] ?? 'neutral'} /> : null}
          <StatusPill status={order.status} />
        </Row>
        {terminal ? (
          <Card style={styles.terminalCard}>
            <Row gap={10} style={{ alignItems: 'flex-start' }}>
              <Icon
                name={order.status === 'disputed' ? 'help-circle-outline' : order.status === 'refunded' ? 'return-down-back-outline' : 'close-circle-outline'}
                size={26}
                color={order.status === 'refunded' ? Colors.warning : Colors.danger}
              />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.terminalTitle}>{t(`od.terminal.${order.status}` as I18nKey)}</Text>
                {order.status === 'disputed' ? (
                  <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '700' }}>{t('od.heldPayout')}</Text>
                ) : null}
                {order.cancelReason ? (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('od.terminalReason', { r: order.cancelReason })}</Text>
                ) : null}
              </View>
            </Row>
          </Card>
        ) : null}
        {order.scheduledAt ? (
          <Card style={styles.preorderCard}>
            <Icon name="calendar-outline" size={18} color={Colors.warning} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.preorderTitle}>{t('od.preorderAt', { t: preorderIn(order.scheduledAt) })}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                {t('od.scheduledHint', { t: fullTime(order.scheduledAt) })}
              </Text>
            </View>
          </Card>
        ) : null}
        {!cancelled && !terminal ? (
          <Card style={{ paddingVertical: Spacing.lg }}>
            <Row style={{ justifyContent: 'space-between', paddingHorizontal: 6 }}>
              {STEPS.map((s, i) => (
                <View key={s.key} style={{ alignItems: 'center', gap: 6, flex: 1 }}>
                  <View
                    style={[
                      styles.stepDot,
                      i <= stepIndex && styles.stepDotActive,
                      s.key === 'completed' && i <= stepIndex && { backgroundColor: Colors.success },
                    ]}>
                    {i < stepIndex ? <Icon name="checkmark" size={13} color={Colors.text} /> : null}
                  </View>
                  <Text style={[styles.stepLabel, i <= stepIndex && { color: Colors.text, fontWeight: '700' }]}>{t(s.label)}</Text>
                </View>
              ))}
            </Row>
            {order.status === 'new' ? (
              <View style={styles.timerWrap}>
                <OrderTimer deadlineAt={order.deadlineAt} />
                <Text style={styles.timerText}>{t('od.decideBefore')}</Text>
              </View>
            ) : null}
          </Card>
        ) : cancelled ? (
          <Card>
            <Row gap={10}>
              <Icon name="close-circle" size={26} color={Colors.danger} />
              <View>
                <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.danger }}>{t('od.cancelled')}</Text>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 }}>
                  {t('od.cancelledReason', { r: order.cancelReason ?? '' })}
                </Text>
              </View>
            </Row>
          </Card>
        ) : null}

        {!cancelled && !terminal ? (
          <Card style={{ gap: Spacing.md }}>
            <Text style={styles.cardTitle}>{t('od.lifecycle')}</Text>
            {events.map((e, i) => (
              <Row key={e.label} gap={Spacing.md} style={{ alignItems: 'flex-start' }}>
                <View style={styles.tlWrap}>
                  <View
                    style={[
                      styles.tlDot,
                      e.done ? styles.tlDotDone : styles.tlDotPending,
                      e.label === 'Completed' && e.done && { backgroundColor: Colors.success },
                    ]}>
                    {e.done ? <Icon name="checkmark" size={10} color={Colors.white} /> : null}
                  </View>
                  {i < events.length - 1 ? <View style={styles.tlLine} /> : null}
                </View>
                <View style={{ paddingBottom: Spacing.md, flex: 1 }}>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: e.done ? '700' : '500', color: e.tone ? toneColor(e.tone) : e.done ? Colors.text : Colors.textTertiary }}>
                    {e.label}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                    {e.ts ? fullTime(e.ts) : t('od.pending')}
                  </Text>
                </View>
              </Row>
            ))}
          </Card>
        ) : null}

        {order.hold ? (
          <View style={styles.holdBanner}>
            <Icon name="pause-circle-outline" size={18} color={Colors.warning} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.holdTitle}>{t('od.heldBanner', { reason: order.hold.reason })}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                {order.hold.until ? t('od.heldBannerUntil', { t: fullTime(order.hold.until), reason: order.hold.reason }) : fullTime(order.hold.at)}
              </Text>
            </View>
            <Btn label={t('od.unhold')} size="sm" variant="ghost" onPress={() => runAction(() => unholdOrder(order.id))} />
          </View>
        ) : null}

        {order.reschedule?.status === 'approved' ? (
          <View style={styles.holdBanner}>
            <Icon name="calendar-outline" size={18} color={Colors.warning} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.holdTitle}>{t('od.rescheduleBanner', { t: fullTime(order.reschedule.scheduledAt), reason: order.reschedule.reason })}</Text>
            </View>
          </View>
        ) : null}

        {!cancelled && !terminal ? (
          <Card style={{ gap: Spacing.md }}>
            <Text style={styles.cardTitle}>{t('od.timeline')}</Text>
            {timeline.length ? (
              timeline.map((ev, i) => (
                <Row key={i} gap={Spacing.md} style={{ alignItems: 'flex-start' }}>
                  <View style={styles.tlWrap}>
                    <View style={[styles.tlDot, styles.tlDotDone]}>
                      <Icon name="checkmark" size={10} color={Colors.white} />
                    </View>
                    {i < timeline.length - 1 ? <View style={styles.tlLine} /> : null}
                  </View>
                  <View style={{ paddingBottom: Spacing.md, flex: 1 }}>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{ev.status.replace(/_/g, ' ')}</Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                      {t('od.timelineBy', { actor: t(`od.actor.${ev.by}` as I18nKey), t: fullTime(ev.at) })}
                    </Text>
                  </View>
                </Row>
              ))
            ) : (
              <Text style={styles.muted}>{t('od.pending')}</Text>
            )}
          </Card>
        ) : null}

        <Card style={{ paddingVertical: Spacing.sm }}>
          <Text style={[styles.cardTitle, { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm }]}>{t('od.items')}</Text>
          {order.items.map((it, i) => {
            const stock = products.find((p) => p.id === it.productId)?.stock;
            return (
              <Row key={i} style={styles.itemRow}>
                <Text style={{ fontSize: 18 }}>{it.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: FontSize.md, color: Colors.text, fontWeight: '600' }}>{it.name}</Text>
                  {it.variants.length ? (
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{it.variants.join(' / ')}</Text>
                  ) : null}
                  {stock !== undefined && stock <= 0 ? (
                    <Text style={{ fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' }}>{t('od.outOfStock')}</Text>
                  ) : null}
                </View>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>×{it.qty}</Text>
                <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text, width: 74, textAlign: 'right' }}>
                  {tzs(it.price * it.qty)}
                </Text>
              </Row>
            );
          })}
          {order.note ? (
            <View style={{ marginHorizontal: Spacing.lg, marginBottom: Spacing.sm }}>
              <Row gap={6} style={{ alignItems: 'flex-start' }}>
                <Icon name="document-text-outline" size={15} color={Colors.warning} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.warning, fontWeight: '600', flex: 1 }}>{t('od.customerNote', { n: order.note })}</Text>
              </Row>
            </View>
          ) : null}
          <View style={styles.divider} />
          <Row style={{ paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, justifyContent: 'space-between' }}>
            <Text style={styles.muted}>{t('od.subtotal')}</Text>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{tzs(order.subtotal)}</Text>
          </Row>
          <Row style={{ paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, justifyContent: 'space-between' }}>
            <Text style={styles.muted}>{order.deliveryType === 'pickup' ? t('od.pickupService') : t('od.deliveryFee')}</Text>
            {order.freeDelivery ? (
              <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{t('od.free')}</Text>
            ) : (
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{tzs(order.deliveryFee)}</Text>
            )}
          </Row>
          <Row style={{ paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t('od.totalPaid')}</Text>
            <Text style={{ fontSize: FontSize.xl, fontWeight: '800', color: Colors.text }}>{tzs(order.total)}</Text>
          </Row>
        </Card>

        {payment ? (
          <Card style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('od.payment')}</Text>
              <Pill
                label={payment.status === 'captured' ? t('od.paid') : payment.status === 'refunded' ? t('od.refunded') : payment.status}
                tone={payment.status === 'captured' ? 'success' : payment.status === 'refunded' ? 'warning' : 'neutral'}
              />
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.muted}>{payment.method.toUpperCase()} · {payment.provider}</Text>
              {payment.capturedAt ? <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('od.capturedAt', { t: fullTime(payment.capturedAt) })}</Text> : null}
            </Row>
            {payment.refundedAmount > 0 ? (
              <Text style={{ fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700' }}>
                {t('od.refundedTo', { a: tzs(payment.refundedAmount) })}
              </Text>
            ) : null}
          </Card>
        ) : null}

        <Card style={{ gap: Spacing.md }}>
          <Text style={styles.cardTitle}>{t('od.customer')}</Text>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary }}>
              {order.customer.name} {order.customer.phone}
            </Text>
            <Btn
              label={called ? t('od.callInitiated') : t('od.callCustomer')}
              icon="call-outline"
              variant="outline"
              size="sm"
              onPress={() => {
                setCalled(true);
                setTimeout(() => setCalled(false), 1800);
              }}
              style={{ paddingHorizontal: 14 }}
            />
          </Row>
          <Row gap={8} style={{ alignItems: 'flex-start' }}>
            <Icon name={order.deliveryType === 'pickup' ? 'location-outline' : 'bicycle-outline'} size={15} color={Colors.textTertiary} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 }}>
              {order.deliveryType === 'pickup' ? t('od.picksUp') : order.customer.address}
            </Text>
          </Row>
        </Card>

        {order.rushAt && !order.rushReplied && !cancelled ? (
          <Card style={styles.rushCard}>
            <Row gap={10} style={{ alignItems: 'flex-start' }}>
              <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.rushTitle}>{t('od.rushing')}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                  {t('od.rushAsked', { t1: clock(order.rushAt), t2: clock(order.deadlineAt) })}
                </Text>
                <Btn
                  label={t('od.replyImOnIt')}
                  size="sm"
                  onPress={() => {
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    setRushText('');
                    setRushDone(false);
                    setRushSheet(true);
                  }}
                  style={{ alignSelf: 'flex-start', marginTop: 4 }}
                />
              </View>
            </Row>
          </Card>
        ) : null}

        {order.refund && order.refund.status !== 'declined' ? (
          <Card style={styles.rushCard}>
            <Row gap={10} style={{ alignItems: 'flex-start' }}>
              <Icon name="return-down-back-outline" size={18} color={Colors.warning} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.rushTitle}>{t('od.refundStatus', { status: order.refund.status, a: tzs(order.refund.amount) })}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                  {t('od.refundReason', { t: fullTime(order.refund.ts), r: refundLabel })}
                </Text>
                {order.refund.status === 'requested' ? (
                  <Row style={{ gap: 10, marginTop: 6 }}>
                    <Btn
                      label={t('od.approveRefund')}
                      variant="success"
                      size="sm"
                      style={{ flex: 1 }}
                      onPress={() => {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        decideRefund(order.id, true);
                      }}
                    />
                    <Btn
label={t('od.declineRefund')}
                      variant="outline"
                      size="sm"
                      style={{ flex: 1 }}
                      onPress={() => decideRefund(order.id, false)}
                    />
                  </Row>
                ) : (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.success, fontWeight: '700' }}>
                    {order.refund.status === 'approved' ? t('od.refundedToWallet') : t('od.requestDeclined')}
                  </Text>
                )}
              </View>
            </Row>
          </Card>
        ) : null}

        {order.rider || order.status === 'ready' || order.status === 'completed' ? (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('od.delivery')}</Text>
              {rider ? (
                <Pill
                  label={rider.status === 'delivering' ? t('od.deliveringNow') : rider.status === 'idle' ? t('od.idle') : t('od.offline')}
                  tone={rider.status === 'delivering' ? 'success' : rider.status === 'idle' ? 'info' : 'neutral'}
                />
              ) : order.rider ? (
                <Pill label={t('od.rider', { n: order.rider })} tone="info" />
              ) : null}
            </Row>
            {rider ? (
              <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, paddingTop: Spacing.sm }}>
                {order.rider ? `${order.rider} · ` : ''}{t('od.lastUpdate', { t: timeAgo(rider.updatedAt) })}
              </Text>
            ) : null}
            {order.deliveryType === 'delivery' && order.deliveryEtaMin ? (
              <Row style={{ justifyContent: 'space-between', paddingTop: Spacing.sm }}>
                <Text style={styles.muted}>{t('od.estDelivery')}</Text>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
                  {t('od.estRange', { min: order.deliveryEtaMin, max: order.deliveryEtaMin + 10 })}
                </Text>
              </Row>
            ) : null}
            {order.readyAt ? (
              <Row style={{ justifyContent: 'space-between', paddingTop: Spacing.sm }}>
                <Text style={styles.muted}>{t('od.readyAt')}</Text>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{fullTime(order.readyAt)}</Text>
              </Row>
            ) : null}
            {order.completedAt ? (
              <Row style={{ justifyContent: 'space-between', paddingTop: Spacing.sm }}>
                <Text style={styles.muted}>{t('od.completedAt')}</Text>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{fullTime(order.completedAt)}</Text>
              </Row>
            ) : null}
          </Card>
        ) : null}

        {order.status === 'preparing' || order.status === 'ready' || order.status === 'completed' ? (
          <Card style={{ gap: Spacing.sm }}>
            <Text style={styles.cardTitle}>{t('od.track')}</Text>
            {track ? (
              <>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.muted}>{t('od.trackStatus', { status: track.status, eta: track.estimateMinutes ?? '—' })}</Text>
                  {track.riderLocation ? <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{track.riderLocation.lat.toFixed(4)}, {track.riderLocation.lon.toFixed(4)}</Text> : null}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('od.lastUpdate', { t: timeAgo(track.updatedAt) })}</Text>
              </>
            ) : (
              <Text style={styles.muted}>{t('od.noTrack')}</Text>
            )}
            {waybill ? (
              <Row style={{ justifyContent: 'space-between', paddingTop: Spacing.sm }}>
                <Text style={styles.muted}>{t('od.waybillNo', { no: waybill.waybillNumber })}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('od.waybillEvents', { n: waybill.events.length })}</Text>
              </Row>
            ) : null}
            {routeLegs.length ? (
              <View style={{ gap: 6, paddingTop: Spacing.sm }}>
                <Text style={styles.muted}>{t('od.legs')}</Text>
                {routeLegs.map((leg) => (
                  <Row key={leg.legId} style={{ justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                      {leg.sequence}. {leg.type.replace(/_/g, ' ')} {leg.handledBy ? `· ${leg.handledBy}` : ''}
                    </Text>
                    <Pill label={t(`od.legStatus.${leg.status}` as I18nKey)} tone={leg.status === 'completed' ? 'success' : leg.status === 'in_progress' ? 'info' : 'neutral'} />
                  </Row>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>

      {!cancelled && !terminal ? (
        <View style={styles.actionBar}>
          {order.status === 'new' ? (
            <>
              <Btn label={t('od.declineRefund')} variant="outline" onPress={() => setCancelOpen(true)} style={{ flex: 1 }} />
              <Btn
                label={t('od.acceptStart')}
                icon="checkmark"
                size="lg"
                disabled={acceptBlocked}
                onPress={() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  runAction(() => acceptOrder(order.id));
                }}
                style={{ flex: 2 }}
              />
            </>
          ) : order.status === 'merchant_accepted' ? (
            <>
              <Btn
                label={t('od.startPreparing')}
                icon="restaurant-outline"
                size="lg"
                onPress={() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  runAction(() => startPreparing(order.id));
                }}
                style={{ flex: 1 }}
              />
              <Btn label={t('od.cancelOrder')} icon="close-circle-outline" variant="outline" onPress={() => setCancelSheet(true)} />
            </>
          ) : order.status === 'preparing' ? (
            <>
              <Btn label={t('od.markReady')} icon="restaurant-outline" size="lg" onPress={() => runAction(() => markReady(order.id))} style={{ flex: 1 }} />
              <Btn
                label={order.hold ? t('od.unhold') : t('od.hold')}
                icon={order.hold ? 'play-outline' : 'pause-outline'}
                variant="ghost"
                onPress={() => runAction(() => (order.hold ? unholdOrder(order.id) : holdOrder(order.id, 'Held from order detail'))).then(() => undefined)}
              />
              <Btn label={t('od.cancelOrder')} icon="close-circle-outline" variant="outline" onPress={() => setCancelSheet(true)} />
            </>
          ) : order.status === 'ready' ? (
            <>
              <Btn
                label={order.rider ? t('od.confirmPickedUp', { rider: order.rider }) : t('orders.confirmDelivered')}
                icon="bicycle-outline"
                variant="success"
                size="lg"
                onPress={() => runAction(() => completeOrder(order.id))}
                style={{ flex: 1 }}
              />
              <Btn
                label={order.hold ? t('od.unhold') : t('od.hold')}
                icon={order.hold ? 'play-outline' : 'pause-outline'}
                variant="ghost"
                onPress={() => runAction(() => (order.hold ? unholdOrder(order.id) : holdOrder(order.id, 'Held from order detail'))).then(() => undefined)}
              />
              <Btn label={t('od.cancelOrder')} icon="close-circle-outline" variant="outline" onPress={() => setCancelSheet(true)} />
            </>
          ) : null}
          <Pressable onPress={() => router.push(`/orders/print?ids=${order.id}`)} accessibilityRole="button" accessibilityLabel={t('od.print')} style={styles.printBtn}>
            <Icon name="print-outline" size={20} color={Colors.textSecondary} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('od.print')}</Text>
          </Pressable>
        </View>
      ) : null}

      {!cancelled && !terminal ? (
        <Row gap={Spacing.sm} style={styles.opsRow}>
          {order.status === 'merchant_accepted' || order.status === 'preparing' || order.status === 'ready' ? (
            <Btn label={t('od.reschedule')} icon="calendar-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setReschedSheet(true)} />
          ) : null}
          {order.status === 'preparing' || order.status === 'ready' ? (
            <Btn label={t('od.transfer')} icon="swap-horizontal-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => runAction(() => transferOrder(order.id, 'Merchant requested transfer'))} />
          ) : null}
          {order.status === 'new' || order.status === 'preparing' ? (
            <Btn label={t('od.addItems')} icon="add-circle-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setItemsSheet(true)} />
          ) : null}
          {order.status === 'completed' ? (
            <Btn label={t('od.tip')} icon="cash-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setTipSheet(true)} />
          ) : null}
          {!order.refund && !terminal ? (
            <Btn label={t('od.damageTitle')} icon="warning-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setDamageSheet(true)} />
          ) : null}
        </Row>
      ) : null}

      {/* P2 sheets */}
      <SheetModal visible={cancelSheet} onClose={() => setCancelSheet(false)} title={t('od.cancelTitle')}>
        <View style={{ gap: Spacing.sm }}>
          {CANCEL_REASONS.map((r) => (
            <Pressable
              key={r}
              onPress={() => setCancelReason(r)}
              accessibilityRole="button"
              accessibilityState={{ selected: cancelReason === r }}
              style={[styles.reasonRow, cancelReason === r && styles.reasonActive]}>
              <Text style={{ fontSize: FontSize.md, color: cancelReason === r ? Colors.text : Colors.textSecondary }}>{r}</Text>
              {cancelReason === r ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : null}
            </Pressable>
          ))}
          {order.cancelFeeTZS !== undefined ? (
            <>
              <Text style={{ fontSize: FontSize.sm, color: Colors.warning, fontWeight: '700' }}>{t('od.cancelFee', { fee: tzs(order.cancelFeeTZS) })}</Text>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('od.refundAfterFee', { refund: tzs(order.refundTZS ?? 0) })}</Text>
            </>
          ) : null}
          <Btn
            label={t('od.confirmCancel')}
            variant="danger"
            size="lg"
            disabled={!cancelReason}
            loading={busy}
            onPress={() => {
              runAction(() => cancelOrder(order.id, cancelReason)).then(() => setCancelSheet(false));
            }}
          />
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' }}>{t('od.cancelHint')}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={rushSheet} onClose={() => setRushSheet(false)} title={t('orders.rushReplyTitle')}>
        <View style={{ gap: Spacing.sm }}>
          {rushDone ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{t('orders.rushRepliedDone')}</Text>
          ) : (
            <>
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                {RUSH_PRESETS_MIN.map((m) => (
                  <Chip key={m} label={t('orders.rushReplyPreset', { n: m })} selected={false} onPress={() => setRushText(`ETA ${m} minutes`)} tone="info" />
                ))}
              </Row>
              <TextInput
                value={rushText}
                onChangeText={(v) => setRushText(v.slice(0, 300))}
                placeholder={t('orders.rushReplyPh')}
                placeholderTextColor={Colors.textTertiary}
                multiline
                style={[styles.input, { minHeight: 84, textAlignVertical: 'top' }]}
              />
              <Btn
                label={t('orders.rushReplySend')}
                variant="danger"
                size="lg"
                disabled={!rushText.trim()}
                loading={rushBusy}
                onPress={() => {
                  setRushBusy(true);
                  replyRush(order.id, rushText.trim())
                    .then(() => setRushDone(true))
                    .catch(() => undefined)
                    .finally(() => setRushBusy(false));
                }}
              />
            </>
          )}
        </View>
      </SheetModal>

      <SheetModal visible={damageSheet} onClose={() => setDamageSheet(false)} title={t('od.damageTitle')}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('od.damageHint')}</Text>
          {damagePill ? (
            <Row gap={6} style={{ alignItems: 'center' }}>
              <Pill label={t('od.damageOpen')} tone="warning" />
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('od.damageExists')}</Text>
            </Row>
          ) : null}
          <Row gap={6} style={{ flexWrap: 'wrap' }}>
            {DAMAGE_TYPES.map((d) => (
              <Chip key={d.key} label={t(d.label)} selected={damageType === d.key} onPress={() => setDamageType(d.key)} tone="danger" />
            ))}
          </Row>
          <TextInput
            value={damageDesc}
            onChangeText={(v) => setDamageDesc(v.slice(0, 1000))}
            placeholder={t('od.damageDescPh')}
            placeholderTextColor={Colors.textTertiary}
            multiline
            maxLength={1000}
            style={[styles.input, { minHeight: 96, textAlignVertical: 'top' }]}
          />
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('od.damagePhotos', { n: damagePhotos.length })}</Text>
            <Btn
              label={t('od.damageAddPhoto')}
              icon="camera-outline"
              variant="outline"
              size="sm"
              disabled={damagePhotos.length >= 5}
              onPress={() => setDamagePhotos((p) => [...p, `https://mock-upload.example/${Date.now()}.jpg`])}
            />
          </Row>
          <Btn
            label={t('od.damageSubmit')}
            variant="danger"
            size="lg"
            disabled={!damageType || !damageDesc.trim()}
            loading={damageBusy}
            onPress={() => {
              setDamageBusy(true);
              runAction(() => damageOrder(order.id, { type: damageType ?? 'quality', description: damageDesc.trim(), images: damagePhotos }))
                .then(() => {
                  setDamagePill('open');
                  setDamageSheet(false);
                  setDamageType(null);
                  setDamageDesc('');
                  setDamagePhotos([]);
                })
                .catch(() => {
                  setConflict(t('od.damageExists'));
                })
                .finally(() => setDamageBusy(false));
            }}
          />
        </View>
      </SheetModal>

      <SheetModal visible={reschedSheet} onClose={() => setReschedSheet(false)} title={t('od.rescheduleTitle')}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('od.rescheduleHint')}</Text>
          <Row gap={Spacing.sm}>
            {[30, 60, 120].map((mins) => (
              <Btn
                key={mins}
                label={t(mins === 30 ? 'od.in30m' : mins === 60 ? 'od.in1h' : 'od.in2h')}
                variant="outline"
                size="sm"
                style={{ flex: 1 }}
                onPress={() => {
                  runAction(() => rescheduleOrder(order.id, Date.now() + mins * 60000, 'Merchant rescheduled delivery')).then(() => setReschedSheet(false));
                }}
              />
            ))}
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={tipSheet} onClose={() => setTipSheet(false)} title={t('od.tipTitle')}>
        <View style={{ gap: Spacing.sm }}>
          <TextInput
            value={tipAmount}
            onChangeText={setTipAmount}
            placeholder={t('od.tipPh')}
            placeholderTextColor={Colors.textTertiary}
            keyboardType="number-pad"
            style={styles.input}
          />
          <Btn
            label={t('od.tipConfirm')}
            variant="success"
            size="lg"
            disabled={!Number.isInteger(Number(tipAmount)) || Number(tipAmount) < 1}
            loading={busy}
            onPress={() => {
              runAction(() => addTip(order.id, Number(tipAmount))).then(() => {
                setTipSheet(false);
                setTipAmount('');
              });
            }}
          />
        </View>
      </SheetModal>

      <SheetModal visible={itemsSheet} onClose={() => setItemsSheet(false)} title={t('od.addItemsTitle')}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('od.addItemsHint')}</Text>
          {products.slice(0, 8).map((p) => (
            <Row key={p.id} style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 }}>
                {p.emoji} {p.name}
              </Text>
              <Row gap={6}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`- ${p.name}`}
                  style={styles.stepper}
                  onPress={() => setItemPicks((prev) => ({ ...prev, [p.id]: Math.max(0, (prev[p.id] ?? 0) - 1) }))}>
                  <Icon name="remove" size={14} color={Colors.textSecondary} />
                </Pressable>
                <Text style={{ minWidth: 20, textAlign: 'center', fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{itemPicks[p.id] ?? 0}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`+ ${p.name}`}
                  style={styles.stepper}
                  onPress={() => setItemPicks((prev) => ({ ...prev, [p.id]: Math.min(9, (prev[p.id] ?? 0) + 1) }))}>
                  <Icon name="add" size={14} color={Colors.textSecondary} />
                </Pressable>
              </Row>
            </Row>
          ))}
          <TextInput
            value={itemsReason}
            onChangeText={setItemsReason}
            placeholder={t('od.addItemsReason')}
            placeholderTextColor={Colors.textTertiary}
            maxLength={300}
            style={styles.input}
          />
          <Btn
            label={t('od.addItemsConfirm')}
            size="lg"
            disabled={!Object.values(itemPicks).some((q) => q > 0) || !itemsReason.trim()}
            loading={busy}
            onPress={() => {
              const items = Object.entries(itemPicks)
                .filter(([, q]) => q > 0)
                .map(([catalogueItemId, quantity]) => ({ catalogueItemId, quantity }));
              runAction(() => addItems(order.id, items, itemsReason.trim())).then(() => {
                setItemsSheet(false);
                setItemsReason('');
                setItemPicks({});
              });
            }}
          />
        </View>
      </SheetModal>

      <SheetModal visible={cancelOpen} onClose={() => setCancelOpen(false)} title={t('od.declineTitle')}>
        <View style={{ gap: Spacing.sm }}>
          {reasonOptions.map((r, i) => (
            <Pressable
              key={i}
              onPress={() => {
                setReason(r.label);
                setReasonCode(r.code);
              }}
              accessibilityRole="button"
              accessibilityLabel={r.label}
              accessibilityState={{ selected: reason === r.label }}
              style={[styles.reasonRow, reason === r.label && styles.reasonActive]}>
              <Text style={{ fontSize: FontSize.md, color: reason === r.label ? Colors.text : Colors.textSecondary }}>{r.label}</Text>
              {reason === r.label ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : null}
            </Pressable>
          ))}
          <Btn label={t('od.confirmDecline')} variant="danger" onPress={confirmReject} disabled={!reason} size="lg" />
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' }}>
            {t('od.declineHint')}
          </Text>
        </View>
      </SheetModal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  stepDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotActive: { backgroundColor: Colors.primary },
  stepLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  timerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
  },
  timerText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  cardTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  rushCard: {
    backgroundColor: `${Colors.danger}10`,
    borderWidth: 1,
    borderColor: `${Colors.danger}40`,
  },
  preorderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.warningSoft,
    borderWidth: 1,
    borderColor: `${Colors.warning}55`,
  },
  preorderTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text },
  rushTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text },
  tlWrap: { alignItems: 'center', width: 20 },
  tlDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tlDotDone: { backgroundColor: Colors.info },
  tlDotPending: { backgroundColor: Colors.borderStrong },
  tlLine: { width: 2, flex: 1, backgroundColor: Colors.border, minHeight: 22 },
  itemRow: { paddingHorizontal: Spacing.lg, paddingVertical: 10, gap: 10 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: 4 },
  muted: { fontSize: FontSize.sm, color: Colors.textTertiary },
  actionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 10,
    padding: Spacing.lg,
    paddingBottom: 26,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  printBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    gap: 2,
  },
  reasonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  reasonActive: { borderColor: Colors.primaryDark, backgroundColor: Colors.primarySoft },
  conflictBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: Radius.md, backgroundColor: `${Colors.danger}14`, borderWidth: 1, borderColor: `${Colors.danger}40` },
  conflictText: { flex: 1, fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600' },
  terminalCard: {
    backgroundColor: `${Colors.danger}0D`,
    borderWidth: 1,
    borderColor: `${Colors.danger}40`,
  },
  terminalTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  holdBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.warningSoft,
    borderWidth: 1,
    borderColor: `${Colors.warning}55`,
    borderRadius: Radius.md,
    padding: 12,
  },
  holdTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text },
  opsRow: { paddingHorizontal: Spacing.lg, paddingBottom: 10, marginTop: -70 },
  input: { borderWidth: 1, borderColor: Colors.borderStrong, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: FontSize.md, color: Colors.text },
  stepper: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
});