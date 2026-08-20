import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { ApiError } from '@/api/client';
import { Btn, Card, Icon, Pill, Row, Screen, Segmented, SheetModal, SosButton, Spinner } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { clockISO, dateISO } from '@/lib/format';
import { advanceStepFor, capitalize, formatEta, priorityMeta, statusMeta } from '@/lib/order';
import { getDeliveryRepository, getPaymentRepository, getRiderRepository } from '@/repos';
import type { PaymentQrResult, RiderAdvanceableStatus } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import { useNetworkStore } from '@/store/network';
import { useSessionStore } from '@/store/session';
import type { FareBreakdown, OrderDetail, ProofOfDeliveryType, TrackingEvent } from '@hudumika/contract';

type Handoff = 'hand_to_customer' | 'leave_at_door';

const POD_OPTIONS: { type: ProofOfDeliveryType; icon: 'camera' | 'keypad' | 'create'; labelKey: 'orders.podPhoto' | 'orders.podOtp' | 'orders.podSignature' }[] = [
  { type: 'photo', icon: 'camera', labelKey: 'orders.podPhoto' },
  { type: 'otp', icon: 'keypad', labelKey: 'orders.podOtp' },
  { type: 'signature', icon: 'create', labelKey: 'orders.podSignature' },
];

interface OrderDetailData {
  order: OrderDetail;
  tracking: TrackingEvent;
  fare: FareBreakdown | null;
}

/** Fare is best-effort context: FARE_NOT_AVAILABLE (and any error) hides the row, never fails the screen. */
async function fetchOrderDetailData(orderId: string): Promise<OrderDetailData> {
  const [order, tracking] = await Promise.all([
    getDeliveryRepository().getOrder(orderId),
    getDeliveryRepository().track(orderId),
  ]);
  let fare: FareBreakdown | null = null;
  try {
    fare = await getDeliveryRepository().getFare(orderId);
  } catch {
    fare = null;
  }
  return { order, tracking, fare };
}

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const offer = useJobsStore((s) => s.offers[orderId]);
  const rider = useSessionStore((s) => s.rider);

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [fare, setFare] = useState<FareBreakdown | null>(null);
  const [tracking, setTracking] = useState<TrackingEvent | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  const [advancing, setAdvancing] = useState(false);
  const [callLoading, setCallLoading] = useState(false);

  const [podVisible, setPodVisible] = useState(false);
  const [podType, setPodType] = useState<ProofOfDeliveryType | null>(null);
  const [podValue, setPodValue] = useState('');
  const [handoff, setHandoff] = useState<Handoff>('hand_to_customer');
  const [podLoading, setPodLoading] = useState(false);
  const [podError, setPodError] = useState('');

  const [failVisible, setFailVisible] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [reasonsError, setReasonsError] = useState('');
  const [failing, setFailing] = useState(false);

  const [pickupVisible, setPickupVisible] = useState(false);
  const [pickupCode, setPickupCode] = useState('');
  const [pickupManual, setPickupManual] = useState(false);
  const [pickupNote, setPickupNote] = useState('');
  const [pickupLoading, setPickupLoading] = useState(false);
  const [pickupError, setPickupError] = useState('');

  const [qrVisible, setQrVisible] = useState(false);
  const [qr, setQr] = useState<PaymentQrResult | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');

  const offline = useNetworkStore((s) => !s.online);

  const loading = order === null && !error;
  const reasonsLoading = failVisible && reasons.length === 0 && !reasonsError;

  const load = useCallback(async () => {
    try {
      const data = await fetchOrderDetailData(orderId);
      setOrder(data.order);
      setTracking(data.tracking);
      setFare(data.fare);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('orders.loadDetailFailed'));
    }
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    fetchOrderDetailData(orderId)
      .then((data) => {
        if (cancelled) return;
        setOrder(data.order);
        setTracking(data.tracking);
        setFare(data.fare);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : t('orders.loadDetailFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  useEffect(() => {
    if (!failVisible || reasons.length > 0) return;
    let cancelled = false;
    getRiderRepository()
      .listIssueReasons()
      .then((list) => {
        if (cancelled) return;
        setReasons(list);
        setReasonsError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setReasonsError(e instanceof ApiError ? e.message : t('orders.reasonsFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [failVisible, reasons.length]);

  const runAdvance = async (next: RiderAdvanceableStatus, opts?: { note?: string; pickupCode?: string }) => {
    if (!order) return;
    setAdvancing(true);
    setActionError('');
    try {
      const updated = await getDeliveryRepository().advance(order.id, next, opts);
      setOrder((prev) => (prev ? { ...prev, ...updated } : prev));
      if (updated.status === 'rider_arrived_dropoff') setPodVisible(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setActionError(e.message);
        load();
      } else {
        setActionError(e instanceof ApiError ? e.message : t('orders.updateFailed'));
      }
    } finally {
      setAdvancing(false);
    }
  };

  const onAdvance = async () => {
    if (!order) return;
    const step = advanceStepFor(order.status);
    if (!step) return;
    if (step.next === 'picked_up') {
      setPickupVisible(true);
      return;
    }
    await runAdvance(step.next);
  };

  const submitPickup = async () => {
    if (!order) return;
    const code = pickupCode.trim();
    const note = pickupManual ? pickupNote.trim() : undefined;
    if (!code && !note) return;
    setPickupLoading(true);
    setPickupError('');
    try {
      const updated = await getDeliveryRepository().advance(order.id, 'picked_up', { pickupCode: code || undefined, note });
      setOrder((prev) => (prev ? { ...prev, ...updated } : prev));
      setPickupVisible(false);
      setPickupCode('');
      setPickupManual(false);
      setPickupNote('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setPickupError(err.message);
        load();
      } else {
        setPickupError(err ? err.message : t('orders.updateFailed'));
      }
    } finally {
      setPickupLoading(false);
    }
  };

  const loadQr = async () => {
    if (!order) return;
    setQrLoading(true);
    setQrError('');
    setQr(null);
    try {
      const result = await getPaymentRepository().createCollectionQr(order.id);
      setQr(result);
    } catch (e) {
      setQrError(e instanceof ApiError ? e.message : t('payments.qrFailed'));
    } finally {
      setQrLoading(false);
    }
  };

  const openQr = () => {
    setQrVisible(true);
    void loadQr();
  };

  const onCall = async () => {
    if (!order) return;
    setCallLoading(true);
    setActionError('');
    try {
      const session = await getDeliveryRepository().createMaskedCall(order.id);
      await Linking.openURL(`tel:${session.maskedNumber}`);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : t('orders.callFailed'));
    } finally {
      setCallLoading(false);
    }
  };

  const selectPodType = (type: ProofOfDeliveryType) => {
    setPodType(type);
    setPodValue('');
    setPodError('');
    Haptics.selectionAsync();
  };

  const submitPOD = async () => {
    if (!order || !podType || !podValue.trim()) return;
    if (handoff === 'leave_at_door' && podType !== 'photo') {
      setPodError(t('orders.leaveAtDoorPhotoRequired'));
      return;
    }
    const loc = rider?.lastLocation;
    if (handoff === 'leave_at_door' && podType === 'photo' && !loc) {
      setPodError(t('orders.leaveAtDoorGpsRequired'));
      return;
    }
    setPodLoading(true);
    setPodError('');
    const pod = {
      type: podType,
      value: podValue.trim(),
      dropoffOption: handoff,
      itemIds: order.items?.map((i) => i.catalogueItemId).filter(Boolean) as string[] | undefined,
      gpsStamp: podType === 'photo' && loc ? { lat: loc.lat, lon: loc.lon, at: loc.updatedAt } : undefined,
    };
    try {
      const updated = await getDeliveryRepository().submitPOD(order.id, pod);
      setOrder((prev) => (prev ? { ...prev, ...updated } : prev));
      setPodVisible(false);
      useJobsStore.getState().setActiveOrder(null);
      useJobsStore.getState().refresh();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'POD_ALREADY_SUBMITTED') {
        setPodVisible(false);
        load();
      } else if (err?.code === 'POD_OTP_INVALID') {
        setPodError(err.message);
      } else {
        setPodError(err ? err.message : t('orders.podFailed'));
      }
    } finally {
      setPodLoading(false);
    }
  };

  const onFail = async (reason: string) => {
    if (!order) return;
    setFailing(true);
    setActionError('');
    try {
      const updated = await getDeliveryRepository().failDelivery(order.id, reason);
      setOrder((prev) => (prev ? { ...prev, ...updated } : prev));
      setFailVisible(false);
      useJobsStore.getState().setActiveOrder(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : t('orders.failFailed'));
    } finally {
      setFailing(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error || !order) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error || t('orders.notFound')}</Text>
          <Btn
            label={t('common.retry')}
            variant="ghost"
            onPress={() => {
              setError('');
              load();
            }}
          />
        </View>
      </Screen>
    );
  }

  const meta = statusMeta(order.status);
  const priority = priorityMeta(order.priority);
  const advance = advanceStepFor(order.status);
  const done = order.status === 'delivered' || order.status === 'completed';
  const failed = order.status === 'failed_delivery';
  const eta = formatEta(tracking?.estimateMinutes);
  const isCod = (fare?.codFeeTZS ?? 0) > 0 || offer?.paymentMethod === 'cod';
  const showQr = isCod && (order.status === 'delivering' || order.status === 'rider_arrived_dropoff');

  const fareRows: { label: string; value?: number }[] = [
    { label: t('orders.fareBase'), value: fare?.baseTZS },
    { label: t('orders.fareDistance'), value: fare?.distanceTZS },
    { label: t('orders.fareTime'), value: fare?.timeTZS },
    { label: t('orders.fareSurge'), value: fare?.surgeTZS },
    { label: t('orders.fareTip'), value: fare?.tipTZS },
    { label: t('orders.fareWaitTime'), value: fare?.waitPayTZS },
    { label: t('orders.fareBonus'), value: fare?.bonusTZS },
  ].filter((r) => r.value !== undefined);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Card style={{ gap: Spacing.sm }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, paddingRight: Spacing.md }}>
              <Text style={styles.orderId}>{t('orders.orderNo', { no: order.no ?? order.id })}</Text>
              <Text style={styles.orderDate}>{dateISO(order.createdAt)}</Text>
            </View>
            {priority ? <Pill label={priority.label} tone={priority.tone} /> : null}
          </Row>
          {failed ? (
            <View style={styles.failedBox}>
              <Icon name="alert-circle" size={14} color={Colors.danger} />
              <Text style={styles.failedText}>{order.rejectReason ?? t('orders.failedMarked')}</Text>
            </View>
          ) : (
            <Row gap={Spacing.sm}>
              <Pill label={meta.label} tone={meta.tone} />
              {eta ? <Text style={styles.eta}>{t('orders.eta', { eta })}</Text> : null}
            </Row>
          )}
        </Card>

        {/* Route */}
        {offer ? (
          <Card style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('orders.pickup')}</Text>
              <Text style={styles.routeMeta}>{offer.distanceKm.toFixed(1)} km</Text>
            </Row>
            <Text style={styles.routeAddress}>{offer.pickup?.address ?? '—'}</Text>
            <View style={styles.routeLine} />
            <Text style={styles.cardTitle}>{t('orders.dropoff')}</Text>
            <Text style={styles.routeAddress}>{offer.dropoff?.address ?? '—'}</Text>
            {offer.itemsSummary ? <Text style={styles.routeItems}>{offer.itemsSummary}</Text> : null}
          </Card>
        ) : null}

        {/* Fare */}
        {fare ? (
          <Card style={{ gap: Spacing.sm }}>
            <Text style={styles.cardTitle}>{t('orders.earnings')}</Text>
            {fareRows.map((r) => (
              <Row key={r.label} style={{ justifyContent: 'space-between' }}>
                <Text style={styles.fareLabel}>{r.label}</Text>
                <Text style={styles.fareValue}>{formatTZS(r.value ?? 0)}</Text>
              </Row>
            ))}
            <View style={styles.divider} />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.fareTotalLabel}>{t('orders.fareTotal')}</Text>
              <Text style={styles.fareTotal}>{formatTZS(fare.totalTZS)}</Text>
            </Row>
          </Card>
        ) : null}

        {/* Delivered summary */}
        {done ? (
          <Card style={{ alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.successSoft }}>
            <Icon name="checkmark-circle" size={44} color={Colors.success} />
            <Text style={styles.summaryTitle}>{t('orders.summaryTitle')}</Text>
            <Text style={styles.summarySub}>
              {t('orders.summarySub', { amount: fare ? formatTZS(fare.totalTZS) : t('orders.yourFare') })}
            </Text>
            <Btn label={t('orders.done')} variant="success" onPress={() => router.back()} style={{ alignSelf: 'stretch' }} />
          </Card>
        ) : null}
      </ScrollView>

      {/* Action bar */}
      {!done && !failed ? (
        <View style={styles.actionBar}>
          {offline ? <Text style={styles.offlineText}>{t('orders.offlineDisabled')}</Text> : null}
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('orders.call')} icon="call" variant="outline" onPress={onCall} loading={callLoading} disabled={advancing || podLoading || offline} style={{ flex: 1 }} />
            {advance ? (
              <Btn
                label={t(advance.labelKey)}
                icon="arrow-forward"
                onPress={onAdvance}
                loading={advancing}
                disabled={callLoading || podLoading || offline}
                style={{ flex: 2 }}
              />
            ) : order.status === 'rider_arrived_dropoff' ? (
              <Btn label={t('orders.pod')} icon="checkmark-circle" onPress={() => setPodVisible(true)} disabled={offline} style={{ flex: 2 }} />
            ) : null}
          </Row>
          {showQr ? (
            <Btn label={t('payments.showQr')} icon="qr-code" variant="outline" onPress={openQr} disabled={advancing || podLoading || offline} style={{ alignSelf: 'stretch' }} />
          ) : null}
          <Btn
            label={t('orders.failed')}
            variant="ghost"
            size="sm"
            onPress={() => setFailVisible(true)}
            disabled={advancing || podLoading || offline}
            style={{ alignSelf: 'center', marginTop: Spacing.xs }}
          />
          <SosButton
            onPress={() => router.push('/profile/safety')}
            style={{ alignSelf: 'center', marginTop: Spacing.sm, paddingHorizontal: Spacing.xl }}
          />
        </View>
      ) : null}

      {/* POD modal */}
      <SheetModal visible={podVisible} onClose={() => setPodVisible(false)} title={t('orders.pod')}>
        <Row gap={Spacing.sm}>
          {POD_OPTIONS.map((opt) => {
            const active = podType === opt.type;
            return (
              <Pressable
                key={opt.type}
                onPress={() => selectPodType(opt.type)}
                accessibilityRole="button"
                accessibilityLabel={t(opt.labelKey)}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [styles.podOption, active && styles.podOptionActive, pressed && { opacity: 0.7 }]}>
                <Icon name={opt.icon} size={20} color={active ? Colors.primaryDeep : Colors.textSecondary} />
                <Text style={[styles.podOptionLabel, active && { color: Colors.primaryDeep }]}>{t(opt.labelKey)}</Text>
              </Pressable>
            );
          })}
        </Row>

        {podType === 'photo' ? (
          <Pressable onPress={() => setPodValue(podValue ? '' : 'photo://simulated')} accessibilityRole="button" accessibilityLabel={t(podValue ? 'orders.podPhotoCaptured' : 'orders.podPhotoPrompt')} style={styles.simTile}>
            {podValue ? (
              <>
                <Icon name="checkmark-circle" size={26} color={Colors.success} />
                <Text style={styles.simTileText}>{t('orders.podPhotoCaptured')}</Text>
              </>
            ) : (
              <>
                <Icon name="camera" size={26} color={Colors.textTertiary} />
                <Text style={styles.simTileText}>{t('orders.podPhotoPrompt')}</Text>
              </>
            )}
          </Pressable>
        ) : podType === 'otp' ? (
          <TextInput
            value={podValue}
            onChangeText={(v) => setPodValue(v.replace(/\D/g, ''))}
            placeholder={t('orders.podOtpPlaceholder')}
            placeholderTextColor={Colors.textTertiary}
            keyboardType="number-pad"
            maxLength={6}
            accessibilityLabel={t('orders.podOtp')}
            style={styles.podInput}
          />
        ) : podType === 'signature' ? (
          <Pressable onPress={() => setPodValue(podValue ? '' : 'signature://simulated')} accessibilityRole="button" accessibilityLabel={t(podValue ? 'orders.podSignatureCaptured' : 'orders.podSignaturePrompt')} style={[styles.simTile, styles.sigTile]}>
            {podValue ? (
              <>
                <Icon name="checkmark-circle" size={26} color={Colors.success} />
                <Text style={styles.simTileText}>{t('orders.podSignatureCaptured')}</Text>
              </>
            ) : (
              <>
                <Icon name="create" size={26} color={Colors.textTertiary} />
                <Text style={styles.simTileText}>{t('orders.podSignaturePrompt')}</Text>
              </>
            )}
          </Pressable>
        ) : null}

        <View style={{ gap: Spacing.xs }}>
          <Text style={styles.podLabel}>{t('orders.dropoffOption')}</Text>
          <Segmented
            options={[
              { key: 'hand_to_customer', label: t('orders.handToCustomer') },
              { key: 'leave_at_door', label: t('orders.leaveAtDoor') },
            ]}
            value={handoff}
            onChange={setHandoff}
            equal
          />
        </View>

        {podError ? <Text style={styles.error}>{podError}</Text> : null}
        {offline ? <Text style={styles.offlineText}>{t('orders.offlineDisabled')}</Text> : null}
        <Btn label={t('orders.podConfirm')} icon="checkmark-done" onPress={submitPOD} loading={podLoading} disabled={!podType || !podValue.trim() || offline} size="lg" />
      </SheetModal>

      {/* Fail modal */}
      <SheetModal visible={failVisible} onClose={() => setFailVisible(false)} title={t('orders.failed')}>
        {reasonsLoading ? <Spinner color={Colors.primary} /> : null}
        {reasonsError ? <Text style={styles.error}>{reasonsError}</Text> : null}
        {reasons.map((r) => (
          <Pressable
            key={r}
            onPress={() => onFail(r)}
            disabled={failing}
            accessibilityRole="button"
            accessibilityState={{ disabled: failing }}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => [styles.reasonRow, pressed && { opacity: 0.7 }]}>
            <Text style={styles.reasonText}>{r}</Text>
          </Pressable>
        ))}
      </SheetModal>

      {/* Pickup confirm — merchant code (mock) or manual note fallback */}
      <SheetModal visible={pickupVisible} onClose={() => setPickupVisible(false)} title={t('orders.pickupConfirm')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: 6 }}>
            <Text style={styles.podLabel}>{t('orders.pickupCode')}</Text>
            <TextInput
              value={pickupCode}
              onChangeText={(v) => setPickupCode(v.replace(/\D/g, ''))}
              placeholder={t('orders.pickupCodePlaceholder')}
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              maxLength={4}
              accessibilityLabel={t('orders.pickupCode')}
              style={styles.podInput}
            />
            <Text style={styles.pickupHint}>{t('orders.pickupDemoHint')}</Text>
          </View>

          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.podLabel}>{t('orders.pickupManual')}</Text>
            <Switch
              value={pickupManual}
              onValueChange={(v) => {
                setPickupManual(v);
                setPickupError('');
              }}
              accessibilityLabel={t('orders.pickupManual')}
            />
          </Row>

          {pickupManual ? (
            <TextInput
              value={pickupNote}
              onChangeText={setPickupNote}
              placeholder={t('orders.pickupNotePlaceholder')}
              placeholderTextColor={Colors.textTertiary}
              multiline
              accessibilityLabel={t('orders.pickupNote')}
              style={styles.noteInput}
            />
          ) : null}

          {pickupError ? <Text style={styles.error}>{pickupError}</Text> : null}
          {offline ? <Text style={styles.offlineText}>{t('orders.offlineDisabled')}</Text> : null}
          <Btn
            label={t('orders.pickupSubmit')}
            icon="checkmark-done"
            onPress={submitPickup}
            loading={pickupLoading}
            disabled={offline || (pickupCode.trim().length !== 4 && !(pickupManual && pickupNote.trim().length > 0))}
            size="lg"
          />
        </View>
      </SheetModal>

      {/* Collection QR — customer scans to pay COD; rider never handles money */}
      <SheetModal visible={qrVisible} onClose={() => setQrVisible(false)} title={t('payments.qrTitle')}>
        {qrLoading ? <Spinner color={Colors.primary} /> : null}
        {qrError ? <Text style={styles.error}>{qrError}</Text> : null}
        {qrError && !qrLoading ? <Btn label={t('common.retry')} variant="ghost" onPress={() => void loadQr()} /> : null}
        {qr ? (
          <View style={{ alignItems: 'center', gap: Spacing.md }}>
            <View
              style={styles.qrFrame}
              accessible
              accessibilityRole="image"
              accessibilityLabel={t('payments.qrLabel', {
                amount: qr.amountTZS != null ? formatTZS(qr.amountTZS) : t('payments.variableAmount'),
              })}>
              <QRCode value={qr.qrPayload} size={200} backgroundColor={Colors.white} color={Colors.black} />
            </View>
            <Row gap={Spacing.sm}>
              <Text style={styles.qrLabel}>{t('payments.amount')}</Text>
              <Text style={styles.qrValue}>{qr.amountTZS != null ? formatTZS(qr.amountTZS) : t('payments.variableAmount')}</Text>
            </Row>
            <Row gap={Spacing.sm}>
              <Text style={styles.qrLabel}>{t('payments.provider')}</Text>
              <Text style={styles.qrValue}>{capitalize(qr.provider)}</Text>
            </Row>
            <Text style={styles.qrExpiry}>{t('payments.expires', { time: clockISO(qr.expiresAt) })}</Text>
          </View>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, paddingBottom: Spacing.xl, gap: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  orderId: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  orderDate: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  failedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  failedText: { flex: 1, color: Colors.danger, fontSize: FontSize.xs, fontWeight: '700' },
  eta: { color: Colors.textTertiary, fontSize: FontSize.xs, fontWeight: '600' },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  routeMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  routeAddress: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 },
  routeLine: {
    height: 14,
    width: 2,
    backgroundColor: Colors.borderStrong,
    marginLeft: 4,
    borderRadius: 1,
  },
  routeItems: { fontSize: FontSize.xs, color: Colors.textTertiary },
  fareLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  fareValue: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  fareTotalLabel: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  fareTotal: { fontSize: FontSize.lg, fontWeight: '900', color: Colors.primaryDeep, fontVariant: NumberStyle.fontVariant },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.xs },
  summaryTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  summarySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  actionBar: {
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.xs,
  },
  podOption: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  podOptionActive: { backgroundColor: Colors.primarySoft, borderColor: Colors.primary },
  podOptionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  simTile: {
    height: 96,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  sigTile: { height: 96 },
  simTileText: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  podInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.lg,
    color: Colors.text,
    backgroundColor: Colors.card,
    textAlign: 'center',
    letterSpacing: 4,
    fontVariant: NumberStyle.fontVariant,
  },
  podLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700' },
  reasonRow: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  reasonText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
  pickupHint: { fontSize: FontSize.xs, color: Colors.textTertiary },
  noteInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  qrFrame: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
  },
  qrLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', width: 72 },
  qrValue: { fontSize: FontSize.md, color: Colors.text, fontWeight: '800', fontVariant: NumberStyle.fontVariant },
  qrExpiry: { fontSize: FontSize.xs, color: Colors.textTertiary },
  offlineText: { color: Colors.warning, fontSize: FontSize.xs, fontWeight: '700', textAlign: 'center' },
});