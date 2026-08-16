import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Divider, EmptyState, ErrorState, Icon, Pill, Row, Screen, SkeletonCard, StatusPill } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getOrdersRepository, getShipmentsRepository } from '@/repos';
import { track } from '@/lib/analytics';
import { dateISO, fullDateISO, weekdayLabelISO, windowLabel } from '@/lib/dates';
import { buildDaySections, delayBannerData, shipmentHeaderData } from '@/lib/shipment';
import type { GetOrderWaybill200, OrderDetail, RouteSegment, TrackingPhase } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import type { DeliveryWindow, RouteCities } from '@/repos';

/** Shipment view (MASTER-BLUEPRINT §13) — the intercity/relay shipment
 * surface. Primary path: GET /shipments/{shipmentId} (contract
 * listShipments/getShipment) — the payload carries the waybill trail,
 * tracking phases and route legs (mock-only extras, CONTRACT-ADDITIONS.md
 * #8); header facts + the mock-only window/city fields (#5) still come from
 * the order. Order fallback: ids that aren't shipments (the route is reached
 * with an order id today) resolve the shipment context from the ORDER
 * surfaces — nothing fabricated. */
export default function ShipmentScreen() {
  const router = useRouter();
  const { shipmentId, orderId } = useLocalSearchParams<{ shipmentId: string; orderId?: string }>();
  const resolvedOrderId = orderId ?? shipmentId;

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [phases, setPhases] = useState<TrackingPhase[] | null>(null);
  const [route, setRoute] = useState<RouteSegment[] | null>(null);
  const [waybill, setWaybill] = useState<GetOrderWaybill200 | null>(null);
  const [shipmentNumber, setShipmentNumber] = useState<string | null>(null);
  const [isShipment, setIsShipment] = useState(false);
  // Mock-only until the contract ships the window/city fields
  // (docs/CONTRACT-ADDITIONS.md #5) — the live repo returns null.
  const [deliveryWindow, setDeliveryWindow] = useState<DeliveryWindow | null>(null);
  const [routeCities, setRouteCities] = useState<RouteCities | null>(null);
  const [shipmentLoading, setShipmentLoading] = useState(false);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    setError('');
    setNotFound(false);
    setOrder(null);
    setPhases(null);
    setRoute(null);
    setWaybill(null);
    setShipmentNumber(null);
    setIsShipment(false);
    setDeliveryWindow(null);
    setRouteCities(null);
    // Primary path: the shipments repo (GET /shipments/{id} — contract
    // getShipment). The shipment payload carries the waybill trail, phases
    // and route legs (mock-only extras, CONTRACT-ADDITIONS.md #8); header
    // facts and the mock-only window/city fields (#5) come from the order.
    try {
      const shipment = await getShipmentsRepository().get(resolvedOrderId);
      const shipmentOrderId = shipment.orderId ?? resolvedOrderId;
      const [detail, dw, rc] = await Promise.all([
        getOrdersRepository().get(shipmentOrderId),
        getOrdersRepository().getDeliveryWindow(shipmentOrderId),
        getOrdersRepository().getRouteCities(shipmentOrderId),
      ]);
      setOrder(detail);
      setDeliveryWindow(dw);
      setRouteCities(rc);
      setPhases(shipment.phases ?? null);
      setRoute(shipment.route ?? null);
      setWaybill(shipment.waybill ?? null);
      setShipmentNumber(shipment.shipmentNumber);
      setIsShipment(true);
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) {
        setError(t('common.error'));
        return;
      }
    }
    // Order fallback: ids that aren't shipments — resolve the shipment
    // context from the order (the contract route/waybill/tracking-phases).
    try {
      const detail = await getOrdersRepository().get(resolvedOrderId);
      if (detail.fulfillmentType !== 'intercity' && detail.fulfillmentType !== 'relay') {
        // Honest state: the shipment surface only exists for intercity/relay
        // orders (the contract exposes route/waybill/tracking-phases there).
        setOrder(detail);
        return;
      }
      setOrder(detail);
      setShipmentLoading(true);
      try {
        const [ph, rt, wb, dw, rc] = await Promise.all([
          getOrdersRepository().getTrackingPhases(resolvedOrderId),
          getOrdersRepository().getRoute(resolvedOrderId),
          getOrdersRepository().getWaybill(resolvedOrderId),
          getOrdersRepository().getDeliveryWindow(resolvedOrderId),
          getOrdersRepository().getRouteCities(resolvedOrderId),
        ]);
        setPhases(ph);
        setRoute(rt);
        setWaybill(wb);
        setDeliveryWindow(dw);
        setRouteCities(rc);
      } catch (e) {
        // 404 on any of the three endpoints is a hard "Shipment unavailable"
        // state — never silently fall back to an empty shipment.
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
          setError(t('shipment.unavailable'));
        }
      } finally {
        setShipmentLoading(false);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setNotFound(true);
        setError(t('shipment.unavailable'));
      } else {
        setError(t('common.error'));
      }
    }
  }, [resolvedOrderId]);

  useEffect(() => {
    load();
    track({ name: 'tracking_viewed', orderId: resolvedOrderId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const header = shipmentHeaderData(order);
  const delay = delayBannerData(waybill);
  const days = buildDaySections(route);

  const phaseTone = (p: TrackingPhase) => (p.status === 'completed' ? 'success' : p.status === 'active' ? 'info' : 'neutral');

  if (notFound) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

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
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  // The intercity-only empty state applies to the order fallback only — a
  // resolved shipment record renders its own surface (e.g. warehouse).
  if (!isShipment && header.fulfillmentType === null) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>{t('shipment.title')}</Text>
          </Row>
          <EmptyState
            icon="cube-outline"
            title={t('shipment.forIntercity')}
            actionLabel={t('shipment.viewOrder')}
            onAction={() => router.push(`/order/${resolvedOrderId}`)}
          />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('shipment.title')}</Text>
        </Row>

        {shipmentLoading ? (
          <View style={{ gap: Spacing.md }}>
            <SkeletonCard rows={2} />
            <SkeletonCard rows={4} />
          </View>
        ) : (
          <>
            {/* Order header — fulfillment type + waybill number + route cities
                (server data only; the city line renders only when the payload
                carries the names — mock-only until CONTRACT-ADDITIONS #5). */}
        <Card style={{ marginBottom: Spacing.md }}>
          <Row gap={Spacing.md} style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ gap: Spacing.xs, flex: 1 }}>
              {header.fulfillmentType ? (
                <View style={{ alignSelf: 'flex-start' }}>
                  <Pill label={header.fulfillmentType} tone="info" />
                </View>
              ) : null}
              {routeCities ? (
                <Text style={styles.value}>{t('track.originTo', { origin: routeCities.origin, destination: routeCities.destination })}</Text>
              ) : null}
              {header.waybillNumber ? (
                <Text style={styles.meta}>{t('track.waybillNumber', { n: header.waybillNumber })}</Text>
              ) : null}
              <Text style={styles.meta}>{order.no ?? order.id} · {dateISO(order.createdAt)}</Text>
            </View>
            <StatusPill status={order.status} />
          </Row>
        </Card>

        {/* Delivery-window promise card — server window only (mock-only until
            the contract ships the fields, CONTRACT-ADDITIONS #5). */}
        {deliveryWindow ? (
          <Card style={{ marginBottom: Spacing.md }}>
            <Row gap={Spacing.md} style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>{t('track.windowLabel')}</Text>
                <Text style={styles.meta}>{t('track.arrives', { window: windowLabel(deliveryWindow.from, deliveryWindow.to) })}</Text>
              </View>
              <Icon name="time-outline" size={20} color={Colors.primaryDeep} />
            </Row>
          </Card>
        ) : null}

        {/* Delay banner — only from server exception events, never fabricated */}
        {delay ? (
          <Card style={[styles.banner, { backgroundColor: Colors.warningSoft }]}>
            <Row gap={Spacing.md} style={{ alignItems: 'flex-start' }}>
              <View style={{ marginTop: 2 }}><Icon name="alert-circle" size={18} color={Colors.warning} /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: Colors.warning, fontSize: FontSize.sm, fontFamily: Fonts.sansExtraBold }}>{t('track.delayed')}</Text>
                {delay.note ? <Text style={[styles.meta, { color: Colors.textSecondary }]}>{delay.note}</Text> : null}
              </View>
            </Row>
          </Card>
        ) : null}

        {/* Six-phase strip — fixed order, per-phase at/eta from the server only */}
        {phases ? (
          <>
            <Text style={styles.section}>{t('track.phases')}</Text>
            <Card style={{ gap: Spacing.md }}>
              {phases.length === 0 ? (
                <EmptyState icon="time-outline" title={t('track.noPhases')} />
              ) : (
                phases.map((p, i) => (
                  <Row key={p.phase} gap={Spacing.md}>
                    <View style={styles.phaseRail}>
                      <View style={[styles.phaseDot, p.status === 'active' && { backgroundColor: Colors.primary }, p.status === 'completed' && { backgroundColor: Colors.success }]} />
                      {i < phases.length - 1 ? <View style={styles.phaseLine} /> : null}
                    </View>
                    <View style={{ flex: 1, paddingBottom: i < phases.length - 1 ? Spacing.lg : 0 }}>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={[styles.value, p.status === 'active' && { color: Colors.primaryDeep, fontFamily: Fonts.sansBold }]}>{p.label}</Text>
                        <Pill label={p.status} tone={phaseTone(p)} />
                      </Row>
                      {p.at ? <Text style={styles.meta}>{dateISO(p.at)}</Text> : null}
                      {p.eta ? <Text style={styles.meta}>{t('track.etaAt', { t: dateISO(p.eta) })}</Text> : null}
                    </View>
                  </Row>
                ))
              )}
            </Card>
          </>
        ) : null}

        {/* Route timeline — grouped into Day 1 / Day 2 sections */}
        {days.length > 0 ? (
          <>
            <Text style={styles.section}>{t('track.route')}</Text>
            {days.map((day) => (
              <Card key={day.key} style={{ gap: Spacing.md, marginBottom: Spacing.md }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold, color: Colors.primaryDeep, letterSpacing: 0.8 }}>{t('track.day', { n: day.day }).toUpperCase()}</Text>
                  {day.date ? <Text style={styles.meta}>{weekdayLabelISO(day.date)}</Text> : null}
                </Row>
                {day.legs.map((leg) => (
                  <Row key={leg.legId} gap={Spacing.md}>
                    <View style={styles.phaseRail}>
                      <View style={[styles.phaseDot, leg.status === 'completed' && { backgroundColor: Colors.success }, leg.status === 'in_progress' && { backgroundColor: Colors.primary }]} />
                      {day.legs.indexOf(leg) < day.legs.length - 1 ? <View style={styles.phaseLine} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={styles.value}>{leg.type}</Text>
                        <Pill label={leg.status} tone={leg.status === 'completed' ? 'success' : leg.status === 'in_progress' ? 'info' : 'neutral'} />
                      </Row>
                      <Text style={styles.meta}>
                        {leg.mode ?? ''} {leg.fromHubId && leg.toHubId ? `${leg.fromHubId} → ${leg.toHubId}` : ''}
                      </Text>
                      {leg.etaAt ? <Text style={styles.meta}>{t('track.etaAt', { t: dateISO(leg.etaAt) })}</Text> : null}
                    </View>
                  </Row>
                ))}
              </Card>
            ))}
          </>
        ) : null}

        {/* Waybill trail */}
        {waybill ? (
          <>
            <Text style={styles.section}>{t('track.waybill')}</Text>
            <Card style={{ gap: Spacing.sm }}>
              {waybill.events.length === 0 ? (
                <EmptyState icon="document-text-outline" title={t('track.noWaybill')} />
              ) : (
                waybill.events.map((ev, i) => (
                  <View key={i}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={[styles.value, ev.type === 'exception' && { color: Colors.warning, fontFamily: Fonts.sansBold }]}>{ev.type}</Text>
                      <Text style={styles.meta}>{fullDateISO(ev.at)}</Text>
                    </Row>
                    <Text style={styles.meta}>{ev.location}{ev.actor ? ` · ${ev.actor}` : ''}</Text>
                    {ev.note ? <Text style={styles.meta}>{ev.note}</Text> : null}
                    {i < waybill.events.length - 1 ? <Divider style={{ marginTop: Spacing.sm }} /> : null}
                  </View>
                ))
              )}
            </Card>
          </>
        ) : null}

        {/* Advanced disclosure — shipment reference for support */}
        {waybill || shipmentNumber ? (
          <Card style={{ marginTop: Spacing.md, paddingVertical: Spacing.sm }}>
            <Pressable onPress={() => setAdvancedOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: advancedOpen }} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg }, pressed && { opacity: 0.7 }]}>
              <View>
                <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold }}>{t('track.advanced')}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans }}>{t('track.advancedHint')}</Text>
              </View>
              <Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textTertiary} />
            </Pressable>
            {advancedOpen ? (
              <View style={{ paddingTop: Spacing.md, paddingHorizontal: Spacing.lg, gap: Spacing.xs }}>
                {shipmentNumber ? (
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={styles.meta}>{t('track.shipmentNumber')}</Text>
                    <Text style={[styles.value, { fontVariant: ['tabular-nums'] }]}>{shipmentNumber}</Text>
                  </Row>
                ) : null}
                {waybill ? (
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={[styles.value, { fontVariant: ['tabular-nums'] }]}>{t('track.waybillNumber', { n: waybill.waybillNumber })}</Text>
                  </Row>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        <Btn label={t('shipment.viewOrder')} onPress={() => router.push(`/order/${resolvedOrderId}`)} variant="outline" icon="receipt-outline" style={{ marginTop: Spacing.lg }} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  banner: { marginBottom: Spacing.md, marginTop: Spacing.md },
  phaseRail: { alignItems: 'center', width: 14 },
  phaseDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.borderStrong },
  phaseLine: { width: 2, flex: 1, backgroundColor: Colors.border, marginTop: 2 },
});
