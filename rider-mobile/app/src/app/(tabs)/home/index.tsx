import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { Badge, Btn, Card, CountdownRing, Empty, Icon, Kpi, Pill, Row, Screen, SectionTitle, SheetModal, SosButton, Spinner, useReduceMotion } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { capitalize, statusMeta } from '@/lib/order';
import { clockISO } from '@/lib/format';
import { getEarningsRepository, getNotificationsRepository, getRiderRepository } from '@/repos';
import type { DispatchOfferFeedItem } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import { useSessionStore } from '@/store/session';
import type { RiderShift } from '@hudumika/contract';

const OFFER_WINDOW_SECONDS = 120;

export default function HomeScreen() {
  const rider = useSessionStore((s) => s.rider);
  const available = useJobsStore((s) => s.available);
  const feedLoading = useJobsStore((s) => s.loading);
  const feedError = useJobsStore((s) => s.error);
  const activeOrder = useJobsStore((s) => s.activeOrder);
  const reduceMotion = useReduceMotion();

  const [shift, setShift] = useState<RiderShift | null>(null);
  const [today, setToday] = useState<{ earningsTZS: number; deliveries: number; onlineMinutes: number } | null>(null);
  const [statsError, setStatsError] = useState('');
  const [toggling, setToggling] = useState(false);
  const [clocking, setClocking] = useState(false);

  const [offer, setOffer] = useState<DispatchOfferFeedItem | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [reasonsLoading, setReasonsLoading] = useState(false);
  const [reasonsError, setReasonsError] = useState('');
  const [modalError, setModalError] = useState('');
  const [feedNotice, setFeedNotice] = useState('');

  const [unreadCount, setUnreadCount] = useState(0);

  const [reconcileVisible, setReconcileVisible] = useState(false);
  const [reconcileExpected, setReconcileExpected] = useState(0);
  const [reconcileCollected, setReconcileCollected] = useState('');
  const [reconcileError, setReconcileError] = useState('');
  const [reconciling, setReconciling] = useState(false);
  const [reconcileShiftId, setReconcileShiftId] = useState('');

  const loadShiftAndStats = useCallback(async () => {
    setStatsError('');
    try {
      const [shifts, summary] = await Promise.all([
        getRiderRepository().listShifts('current'),
        getEarningsRepository().getTodaySummary(),
      ]);
      setShift(shifts.find((s) => s.status === 'active') ?? shifts[0] ?? null);
      setToday(summary);
    } catch (e) {
      setStatsError(e instanceof ApiError ? e.message : t('home.loadShiftFailed'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadShiftAndStats();
      useJobsStore.getState().refresh();
    }, [loadShiftAndStats]),
  );

  // Unread badge refreshes on focus so reading notifications updates it.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getNotificationsRepository()
        .list()
        .then((items) => {
          if (cancelled) return;
          setUnreadCount(items.filter((n) => !n.read).length);
        })
        .catch(() => {
          if (!cancelled) setUnreadCount(0);
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const dismissOffer = useCallback(() => {
    setOffer(null);
    setDeclining(false);
    setModalError('');
  }, []);

  const expireOffer = useCallback((notify = false) => {
    setOffer(null);
    setDeclining(false);
    setModalError('');
    useJobsStore.getState().refresh();
    if (notify) {
      setFeedNotice(t('jobs.offerExpired'));
      setTimeout(() => setFeedNotice((n) => (n === t('jobs.offerExpired') ? '' : n)), 4000);
    }
  }, []);

  const onToggleAvailability = async (online: boolean) => {
    setToggling(true);
    try {
      const updated = await getRiderRepository().setAvailability(online);
      useSessionStore.getState().applyRider(updated);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Location sharing runs only while online (native-only; no-ops elsewhere).
      try {
        const { startBackgroundTracking, stopBackgroundTracking } = await import('@/lib/location');
        if (online) void startBackgroundTracking();
        else void stopBackgroundTracking();
      } catch {
        /* not native */
      }
    } catch (e) {
      setStatsError(e instanceof ApiError ? e.message : t('home.availabilityFailed'));
    } finally {
      setToggling(false);
    }
  };

  const onClockIn = async () => {
    setClocking(true);
    try {
      setShift(await getRiderRepository().clockIn());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SHIFT_ALREADY_ACTIVE') {
        loadShiftAndStats();
      } else {
        setStatsError(e instanceof ApiError ? e.message : t('home.clockInFailed'));
      }
    } finally {
      setClocking(false);
    }
  };

  const onClockOut = async () => {
    if (!shift) return;
    setClocking(true);
    try {
      setShift(await getRiderRepository().clockOut(shift.id));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SHIFT_CASH_MISMATCH') {
        const expected = typeof e.details?.expectedTZS === 'number' ? e.details.expectedTZS : 0;
        setReconcileShiftId(shift.id);
        setReconcileExpected(expected);
        setReconcileCollected(String(expected));
        setReconcileError('');
        setReconcileVisible(true);
      } else {
        setStatsError(e instanceof ApiError ? e.message : t('home.clockOutFailed'));
      }
    } finally {
      setClocking(false);
    }
  };

  const submitReconciliation = async () => {
    if (!reconcileShiftId) return;
    const amount = Number(reconcileCollected.replace(/\D/g, ''));
    if (!Number.isInteger(amount) || amount < 0) {
      setReconcileError(t('home.reconcileInvalidAmount'));
      return;
    }
    setReconciling(true);
    setReconcileError('');
    try {
      const done = await getRiderRepository().clockOut(reconcileShiftId, {
        cashCollectedTZS: amount,
        cashReconciled: true,
      });
      setShift(done);
      setReconcileVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SHIFT_CASH_MISMATCH') {
        const expected = typeof e.details?.expectedTZS === 'number' ? e.details.expectedTZS : reconcileExpected;
        setReconcileExpected(expected);
        setReconcileError(t('home.reconcileMismatch'));
      } else {
        setReconcileError(e instanceof ApiError ? e.message : t('home.clockOutFailed'));
      }
    } finally {
      setReconciling(false);
    }
  };

  const onAccept = async () => {
    if (!offer) return;
    if (forcedRest) {
      setModalError(t('home.restEnforced'));
      return;
    }
    setAccepting(true);
    setModalError('');
    try {
      const order = await useJobsStore.getState().acceptOffer(offer.orderId);
      if (!order) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      dismissOffer();
      router.push(`/orders/${order.id}`);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err && (err.code === 'OFFER_NOT_AVAILABLE' || err.code === 'OFFER_NOT_FOUND' || err.code === 'REST_ENFORCED')) {
        if (err.code === 'REST_ENFORCED') setModalError(t('home.restEnforced'));
        else expireOffer(true);
      } else {
        setModalError(err ? err.message : t('jobs.acceptFailed'));
      }
    } finally {
      setAccepting(false);
    }
  };

  const onDecline = () => {
    setDeclining(true);
    setModalError('');
    if (reasons.length === 0) loadReasons();
  };

  const loadReasons = async () => {
    setReasonsLoading(true);
    setReasonsError('');
    try {
      setReasons(await getRiderRepository().listRejectReasons());
    } catch (e) {
      setReasonsError(e instanceof ApiError ? e.message : t('jobs.reasonsFailed'));
    } finally {
      setReasonsLoading(false);
    }
  };

  const pickReason = async (reason?: string) => {
    if (!offer) return;
    setAccepting(true);
    setModalError('');
    try {
      await useJobsStore.getState().rejectOffer(offer.orderId, reason);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      dismissOffer();
    } catch (e) {
      setModalError(e instanceof ApiError ? e.message : t('jobs.declineFailed'));
    } finally {
      setAccepting(false);
    }
  };

  const online = rider?.online ?? false;
  const verified = rider?.verification === 'approved';

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shift?.forcedRestUntil) return;
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, [shift?.forcedRestUntil]);
  const forcedRest = shift?.forcedRestUntil != null && new Date(shift.forcedRestUntil).getTime() > now;

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.lg }}>
        <Text style={styles.heading}>{t('tab.home')}</Text>
        <Row gap={Spacing.sm}>
          <Pressable
            onPress={() => router.push('/notifications')}
            accessibilityRole="button"
            accessibilityLabel={unreadCount > 0 ? t('notifications.unread', { count: unreadCount }) : t('notifications.title')}
            hitSlop={8}
            style={styles.bellBtn}>
            <Icon name="notifications-outline" size={22} color={Colors.text} />
            <View style={styles.bellBadge}>
              <Badge count={unreadCount} />
            </View>
          </Pressable>
          <SosButton onPress={() => router.push('/profile/safety')} />
        </Row>
      </Row>

      {/* Availability */}
      <Card style={styles.availability}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={Spacing.md}>
            <View style={[styles.dot, { backgroundColor: online ? Colors.success : Colors.borderStrong }]} />
            <View>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: online ? Colors.success : Colors.textSecondary }}>
                {online ? t('home.online') : t('home.offline')}
              </Text>
              <Text style={styles.availabilitySub}>
                {online ? t('home.receivingOffers') : t('home.offersPaused')}
              </Text>
            </View>
          </Row>
          <Switch
            value={online}
            onValueChange={onToggleAvailability}
            disabled={toggling || !verified}
            accessibilityRole="switch"
            accessibilityLabel={t('home.availability')}
            accessibilityState={{ checked: online, disabled: toggling || !verified }}
            trackColor={{ false: Colors.borderStrong, true: Colors.success }}
            thumbColor={Colors.white}
            ios_backgroundColor={Colors.borderStrong}
          />
        </Row>
        {!verified ? (
          <View style={styles.gateBox}>
            <Icon name="lock-closed" size={13} color={Colors.warning} />
            <Text style={styles.gateText}>{t('home.verificationPending')}</Text>
          </View>
        ) : null}
      </Card>

      {/* Shift */}
      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.cardTitle}>{t('home.shift')}</Text>
          {shift ? <Pill label={shift.status.toUpperCase()} tone={shift.status === 'active' ? 'success' : 'neutral'} /> : null}
        </Row>
        {shift?.status === 'active' ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.shiftTime}>{t('home.clockedInAt', { time: clockISO(shift.clockedInAt) })}</Text>
              <Text style={styles.shiftStats}>
                {t('home.shiftStats', { deliveries: shift.deliveriesCompleted ?? 0, tzs: formatTZS(shift.earningsTZS ?? 0) })}
              </Text>
            </Row>
            <Btn label={t('home.clockOut')} variant="dark" onPress={onClockOut} loading={clocking} />
          </>
        ) : (
          <Btn label={t('home.clockIn')} onPress={onClockIn} loading={clocking} />
        )}
        {forcedRest ? (
          <View style={styles.restBox}>
            <Icon name="moon" size={14} color={Colors.warning} />
            <Text style={styles.restText}>{t('home.breakUntil', { time: clockISO(shift?.forcedRestUntil) })}</Text>
          </View>
        ) : null}
      </Card>

      {/* Quick stats */}
      {statsError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{statsError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadShiftAndStats} />
        </Card>
      ) : today ? (
        <Row gap={Spacing.md}>
          <Kpi label={t('home.today')} value={formatTZS(today.earningsTZS)} icon="cash-outline" />
          <Kpi label={t('home.deliveries')} value={String(today.deliveries)} icon="receipt-outline" />
          <Kpi label={t('home.rating')} value={rider?.rating != null ? rider.rating.toFixed(1) : '—'} icon="star-outline" />
        </Row>
      ) : (
        <View style={{ paddingVertical: Spacing.xl }}>
          <Spinner color={Colors.primary} />
        </View>
      )}

      {/* Heatmap — Meituan-style demand zones (surge guidance) */}
      {(() => {
        const heatmap = useJobsStore((s) => s.heatmap);
        if (!heatmap.length) return null;
        const toneForLevel = (lvl: string): 'danger' | 'warning' | 'info' | 'neutral' => (lvl === 'critical' ? 'danger' : lvl === 'high' ? 'warning' : lvl === 'medium' ? 'info' : 'neutral');
        return (
          <Card style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('jobs.heatmap')}</Text>
              <Icon name="flame-outline" size={16} color={Colors.warning} />
            </Row>
            <View style={{ gap: Spacing.sm }}>
              {heatmap.slice(0, 5).map((z) => (
                <Row key={z.zoneId} style={{ justifyContent: 'space-between' }}>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary }}>
                    {z.name}
                  </Text>
                  <Row gap={Spacing.sm}>
                    <Pill label={z.demandLevel.toUpperCase()} tone={toneForLevel(z.demandLevel)} />
                    {z.surgeMultiplier && z.surgeMultiplier > 1 ? <Text style={{ fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700' }}>×{z.surgeMultiplier.toFixed(1)}</Text> : null}
                    {typeof z.activeOrders === 'number' ? <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{z.activeOrders} orders</Text> : null}
                  </Row>
                </Row>
              ))}
            </View>
          </Card>
        );
      })()}

      {/* Active delivery */}
      {activeOrder ? (
        <Card onPress={() => router.push(`/orders/${activeOrder.id}`)} style={{ backgroundColor: Colors.successSoft }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Row gap={Spacing.md}>
              <Icon name="navigate" size={20} color={Colors.success} />
              <View>
                <Text style={styles.cardTitle}>{t('home.currentDelivery')}</Text>
                <Text style={styles.activeOrderSub}>
                  {activeOrder.no ?? activeOrder.id} · {statusMeta(activeOrder.status).label}
                </Text>
              </View>
            </Row>
            <Icon name="chevron-forward" size={16} color={Colors.textFaint} />
          </Row>
        </Card>
      ) : null}

      {/* Available feed */}
      <SectionTitle title={t('jobs.available')} icon="flash" action={t('common.refresh')} onAction={() => useJobsStore.getState().refresh()} />
      {feedNotice ? (
        <View style={styles.noticeBox}>
          <Icon name="alert-circle-outline" size={14} color={Colors.warning} />
          <Text style={styles.noticeText}>{feedNotice}</Text>
        </View>
      ) : null}
      {feedError && available.length > 0 ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{feedError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={() => useJobsStore.getState().refresh()} />
        </Card>
      ) : null}
      {feedLoading && available.length === 0 ? (
        <View style={{ paddingVertical: Spacing.xl }}>
          <Spinner color={Colors.primary} />
        </View>
      ) : feedError && available.length === 0 ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{feedError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={() => useJobsStore.getState().refresh()} />
        </Card>
      ) : available.length === 0 ? (
        <Empty icon="flash-outline" title={t('jobs.none')} sub={t('jobs.noneSub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {available.map((item) => {
            const o = item.offer;
            return (
              <Card key={item.orderId} onPress={() => setOffer(item)} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Text style={styles.offerEarnings}>{formatTZS(o.estimatedEarningsTZS)}</Text>
                  <Text style={styles.offerDistance}>{o.distanceKm.toFixed(1)} km</Text>
                </Row>
                <View style={{ gap: 6 }}>
                  <Row gap={Spacing.sm}>
                    <Icon name="location" size={14} color={Colors.success} />
                    <Text numberOfLines={1} style={styles.offerAddress}>{o.pickup?.address ?? t('orders.pickup')}</Text>
                  </Row>
                  <Row gap={Spacing.sm}>
                    <Icon name="navigate" size={14} color={Colors.info} />
                    <Text numberOfLines={1} style={styles.offerAddress}>{o.dropoff?.address ?? t('orders.dropoff')}</Text>
                  </Row>
                </View>
                <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
                  {o.paymentMethod ? <Pill label={capitalize(o.paymentMethod)} tone="neutral" /> : null}
                  {o.itemsSummary ? (
                    <Text numberOfLines={1} style={styles.offerItems}>{o.itemsSummary}</Text>
                  ) : null}
                </Row>
              </Card>
            );
          })}
        </View>
      )}

      {/* Offer takeover — fullscreen modal, no tab bar. The CountdownRing owns
          the 1s tick and auto-declines on expiry (no per-second re-render here). */}
      <Modal visible={!!offer} animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={dismissOffer}>
        <SafeAreaView style={styles.takeover}>
          {offer ? (
            <View style={styles.takeoverBody}>
              <View style={styles.ringWrap}>
                <CountdownRing expiresAt={offer.expiresAt} totalSeconds={OFFER_WINDOW_SECONDS} label={t('jobs.offer')} onExpire={() => expireOffer()} />
              </View>
              <Text style={styles.takeoverTitle}>{t('jobs.offer')}</Text>

              {/* Route card */}
              <Card style={{ gap: Spacing.md }}>
                <Row gap={Spacing.sm}>
                  <Icon name="location" size={16} color={Colors.success} />
                  <Text style={styles.routeLabel}>{t('orders.pickup')}</Text>
                  <Text numberOfLines={2} style={styles.routeAddress}>{offer.offer.pickup?.address ?? t('orders.pickup')}</Text>
                </Row>
                <Row gap={Spacing.sm}>
                  <Icon name="navigate" size={16} color={Colors.info} />
                  <Text style={styles.routeLabel}>{t('orders.dropoff')}</Text>
                  <Text numberOfLines={2} style={styles.routeAddress}>{offer.offer.dropoff?.address ?? t('orders.dropoff')}</Text>
                </Row>
                <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
                  <Text style={styles.metaText}>{offer.offer.distanceKm.toFixed(1)} km</Text>
                  {offer.offer.predictedPrepMinutes != null ? (
                    <Text style={styles.metaText}>{t('jobs.prepTime', { minutes: offer.offer.predictedPrepMinutes })}</Text>
                  ) : null}
                  {offer.offer.paymentMethod === 'cod' ? <Pill label={t('jobs.cod')} tone="warning" /> : null}
                  {offer.offer.itemsSummary ? (
                    <Text numberOfLines={2} style={styles.itemsText}>{offer.offer.itemsSummary}</Text>
                  ) : null}
                </Row>
              </Card>

              {/* Earnings box */}
              <View style={styles.earningsBox}>
                <Text style={styles.earningsLabel}>{t('jobs.earnings')}</Text>
                <Text style={styles.earningsValue}>{formatTZS(offer.offer.estimatedEarningsTZS)}</Text>
              </View>

              <View style={{ marginTop: 'auto', gap: Spacing.md }}>
                {!declining ? (
                  <Row gap={Spacing.md}>
                    <Btn label={t('jobs.decline')} variant="outline" onPress={onDecline} disabled={accepting} style={{ flex: 1, minHeight: 48 }} />
                    <Btn label={t('jobs.accept')} icon="checkmark-circle" onPress={onAccept} loading={accepting} style={{ flex: 2, minHeight: 48 }} />
                  </Row>
                ) : (
                  <View style={{ gap: Spacing.xs }}>
                    <Text style={styles.reasonLabel}>{t('jobs.rejectReason')}</Text>
                    {reasonsLoading ? <Spinner color={Colors.primary} /> : null}
                    {reasonsError ? <Text style={styles.error}>{reasonsError}</Text> : null}
                    {reasonsError && reasons.length === 0 ? (
                      <Btn label={t('jobs.decline')} variant="outline" onPress={() => pickReason()} disabled={accepting} style={{ minHeight: 48 }} />
                    ) : null}
                    {reasons.map((r) => (
                      <Pressable
                        key={r}
                        onPress={() => pickReason(r)}
                        disabled={accepting}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: accepting }}
                        hitSlop={{ top: 4, bottom: 4 }}
                        style={({ pressed }) => [styles.reasonRow, pressed && { opacity: 0.7 }]}>
                        <Text style={styles.reasonText}>{r}</Text>
                        <Icon name="chevron-forward" size={13} color={Colors.textFaint} />
                      </Pressable>
                    ))}
                    <Pressable onPress={() => setDeclining(false)} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={16}>
                      <Text style={styles.backLink}>{t('common.back')}</Text>
                    </Pressable>
                  </View>
                )}

                {modalError ? <Text style={styles.error}>{modalError}</Text> : null}
              </View>
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>

      {/* Shift cash reconciliation */}
      <SheetModal visible={reconcileVisible} onClose={() => setReconcileVisible(false)} title={t('home.reconcileTitle')}>
        <View style={{ gap: Spacing.md }}>
          <View style={styles.reconcileExpectedBox}>
            <Text style={styles.reconcileExpectedLabel}>{t('home.reconcileExpected')}</Text>
            <Text style={styles.reconcileExpectedValue}>{formatTZS(reconcileExpected)}</Text>
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.reasonLabel}>{t('home.reconcileCollected')}</Text>
            <TextInput
              value={reconcileCollected}
              onChangeText={(v) => setReconcileCollected(v.replace(/\D/g, ''))}
              placeholder="0"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              style={styles.reconcileInput}
            />
          </View>
          {reconcileError ? <Text style={styles.error}>{reconcileError}</Text> : null}
          <Btn
            label={t('home.reconcileSubmit')}
            icon="checkmark-circle"
            onPress={submitReconciliation}
            loading={reconciling}
            disabled={!reconcileShiftId}
            size="lg"
          />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.text },
  availability: { marginBottom: Spacing.md },
  availabilitySub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  shiftTime: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  shiftStats: { fontSize: FontSize.sm, color: Colors.textTertiary, fontVariant: NumberStyle.fontVariant },
  restBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  restText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, fontWeight: '700' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  gateBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  gateText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, fontWeight: '700' },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  noticeText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, fontWeight: '600' },
  reconcileExpectedBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  reconcileExpectedLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  reconcileExpectedValue: {
    fontSize: FontSize.xl,
    fontWeight: '900',
    color: Colors.primaryDeep,
    fontVariant: NumberStyle.fontVariant,
  },
  reconcileInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.lg,
    color: Colors.text,
    backgroundColor: Colors.card,
    textAlign: 'center',
    fontVariant: NumberStyle.fontVariant,
  },
  activeOrderSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, fontVariant: NumberStyle.fontVariant },
  offerEarnings: { fontSize: FontSize.xl, fontWeight: '900', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  offerDistance: { fontSize: FontSize.sm, color: Colors.textTertiary, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  offerAddress: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm },
  offerItems: { flex: 1, color: Colors.textTertiary, fontSize: FontSize.xs },
  bellBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  bellBadge: { position: 'absolute', top: 4, right: 4 },
  takeover: { flex: 1, backgroundColor: Colors.bg },
  takeoverBody: { flex: 1, padding: Spacing.xl, gap: Spacing.lg },
  ringWrap: { alignItems: 'center', marginTop: Spacing.sm },
  takeoverTitle: { textAlign: 'center', fontSize: FontSize.xl, fontWeight: '900', color: Colors.text },
  routeLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', width: 58 },
  routeAddress: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 19 },
  metaText: { color: Colors.textSecondary, fontSize: FontSize.xs, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  itemsText: { flex: 1, color: Colors.textTertiary, fontSize: FontSize.xs },
  earningsBox: {
    backgroundColor: Colors.successSoft,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: 4,
  },
  earningsLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  earningsValue: {
    fontSize: FontSize.xxl,
    fontWeight: '900',
    color: Colors.success,
    fontVariant: NumberStyle.fontVariant,
  },
  reasonLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700', marginTop: Spacing.sm },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  reasonText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
  backLink: { color: Colors.textTertiary, fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },
});