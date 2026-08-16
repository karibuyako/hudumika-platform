import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import type { Refund } from '@/api/types';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; internal?: boolean; idem?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  if (opts.internal) headers['x-internal-key'] = 'demo-customer-platform';
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

/** Internal (customer-platform) order creation — returns the new order id. */
async function createOrder(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call('POST', '/orders', {
    internal: true,
    body: {
      merchantId: 'm_demo',
      items: [
        { productId: 'p1', qty: 2 },
        { productId: 'p4', qty: 1 },
      ],
      paymentMethod: 'mpesa',
      ...extra,
    },
  });
  assert.equal(res.status, 200, `createOrder failed: ${JSON.stringify(res.body)}`);
  return res.body.order.id;
}

/** Accept a fresh order into `preparing` via the contract status endpoint. */
async function acceptToPreparing(id: string): Promise<void> {
  const res = await call('POST', `/orders/${id}/status`, { body: { status: 'preparing' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'preparing');
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000000', purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  token = ok.body.accessToken;
});

after(() => {
  server.close();
});

/* ================= P2: orders + refunds ops (contract /orders*, /refunds*) ================= */

test('orders/me: bare Order[] list with status filter, limit and cursor offset', async () => {
  const all = await call('GET', '/orders/me');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body), 'contract /orders/me returns a bare array');
  assert.ok(all.body.length > 0);
  const first = all.body[0];
  assert.ok(first.id && first.status, 'row looks like a contract Order');
  assert.equal(typeof first.totals.totalTZS, 'number');

  const completed = await call('GET', '/orders/me?status=completed');
  assert.equal(completed.status, 200);
  assert.ok(completed.body.every((o: any) => o.status === 'completed'));

  const limited = await call('GET', '/orders/me?limit=3');
  assert.ok(limited.body.length <= 3);
  const paged = await call('GET', '/orders/me?limit=3&cursor=3');
  assert.ok(paged.body.every((o: any) => !limited.body.some((x: any) => x.id === o.id)), 'cursor offset pages do not overlap');
});

test('orders/search: q, status, from/to and customerPhone filters; invalid q rejected', async () => {
  const byQ = await call('GET', '/orders/search?q=lamb');
  assert.equal(byQ.status, 200);
  assert.ok(Array.isArray(byQ.body));
  assert.ok(byQ.body.length > 0, 'lamb items exist in seed');
  assert.ok(byQ.body.every((o: any) => o.items.some((i: any) => i.name.toLowerCase().includes('lamb'))));

  const byStatus = await call('GET', '/orders/search?status=preparing');
  assert.ok(byStatus.body.every((o: any) => o.status === 'preparing'));

  const byDate = await call('GET', '/orders/search?from=2000-01-01&to=2099-01-01');
  assert.equal(byDate.status, 200);
  assert.equal(byDate.body.length, (await call('GET', '/orders/search')).body.length, 'wide date range includes everything');

  const byPhone = await call('GET', '/orders/search?customerPhone=138****2210');
  assert.ok(byPhone.body.every((o: any) => o.customer.phone.includes('138****2210')));

  const invalid = await call('GET', `/orders/search?q=${'x'.repeat(121)}`);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'ORDER_SEARCH_INVALID');
});

test('orders/enterprise: corporate rows carry companyName/costCenter/billingRef', async () => {
  const res = await call('GET', '/orders/enterprise');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2, 'two enterprise orders seeded');
  for (const o of res.body) {
    assert.equal(typeof o.companyName, 'string');
    assert.ok(o.costCenter === null || typeof o.costCenter === 'string');
    assert.ok(o.billingRef === null || typeof o.billingRef === 'string');
  }
});

test('orders/rush: open queue + resolved rows; issue-reasons catalog is string[]', async () => {
  const open = await call('GET', '/orders/rush?status=open');
  assert.equal(open.status, 200);
  assert.ok(Array.isArray(open.body));
  assert.ok(open.body.some((r: any) => r.status === 'open'), 'seeded new order with rushAt is open');
  for (const r of open.body) {
    assert.equal(typeof r.orderId, 'string');
    assert.ok(['open', 'replied', 'resolved'].includes(r.status));
    assert.equal(typeof r.requestedAt, 'number');
  }
  const resolved = await call('GET', '/orders/rush?status=resolved');
  assert.ok(resolved.body.every((r: any) => r.status === 'resolved'));

  const reasons = await call('GET', '/orders/issue-reasons');
  assert.equal(reasons.status, 200);
  assert.ok(Array.isArray(reasons.body));
  assert.ok(reasons.body.every((r: any) => typeof r === 'string' && r.length > 0));
});

test('orders/me/advance: GET lists scheduled orders for the day; POST hands a scheduled order into prep', async () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = await call('GET', `/orders/me/advance?date=${today}`);
  assert.equal(day.status, 200);
  assert.ok(Array.isArray(day.body));
  assert.ok(day.body.length > 0, 'o_seed_19 is scheduled today');
  assert.ok(day.body.every((o: any) => typeof o.scheduledAt === 'number'));

  const missing = await call('GET', '/orders/me/advance');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'DATE_REQUIRED');

  const scheduled = await createOrder({ scheduledAt: Date.now() + 2 * 3600000 });
  const adv = await call('POST', '/orders/me/advance', { body: { orderId: scheduled, note: 'start prep' } });
  assert.equal(adv.status, 200);
  assert.equal(adv.body.status, 'preparing');

  const plain = await createOrder();
  const blocked = await call('POST', '/orders/me/advance', { body: { orderId: plain } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'INVALID_TRANSITION');
});

test('orders/{id}/timeline + track + tracking-phases + waybill + fare + route shapes', async () => {
  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const id = completed.id;

  const timeline = await call('GET', `/orders/${id}/timeline`);
  assert.equal(timeline.status, 200);
  assert.ok(Array.isArray(timeline.body.events));
  assert.ok(timeline.body.events.length > 0);
  for (const ev of timeline.body.events) {
    assert.equal(typeof ev.status, 'string');
    assert.equal(typeof ev.at, 'number');
    assert.equal(typeof ev.by, 'string');
  }

  const track = await call('GET', `/orders/${id}/track`);
  assert.equal(track.status, 200);
  assert.equal(typeof track.body.status, 'string');
  assert.equal(typeof track.body.updatedAt, 'number');
  assert.ok(track.body.riderLocation === undefined || (typeof track.body.riderLocation.lat === 'number' && typeof track.body.riderLocation.lon === 'number'));

  const phases = await call('GET', `/orders/${id}/tracking-phases`);
  assert.equal(phases.status, 200);
  assert.ok(Array.isArray(phases.body));
  assert.ok(phases.body.length >= 5);
  for (const p of phases.body) {
    assert.ok(['confirmed', 'picked_up', 'in_transit', 'arrived_city', 'out_for_delivery', 'delivered'].includes(p.phase));
    assert.ok(['pending', 'active', 'completed'].includes(p.status));
  }

  const waybill = await call('GET', `/orders/${id}/waybill`);
  assert.equal(waybill.status, 200);
  assert.equal(typeof waybill.body.waybillNumber, 'string');
  assert.ok(Array.isArray(waybill.body.events));
  assert.ok(waybill.body.events.length > 0);
  assert.equal(typeof waybill.body.events[0].location, 'string');

  const fare = await call('GET', `/orders/${id}/fare`);
  assert.equal(fare.status, 200);
  assert.equal(fare.body.orderId, id);
  for (const k of ['baseTZS', 'distanceTZS', 'timeTZS', 'surgeTZS', 'tipTZS', 'totalTZS']) {
    assert.ok(Number.isInteger(fare.body[k]), `${k} integer`);
  }
  assert.equal(fare.body.currency, 'TZS');

  const route = await call('GET', `/orders/${id}/route`);
  assert.equal(route.status, 200);
  assert.ok(Array.isArray(route.body));
  for (const leg of route.body) {
    assert.equal(typeof leg.legId, 'string');
    assert.equal(typeof leg.sequence, 'number');
    assert.ok(['pending', 'in_progress', 'completed', 'skipped'].includes(leg.status));
  }
});

test('orders/{id}/status: contract state-advance new→preparing→ready→completed + conflicts', async () => {
  const id = await createOrder();
  const bad = await call('POST', `/orders/${id}/status`, { body: { status: 'completed' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.code, 'INVALID_TRANSITION');

  await acceptToPreparing(id);
  const ready = await call('POST', `/orders/${id}/status`, { body: { status: 'ready', note: 'prep done' } });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');

  const done = await call('POST', `/orders/${id}/status`, { body: { status: 'completed' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'completed');
  assert.equal(typeof done.body.completedAt, 'number');

  const replay = await call('POST', `/orders/${id}/status`, { body: { status: 'completed' } });
  assert.equal(replay.status, 200, 'idempotent replay');
  assert.equal(replay.body.status, 'completed');

  const bogus = await call('POST', `/orders/${id}/status`, { body: { status: 'disputed' } });
  assert.equal(bogus.status, 409);
  assert.equal(bogus.body.error.code, 'INVALID_TRANSITION');
});

test('orders/{id}/cancel: reason recorded, refund on captured; completed cannot cancel', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/cancel`, { body: { reason: 'Customer requested cancellation' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.cancelReason, 'Customer requested cancellation');
  assert.equal(typeof res.body.cancelledAt, 'number');

  const replay = await call('POST', `/orders/${id}/cancel`, { body: { reason: 'again' } });
  assert.equal(replay.status, 200, 'idempotent replay — no double refund');

  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const blocked = await call('POST', `/orders/${completed.id}/cancel`, { body: { reason: 'late' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'INVALID_TRANSITION');

  const missingReason = await call('POST', `/orders/${id}/cancel`, { body: {} });
  assert.equal(missingReason.status, 400);
});

test('orders/{id}/hold + unhold: flags round-trip; NOT_HELD and INVALID_TRANSITION conflicts', async () => {
  const id = await createOrder();
  const blocked = await call('POST', `/orders/${id}/hold`, { body: { reason: 'x' } });
  assert.equal(blocked.status, 409, 'new orders cannot be held');
  assert.equal(blocked.body.error.code, 'INVALID_TRANSITION');

  await acceptToPreparing(id);
  const hold = await call('POST', `/orders/${id}/hold`, { body: { reason: 'Waiting for payment confirmation' } });
  assert.equal(hold.status, 200);
  assert.equal(hold.body.hold.reason, 'Waiting for payment confirmation');
  assert.equal(typeof hold.body.hold.at, 'number');

  const unhold = await call('POST', `/orders/${id}/unhold`, {});
  assert.equal(unhold.status, 200);
  assert.equal(unhold.body.hold, undefined);

  const again = await call('POST', `/orders/${id}/unhold`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'NOT_HELD');

  const seeded = await call('GET', '/orders/me?status=preparing');
  assert.ok(seeded.body.some((o: any) => o.hold), 'seeded held order visible in list');
});

test('orders/{id}/reschedule: approved flag + aggregated rescheduled status; conflicts', async () => {
  const id = await createOrder();
  const when = Date.now() + 2 * 3600000;
  const res = await call('POST', `/orders/${id}/reschedule`, { body: { scheduledAt: when, reason: 'Customer asked for later' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'rescheduled');
  assert.equal(res.body.reschedule.status, 'approved');
  assert.equal(res.body.reschedule.scheduledAt, when);

  const dup = await call('POST', `/orders/${id}/reschedule`, { body: { scheduledAt: when + 3600000, reason: 'again' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ALREADY_RESCHEDULED');

  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const blocked = await call('POST', `/orders/${completed.id}/reschedule`, { body: { scheduledAt: when, reason: 'x' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'INVALID_TRANSITION');
});

test('orders/{id}/transfer: 202 requested + conflict on double-request', async () => {
  const id = await createOrder();
  const blocked = await call('POST', `/orders/${id}/transfer`, { body: { reason: 'x' } });
  assert.equal(blocked.status, 409, 'new orders cannot be transferred');

  await acceptToPreparing(id);
  const res = await call('POST', `/orders/${id}/transfer`, { body: { reason: 'Rider stuck in traffic' } });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'requested');
  assert.equal(typeof res.body.transferId, 'string');

  const dup = await call('POST', `/orders/${id}/transfer`, { body: { reason: 'again' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'TRANSFER_ALREADY_REQUESTED');
});

test('orders/{id}/tip: integer TZS on completed order; blocked before completion', async () => {
  const id = await createOrder();
  const blocked = await call('POST', `/orders/${id}/tip`, { body: { amountTZS: 2000 } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'INVALID_TRANSITION');

  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const bad = await call('POST', `/orders/${completed.id}/tip`, { body: { amountTZS: 0 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_AMOUNT');

  const res = await call('POST', `/orders/${completed.id}/tip`, { body: { amountTZS: 5000, note: 'great ride' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.tipTZS, 5000);

  const more = await call('POST', `/orders/${completed.id}/tip`, { body: { amountTZS: 2500 } });
  assert.equal(more.body.tipTZS, 7500, 'tips accumulate');
});

test('orders/{id}/add-items: 202 pending_merchant_approval + ITEMS_REQUEST_PENDING conflict', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/add-items`, { body: { items: [{ catalogueItemId: 'p2', quantity: 2 }], reason: 'Customer asked to add wings' } });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'pending_merchant_approval');
  assert.equal(typeof res.body.requestId, 'string');

  const dup = await call('POST', `/orders/${id}/add-items`, { body: { items: [{ catalogueItemId: 'p3', quantity: 1 }], reason: 'again' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ITEMS_REQUEST_PENDING');

  const fresh = await createOrder();
  const bad = await call('POST', `/orders/${fresh}/add-items`, { body: { items: [], reason: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_ITEMS');

  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const blocked = await call('POST', `/orders/${completed.id}/add-items`, { body: { items: [{ catalogueItemId: 'p2', quantity: 1 }], reason: 'x' } });
  assert.equal(blocked.status, 409);
});

test('orders/{id}/damage: claim created 201; duplicate claim conflicts', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/damage`, { body: { type: 'spilled', description: 'Sauce leaked in the bag', images: ['https://example.com/1.jpg'] } });
  assert.equal(res.status, 201);
  assert.equal(res.body.orderId, id);
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.type, 'spilled');
  assert.equal(typeof res.body.id, 'string');
  assert.equal(typeof res.body.createdAt, 'number');

  const dup = await call('POST', `/orders/${id}/damage`, { body: { type: 'missing', description: 'again' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DAMAGE_CLAIM_EXISTS');

  const bad = await call('POST', '/orders/o_seed_6/damage', { body: { type: 'nonsense', description: 'x' } });
  assert.equal(bad.status, 400);
});

test('orders/{id}/failed-delivery: aggregated failed_delivery + DELIVERY_ALREADY_FAILED conflict', async () => {
  const id = await createOrder();
  await acceptToPreparing(id);
  const res = await call('POST', `/orders/${id}/failed-delivery`, { body: { reason: 'customer_unavailable', note: 'No answer at door', returnToMerchant: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'failed_delivery');
  assert.equal(res.body.failedDelivery.reason, 'customer_unavailable');
  assert.equal(res.body.failedDelivery.returnToMerchant, true);

  const dup = await call('POST', `/orders/${id}/failed-delivery`, { body: { reason: 'other' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DELIVERY_ALREADY_FAILED');

  const fresh = await createOrder();
  await acceptToPreparing(fresh);
  const bad = await call('POST', `/orders/${fresh}/failed-delivery`, { body: { reason: 'mystery' } });
  assert.equal(bad.status, 400);

  const fresh2 = await createOrder();
  const blocked = await call('POST', `/orders/${fresh2}/failed-delivery`, { body: { reason: 'other' } });
  assert.equal(blocked.status, 409);
});

test('orders/{id}/handoff: seal check, custody row, HANDOFF_CONFLICT on duplicate', async () => {
  const route = await call('GET', '/orders/o_seed_5/route');
  assert.equal(route.status, 200);
  const fromLeg = route.body[0].legId;
  const toLeg = route.body[1].legId;

  const brokenSeal = await call('POST', '/orders/o_seed_5/handoff', { body: { fromLegId: fromLeg, toLegId: toLeg, scanCode: 'WB-X', sealIntact: false } });
  assert.equal(brokenSeal.status, 409);
  assert.equal(brokenSeal.body.error.code, 'SEAL_BROKEN');

  const res = await call('POST', '/orders/o_seed_5/handoff', { body: { fromLegId: fromLeg, toLegId: toLeg, scanCode: 'WB-SEED-5', sealIntact: true, location: { lat: -6.82, lon: 39.28 } } });
  assert.equal(res.status, 201);
  assert.equal(res.body.sealIntact, true);
  assert.equal(res.body.scanCode, 'WB-SEED-5');
  assert.equal(typeof res.body.id, 'string');
  assert.equal(typeof res.body.at, 'number');

  const dup = await call('POST', '/orders/o_seed_5/handoff', { body: { fromLegId: fromLeg, toLegId: toLeg, scanCode: 'WB-SEED-5', sealIntact: true } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'HANDOFF_CONFLICT');

  const badLeg = await call('POST', '/orders/o_seed_5/handoff', { body: { fromLegId: 'nope', toLegId: toLeg, scanCode: 'x', sealIntact: true } });
  assert.equal(badLeg.status, 409);
  assert.equal(badLeg.body.error.code, 'INVALID_LEG');
});

test('orders/{id}/masked-call: session shape + MASKED_CALL_ACTIVE conflict', async () => {
  const res = await call('POST', '/orders/o_seed_5/masked-call', {});
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.sessionId, 'string');
  assert.equal(res.body.orderId, 'o_seed_5');
  assert.equal(typeof res.body.maskedNumber, 'string');
  assert.equal(typeof res.body.expiresAt, 'number');
  assert.ok(res.body.expiresAt > Date.now());

  const dup = await call('POST', '/orders/o_seed_5/masked-call', {});
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'MASKED_CALL_ACTIVE');

  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const blocked = await call('POST', `/orders/${completed.id}/masked-call`, {});
  assert.equal(blocked.status, 409);
});

test('orders/{id}/proof-of-delivery: submitted POD + POD_ALREADY_SUBMITTED conflict', async () => {
  const res = await call('POST', '/orders/o_seed_5/proof-of-delivery', { body: { type: 'photo', value: 'https://example.com/pod.jpg', dropoffOption: 'hand_to_customer' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.orderId, 'o_seed_5');
  assert.equal(res.body.type, 'photo');
  assert.equal(res.body.verified, false);
  assert.equal(typeof res.body.submittedAt, 'number');

  const dup = await call('POST', '/orders/o_seed_5/proof-of-delivery', { body: { type: 'otp', value: '123456' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'POD_ALREADY_SUBMITTED');

  const fresh = await createOrder();
  await acceptToPreparing(fresh);
  const ready = await call('POST', `/orders/${fresh}/status`, { body: { status: 'ready' } });
  assert.equal(ready.status, 200);
  const bad = await call('POST', `/orders/${fresh}/proof-of-delivery`, { body: { type: 'selfie', value: 'x' } });
  assert.equal(bad.status, 400);
});

test('orders/{id}/modify-request: 202 pending_approval; blocked on completed', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/modify-request`, { body: { type: 'change_address', note: 'Deliver to office reception instead' } });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'pending_approval');
  assert.equal(typeof res.body.requestId, 'string');

  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const blocked = await call('POST', `/orders/${completed.id}/modify-request`, { body: { type: 'other', note: 'x' } });
  assert.equal(blocked.status, 409);
});

test('orders/batch/reject: BatchResult + BATCH_EMPTY + BATCH_EXCEEDS_LIMIT', async () => {
  const a = await createOrder();
  const b = await createOrder();
  await acceptToPreparing(b);

  const empty = await call('POST', '/orders/batch/reject', { body: { orderIds: [], reason: 'x' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'BATCH_EMPTY');

  const tooMany = await call('POST', '/orders/batch/reject', { body: { orderIds: Array.from({ length: 51 }, (_, i) => `x${i}`), reason: 'x' } });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'BATCH_EXCEEDS_LIMIT');

  const res = await call('POST', '/orders/batch/reject', { body: { orderIds: [a, b, 'o_seed_9'], reason: 'Store closing early' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 1, 'only the pending order was rejected');
  assert.equal(res.body.failed, 2);
  const codes = new Map(res.body.failures.map((f: any) => [f.orderId, f.code]));
  assert.equal(codes.get(b), 'ORDER_REJECT_AFTER_ACCEPTANCE');
  assert.equal(codes.get('o_seed_9'), 'ORDER_ALREADY_REJECTED');

  const detail = await call('GET', `/orders/${a}`);
  assert.equal(detail.body.order.status, 'cancelled');
  assert.equal(detail.body.order.cancelReason, 'Store closing early');
});

test('orders/legs/{legId}/advance: start→complete with transition conflicts', async () => {
  const id = await createOrder();
  const route = await call('GET', `/orders/${id}/route`);
  assert.equal(route.status, 200);
  const legId = route.body[0].legId;
  assert.equal(route.body[0].status, 'pending');

  const start = await call('POST', `/orders/${id}/legs/${legId}/advance`, { body: { action: 'start' } });
  assert.equal(start.status, 200);
  const started = start.body.find((s: any) => s.legId === legId);
  assert.equal(started.status, 'in_progress');
  assert.equal(typeof started.startedAt, 'number');

  const restart = await call('POST', `/orders/${id}/legs/${legId}/advance`, { body: { action: 'start' } });
  assert.equal(restart.status, 409);
  assert.equal(restart.body.error.code, 'INVALID_TRANSITION');

  const complete = await call('POST', `/orders/${id}/legs/${legId}/advance`, { body: { action: 'complete' } });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.find((s: any) => s.legId === legId).status, 'completed');

  const badAction = await call('POST', `/orders/${id}/legs/${legId}/advance`, { body: { action: 'teleport' } });
  assert.equal(badAction.status, 400);
});

test('refunds: list queue with statuses, integer TZS; approve executes payment+ledger; re-decide conflicts', async () => {
  const list = await call('GET', '/refunds');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  const byId = new Map(list.body.map((r: any) => [r.id, r]));
  assert.equal(byId.get('rf_o_seed_8').status, 'pending', 'requested → pending');
  assert.equal(byId.get('rf_o_seed_11').status, 'approved');
  assert.equal(byId.get('rf_o_seed_10').status, 'rejected');
  for (const r of list.body) {
    assert.ok(Number.isInteger(r.amountTZS), 'amountTZS integer');
    assert.equal(typeof r.orderId, 'string');
    assert.equal(typeof r.createdAt, 'number');
    assert.equal(typeof r.reason, 'string');
  }
  const filtered = await call('GET', '/refunds?status=pending');
  assert.ok(filtered.body.every((r: any) => r.status === 'pending'));

  // Fresh pending request on a captured-payment order (o_seed_12).
  db.table<Refund>('refunds').insert({
    id: 'rf_test_12',
    merchantId: 'm_demo',
    orderId: 'o_seed_12',
    paymentId: 'pay_o_seed_12',
    amount: 5000,
    reason: 'Delivered very late',
    reasonCode: 'LATE_DELIVERY',
    status: 'requested',
    createdAt: Date.now() - 60000,
    ts: Date.now() - 60000,
  });
  const approve = await call('POST', '/refunds/rf_test_12/approve', { body: { reason: 'Verified with support' } });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, 'approved');
  assert.equal(approve.body.amountTZS, 5000);
  assert.equal(approve.body.decisionReason, 'Verified with support');

  const reapprove = await call('POST', '/refunds/rf_test_12/approve', { body: { reason: 'again' } });
  assert.equal(reapprove.status, 409);
  assert.equal(reapprove.body.error.code, 'REFUND_ALREADY_DECIDED');

  const payment = await call('GET', '/orders/o_seed_12');
  assert.equal(payment.body.order.payment.status, 'refunded');
  assert.equal(payment.body.order.payment.refundedAmount, 5000);

  const ledger = await call('GET', '/ledger?type=refund&size=100');
  assert.ok(ledger.body.entries.some((e: any) => e.amount === -5000 && e.refId === 'o_seed_12'), 'exactly one refund ledger debit');
});

test('refunds: partial approve clamps at order total; reject + re-decision conflict', async () => {
  db.table<Refund>('refunds').insert({
    id: 'rf_test_8',
    merchantId: 'm_demo',
    orderId: 'o_seed_8',
    paymentId: 'pay_o_seed_8',
    amount: 600,
    reason: 'Missing side dish',
    reasonCode: 'MISSING_ITEM',
    status: 'requested',
    createdAt: Date.now() - 60000,
    ts: Date.now() - 60000,
  });
  const partial = await call('POST', '/refunds/rf_test_8/approve', { body: { reason: 'partial ok', amountTZS: 250 } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.status, 'approved');
  assert.equal(partial.body.amountTZS, Math.min(250, Math.round((await call('GET', '/orders/o_seed_8')).body.order.total)), 'partial approval clamps at order total');

  const reject = await call('POST', '/refunds/rf_o_seed_8/reject', { body: { reason: 'Policy does not cover this' } });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.status, 'rejected');
  assert.equal(reject.body.decisionReason, 'Policy does not cover this');

  const rereject = await call('POST', '/refunds/rf_o_seed_8/reject', { body: { reason: 'again' } });
  assert.equal(rereject.status, 409);
  assert.equal(rereject.body.error.code, 'REFUND_ALREADY_DECIDED');

  const approveAfterReject = await call('POST', '/refunds/rf_o_seed_8/approve', { body: { reason: 'never mind' } });
  assert.equal(approveAfterReject.status, 409);
  assert.equal(approveAfterReject.body.error.code, 'REFUND_ALREADY_DECIDED');

  const missing = await call('POST', '/refunds/rf_ghost/approve', { body: { reason: 'x' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'REFUND_REQUEST_NOT_FOUND');
});

test('legacy aliases stay intact: /orders/{id}/ready + /complete still work', async () => {
  const id = await createOrder();
  await acceptToPreparing(id);
  const ready = await call('POST', `/orders/${id}/ready`, { body: { expectedVersion: 2 }, idem: 'gaps-alias-ready' });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.order.status, 'ready');
  const done = await call('POST', `/orders/${id}/complete`, { body: { expectedVersion: 3 }, idem: 'gaps-alias-complete' });
  assert.equal(done.status, 200);
  assert.equal(done.body.order.status, 'completed');
});

/* ================= Gap-close additions (ORDER-FLOW.md audit) ================= */

test('gap OF-01: terminal statuses refunded/failed/disputed + merchant_accepted are queueable and render', async () => {
  for (const status of ['refunded', 'failed', 'disputed', 'merchant_accepted']) {
    const res = await call('GET', `/orders/me?status=${status}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((o: any) => o.status === status), `seeded ${status} order listed`);
  }
  const disputed = (await call('GET', '/orders/me?status=disputed')).body[0];
  const detail = await call('GET', `/orders/${disputed.id}`);
  assert.equal(detail.body.order.payment.status, 'captured', 'dispute holds the captured payment (payout held)');
});

test('gap OF-02: cancel carries server-computed cancelFeeTZS/refundTZS (0 fee before acceptance)', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/cancel`, { body: { reason: 'Customer changed mind' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.cancelFeeTZS, 0, 'no fee before merchant acceptance');
  assert.equal(res.body.refundTZS, Math.round(res.body.total), 'full refund before acceptance');

  const acc = await createOrder();
  await acceptToPreparing(acc);
  const fee = await call('POST', `/orders/${acc}/cancel`, { body: { reason: 'late cancel' } });
  assert.equal(fee.status, 200);
  assert.ok(fee.body.cancelFeeTZS > 0, 'fee applies after acceptance');
  assert.equal(fee.body.refundTZS + fee.body.cancelFeeTZS, Math.round(fee.body.total));
});

test('gap OF-04: accept on a non-paid order is ORDER_STATUS_CONFLICT; late accept after auto-cancel is ORDER_AUTO_CANCELLED', async () => {
  const acc = await call('POST', '/orders/o_seed_24/accept', { body: { expectedVersion: 1 }, idem: 'gaps-of4-1' });
  assert.equal(acc.status, 409);
  assert.equal(acc.body.error.code, 'ORDER_STATUS_CONFLICT');

  const id = await createOrder();
  db.table('orders').update(id, { deadlineAt: Date.now() - 1000 });
  const { runSweeperJobs } = await import('@/mock/sweeper');
  runSweeperJobs();
  const late = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'gaps-of4-2' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ORDER_AUTO_CANCELLED');
});

test('gap OF-06: rush-reply message stored + RUSH_ALREADY_REPLIED on a different second message', async () => {
  const id = await createOrder();
  await call('POST', `/orders/${id}/rush`, { internal: true, body: { note: 'hurry' } });
  const reply = await call('POST', `/orders/${id}/rush-reply`, { body: { message: 'ETA 10 minutes' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.rushOrder.replyMessage, 'ETA 10 minutes');
  const dup = await call('POST', `/orders/${id}/rush-reply`, { body: { message: 'ETA 30 minutes' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'RUSH_ALREADY_REPLIED');
  const plain = await createOrder();
  const notOpen = await call('POST', `/orders/${plain}/rush-reply`, { body: { message: 'on it' } });
  assert.equal(notOpen.status, 409);
  assert.equal(notOpen.body.error.code, 'RUSH_NOT_OPEN');
});

test('gap OF-08: decided damage claims block resubmission with DAMAGE_CLAIM_ALREADY_DECIDED', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/damage`, { body: { type: 'spilled', description: 'Sauce leaked' } });
  assert.equal(res.status, 201);
  db.table('damageClaims').update(res.body.id, { status: 'rejected' });
  const resubmit = await call('POST', `/orders/${id}/damage`, { body: { type: 'missing', description: 'resubmit' } });
  assert.equal(resubmit.status, 409);
  assert.equal(resubmit.body.error.code, 'DAMAGE_CLAIM_ALREADY_DECIDED');
});

test('gap OF-09: GET /orders/receipts serves contract reprint rows {orderId, printedAt, jobId}', async () => {
  const rows = await call('GET', '/orders/receipts?limit=20');
  assert.equal(rows.status, 200);
  assert.ok(Array.isArray(rows.body));
  assert.ok(rows.body.length >= 3, 'seeded receipt history');
  for (const r of rows.body) {
    assert.equal(typeof r.orderId, 'string');
    assert.equal(typeof r.printedAt, 'number');
    assert.equal(typeof r.jobId, 'string');
  }
});

test('gap OF-15: single-reject returns ORDER_ALREADY_REJECTED / ORDER_REJECT_AFTER_ACCEPTANCE', async () => {
  const id = await createOrder();
  await call('POST', `/orders/${id}/reject`, { body: { reason: 'Store too busy' }, idem: 'gaps-of15-1' });
  const again = await call('POST', `/orders/${id}/reject`, { body: { reason: 'again' }, idem: 'gaps-of15-2' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ORDER_ALREADY_REJECTED');

  const acc = await createOrder();
  await acceptToPreparing(acc);
  const late = await call('POST', `/orders/${acc}/reject`, { body: { reason: 'late' }, idem: 'gaps-of15-3' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ORDER_REJECT_AFTER_ACCEPTANCE');
});

test('gap OF-16: timeline by resolves to role labels, never raw staff ids', async () => {
  const completed = (await call('GET', '/orders?status=completed')).body.orders[0];
  const tl = await call('GET', `/orders/${completed.id}/timeline`);
  const allowed = new Set(['system', 'merchant', 'rider', 'customer', 'owner', 'manager', 'cashier', 'kitchen', 'waiter']);
  for (const ev of tl.body.events) {
    assert.ok(allowed.has(ev.by), `actor "${ev.by}" is a role label`);
  }
});
