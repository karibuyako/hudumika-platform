import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import type { ServerEvent } from '@/api/types';
import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db, uid } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { subscribe } from '@/mock/events';
import { webhookDeliveryTick } from '@/mock/handlers/webhooks';

/* P8d supply-chain + enterprise-finance gap flows:
 *  - webhook retry/backoff engine (attempts, backoff schedule, failing flip,
 *    webhook.delivery_failed event + notification, re-enable, test endpoint)
 *  - approval-gated refunds (REFUND_AWAITING_APPROVAL → decision → execute)
 *  - inventory/purchase_order/warehouse/integration notification events */

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
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

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

const seen: ServerEvent[] = [];
let unsub: (() => void) | null = null;

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  token = await loginAs('+255700000000');
  unsub = subscribe((e) => seen.push(e));
});

beforeEach(() => {
  seen.length = 0;
});

after(() => {
  unsub?.();
  server.close();
});

/* ================= Webhook retry / backoff engine ================= */

test('webhook engine: create enqueues a delivery; backoff schedule + success path', async () => {
  const created = await call('POST', '/webhooks', {
    body: { url: 'https://hooks.example.com/supply-flow', events: ['order.created'] },
    idem: 'sf-wh-1',
  });
  assert.equal(created.status, 201);
  const webhookId = created.body.id;

  const deliveries = await call('GET', `/webhooks/deliveries?webhookId=${webhookId}`);
  const enqueued = deliveries.body.find((d: any) => d.webhookId === webhookId);
  assert.ok(enqueued, 'create enqueues a delivery row');
  assert.equal(enqueued.status, 'retrying');
  assert.equal(enqueued.attempts, 0);
  assert.equal(typeof enqueued.nextRetryAt, 'number');

  /* Deterministic: force 2 failures then success on attempt 3. */
  db.table('webhookDeliveries').remove(enqueued.id);
  const t0 = Date.now();
  const row = db.table<any>('webhookDeliveries').insert({
    id: uid('wdel'),
    merchantId: 'm_demo',
    webhookId,
    event: 'order.created',
    status: 'retrying',
    attempts: 0,
    statusCode: null,
    nextRetryAt: t0 - 1000,
    deliveredAt: null,
    failUntilAttempts: 2,
  });

  const r1 = webhookDeliveryTick(t0);
  assert.equal(r1.attempted, 1);
  const after1 = db.table<any>('webhookDeliveries').find(row.id);
  assert.equal(after1.attempts, 1);
  assert.equal(after1.status, 'retrying');
  assert.equal(after1.nextRetryAt, t0 + 30_000, 'attempt 1 → 30s backoff');

  const r2 = webhookDeliveryTick(t0 + 30_001);
  assert.equal(r2.attempted, 1);
  const after2 = db.table<any>('webhookDeliveries').find(row.id);
  assert.equal(after2.attempts, 2);
  assert.equal(after2.status, 'retrying');
  assert.equal(after2.nextRetryAt, t0 + 30_001 + 60_000, 'attempt 2 → 60s backoff');

  const r3 = webhookDeliveryTick(t0 + 90_001 + 60_000);
  assert.equal(r3.delivered, 1);
  const after3 = db.table<any>('webhookDeliveries').find(row.id);
  assert.equal(after3.status, 'success');
  assert.equal(after3.statusCode, 200);
  assert.equal(after3.deliveredAt, t0 + 90_001 + 60_000);
  assert.equal(after3.nextRetryAt, null);

  const wh = (await call('GET', '/webhooks')).body.find((w: any) => w.id === webhookId);
  assert.equal(wh.lastDeliveryAt, t0 + 90_001 + 60_000, 'subscription lastDeliveryAt advances on success');

  await call('DELETE', `/webhooks/${webhookId}`);
});

test('webhook engine: 5 consecutive errors flip the subscription to failing + webhook.delivery_failed', async () => {
  const created = await call('POST', '/webhooks', {
    body: { url: 'https://hooks.example.com/flaky', events: ['order.created'] },
    idem: 'sf-wh-2',
  });
  assert.equal(created.status, 201);
  const webhookId = created.body.id;
  const deliveries = (await call('GET', `/webhooks/deliveries?webhookId=${webhookId}`)).body;
  for (const d of deliveries) db.table('webhookDeliveries').remove(d.id);

  const t0 = Date.now();
  const row = db.table<any>('webhookDeliveries').insert({
    id: uid('wdel'),
    merchantId: 'm_demo',
    webhookId,
    event: 'order.created',
    status: 'retrying',
    attempts: 0,
    statusCode: null,
    nextRetryAt: t0 - 1000,
    deliveredAt: null,
    /* Never succeed — drive the full failure path through the 8-attempt cap. */
    failUntilAttempts: 99,
  });

  /* Drive ticks at each delivery's own nextRetryAt (+1ms) so the growing
   * backoff (30s → 60s → 120s → 240s → 480s) is always due. */
  let tickAt = t0 - 1000;
  for (let i = 0; i < 4; i += 1) {
    const r = webhookDeliveryTick(tickAt);
    assert.equal(r.attempted, 1, `tick ${i + 1} processed the due delivery`);
    const cur = db.table<any>('webhookDeliveries').find(row.id);
    tickAt = (cur.nextRetryAt ?? tickAt) + 1;
  }
  const before = db.table<any>('webhookDeliveries').find(row.id);
  assert.equal(before.attempts, 4);
  let wh = (await call('GET', '/webhooks')).body.find((w: any) => w.id === webhookId);
  assert.equal(wh.status, 'active', 'not failing before 5 consecutive errors');

  webhookDeliveryTick(tickAt);
  const after = db.table<any>('webhookDeliveries').find(row.id);
  assert.equal(after.attempts, 5);
  tickAt = (after.nextRetryAt ?? tickAt) + 1;
  wh = (await call('GET', '/webhooks')).body.find((w: any) => w.id === webhookId);
  assert.equal(wh.status, 'failing', '5 consecutive errors flip the subscription to failing');

  const failedEvents = seen.filter((e) => e.type === 'webhooks.delivery_failed');
  assert.ok(failedEvents.length >= 1, 'webhook.delivery_failed emitted');
  const notes = db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo' && n.title.includes('Webhook delivery failing'));
  assert.ok(notes.length >= 1, 'webhook.delivery_failed surfaces an in-app notification');

  /* keep failing through the max (8) attempts → final failed row */
  for (let i = 5; i < 8; i += 1) {
    webhookDeliveryTick(tickAt);
    const cur = db.table<any>('webhookDeliveries').find(row.id);
    tickAt = (cur.nextRetryAt ?? tickAt) + 1;
  }
  const done = db.table<any>('webhookDeliveries').find(row.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.attempts, 8, 'max 8 attempts per event');
  assert.equal(done.statusCode, 500);

  /* re-enable resets the failure counter (PATCH {status: active}) */
  const re = await call('PATCH', `/webhooks/${webhookId}`, { body: { status: 'active' }, idem: 'sf-wh-re' });
  assert.equal(re.status, 200);
  assert.equal(re.body.status, 'active');

  await call('DELETE', `/webhooks/${webhookId}`);
});

test('webhook engine: test endpoint enqueues + attempts synchronously; disabled blocked', async () => {
  const created = await call('POST', '/webhooks', {
    body: { url: 'https://hooks.example.com/test-me', events: ['order.created'] },
    idem: 'sf-wh-3',
  });
  assert.equal(created.status, 201);
  const webhookId = created.body.id;
  const deliveries = (await call('GET', `/webhooks/deliveries?webhookId=${webhookId}`)).body;
  for (const d of deliveries) db.table('webhookDeliveries').remove(d.id);

  const res = await call('POST', `/webhooks/${webhookId}/test`, { idem: 'sf-wh-test-1' });
  assert.ok(res.status === 200 || (res.status === 400 && res.body.error.code === 'WEBHOOK_DELIVERY_FAILED'), 'test delivers or fails with WEBHOOK_DELIVERY_FAILED');
  if (res.status === 200) {
    assert.equal(res.body.webhookId, webhookId);
    assert.ok(['success', 'retrying'].includes(res.body.status));
  }
  const after = (await call('GET', `/webhooks/deliveries?webhookId=${webhookId}`)).body;
  assert.ok(after.length >= 1, 'test delivery row persisted');

  const disabled = await call('PATCH', `/webhooks/${webhookId}`, { body: { status: 'disabled' } });
  assert.equal(disabled.status, 200);
  const blocked = await call('POST', `/webhooks/${webhookId}/test`);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'WEBHOOK_STATUS_INVALID');

  await call('DELETE', `/webhooks/${webhookId}`);
});

test('integration disconnect emits event + creates the in-app notification', async () => {
  const before = db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo').length;
  const res = await call('POST', '/integrations/int_seed_1/disconnect', { body: { reason: 'Switching POS provider' } });
  assert.equal(res.status, 204);
  assert.ok(seen.some((e) => e.type === 'integrations.disconnected'), 'integration.disconnected event emitted');
  const notes = db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo');
  assert.equal(notes.length, before + 1, 'disconnect inserts a NotificationDto row');
  assert.ok(notes[notes.length - 1].title.includes('Integration disconnected'));
});

/* ================= Approval-gated refunds (EF L49-51) ================= */

test('refunds: above-threshold refund awaits approval; executes after the approval decision', async () => {
  const queue = await call('GET', '/refunds');
  assert.equal(queue.status, 200);
  const gated = queue.body.find((r: any) => r.id === 'rf_above_threshold');
  assert.ok(gated, 'seeded above-threshold refund present');
  assert.equal(gated.status, 'pending');
  assert.equal(gated.awaitingApproval.approvalStatus, 'pending');
  assert.equal(gated.awaitingApproval.thresholdTZS, 150000);
  assert.equal(gated.awaitingApproval.amountTZS, 180000);

  const blocked = await call('POST', '/refunds/rf_above_threshold/approve', { body: { reason: 'customer confirmed duplicate' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'REFUND_AWAITING_APPROVAL');
  assert.equal(blocked.body.error.details.approvalStatus, 'pending');
  assert.equal(blocked.body.error.details.approvalId, 'ap_seed_refund_gate');

  const decided = await call('POST', '/approvals/ap_seed_refund_gate/decision', {
    body: { decision: 'approved', comment: 'Confirmed with the corporate finance team' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.approval.status, 'approved');

  const approved = await call('POST', '/refunds/rf_above_threshold/approve', { body: { reason: 'approval granted' }, idem: 'sf-refund-1' });
  assert.equal(approved.status, 200, 'refund executes after the approval is approved');
  assert.equal(approved.body.status, 'approved');

  const pay = db.table<any>('payments').find('pay_o_seed_15');
  assert.equal(pay.status, 'refunded');
  assert.equal(pay.refundedAmount, 180000, 'payment refunded for the approved amount (integer TZS)');
  const ledger = db.table<any>('ledger').where((l: any) => l.merchantId === 'm_demo' && l.type === 'refund' && l.refId === 'o_seed_15');
  assert.ok(ledger.length >= 1, 'ledger debit written');
});

test('refunds: below-threshold refund executes directly (no approval gate)', async () => {
  const queue = await call('GET', '/refunds');
  const small = queue.body.find((r: any) => r.id === 'rf_o_seed_8');
  assert.ok(small, 'seeded small refund present');
  assert.equal(small.awaitingApproval, null, 'no gate below the threshold');
  const approved = await call('POST', '/refunds/rf_o_seed_8/approve', { body: { reason: 'within threshold' }, idem: 'sf-refund-2' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
});

test('refunds: approve above threshold without an existing approval creates one, then binds', async () => {
  db.table<any>('refunds').insert({
    id: 'rf_new_gate',
    merchantId: 'm_demo',
    orderId: 'o_seed_16',
    paymentId: 'pay_o_seed_16',
    amount: 200000,
    reason: 'Bulk enterprise return',
    reasonCode: 'ENTERPRISE_RETURN',
    status: 'requested',
    createdAt: Date.now(),
    ts: Date.now(),
  });
  const first = await call('POST', '/refunds/rf_new_gate/approve', { body: { reason: 'please approve' } });
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'REFUND_AWAITING_APPROVAL');
  assert.equal(first.body.error.details.approvalStatus, 'pending');
  assert.ok(first.body.error.details.approvalId, 'approval row created');

  const approvals = await call('GET', '/approvals?scope=all');
  const created = approvals.body.approvals.find((a: any) => a.id === first.body.error.details.approvalId);
  assert.ok(created, 'approval visible in the approvals list');
  assert.equal(created.type, 'refund_above_threshold');
  assert.equal(created.refId, 'rf_new_gate');
  assert.equal(created.amountTZS, 200000);

  /* still gated while pending */
  const second = await call('POST', '/refunds/rf_new_gate/approve', { body: { reason: 'again' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'REFUND_AWAITING_APPROVAL');

  /* a rejected decision keeps the refund from executing */
  const reject = await call('POST', `/approvals/${created.id}/decision`, { body: { decision: 'rejected', comment: 'No funds — hold' } });
  assert.equal(reject.status, 200);
  const third = await call('POST', '/refunds/rf_new_gate/approve', { body: { reason: 'after reject' } });
  assert.equal(third.status, 409);
  assert.equal(third.body.error.details.approvalStatus, 'rejected', 'rejected approval blocks execution');
});

/* ================= Notification events (ISC L33, L81, L179-187) ================= */

test('inventory adjust crossing the threshold emits low_stock/out_of_stock + notification', async () => {
  /* p2: stock 150, threshold 10 → drop to 8 in one adjust. */
  const res = await call('POST', '/inventory/items/p2/adjust', { body: { delta: -142, reason: 'damaged during service' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.stockOnHand, 8);
  assert.ok(seen.some((e) => e.type === 'inventory.low_stock'), 'inventory.low_stock event emitted');
  const notes = db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo' && n.title.includes('Low stock'));
  assert.ok(notes.length >= 1, 'low-stock notification row inserted');

  /* p7 is already at 0 — a non-crossing adjust emits nothing new */
  const before = seen.length;
  const noop = await call('POST', '/inventory/items/p7/adjust', { body: { delta: -1, reason: 'x' } });
  assert.equal(noop.status, 409, 'stock cannot go negative');
  assert.equal(seen.length, before, 'no event when the adjustment fails');
});

test('PO receive emits purchase_order.received + in-app notification', async () => {
  const before = seen.filter((e) => e.type === 'purchase_order.received').length;
  const created = await call('POST', '/purchase-orders', {
    body: { supplierId: 'sup_seed_2', items: [{ catalogueItemId: 'p2', quantity: 10 }] },
    idem: 'sf-po-1',
  });
  await call('POST', `/purchase-orders/${created.body.id}/send`);
  const recv = await call('POST', `/purchase-orders/${created.body.id}/receive`, { body: { items: [{ catalogueItemId: 'p2', quantity: 10 }] } });
  assert.equal(recv.status, 200);
  assert.ok(seen.filter((e) => e.type === 'purchase_order.received').length > before, 'purchase_order.received event emitted');
  const notes = db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo' && n.title.includes('Purchase order received'));
  assert.ok(notes.length >= 1, 'purchase_order.received in-app notification inserted');
});

test('warehouse stock crossing the serving threshold emits warehouse.stock_low + notification', async () => {
  const before = seen.filter((e) => e.type === 'warehouse.stock_low').length;
  /* wh_seed_1 holds p3 at 8 (threshold 10) — push it lower. */
  const res = await call('PUT', '/warehouses/wh_seed_1/stock', {
    body: { items: [{ catalogueItemId: 'p3', delta: -6 }], reason: 'write-off — sample batch failed QC' },
    idem: 'sf-wh-low-1',
  });
  assert.equal(res.status, 200);
  const lowEvents = seen.filter((e) => e.type === 'warehouse.stock_low');
  assert.ok(lowEvents.length > before, 'warehouse.stock_low event emitted');
  assert.equal((lowEvents[lowEvents.length - 1] as any).item.catalogueItemId, 'p3');
  const notes = db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo' && n.title.includes('Warehouse low stock'));
  assert.ok(notes.length >= 1, 'warehouse.stock_low in-app notification inserted');
});

test('supplier returns: status transitions emit processed/rejected events + notifications', async () => {
  const created = await call('POST', '/supplier-returns', {
    body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p1', quantity: 2 }], reason: 'Wrong batch delivered' },
    idem: 'sf-sr-1',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const processed = await call('POST', `/supplier-returns/${id}/process`, { idem: 'sf-sr-proc-1' });
  assert.equal(processed.status, 200);
  assert.equal(processed.body.status, 'processed');
  assert.ok(seen.some((e) => e.type === 'supplier_returns.processed'), 'supplier_returns.processed event emitted');
  assert.ok(db.table<any>('notifications').where((n: any) => n.merchantId === 'm_demo' && n.title.includes('Supplier return processed')).length >= 1);

  const created2 = await call('POST', '/supplier-returns', {
    body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p1', quantity: 1 }], reason: 'Damaged in transit' },
    idem: 'sf-sr-2',
  });
  const rejected = await call('POST', `/supplier-returns/${created2.body.id}/reject`, { body: { reason: 'No damage evidence' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');
  assert.ok(seen.some((e) => e.type === 'supplier_returns.rejected'), 'supplier_returns.rejected event emitted');
});
