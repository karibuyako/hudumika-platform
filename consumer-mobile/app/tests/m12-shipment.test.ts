/* M12 — Shipment detail + dispute center data paths.
 *
 * Shipment: pure day-section/delay/header helpers (src/lib/shipment.ts) + the
 * repo-level path through the mock-first shipments repo (GET /shipments +
 * /shipments/{id} — contract listShipments/getShipment; the consumer surface
 * of waybill/phases/route rides the payload as mock-only extras,
 * CONTRACT-ADDITIONS.md #8), with the order-derived fallback still covered
 * for non-shipment ids.
 *
 * Disputes: the data path the dispute center sources — disputed orders and
 * disputed bookings filter from the mock seeds (the bookings seed lives in
 * src/repos/mock/bookings.ts module-local, since mockState is read-only), and
 * refunded payment intents resolve through getHistory().
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDaySections, delayBannerData, shipmentHeaderData } from '@/lib/shipment';
import { localSlotISO, windowLabel } from '@/lib/dates';
import { resetMockState, getState, nowIso, simulateIntercityDelay } from '@/repos/mock/mockState';
import { MockOrdersRepository, resetMockOrdersState } from '@/repos/mock/orders';
import { MockBookingsRepository } from '@/repos/mock/bookings';
import { MockPaymentsRepository } from '@/repos/mock/payments';
import { MockShipmentsRepository } from '@/repos/mock/shipments';
import { rejectsApiError } from './helpers';
import type { RouteSegment } from '@hudumika/contract';

const orders = new MockOrdersRepository();
const bookings = new MockBookingsRepository();
const payments = new MockPaymentsRepository();
const shipments = new MockShipmentsRepository();

beforeEach(() => {
  resetMockState();
  resetMockOrdersState();
});

/* ---------------- shipment helpers (src/lib/shipment.ts) ---------------- */

test('buildDaySections groups route legs into Day 1 / Day 2 sections in plan order', () => {
  // localSlotISO builds UTC timestamps from LOCAL components, so the local
  // day grouping below is deterministic regardless of the runner's timezone.
  // (The day key derives from the rendered date prefix — same as tracking.tsx.)
  const day1 = new Date();
  const day2 = new Date(day1.getTime() + 86400_000);
  const route: RouteSegment[] = [
    { legId: 'l1', sequence: 1, type: 'first_mile', mode: 'motorcycle', status: 'completed', plannedStartAt: localSlotISO(day1, 9, 0) },
    { legId: 'l2', sequence: 2, type: 'linehaul', mode: 'bus', status: 'in_progress', plannedStartAt: localSlotISO(day1, 9, 30) },
    { legId: 'l3', sequence: 3, type: 'last_mile', status: 'pending', plannedStartAt: localSlotISO(day2, 9, 0) },
  ];
  const days = buildDaySections(route);
  assert.equal(days.length, 2, 'two distinct local days → two sections');
  assert.equal(days[0].day, 1);
  assert.deepEqual(days[0].legs.map((l) => l.legId), ['l1', 'l2'], 'same-day legs stay in plan order');
  assert.equal(days[1].day, 2);
  assert.deepEqual(days[1].legs.map((l) => l.legId), ['l3']);
  assert.ok(days[0].date.length > 0, 'section carries its label date');
});

test('buildDaySections falls back to etaAt and buckets untimestamped legs, and handles empties', () => {
  const day1 = new Date();
  const route: RouteSegment[] = [
    { legId: 'a', sequence: 1, type: 'first_mile', status: 'completed', etaAt: localSlotISO(day1, 10, 0) },
    { legId: 'b', sequence: 2, type: 'last_mile', status: 'pending' },
  ];
  const days = buildDaySections(route);
  assert.equal(days.length, 2, 'etaAt derives a day; untimestamped leg gets its own plan bucket');
  const planBucket = days.find((d) => d.date === '');
  assert.ok(planBucket, 'untimestamped legs land in a plan bucket');
  assert.deepEqual(planBucket?.legs.map((l) => l.legId), ['b']);
  assert.deepEqual(buildDaySections([]), []);
  assert.deepEqual(buildDaySections(null), []);
});

test('delayBannerData surfaces the latest exception event note, and null otherwise', () => {
  assert.equal(delayBannerData(undefined), null);
  assert.equal(delayBannerData(null), null);
  assert.equal(delayBannerData({ waybillNumber: 'WB-1', events: [] }), null);
  assert.equal(
    delayBannerData({ waybillNumber: 'WB-1', events: [{ at: nowIso(), type: 'scanned', location: 'Dar hub' }] }),
    null,
    'non-exception events never raise the banner',
  );
  const banner = delayBannerData({
    waybillNumber: 'WB-1',
    events: [
      { at: nowIso(), type: 'scanned', location: 'Dar hub' },
      { at: nowIso(), type: 'exception', location: 'En route — Tabora', actor: 'ops', note: 'Linehaul bus delayed' },
    ],
  });
  assert.deepEqual(banner, { note: 'Linehaul bus delayed' });
  const lastWins = delayBannerData({
    waybillNumber: 'WB-1',
    events: [
      { at: nowIso(), type: 'exception', location: 'A', note: 'first' },
      { at: nowIso(), type: 'exception', location: 'B', note: 'second' },
    ],
  });
  assert.deepEqual(lastWins, { note: 'second' }, 'the newest exception event drives the banner note');
  assert.deepEqual(
    delayBannerData({ waybillNumber: 'WB-1', events: [{ at: nowIso(), type: 'exception', location: 'C' }] }),
    { note: null },
    'exception without a note still raises the banner',
  );
});

test('shipmentHeaderData flags intercity/relay orders with their waybill', () => {
  const intercity = getState().orders.find((o) => o.id === 'ord_intercity_002')!;
  assert.deepEqual(shipmentHeaderData(intercity), { fulfillmentType: 'intercity', waybillNumber: 'WB-1042-MWZ' });
  const relay = getState().orders.find((o) => o.id === 'ord_relay_005')!;
  assert.deepEqual(shipmentHeaderData(relay), { fulfillmentType: 'relay', waybillNumber: 'WB-2048-DAR' });
  // ord_warehouse_003 is explicitly 'local' but still carries a waybill number.
  const local = getState().orders.find((o) => o.id === 'ord_warehouse_003')!;
  assert.deepEqual(shipmentHeaderData(local), { fulfillmentType: null, waybillNumber: 'WB-1107-DAR' });
  assert.deepEqual(shipmentHeaderData(null), { fulfillmentType: null, waybillNumber: null });
});

/* ---------------- shipment route data path (repo-level) ---------------- */

test('the shipment route resolves an intercity order and its shipment surface from the mock', async () => {
  const detail = await orders.get('ord_intercity_002');
  assert.equal(detail.fulfillmentType, 'intercity');
  assert.equal(detail.waybillNumber, 'WB-1042-MWZ');
  const [route, waybill, phases] = await Promise.all([
    orders.getRoute('ord_intercity_002'),
    orders.getWaybill('ord_intercity_002'),
    orders.getTrackingPhases('ord_intercity_002'),
  ]);
  assert.ok(route.length >= 3, 'route legs render the leg timeline');
  assert.equal(waybill.waybillNumber, 'WB-1042-MWZ');
  assert.ok(waybill.events.length >= 1);
  assert.equal(phases.length, 6, 'six-phase strip');
  assert.deepEqual(phases.map((p) => p.phase), ['confirmed', 'picked_up', 'in_transit', 'arrived_city', 'out_for_delivery', 'delivered']);
  assert.ok(buildDaySections(route).length >= 1, 'day sections derive from the mock route');
  const relay = await orders.get('ord_relay_005');
  assert.equal(shipmentHeaderData(relay).fulfillmentType, 'relay', 'relay shares the intercity shipment surface');
});

test('a local order resolves to the honest intercity-only state, not a shipment surface', async () => {
  const detail = await orders.get('ord_warehouse_003');
  assert.equal(shipmentHeaderData(detail).fulfillmentType, null, 'local orders are not shipments');
  await rejectsApiError(orders.getRoute('ord_warehouse_003'), 404);
});

/* ---------------- delivery window + route cities (mock-only, CONTRACT-ADDITIONS #5) ----------------
 * The contract order/tracking payloads carry no deliveryWindowFrom/To or
 * originCityName/destinationCityName; the mock rides them on the intercity
 * route payload (mockState buildRoute) and exposes them through the repo
 * getters. The live repo returns null until Team 6 ships the fields. */

test('the mock returns the delivery window and route cities for the seeded intercity order', async () => {
  const window = await orders.getDeliveryWindow('ord_intercity_002');
  assert.ok(window, 'intercity order carries a seeded window');
  assert.ok(Date.parse(window!.from) < Date.parse(window!.to), 'window from precedes window to');
  assert.ok(Date.parse(window!.from) > Date.now(), 'window lies in the future');

  const cities = await orders.getRouteCities('ord_intercity_002');
  assert.deepEqual(cities, { origin: 'Dar es Salaam', destination: 'Mwanza' });
});

test('the mock returns null window/cities for every other order (relay, local, warehouse)', async () => {
  assert.equal(await orders.getDeliveryWindow('ord_relay_005'), null, 'relay has no seeded window');
  assert.equal(await orders.getRouteCities('ord_relay_005'), null, 'relay has no seeded cities');
  assert.equal(await orders.getDeliveryWindow('ord_active_001'), null, 'local order has no window');
  assert.equal(await orders.getRouteCities('ord_active_001'), null);
  assert.equal(await orders.getDeliveryWindow('ord_warehouse_003'), null);
  // Unknown orders 404 like the other order surfaces — never a silent null.
  await rejectsApiError(orders.getDeliveryWindow('ord_nope'), 404, 'ORDER_NOT_FOUND');
  await rejectsApiError(orders.getRouteCities('ord_nope'), 404, 'ORDER_NOT_FOUND');
});

test('simulateIntercityDelay reposts a shifted delivery window (the tracking card follows the server event)', async () => {
  const before = await orders.getDeliveryWindow('ord_intercity_002');
  const state = getState();
  simulateIntercityDelay(state, 2);
  const after = await orders.getDeliveryWindow('ord_intercity_002');
  assert.ok(before && after, 'window exists before and after the delay event');
  assert.equal(Date.parse(after!.to) - Date.parse(before!.to), 2 * 3600_000, 'window end shifts by the delay hours');
  assert.equal(Date.parse(after!.from) - Date.parse(before!.from), 2 * 3600_000, 'window start shifts too');
});

test('windowLabel formats the from/to window for the delivery-window card', () => {
  const from = localSlotISO(new Date(2026, 7, 14), 9, 0);
  const to = localSlotISO(new Date(2026, 7, 14), 14, 0);
  assert.equal(windowLabel(from, to), 'Aug 14, 09:00–14:00');
  assert.equal(windowLabel(null, to), '—', 'missing bound renders the placeholder, never crashes');
  assert.equal(windowLabel(from, undefined), '—');
  assert.equal(windowLabel(undefined, null), '—');
});

/* ---------------- shipment repo (mock-first, CONTRACT-ADDITIONS.md #8) ----------------
 * The contract exposes GET /shipments + GET /shipments/{id} (generated
 * listShipments/getShipment); the consumer shipment surface (waybill trail,
 * phases, route legs) is a mock-only extension served from the seeded
 * orders' tracking data. The shipment screen resolves /shipment/{id} through
 * this repo with an order-id fallback. */

test('the shipments repo lists the seeded shipment records', async () => {
  const all = await shipments.listMine();
  assert.equal(all.length, 3);
  const intercity = all.find((s) => s.orderId === 'ord_intercity_002')!;
  assert.equal(intercity.id, 'shp_1042');
  assert.equal(intercity.shipmentNumber, 'SH-1042-MWZ');
  assert.equal(intercity.status, 'in_transit');
  const relay = all.find((s) => s.orderId === 'ord_relay_005')!;
  assert.equal(relay.shipmentNumber, 'SH-2048-DAR');
  assert.ok(all.every((s) => s.shipmentNumber.startsWith('SH-')), 'shipment numbers follow the SH-… scheme');
  const outForDelivery = all.filter((s) => s.status === 'out_for_delivery');
  assert.deepEqual(outForDelivery.map((s) => s.orderId), ['ord_warehouse_003']);
  const inTransit = await shipments.listMine({ status: 'in_transit' });
  assert.equal(inTransit.length, 2, 'status filter narrows the list');
  const listed = await shipments.listMine({ limit: 2 });
  assert.equal(listed.length, 2, 'limit applies');
});

test('shipment get resolves by shipment id or order id and 404s unknown ids', async () => {
  const byId = await shipments.get('shp_1042');
  assert.equal(byId.orderId, 'ord_intercity_002');
  assert.equal(byId.shipmentNumber, 'SH-1042-MWZ');
  const byOrderId = await shipments.get('ord_intercity_002');
  assert.equal(byOrderId.id, byId.id, 'order id is an accepted resolution key (the route links /shipment/{order.id})');
  await rejectsApiError(shipments.get('ord_nope'), 404, 'SHIPMENT_NOT_FOUND');
  await rejectsApiError(shipments.get('shp_9999'), 404, 'SHIPMENT_NOT_FOUND');
});

test('the shipment payload carries the waybill trail, phases and route legs the screen renders', async () => {
  const detail = await shipments.get('ord_intercity_002');
  assert.equal(detail.phases?.length, 6, 'six-phase strip rides the shipment payload');
  assert.deepEqual(detail.phases!.map((p) => p.phase), ['confirmed', 'picked_up', 'in_transit', 'arrived_city', 'out_for_delivery', 'delivered']);
  assert.equal(detail.waybill?.waybillNumber, 'WB-1042-MWZ');
  assert.ok(detail.waybill!.events.length >= 1);
  assert.ok((detail.route?.length ?? 0) >= 3, 'route legs ride the shipment payload');
  assert.ok(buildDaySections(detail.route).length >= 1, 'day sections derive from the shipment payload route');
  // Warehouse shipment: local two-leg route + warehouse waybill.
  const warehouse = await shipments.get('ord_warehouse_003');
  assert.equal(warehouse.status, 'out_for_delivery');
  assert.equal(warehouse.waybill?.waybillNumber, 'WB-1107-DAR');
  assert.ok((warehouse.route?.length ?? 0) >= 2, 'warehouse shipment carries its own route legs');
});

/* ---------------- dispute center data path ---------------- */

test('disputed orders filter from the mock seed for the dispute center', async () => {
  const all = await orders.list({ limit: 50 });
  const disputed = all.filter((o) => o.status === 'disputed');
  assert.equal(disputed.length, 1);
  assert.equal(disputed[0].id, 'ord_disputed_007');
  assert.equal(disputed[0].no, 'HD-OR-475903');
  const detail = await orders.get('ord_disputed_007');
  assert.ok(detail.events.some((e) => e.status === 'disputed'), 'the timeline carries the dispute event');
});

test('disputed bookings filter from the module-local seed (mockState stays untouched)', async () => {
  assert.equal(getState().bookings.some((b) => b.status === 'disputed'), false, 'mockState carries no disputed booking');
  const all = await bookings.list({ limit: 50 });
  const disputed = all.filter((b) => b.status === 'disputed');
  assert.equal(disputed.length, 1);
  assert.equal(disputed[0].id, 'bk_disputed_101');
  const detail = await bookings.get('bk_disputed_101');
  assert.equal(detail.status, 'disputed');
  assert.ok(detail.events.some((e) => e.status === 'disputed'));
  const active = await bookings.list({ status: 'active' });
  assert.ok(!active.some((b) => b.id === 'bk_disputed_101'), 'disputed bookings stay out of the active scope');
});

test('refunded payment intents resolve through getHistory as resolved dispute markers', async () => {
  const history = await payments.getHistory();
  const refunded = history.filter((p) => p.status === 'refunded' || p.status === 'partially_refunded');
  assert.ok(refunded.length >= 1, 'the seed carries a refunded intent');
  const intent = refunded.find((p) => p.orderId === 'ord_refunded_006');
  assert.ok(intent, 'the refunded intent links back to the refunded order');
  assert.equal(intent?.amountTZS, 27300);
  assert.ok(Number.isInteger(intent!.amountTZS), 'integer TZS');
});
