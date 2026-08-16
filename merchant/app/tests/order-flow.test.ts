import './shims';

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { subscribe } from '@/mock/events';
import { seedDatabase } from '@/mock/seed';
import { runSweeperJobs } from '@/mock/sweeper';
import { setToken } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useOrderStore } from '@/store/orders';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let ownerToken: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; internal?: boolean; idem?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` };
  if (opts.internal) headers['x-internal-key'] = 'demo-customer-platform';
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await fetch(`http://localhost/api${path}`, {
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

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const { requestId, debugCode } = await useSessionStore.getState().requestOtp('+255700000000', 'login');
  await useSessionStore.getState().verifyOtp(requestId, debugCode, 'login');
  ownerToken = useSessionStore.getState().token;
  assert.ok(ownerToken, 'owner session token issued');
});

beforeEach(() => {
  setToken(ownerToken);
});

after(() => {
  server.close();
});

/* ============ OF-01 terminal statuses are representable end-to-end ============ */

test('terminal statuses: seeded refunded/failed/disputed/merchant_accepted orders are listable + detail renders', async () => {
  for (const status of ['refunded', 'failed', 'disputed', 'merchant_accepted']) {
    const res = await call('GET', `/orders/me?status=${status}`);
    assert.equal(res.status, 200, `${status} list`);
    assert.ok(res.body.some((o: any) => o.status === status), `a ${status} order exists in the queue`);
    const row = res.body.find((o: any) => o.status === status);
    assert.equal(typeof row.totals.totalTZS, 'number', 'contract Order totals present');
    const detail = await call('GET', `/orders/${row.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.order.status, status);
  }
  // Disputed order: payment stays captured (payout held) + cancel fee is 0.
  const disputed = (await call('GET', '/orders/me?status=disputed')).body[0];
  const detail = await call('GET', `/orders/${disputed.id}`);
  assert.equal(detail.body.order.payment.status, 'captured', 'dispute holds the captured payment');
  assert.equal(detail.body.order.cancelFeeTZS, 0, 'terminal orders carry a server-computed cancelFeeTZS');
});

/* ============ OF-02 cancellation fee ============ */

test('cancel fee: cancelling before acceptance is free; after acceptance a fee + refundTZS come back', async () => {
  const fresh = await createOrder();
  const free = await call('POST', `/orders/${fresh}/cancel`, { body: { reason: 'Customer changed mind' } });
  assert.equal(free.status, 200);
  assert.equal(free.body.cancelFeeTZS, 0, 'no fee before merchant acceptance');
  assert.equal(free.body.refundTZS, Math.round(free.body.total), 'full refund before acceptance');

  const accepted = await createOrder();
  const acc = await call('POST', `/orders/${accepted}/accept`, { body: { expectedVersion: 1 }, idem: 'of2-accept' });
  assert.equal(acc.status, 200);
  const fee = await call('POST', `/orders/${accepted}/cancel`, { body: { reason: 'Merchant-initiated after acceptance' } });
  assert.equal(fee.status, 200);
  assert.equal(fee.body.status, 'cancelled');
  assert.ok(Number.isInteger(fee.body.cancelFeeTZS) && fee.body.cancelFeeTZS > 0, 'fee applies after acceptance');
  assert.ok(Number.isInteger(fee.body.refundTZS) && fee.body.refundTZS > 0, 'refundTZS is integer TZS');
  assert.equal(fee.body.refundTZS + fee.body.cancelFeeTZS, Math.round(fee.body.total), 'fee + refund = order total');
  // The fee is server-computed and carried on list rows too.
  const list = await call('GET', '/orders/me?limit=100');
  assert.ok(list.body.every((o: any) => typeof o.cancelFeeTZS === 'number'), 'every queue row carries cancelFeeTZS');
});

/* ============ OF-03 / OF-04 accept conflicts are never silent ============ */

test('accept conflict: accept on a non-paid order is 409 ORDER_STATUS_CONFLICT (not a silent 200)', async () => {
  // A resting `merchant_accepted` order (already transitioned) rejects a fresh
  // accept with ORDER_STATUS_CONFLICT; a preparing replay stays idempotent 200.
  const acc = await call('POST', '/orders/o_seed_24/accept', { body: { expectedVersion: 1 }, idem: 'of4-a0' });
  assert.equal(acc.status, 409);
  assert.equal(acc.body.error.code, 'ORDER_STATUS_CONFLICT', 'accept on an already-transitioned order is a conflict');

  const id = await createOrder();
  const first = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'of4-a1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.order.status, 'preparing');
  const replay = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 2 }, idem: 'of4-a2' });
  assert.equal(replay.status, 200, 'already-accepted replay is absorbed (state machine)');
  assert.equal(replay.body.order.status, 'preparing');
});

test('accept conflict: a late accept after auto-cancel is 409 ORDER_AUTO_CANCELLED', async () => {
  const id = await createOrder({ scheduledAt: undefined });
  db.table('orders').update(id, { deadlineAt: Date.now() - 1000 });
  runSweeperJobs();
  const late = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'of4-b' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ORDER_AUTO_CANCELLED');
  const detail = await call('GET', `/orders/${id}`);
  assert.equal(detail.body.order.cancelReasonCode, 'AUTO_CANCEL');
});

test('conflict events: orders.status_conflict emitted on accept collisions and auto-cancel', async () => {
  const seen: { type: string; code?: string; orderId?: string }[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'orders.status_conflict') seen.push({ type: e.type, code: e.code, orderId: e.orderId });
  });
  try {
    await call('POST', '/orders/o_seed_24/accept', { body: { expectedVersion: 1 }, idem: 'of-ev-0' });
    assert.ok(seen.some((s) => s.code === 'ORDER_STATUS_CONFLICT' && s.orderId === 'o_seed_24'), 'collision emitted ORDER_STATUS_CONFLICT');

    const late = await createOrder();
    db.table('orders').update(late, { deadlineAt: Date.now() - 1000 });
    runSweeperJobs();
    assert.ok(seen.some((s) => s.code === 'ORDER_AUTO_CANCELLED' && s.orderId === late), 'auto-cancel emitted ORDER_AUTO_CANCELLED');
  } finally {
    unsub();
  }
});

/* ============ OF-05 cursor pagination on /orders/me ============ */

test('orders/me: limit+cursor paginate without overlap and the store hydrates pages', async () => {
  const page1 = await call('GET', '/orders/me?limit=4&cursor=0');
  assert.equal(page1.status, 200);
  const page2 = await call('GET', `/orders/me?limit=4&cursor=${page1.body.length}`);
  assert.ok(page2.body.every((o: any) => !page1.body.some((x: any) => x.id === o.id)), 'cursor pages do not overlap');

  useOrderStore.setState({ orders: [], loaded: false, queueCursor: 0, queueHasMore: false });
  await useOrderStore.getState().hydrateQueue('completed');
  const s = useOrderStore.getState();
  assert.ok(s.orders.length > 0, 'server-side queue page hydrated');
  assert.ok(s.orders.every((o) => o.status === 'completed'), 'status filter applied server-side');
  assert.equal(typeof s.queueCursor, 'number');
});

/* ============ OF-06 rush reply message + codes ============ */

test('rush reply: message ≤300 stored; RUSH_ALREADY_REPLIED on a different second reply; RUSH_NOT_OPEN when closed', async () => {
  const id = await createOrder();
  const rush = await call('POST', `/orders/${id}/rush`, { internal: true, body: { note: 'hurry' } });
  assert.equal(rush.status, 200);

  const reply = await call('POST', `/orders/${id}/rush-reply`, { body: { message: 'ETA 10 minutes' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.rushOrder.status, 'replied');
  assert.equal(reply.body.rushOrder.replyMessage, 'ETA 10 minutes');
  assert.equal(reply.body.order.rushReplied, true);

  // Identical replay stays idempotent (deadline untouched).
  const same = await call('POST', `/orders/${id}/rush-reply`, { body: { message: 'ETA 10 minutes' } });
  assert.equal(same.status, 200);
  assert.equal(same.body.order.deadlineAt, reply.body.order.deadlineAt, 'identical replay does not re-extend the deadline');

  // A different second message is a double reply → 409.
  const dup = await call('POST', `/orders/${id}/rush-reply`, { body: { message: 'ETA 30 minutes' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'RUSH_ALREADY_REPLIED');

  // RUSH_NOT_OPEN for orders that never had a rush.
  const plain = await createOrder();
  const notOpen = await call('POST', `/orders/${plain}/rush-reply`, { body: { message: 'on it' } });
  assert.equal(notOpen.status, 409);
  assert.equal(notOpen.body.error.code, 'RUSH_NOT_OPEN');

  // The rush queue surfaces the stored message.
  const queue = await call('GET', '/orders/rush?status=all');
  const row = queue.body.find((r: any) => r.orderId === id);
  assert.equal(row.replyMessage, 'ETA 10 minutes');
});

/* ============ OF-08 damage claim codes ============ */

test('damage claim: open duplicate is DAMAGE_CLAIM_EXISTS; decided claim blocks with DAMAGE_CLAIM_ALREADY_DECIDED', async () => {
  const id = await createOrder();
  const res = await call('POST', `/orders/${id}/damage`, { body: { type: 'spilled', description: 'Sauce leaked', images: ['https://example.com/1.jpg'] } });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'open');

  const dup = await call('POST', `/orders/${id}/damage`, { body: { type: 'missing', description: 'again' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DAMAGE_CLAIM_EXISTS');

  // A decided claim blocks resubmission with the documented code.
  db.table('damageClaims').update(res.body.id, { status: 'approved' });
  const resubmit = await call('POST', `/orders/${id}/damage`, { body: { type: 'missing', description: 'resubmit' } });
  assert.equal(resubmit.status, 409);
  assert.equal(resubmit.body.error.code, 'DAMAGE_CLAIM_ALREADY_DECIDED');
});

/* ============ OF-09 receipts reprint list ============ */

test('receipts: GET /orders/receipts serves contract rows {orderId, printedAt, jobId}; reprint creates a print job', async () => {
  const rows = await call('GET', '/orders/receipts?limit=20');
  assert.equal(rows.status, 200);
  assert.ok(Array.isArray(rows.body));
  assert.ok(rows.body.length >= 3, 'seeded receipt history present');
  for (const r of rows.body) {
    assert.equal(typeof r.orderId, 'string');
    assert.equal(typeof r.printedAt, 'number');
    assert.equal(typeof r.jobId, 'string');
  }

  const job = await call('POST', '/print-jobs', { body: { jobType: 'receipt', orderIds: ['o_seed_6'], copies: 1 } });
  assert.equal(job.status, 201);
  assert.equal(job.body.status, 'queued');

  // The sweeper advances the job and records the fresh receipt row.
  runSweeperJobs();
  runSweeperJobs();
  const updated = await call('GET', `/print-jobs/${job.body.id}`);
  assert.equal(updated.body.status, 'done');
  const after = await call('GET', '/orders/receipts?limit=20');
  assert.ok(after.body.some((r: any) => r.jobId === job.body.id), 'completed receipt job recorded in the reprint list');
});

/* ============ OF-10 merchant_accepted machine state ============ */

test('merchant_accepted: seeded state + POST /status transitions new → merchant_accepted → preparing', async () => {
  const seeded = (await call('GET', '/orders/me?status=merchant_accepted')).body[0];
  assert.ok(seeded, 'a seeded merchant_accepted order exists');
  const advance = await call('POST', `/orders/${seeded.id}/status`, { body: { status: 'preparing' } });
  assert.equal(advance.status, 200);
  assert.equal(advance.body.status, 'preparing', 'merchant_accepted advances to preparing');

  // A fresh order accepted through the accept endpoint also lands on preparing
  // (the app's legacy accept path runs new → merchant_accepted → preparing).
  const id = await createOrder();
  const acc = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'of10-accept' });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.order.status, 'preparing');
  const timeline = await call('GET', `/orders/${id}/timeline`);
  assert.ok(timeline.body.events.some((e: any) => e.status === 'merchant_accepted'), 'timeline records the merchant_accepted step');
});

/* ============ OF-11 print-job lifecycle (sweeper) ============ */

test('print jobs: queued → printing → done via the sweeper; offline devices fail with PRINT_DEVICE_OFFLINE', async () => {
  const job = await call('POST', '/print-jobs', { body: { jobType: 'kitchen_ticket', orderIds: ['o_seed_5'], deviceId: 'dev_seed_2', copies: 1 } });
  assert.equal(job.status, 201);
  runSweeperJobs();
  const printing = await call('GET', `/print-jobs/${job.body.id}`);
  assert.equal(printing.body.status, 'printing', 'first sweep moves queued → printing');
  runSweeperJobs();
  const done = await call('GET', `/print-jobs/${job.body.id}`);
  assert.equal(done.body.status, 'done', 'second sweep moves printing → done');
  assert.equal(typeof done.body.completedAt, 'number');

  // A device that is not online fails the job with PRINT_DEVICE_OFFLINE.
  db.table('devices').insert({
    id: 'dev_offline_test',
    merchantId: 'm_demo',
    type: 'printer',
    label: 'Offline test printer',
    purpose: 'receipt',
    paperSize: '80mm',
    copies: 1,
    status: 'offline',
    settings: {},
    lastSeenAt: Date.now(),
  });
  const offline = await call('POST', '/print-jobs', { body: { jobType: 'receipt', orderIds: ['o_seed_6'], deviceId: 'dev_offline_test', queueIfOffline: true, copies: 1 } });
  assert.equal(offline.status, 201);
  runSweeperJobs();
  const failed = await call('GET', `/print-jobs/${offline.body.id}`);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.error, 'PRINT_DEVICE_OFFLINE');
});

/* ============ OF-12 advance tabs consume GET /orders/me/advance?date= ============ */

test('advance: Today/Upcoming/Past hydrate from GET /orders/me/advance?date=', async () => {
  await useOrderStore.getState().hydrateAdvance('today');
  assert.ok(useOrderStore.getState().advanceLoaded);
  assert.ok(useOrderStore.getState().advanceOrders.length > 0, 'today has the seeded pre-order');

  // Seed a pre-order for tomorrow so the Upcoming query has rows.
  const d = new Date();
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const schedId = await createOrder({ scheduledAt: tomorrow.getTime() });
  await useOrderStore.getState().hydrateAdvance('upcoming');
  assert.ok(useOrderStore.getState().advanceOrders.some((o) => o.id === schedId), 'upcoming (next 7 days) pre-orders hydrate');

  useOrderStore.setState({ advanceOrders: [] });
  await useOrderStore.getState().hydrateAdvance('past');
  assert.ok(useOrderStore.getState().advanceLoaded, 'past tab resolves');

  const missing = await call('GET', '/orders/me/advance');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'DATE_REQUIRED');
});

/* ============ OF-15 single-reject documented codes ============ */

test('reject: double reject is 409 ORDER_ALREADY_REJECTED; post-acceptance reject is ORDER_REJECT_AFTER_ACCEPTANCE', async () => {
  const id = await createOrder();
  const first = await call('POST', `/orders/${id}/reject`, { body: { reason: 'Store too busy' }, idem: 'of15-r1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.order.status, 'cancelled');

  const again = await call('POST', `/orders/${id}/reject`, { body: { reason: 'again' }, idem: 'of15-r2' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ORDER_ALREADY_REJECTED');

  const accepted = await createOrder();
  await call('POST', `/orders/${accepted}/accept`, { body: { expectedVersion: 1 }, idem: 'of15-a1' });
  const late = await call('POST', `/orders/${accepted}/reject`, { body: { reason: 'late' }, idem: 'of15-r3' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ORDER_REJECT_AFTER_ACCEPTANCE');
});

/* ============ OF-16 timeline actors resolve to roles ============ */

test('timeline: by is a role label, never a raw staff id', async () => {
  const completed = (await call('GET', '/orders/me?status=completed')).body[0];
  const timeline = await call('GET', `/orders/${completed.id}/timeline`);
  const allowed = new Set(['system', 'merchant', 'rider', 'customer', 'owner', 'manager', 'cashier', 'kitchen', 'waiter']);
  for (const ev of timeline.body.events) {
    assert.ok(allowed.has(ev.by), `timeline actor "${ev.by}" maps to a role label`);
  }
  // A fresh accepted order's timeline carries the staff-role label (s2 → manager).
  const id = await createOrder();
  await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'of16-a' });
  const tl = await call('GET', `/orders/${id}/timeline`);
  assert.ok(tl.body.events.some((e: any) => e.status === 'merchant_accepted' && ['owner', 'manager'].includes(e.by)), 'accept event carries a staff role label');
});

/* ============ batch reject contract shape (store-level) ============ */

test('batch reject: store posts orderIds + reason and surfaces the BatchResult', async () => {
  const a = await createOrder();
  const b = await createOrder();
  const res = await useOrderStore.getState().batchRejectOrder([a, b, 'missing-id'], 'Store closing early');
  assert.equal(res.accepted, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.failures[0].orderId, 'missing-id');
  const detail = await call('GET', `/orders/${a}`);
  assert.equal(detail.body.order.status, 'cancelled');
});

/* ============ cancel fee + rush reply via the store ============ */

test('store: cancelOrder surfaces refundTZS/cancelFeeTZS; replyRush sends the message', async () => {
  const id = await createOrder();
  const res = await useOrderStore.getState().cancelOrder(id, 'Customer requested cancellation');
  assert.equal(res.status, 'cancelled');
  assert.equal(res.cancelFeeTZS, 0);
  assert.equal(res.refundTZS, Math.round(res.total));

  const rushId = await createOrder();
  await call('POST', `/orders/${rushId}/rush`, { internal: true, body: { note: 'hurry' } });
  await useOrderStore.getState().replyRush(rushId, 'ETA 15 minutes');
  const row = db.table('orders').find(rushId) as any;
  assert.equal(row.replyMessage, 'ETA 15 minutes');
});
