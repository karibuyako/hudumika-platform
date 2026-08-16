/* Drift elimination tests (Phase B wave): every contract path in this module
 * must serve the SAME behavior the legacy app path serves. Each test calls the
 * contract path (no /api prefix, like the app) and the legacy path (with /api,
 * kept for contract.test.ts) and compares key fields, error codes and auth.
 *
 * Contract paths covered:
 *   - POST /orders/{orderId}/status            (legacy /api/orders/:id/ready, /complete)
 *   - GET  /payouts/me/statement               (legacy /api/ledger)
 *   - GET  /finance/settlements/daily          (legacy /api/settlements)
 *   - POST /finance/settlements/run            (legacy /api/settlements/run)
 *   - POST /finance/settlements/{id}/payout    (legacy /api/settlements/:id/payout)
 *   - GET  /finance/invoices                   (contract list, already at contract path)
 *   - POST /finance/invoices/{id}/issue        (legacy /api/invoices/:id/issue)
 *   - GET  /payments/methods                   (contract-only; no app call today)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;
let staffToken: string | null = null;

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

async function loginAs(phone: string): Promise<string> {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

/* The store enforces a minimum order (minOrder = 30) — filler line (p4) clears it. */
const MIN_ORDER = 30;

function minCart(items: { productId: string; qty: number }[]): { productId: string; qty: number }[] {
  const subtotal = items.reduce((s, it) => s + (db.table('products').find(it.productId)?.price ?? 0) * it.qty, 0);
  if (subtotal >= MIN_ORDER) return items;
  return [...items, { productId: 'p4', qty: 1 }];
}

async function createOrder(): Promise<string> {
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p1', qty: 1 }]) } });
  assert.equal(created.status, 200);
  return created.body.order.id;
}

/** A completed order inside [completedAt - 1min, completedAt], used to make a
 * settlement period non-empty without touching seeded rows. */
function insertCompletedOrder(id: string, completedAt: number): void {
  const base = db.table('orders').find('o_seed_6')!;
  db.table('orders').insert({
    ...base,
    id,
    no: `MT${88000 + Math.floor(Math.random() * 1000)}`,
    status: 'completed',
    createdAt: completedAt - 60000,
    completedAt,
    settledAt: completedAt,
  });
}

/** A day with no seeded settlement collisions (30 days out). */
function futureDay(offsetDays: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 30 + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  token = await loginAs('+255700000000');
  staffToken = await loginAs('+255700000003'); // role staff — no finance:view
});

after(() => {
  server.close();
});

/* ============ POST /orders/{orderId}/status (app already re-pointed; verify parity) ============ */

test('orders/status: contract ready/complete match legacy /ready + /complete', async () => {
  const a = await createOrder();
  const b = await createOrder();

  // Both orders to 'preparing' — contract path vs legacy accept.
  const acceptContract = await call('POST', `/orders/${a}/status`, { body: { status: 'preparing' }, idem: 'dr-a-accept' });
  assert.equal(acceptContract.status, 200);
  assert.equal(acceptContract.body.status, 'preparing');
  const acceptLegacy = await call('POST', `/api/orders/${b}/accept`, { body: { expectedVersion: 1 }, idem: 'dr-b-accept' });
  assert.equal(acceptLegacy.status, 200);
  assert.equal(acceptLegacy.body.order.status, 'preparing');

  // Ready: contract returns the bare Order; legacy wraps {ready:true, order}.
  const readyContract = await call('POST', `/orders/${a}/status`, { body: { status: 'ready' }, idem: 'dr-a-ready' });
  assert.equal(readyContract.status, 200);
  const readyLegacy = await call('POST', `/api/orders/${b}/ready`, { body: { expectedVersion: 2 }, idem: 'dr-b-ready' });
  assert.equal(readyLegacy.status, 200);

  assert.equal(readyContract.body.status, 'ready');
  assert.equal(readyLegacy.body.order.status, 'ready');
  assert.equal(typeof readyContract.body.readyAt, 'number', 'contract sets readyAt');
  assert.equal(typeof readyLegacy.body.order.readyAt, 'number', 'legacy sets readyAt');
  assert.equal(readyContract.body.version, readyLegacy.body.order.version, 'same version bump count');

  // Complete: same comparison.
  const completeContract = await call('POST', `/orders/${a}/status`, { body: { status: 'completed' }, idem: 'dr-a-complete' });
  assert.equal(completeContract.status, 200);
  const completeLegacy = await call('POST', `/api/orders/${b}/complete`, { body: { expectedVersion: 3 }, idem: 'dr-b-complete' });
  assert.equal(completeLegacy.status, 200);

  assert.equal(completeContract.body.status, 'completed');
  assert.equal(completeLegacy.body.order.status, 'completed');
  assert.equal(typeof completeContract.body.completedAt, 'number');
  assert.equal(typeof completeLegacy.body.order.completedAt, 'number');
  assert.equal(typeof completeContract.body.settledAt, 'number', 'contract marks order settled');
  assert.equal(typeof completeLegacy.body.order.settledAt, 'number', 'legacy marks order settled');
  assert.equal(completeContract.body.version, completeLegacy.body.order.version, 'same version bump count');
});

test('orders/status: error codes and auth parity with legacy ready/complete', async () => {
  const missing = await createOrder(); // real id, but we use a bogus one for the 404 check
  void missing;

  const notFoundContract = await call('POST', '/orders/order_missing/status', { body: { status: 'ready' } });
  assert.equal(notFoundContract.status, 404);
  const notFoundLegacy = await call('POST', '/api/orders/order_missing/ready', {});
  assert.equal(notFoundLegacy.status, 404);

  const freshA = await createOrder();
  const freshB = await createOrder();
  const invalidContract = await call('POST', `/orders/${freshA}/status`, { body: { status: 'ready' } });
  assert.equal(invalidContract.status, 409);
  assert.equal(invalidContract.body.error.code, 'INVALID_TRANSITION');
  const invalidLegacy = await call('POST', `/api/orders/${freshB}/ready`, { body: { expectedVersion: 1 } });
  assert.equal(invalidLegacy.status, 409);
  assert.equal(invalidLegacy.body.error.code, 'INVALID_TRANSITION');

  const unauth = await call('POST', `/orders/${freshA}/status`, { auth: false, body: { status: 'ready' } });
  assert.equal(unauth.status, 401);
  const unauthLegacy = await call('POST', `/api/orders/${freshB}/ready`, { auth: false, body: {} });
  assert.equal(unauthLegacy.status, 401);
});

/* ============ GET /payouts/me/statement (legacy /api/ledger) ============ */

test('statement: contract /payouts/me/statement matches legacy /api/ledger', async () => {
  const legacy = await call('GET', '/api/ledger?size=100');
  assert.equal(legacy.status, 200);
  const contract = await call('GET', '/payouts/me/statement?size=100');
  assert.equal(contract.status, 200);

  assert.deepEqual(contract.body.entries.map((e: any) => e.id), legacy.body.entries.map((e: any) => e.id), 'same ledger rows');
  assert.equal(contract.body.total, legacy.body.total);
  assert.equal(contract.body.page, legacy.body.page);
  assert.equal(contract.body.size, legacy.body.size);
  assert.equal(contract.body.balance, legacy.body.balance);
  assert.ok(contract.body.entries.length > 0, 'seeded ledger rows present');
  for (const e of contract.body.entries) {
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.amount, 'number');
    assert.equal(typeof e.ts, 'number');
  }

  // Contract-shaped date bounds are accepted (YYYY-MM-DD).
  const dated = await call('GET', '/payouts/me/statement?from=2026-01-01&to=2026-12-31&size=100');
  assert.equal(dated.status, 200);
  assert.equal(dated.body.entries.length, dated.body.total, 'all rows inside the window');

  const unauth = await call('GET', '/payouts/me/statement', { auth: false });
  assert.equal(unauth.status, 401);
});

/* ============ GET /finance/settlements/daily (legacy /api/settlements) ============ */

test('settlements/daily: contract list matches legacy /api/settlements', async () => {
  const legacy = await call('GET', '/api/settlements');
  assert.equal(legacy.status, 200);
  const contract = await call('GET', '/finance/settlements/daily');
  assert.equal(contract.status, 200);

  assert.deepEqual(contract.body.settlements.map((s: any) => s.id), legacy.body.settlements.map((s: any) => s.id), 'same settlement rows');
  assert.ok(contract.body.settlements.length >= 1, 'seeded settlements present');
  for (const s of contract.body.settlements) {
    assert.equal(typeof s.batchNo, 'string');
    assert.equal(typeof s.net, 'number');
    assert.ok(['pending', 'paid'].includes(s.payoutStatus), `payoutStatus ${s.payoutStatus}`);
  }

  const unauth = await call('GET', '/finance/settlements/daily', { auth: false });
  assert.equal(unauth.status, 401);
});

/* ============ POST /finance/settlements/run (legacy /api/settlements/run) ============ */

test('settlements/run: contract path matches legacy run (success shape + 409s)', async () => {
  const dayA = futureDay(0);
  const dayB = futureDay(1);
  insertCompletedOrder('dr_settle_a', dayA + 12 * 3600000);
  insertCompletedOrder('dr_settle_b', dayB + 12 * 3600000);

  const contractRun = await call('POST', '/finance/settlements/run', { body: { periodStart: dayA }, idem: 'dr-run-contract' });
  assert.equal(contractRun.status, 200);
  assert.equal(contractRun.body.settlement.payoutStatus, 'pending');
  assert.equal(contractRun.body.invoice.status, 'draft');
  assert.equal(contractRun.body.settlement.orderCount, 1);

  const legacyRun = await call('POST', '/api/settlements/run', { body: { periodStart: dayB }, idem: 'dr-run-legacy' });
  assert.equal(legacyRun.status, 200);
  assert.equal(legacyRun.body.settlement.payoutStatus, 'pending');
  assert.equal(legacyRun.body.invoice.status, 'draft');

  // Key-field parity: same batch number format, same net arithmetic.
  assert.match(contractRun.body.settlement.batchNo, /^S\d{8}$/, 'contract batchNo format');
  assert.match(legacyRun.body.settlement.batchNo, /^S\d{8}$/, 'legacy batchNo format');
  assert.equal(contractRun.body.settlement.net, legacyRun.body.settlement.net, 'same net for one order of the same value');
  assert.equal(contractRun.body.settlement.gross, legacyRun.body.settlement.gross);

  // Contract body shape {date} is also accepted.
  const dated = new Date(dayA);
  const dateStr = `${dated.getFullYear()}-${String(dated.getMonth() + 1).padStart(2, '0')}-${String(dated.getDate()).padStart(2, '0')}`;
  const datedRun = await call('POST', '/finance/settlements/run', { body: { date: dateStr, reason: 'drift test' }, idem: 'dr-run-date' });
  assert.equal(datedRun.status, 409, 'already settled for that date');
  assert.equal(datedRun.body.error.code, 'ALREADY_SETTLED');

  // 409 parity: re-run the same period on both paths.
  const againContract = await call('POST', '/finance/settlements/run', { body: { periodStart: dayA }, idem: 'dr-run-contract-2' });
  assert.equal(againContract.status, 409);
  assert.equal(againContract.body.error.code, 'ALREADY_SETTLED');
  const againLegacy = await call('POST', '/api/settlements/run', { body: { periodStart: dayB }, idem: 'dr-run-legacy-2' });
  assert.equal(againLegacy.status, 409);
  assert.equal(againLegacy.body.error.code, 'ALREADY_SETTLED');

  // Empty period → NOTHING_TO_SETTLE on both paths.
  const emptyContract = await call('POST', '/finance/settlements/run', { body: { periodStart: futureDay(9) }, idem: 'dr-run-empty' });
  assert.equal(emptyContract.status, 409);
  assert.equal(emptyContract.body.error.code, 'NOTHING_TO_SETTLE');
  const emptyLegacy = await call('POST', '/api/settlements/run', { body: { periodStart: futureDay(10) }, idem: 'dr-run-empty-2' });
  assert.equal(emptyLegacy.status, 409);
  assert.equal(emptyLegacy.body.error.code, 'NOTHING_TO_SETTLE');
});

/* ============ POST /finance/settlements/{settlementId}/payout (legacy /api/settlements/:id/payout) ============ */

test('settlements/payout: contract path matches legacy payout (success + already-paid + perm parity)', async () => {
  // Permission parity first: staff without finance:view is rejected on both paths
  // (403 before the rate limit is consumed).
  const denied = await call('POST', '/finance/settlements/set_000001/payout', { body: {}, auth: false });
  assert.equal(denied.status, 401, 'no session');
  const noPermContract = await fetch(`${base}/api/finance/settlements/set_000001/payout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken ?? ''}` },
  });
  assert.equal(noPermContract.status, 403);
  const noPermLegacy = await fetch(`${base}/api/settlements/set_000001/payout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken ?? ''}` },
  });
  assert.equal(noPermLegacy.status, 403);

  const dayA = futureDay(0);
  const dayB = futureDay(1);
  const settleA = db.table('settlements').where((s: any) => s.periodStart === dayA)[0];
  const settleB = db.table('settlements').where((s: any) => s.periodStart === dayB)[0];
  assert.ok(settleA && settleB, 'both periods settled by the run test above');

  // Rate budget is 3 per 10 min per merchant — spend it exactly on the parity checks.
  const paidContract = await call('POST', `/finance/settlements/${settleA.id}/payout`, { body: {}, idem: 'dr-pay-a' });
  assert.equal(paidContract.status, 200);
  assert.equal(paidContract.body.payout, 'paid');

  const paidLegacy = await call('POST', `/api/settlements/${settleB.id}/payout`, { body: {}, idem: 'dr-pay-b' });
  assert.equal(paidLegacy.status, 200);
  assert.equal(paidLegacy.body.payout, 'paid');

  assert.equal(paidContract.body.settlement.id, settleA.id);
  assert.equal(paidLegacy.body.settlement.id, settleB.id);
  assert.equal(paidContract.body.settlement.payoutStatus, 'paid');
  assert.equal(paidLegacy.body.settlement.payoutStatus, 'paid');
  assert.equal(paidContract.body.settlement.net, paidLegacy.body.settlement.net, 'same net');

  const replay = await call('POST', `/finance/settlements/${settleA.id}/payout`, { body: {}, idem: 'dr-pay-a-2' });
  assert.equal(replay.status, 409, 'double payout is blocked (EARNINGS.md SETTLEMENT_ALREADY_PAID)');
  assert.equal(replay.body.error.code, 'SETTLEMENT_ALREADY_PAID');
});

/* ============ GET /finance/invoices (contract list) + POST /finance/invoices/{id}/issue ============ */

test('invoices: contract list is an Invoice array; issue parity with legacy /api/invoices/:id/issue', async () => {
  // Contract list (already at contract path; app hydrateInvoices consumes it).
  const list = await call('GET', '/finance/invoices');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body), 'bare array per contract');
  for (const inv of list.body) {
    assert.equal(typeof inv.id, 'string');
    assert.equal(typeof inv.number, 'string');
    assert.ok(Number.isInteger(inv.amountTZS), 'amountTZS integer');
    assert.equal(typeof inv.status, 'string');
    assert.equal(typeof inv.createdAt, 'number');
    assert.equal(inv.merchantId, undefined, 'merchant scoping field not leaked');
  }

  // Legacy settlement invoices (mock-only list) — issue parity on draft rows.
  const legacy = await call('GET', '/api/invoices');
  assert.equal(legacy.status, 200);
  const drafts = legacy.body.invoices.filter((i: any) => i.status === 'draft');
  assert.ok(drafts.length >= 2, 'two draft settlement invoices available');
  const [a, b] = drafts;

  const issuedContract = await call('POST', `/finance/invoices/${a.id}/issue`, { body: {}, idem: 'dr-inv-issue-a' });
  assert.equal(issuedContract.status, 200);
  const issuedLegacy = await call('POST', `/api/invoices/${b.id}/issue`, { body: {}, idem: 'dr-inv-issue-b' });
  assert.equal(issuedLegacy.status, 200);

  assert.equal(issuedContract.body.invoice.id, a.id);
  assert.equal(issuedLegacy.body.invoice.id, b.id);
  assert.equal(issuedContract.body.invoice.status, 'issued');
  assert.equal(issuedLegacy.body.invoice.status, 'issued');
  assert.equal(typeof issuedContract.body.invoice.no, 'string');
  assert.equal(issuedContract.body.invoice.no, a.no, 'same row, same number');

  // Replay: both paths stay 200 and idempotent.
  const replayContract = await call('POST', `/finance/invoices/${a.id}/issue`, { body: {}, idem: 'dr-inv-issue-a-2' });
  assert.equal(replayContract.status, 200);
  assert.equal(replayContract.body.invoice.status, 'issued');
  const replayLegacy = await call('POST', `/api/invoices/${b.id}/issue`, { body: {}, idem: 'dr-inv-issue-b-2' });
  assert.equal(replayLegacy.status, 200);
  assert.equal(replayLegacy.body.invoice.status, 'issued');

  // 404 parity.
  const missingContract = await call('POST', '/finance/invoices/inv_missing/issue', { body: {}, idem: 'dr-inv-miss-a' });
  assert.equal(missingContract.status, 404);
  const missingLegacy = await call('POST', '/api/invoices/inv_missing/issue', { body: {}, idem: 'dr-inv-miss-b' });
  assert.equal(missingLegacy.status, 404);
});

test('invoices: contract issue serves requested e-invoices (requested → issued)', async () => {
  const created = await call('POST', '/finance/invoices', { body: { amountTZS: 75000 }, idem: 'dr-inv-create' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'requested');

  const issued = await call('POST', `/finance/invoices/${created.body.id}/issue`, { body: {}, idem: 'dr-inv-issue-finv' });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.invoice.id, created.body.id);
  assert.equal(issued.body.invoice.status, 'issued');

  const unauth = await call('POST', '/finance/invoices/inv_missing/issue', { auth: false, body: {} });
  assert.equal(unauth.status, 401);
});

/* ============ GET /payments/methods (contract-only; no app call today) ============ */

test('payments/methods: contract shape {method, available} for all eight methods; auth required', async () => {
  const res = await call('GET', '/payments/methods');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'array per contract');
  const methods = res.body.map((m: any) => m.method);
  for (const expected of ['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel', 'card', 'cod', 'bank']) {
    assert.ok(methods.includes(expected), `method ${expected} present`);
  }
  for (const m of res.body) {
    assert.equal(typeof m.method, 'string');
    assert.equal(typeof m.available, 'boolean');
  }
  assert.equal(res.body.length, 8, 'exactly the eight contract methods');

  const unauth = await call('GET', '/payments/methods', { auth: false });
  assert.equal(unauth.status, 401);
});
