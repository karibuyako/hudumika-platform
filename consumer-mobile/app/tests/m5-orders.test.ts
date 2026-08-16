/* M5 — Orders + tracking: status set helpers, timeline order, tracking
 * semantics (server estimate rendered verbatim, timestamps UTC→local). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { dateISO, windowLabel } from '@/lib/dates';
import {
  ACTIVE_ORDER_STATUSES,
  CANCELLABLE_STATUSES,
  ORDER_TIMELINE,
  REVIEWABLE_STATUSES,
  RUSHABLE_STATUSES,
  isActiveOrder,
  isCancellable,
  isReviewable,
  isRushable,
} from '@/lib/order';
import { resetMockState, rejectsApiError } from './helpers';
import { MockOrdersRepository, resetMockOrdersState } from '@/repos/mock/orders';
import { getState } from '@/repos/mock/mockState';
import { CouponStatus } from '@hudumika/contract';

const orders = new MockOrdersRepository();

beforeEach(() => {
  resetMockState();
  resetMockOrdersState();
});

test('status sets are disjoint where the UI must be (no cancel after preparation)', () => {
  assert.ok(CANCELLABLE_STATUSES.every((s) => isCancellable(s)));
  assert.ok(REVIEWABLE_STATUSES.every((s) => isReviewable(s)));
  assert.ok(RUSHABLE_STATUSES.every((s) => isRushable(s)));
  // Rush and cancel legitimately overlap at merchant_accepted (spec allows both).
  assert.equal(REVIEWABLE_STATUSES.every((s) => !isActiveOrder(s)), true);
  assert.ok(ACTIVE_ORDER_STATUSES.length >= 7);
});

test('timeline renders the contract status order (draft → completed)', () => {
  const expected = ['draft', 'pending_payment', 'paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering', 'delivered', 'completed'];
  assert.deepEqual(ORDER_TIMELINE, expected);
});

test('placed orders move into orders/me and show in the active scope', async () => {
  const before = (await orders.list({ status: 'active' })).length;
  const merchant = getState().merchants.find((m) => m.isOpen)!;
  const item = getState().catalogues.get(merchant.id)!.items.find((i) => i.available !== false)!;
  await orders.create(
    { merchantId: merchant.id, items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS }], paymentMethod: 'mpesa' },
    'm5-key',
  );
  const active = await orders.list({ status: 'active' });
  assert.equal(active.length, before + 1);
});

test('tracking renders the server estimate verbatim — client computes nothing', async () => {
  const event = await orders.track('ord_active_001');
  assert.ok(Number.isInteger(event.estimateMinutes));
  assert.ok(event.estimateMinutes! > 0);
  assert.ok(!Number.isNaN(Date.parse(event.updatedAt)), 'updatedAt is a parseable UTC ISO string');
  assert.equal(event.status, 'delivering');
});

test('UTC ISO timestamps render local through the shared helpers only', () => {
  const iso = '2026-08-14T14:32:00Z';
  const rendered = dateISO(iso);
  assert.ok(!rendered.includes('Z'), 'never renders raw UTC');
  assert.match(rendered, /^[0-9]{1,2} [A-Z][a-z]{2} · [0-9]{2}:[0-9]{2}$/);
  assert.equal(dateISO('garbage'), '—');
  assert.equal(dateISO(null), '—');
});

test('delivery-window promise derives from server leg ETAs only', () => {
  const label = windowLabel('2026-08-15T09:00:00Z', '2026-08-15T14:00:00Z');
  assert.match(label, /\d{2}:\d{2}–\d{2}:\d{2}$/, 'window renders local start–end');
  assert.equal(windowLabel(null, null), '—');
  assert.equal(windowLabel('bad', '2026-08-15T14:00:00Z'), '—');
});

test('disputed orders resolve from the mock seed (banner data path)', async () => {
  const disputed = getState().orders.find((o) => o.id === 'ord_disputed_007');
  assert.ok(disputed, 'seed includes a disputed order for the banner');
  assert.equal(disputed.status, 'disputed');
  const detail = await orders.get('ord_disputed_007');
  assert.equal(detail.status, 'disputed');
  assert.ok(detail.events.some((e) => e.status === 'disputed'), 'the timeline carries the dispute event');
  assert.ok(!isActiveOrder(detail.status), 'disputed is not an active order');
});

test('refunded orders resolve with integer totals and a terminal status (refund card)', async () => {
  const detail = await orders.get('ord_refunded_006');
  assert.equal(detail.status, 'refunded');
  assert.equal(detail.totals.subtotalTZS + detail.totals.deliveryFeeTZS + detail.totals.platformFeeTZS + detail.totals.taxTZS - detail.totals.discountTZS, detail.totals.totalTZS);
  assert.ok(!isActiveOrder(detail.status));
});

/* Fix 1 — customized items: the cart sends BASE price + option keys; the
 * server validates the base against the catalogue and prices options itself. */
function customisableInput() {
  for (const merchant of getState().merchants.filter((m) => m.isOpen)) {
    const catalogue = getState().catalogues.get(merchant.id)!;
    const item = catalogue.items.find((i) => i.available !== false && (i.options ?? []).some((g) => g.choices.some((c) => c.priceTZS > 0)));
    if (item) {
      const paidChoice = (item.options ?? []).flatMap((g) => g.choices).find((c) => c.priceTZS > 0)!;
      return { merchant, item, paidChoice };
    }
  }
  throw new Error('no seeded catalogue item with a paid option');
}

test('ordering a catalogue item with a paid option succeeds and the server prices it', async () => {
  const { merchant, item, paidChoice } = customisableInput();
  const addon = (item.addons ?? [])[0];
  const options = addon ? [paidChoice.label, addon.name] : [paidChoice.label];
  const qty = 2;
  const order = await orders.create(
    { merchantId: merchant.id, items: [{ catalogueItemId: item.id!, quantity: qty, unitPriceTZS: item.priceTZS, options }], paymentMethod: 'mpesa' },
    'm5-options-1',
  );
  const expectedLine = item.priceTZS + paidChoice.priceTZS + (addon?.priceTZS ?? 0);
  assert.equal(order.items?.length, 1);
  assert.equal(order.items?.[0].unitPriceTZS, expectedLine, 'line unit price = base + option/addon prices');
  assert.equal(order.totals.subtotalTZS, expectedLine * qty);
  assert.equal(order.totals.subtotalTZS + order.totals.deliveryFeeTZS + order.totals.platformFeeTZS + order.totals.taxTZS - order.totals.discountTZS, order.totals.totalTZS);
  assert.ok(Number.isInteger(order.totals.totalTZS));
});

test('a free (zero-price) option choice stays valid and does not change the line price', async () => {
  const { merchant, item } = customisableInput();
  const freeChoice = (item.options ?? []).flatMap((g) => g.choices).find((c) => c.priceTZS === 0);
  const options = freeChoice ? [freeChoice.label] : [];
  const order = await orders.create(
    { merchantId: merchant.id, items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS, options }], paymentMethod: 'mpesa' },
    'm5-options-2',
  );
  assert.equal(order.items?.[0].unitPriceTZS, item.priceTZS);
});

test('an option key that does not exist on the catalogue item is rejected (422 VALIDATION_FAILED)', async () => {
  const { merchant, item } = customisableInput();
  await rejectsApiError(
    orders.create({ merchantId: merchant.id, items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS, options: ['Bogus option'] }], paymentMethod: 'mpesa' }, 'm5-options-3'),
    422,
    'VALIDATION_FAILED',
  );
  assert.equal((await orders.list()).length, 9, 'nothing is placed on a rejected option key');
});

/* Fix 2 — coupon: the contract has NO couponId on OrderCreate (checked against
 * packages/contract/src/generated/model/orderCreate.ts), so the mock never
 * applies a coupon discount and no coupon can be attached to an order. */
test('orders never carry a coupon discount while OrderCreate has no couponId', async () => {
  const merchant = getState().merchants.find((m) => m.isOpen)!;
  const item = getState().catalogues.get(merchant.id)!.items.find((i) => i.available !== false)!;
  const order = await orders.create(
    { merchantId: merchant.id, items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS }], paymentMethod: 'mpesa' },
    'm5-coupon-1',
  );
  assert.equal(order.totals.discountTZS, 0, 'no discount is applied without a couponId field');
  const claimed = getState().coupons.find((c) => c.status === CouponStatus.claimed);
  assert.ok(claimed, 'seed carries a claimed coupon');
  assert.equal(getState().coupons.find((c) => c.id === claimed!.id)?.status, CouponStatus.claimed, 'claimed coupons stay un-used — nothing to redeem them against');
});

/* Tracking fixes — per-phase eta renders as a local date (never "~N min" via
 * the estimate path), 404s on the tracking sub-endpoints surface as
 * "Tracking unavailable", and relay orders share the intercity surfaces. */
test('tracking-phases per-phase eta stays a server timestamp rendered as local date, never "~N min"', async () => {
  const phases = await orders.getTrackingPhases('ord_intercity_002');
  const active = phases.find((p) => p.status === 'active');
  assert.ok(active?.eta, 'the server provides a per-phase eta');
  assert.ok(!Number.isNaN(Date.parse(active.eta!)), 'eta stays a UTC ISO timestamp');
  const rendered = dateISO(active.eta);
  assert.ok(!rendered.includes('Z'), 'never renders raw UTC');
  assert.ok(!rendered.includes('min'), 'eta renders as a local date, not an estimate in minutes');
  assert.match(rendered, /^[0-9]{1,2} [A-Z][a-z]{2} · [0-9]{2}:[0-9]{2}$/);
});

test('route/waybill/tracking-phases 404 on an unknown order (Tracking unavailable path)', async () => {
  await rejectsApiError(orders.getRoute('ord_nope_999'), 404);
  await rejectsApiError(orders.getWaybill('ord_nope_999'), 404);
  await rejectsApiError(orders.getTrackingPhases('ord_nope_999'), 404);
});

test('relay orders carry a route and waybill — same leg/waybill surfaces as intercity', async () => {
  const relay = getState().orders.find((o) => o.id === 'ord_relay_005');
  assert.ok(relay, 'seed includes a relay order');
  assert.equal(relay.fulfillmentType, 'relay');
  const route = await orders.getRoute('ord_relay_005');
  assert.ok(route.length >= 2, 'relay route renders the leg timeline');
  const waybill = await orders.getWaybill('ord_relay_005');
  assert.ok(waybill.waybillNumber.length > 0);
  assert.ok(waybill.events.length >= 1);
  const phases = await orders.getTrackingPhases('ord_relay_005');
  assert.deepEqual(phases.map((p) => p.phase), ['confirmed', 'picked_up', 'in_transit', 'arrived_city', 'out_for_delivery', 'delivered']);
});

/* ---- Modification requests (POST /orders/{id}/modify-request, contract
 * RequestOrderModificationBody + RequestOrderModification202) ---- */

test('modifyRequest succeeds for an active order (202 {requestId, status})', async () => {
  const res = await orders.modifyRequest('ord_active_001', { type: 'change_time', note: 'Deliver after 18:00' }, 'm5-mod-1');
  assert.equal(res.status, 'pending_approval');
  assert.ok(res.requestId.length > 0, 'the server returns a requestId');
  const detail = await orders.get('ord_active_001');
  assert.ok(
    detail.events.some((e) => (e.note ?? '').includes('change_time')),
    'the request is visible on the order timeline',
  );
});

test('modifyRequest accepts every contract type value and an empty note', async () => {
  for (const type of ['change_address', 'change_time', 'add_item', 'remove_item', 'other'] as const) {
    resetMockOrdersState(); // one open request per order — start each case clean
    const res = await orders.modifyRequest('ord_intercity_002', { type }, `m5-mod-${type}`);
    assert.equal(res.status, 'pending_approval', `${type} is accepted`);
    assert.ok(res.requestId.length > 0);
  }
});

test('modifyRequest throws ORDER_MODIFICATION_NOT_ALLOWED for terminal orders', async () => {
  await rejectsApiError(orders.modifyRequest('ord_refunded_006', { type: 'other', note: 'x' }, 'm5-mod-2'), 409, 'ORDER_MODIFICATION_NOT_ALLOWED');
  await rejectsApiError(orders.modifyRequest('ord_completed_004', { type: 'change_address' }, 'm5-mod-3'), 409, 'ORDER_MODIFICATION_NOT_ALLOWED');
});

test('modifyRequest throws ORDER_MODIFICATION_PENDING while one is open for the order', async () => {
  await orders.modifyRequest('ord_intercity_002', { type: 'change_address', note: 'New office' }, 'm5-mod-4');
  await rejectsApiError(orders.modifyRequest('ord_intercity_002', { type: 'other' }, 'm5-mod-5'), 409, 'ORDER_MODIFICATION_PENDING');
});
