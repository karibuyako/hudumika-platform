/* Shared order-tracking body (OPERATIONS-COVERAGE #77 "Share live location —
 * trip-share pattern"): the full tracking rendering — order header, delivery-
 * window promise card, rider map + ETA, warehouse chip, delay banner, six-
 * phase strip, route timeline, waybill trail, advanced disclosure and the
 * owner-only actions.
 *
 * Both tracking surfaces render through it:
 *   - the owner screen (src/app/order/[orderId]/tracking.tsx) — full actions
 *     (share, support, review, masked call, dev delay trigger);
 *   - the recipient screen (src/app/track-share/[token].tsx) — readOnly: every
 *     action button and the shared-view note render instead.
 *
 * Pure presentational: data + callbacks in, JSX out — fetching, polling,
 * live-refresh and error gating stay in the screens. */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  EmptyState,
  Icon,
  Pill,
  Row,
  Screen,
  StatusPill,
} from '@/components/ui';
import { MapView } from '@/components/MapView';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { clockISO, dateISO, fullDateISO, weekdayLabelISO, windowLabel } from '@/lib/dates';
import { toCoordinate } from '@/lib/maps';
import { isReviewable } from '@/lib/order';
import { buildDaySections, delayBannerData, shipmentHeaderData } from '@/lib/shipment';
import type { GetOrderWaybill200, OrderDetail, RouteSegment, TrackingEvent, TrackingPhase } from '@hudumika/contract';
import type { DeliveryWindow, RouteCities } from '@/repos';

const STALE_MS = 120000;

export interface OrderTrackingViewProps {
  order: OrderDetail;
  tracking: TrackingEvent;
  phases: TrackingPhase[] | null;
  route: RouteSegment[] | null;
  waybill: GetOrderWaybill200 | null;
  deliveryWindow: DeliveryWindow | null;
  routeCities: RouteCities | null;
  online?: boolean;
  /** Read-only (recipient) view: hides every action and shows the shared-view note. */
  readOnly?: boolean;
  /** Owner-only: "Share trip" (creates the tracking-share token + opens the share sheet). */
  onShare?: () => void;
  sharing?: boolean;
  onBack?: () => void;
  onSupport?: () => void;
  onReview?: () => void;
  onMaskedCall?: () => void;
  maskedBusy?: boolean;
  /** Dev-only delay simulation (owner screen only; undefined hides the button). */
  onSimulateDelay?: () => void;
}

export function OrderTrackingView({
  order,
  tracking,
  phases,
  route,
  waybill,
  deliveryWindow,
  routeCities,
  online = true,
  readOnly = false,
  onShare,
  sharing = false,
  onBack,
  onSupport,
  onReview,
  onMaskedCall,
  maskedBusy = false,
  onSimulateDelay,
}: OrderTrackingViewProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const stale = Date.now() - Date.parse(tracking.updatedAt) > STALE_MS;
  const riderLoc = toCoordinate(tracking.riderLocation);
  const eta = tracking.estimateMinutes;
  const header = order ? shipmentHeaderData(order) : null;
  const delay = delayBannerData(waybill);
  const days = useMemo(() => buildDaySections(route), [route]);
  const reviewable = isReviewable(order.status);

  const phaseTone = (p: TrackingPhase) => (p.status === 'completed' ? 'success' : p.status === 'active' ? 'info' : 'neutral');

  return (
    <Screen>
      {!online ? (
        <View style={styles.offlineBanner} accessibilityRole="alert">
          <Text style={styles.offlineText}>{t('track.offlineResume')}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={onBack} variant="subtle" size="sm" icon="arrow-back" />
          <Row gap={Spacing.sm}>
            {!readOnly && onShare ? (
              <Btn label={t('tripShare.share')} onPress={onShare} loading={sharing} variant="subtle" size="sm" icon="share-social-outline" />
            ) : null}
            <StatusPill status={tracking.status} />
          </Row>
        </Row>
        {readOnly ? (
          <Card style={[styles.banner, { backgroundColor: Colors.primarySoft }]}>
            <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>{t('tripShare.watchBanner')}</Text>
          </Card>
        ) : null}
        {/* Order header — server data only, nothing fabricated. The origin →
            destination city line renders only when the payload carries the
            city names (mock-only until CONTRACT-ADDITIONS #5 ships them). */}
        {header && (header.fulfillmentType !== null || header.waybillNumber) ? (
          <Card style={{ marginBottom: Spacing.md }}>
            <Row gap={Spacing.md} style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ gap: Spacing.xs, flex: 1 }}>
                {header.fulfillmentType !== null ? (
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
              </View>
              <Text style={styles.meta}>{t('track.stale', { t: fullDateISO(tracking.updatedAt) })}</Text>
            </Row>
          </Card>
        ) : null}
        {/* Delivery-window promise card — rendered ONLY from the server window
            (deliveryWindowFrom/To; mock-only until the contract ships them,
            CONTRACT-ADDITIONS #5). The delayed event reposts it via the mock. */}
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
        {/* Rider map + ETA — renders server values verbatim, computes nothing.
            The map centers on the rider's own position (the only coordinate
            the tracking event carries) via the lib/maps abstraction; when the
            event has no riderLocation the surface shows the unavailable state
            and the ETA row falls back to the same copy. */}
        <Card>
          {riderLoc ? (
            <MapView center={riderLoc} marker={riderLoc} height={170} label={t('map.riderMarker')} />
          ) : (
            <View style={styles.mapPlaceholder}>
              <Icon name="location-outline" size={30} color={Colors.textFaint} />
              <Text style={styles.meta}>{t('track.locationUnavailable')}</Text>
            </View>
          )}
          <Row gap={Spacing.md} style={{ padding: Spacing.lg, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              {riderLoc ? (
                <>
                  <Text style={styles.eta}>
                    {eta !== undefined ? t('order.estimated', { m: eta }) : '—'}
                  </Text>
                  <Text style={styles.meta}>{t('track.stale', { t: clockISO(tracking.updatedAt) })}</Text>
                </>
              ) : (
                <Text style={styles.meta}>{t('track.locationUnavailable')}</Text>
              )}
            </View>
          </Row>
          {stale ? (
            <Text style={[styles.meta, { color: Colors.warning, marginTop: Spacing.sm, marginLeft: Spacing.lg }]}>{t('track.stale', { t: clockISO(tracking.updatedAt) })}</Text>
          ) : null}
        </Card>

        {/* Warehouse source chip — fulfillmentSource only. The contract has no
            dispatchStrategyLabel, so dispatchStrategy renders nothing (the app
            never composes strategy copy). */}
        {order?.fulfillmentSource === 'warehouse' ? (
          <Card style={[styles.banner, { backgroundColor: Colors.primarySoft }]}>
            <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>{t('order.warehouseChip')}</Text>
          </Card>
        ) : null}

        {/* Dev-only trigger (E2E T3/T6): exercises the delay simulation for
            the seeded intercity order. Never rendered in production builds
            (the owner screen passes onSimulateDelay only in dev) and never in
            the read-only shared view. */}
        {!readOnly && onSimulateDelay && order?.id === 'ord_intercity_002' ? (
          <Btn label={t('track.simulateDelay')} onPress={onSimulateDelay} variant="subtle" size="sm" style={{ alignSelf: 'flex-start' }} />
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

        {/* Route timeline (intercity) — grouped into Day 1 / Day 2 sections */}
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

        {/* Waybill trail (intercity) */}
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

        {/* Advanced disclosure — shipment reference for support (intercity only) */}
        {waybill ? (
          <Card style={{ marginTop: Spacing.md, paddingVertical: Spacing.sm }}>
            <PressableRow label={t('track.advanced')} hint={t('track.advancedHint')} open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} />
            {advancedOpen ? (
              <View style={{ paddingTop: Spacing.md, gap: Spacing.xs }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.meta}>{t('track.shipmentNumber')}</Text>
                  <Text style={[styles.value, { fontVariant: ['tabular-nums'] }]}>{waybill.waybillNumber}</Text>
                </Row>
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* Owner-only actions — hidden entirely in the read-only shared view */}
        {!readOnly ? (
          <>
            <Btn label={t('order.support')} onPress={onSupport} variant="outline" style={{ marginTop: Spacing.lg }} />
            {reviewable ? (
              <Btn label={t('order.review')} onPress={onReview} variant="outline" style={{ marginTop: Spacing.md }} />
            ) : null}
            <Btn label={t('track.maskedCall')} onPress={onMaskedCall} loading={maskedBusy} variant="subtle" icon="call-outline" style={{ marginTop: Spacing.md }} />
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapPlaceholder: {
    height: 170,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  eta: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  banner: { marginBottom: Spacing.md, marginTop: Spacing.md },
  offlineBanner: {
    backgroundColor: Colors.warningSoft,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  offlineText: { color: Colors.warning, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, textAlign: 'center' },
  phaseRail: { alignItems: 'center', width: 14, alignSelf: 'stretch' },
  phaseDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.borderStrong },
  phaseLine: { width: 2, flex: 1, minHeight: 18, backgroundColor: Colors.border, marginTop: 2 },
});

function PressableRow({ label, hint, open, onToggle }: { label: string; hint: string; open: boolean; onToggle: () => void }) {
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg }, pressed && { opacity: 0.7 }]}>
      <View>
        <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold }}>{label}</Text>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans }}>{hint}</Text>
      </View>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textTertiary} />
    </Pressable>
  );
}
