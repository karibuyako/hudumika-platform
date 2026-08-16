import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { eventsAfter, latestSeq } from '@/mock/events';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;
let staffToken: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${opts.token !== undefined ? opts.token : token ?? ''}`;
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

/* ================= Earnings pass (gap-09): collection QR (POST /payments/qr) ================= */

test('payments/qr: 201 PaymentQr for fixed + variable; provider/amount validation; 403 for non-finance', async () => {
  const before = latestSeq();
  const fixed = await call('POST', '/payments/qr', { body: { provider: 'mpesa', amountTZS: 5000 }, idem: 'qr-fixed' });
  assert.equal(fixed.status, 201);
  assert.equal(typeof fixed.body.qrPayload, 'string');
  assert.ok(fixed.body.qrPayload.length > 0, 'scannable payload text');
  assert.equal(fixed.body.provider, 'mpesa');
  assert.equal(fixed.body.amountTZS, 5000);
  assert.equal(typeof fixed.body.merchantRef, 'string');
  assert.ok(fixed.body.merchantRef.startsWith('QR'), 'merchantRef links payment to QR');
  assert.ok(fixed.body.expiresAt > Date.now(), 'expiry in the future');

  const events = eventsAfter(before);
  assert.ok(events.some((e) => e.event.type === 'payment.qr_created' && (e.event as any).qr?.id === undefined && (e.event as any).qr?.merchantRef === fixed.body.merchantRef), 'payment.qr_created emitted');

  const variable = await call('POST', '/payments/qr', { body: { provider: 'tigo_pesa', amountTZS: null }, idem: 'qr-var' });
  assert.equal(variable.status, 201);
  assert.equal(variable.body.amountTZS, null, 'null = variable amount');
  assert.equal(variable.body.provider, 'tigo_pesa');

  const badProvider = await call('POST', '/payments/qr', { body: { provider: 'visa' }, idem: 'qr-bad1' });
  assert.equal(badProvider.status, 400);
  assert.equal(badProvider.body.error.code, 'PAYMENT_QR_PROVIDER_UNSUPPORTED');

  const badAmount = await call('POST', '/payments/qr', { body: { provider: 'mpesa', amountTZS: 0 }, idem: 'qr-bad2' });
  assert.equal(badAmount.status, 400);

  const noAuth = await call('POST', '/payments/qr', { auth: false, body: { provider: 'mpesa' } });
  assert.equal(noAuth.status, 401);

  const noPerm = await call('POST', '/payments/qr', { body: { provider: 'mpesa' }, idem: 'qr-403', token: staffToken });
  assert.equal(noPerm.status, 403, 'finance-role gating enforced server-side');
});

/* ================= Earnings pass (gap-09): payments history + reversal ================= */

test('payments/history: contract rows with masked reference, status enum, integer TZS', async () => {
  const res = await call('GET', '/payments/history?limit=50');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'array per contract');
  assert.ok(res.body.length >= 3, 'seeded payment rows present');
  for (const p of res.body) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.method, 'string');
    assert.ok(Number.isInteger(p.amountTZS), 'amountTZS integer');
    assert.ok(['created', 'pending', 'paid', 'failed', 'refunded', 'reversed'].includes(p.status), `status ${p.status}`);
    assert.match(p.reference ?? '', /^\*{4}\S+$/, 'reference masked');
    assert.equal(typeof p.createdAt, 'number');
  }
  const statuses = new Set(res.body.map((p: any) => p.status));
  assert.ok(statuses.has('paid'), 'a paid payment exists');
});

test('payments/reverse: finance role reverses a paid payment (200, intent reversed); 403/404/409/400 paths', async () => {
  const history = await call('GET', '/payments/history?limit=50');
  const paid = history.body.find((p: any) => p.status === 'paid');
  assert.ok(paid, 'a reversible paid payment exists');

  const noReason = await call('POST', `/payments/${paid.id}/reverse`, { body: {}, idem: 'rv-noreason' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'REASON_REQUIRED');

  const missing = await call('POST', '/payments/pay_missing/reverse', { body: { reason: 'gone' }, idem: 'rv-404' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PAYMENT_NOT_FOUND');

  const noPerm = await call('POST', `/payments/${paid.id}/reverse`, { body: { reason: 'no perm' }, idem: 'rv-403', token: staffToken });
  assert.equal(noPerm.status, 403, 'reversal is finance-role only');

  const before = latestSeq();
  const reversed = await call('POST', `/payments/${paid.id}/reverse`, { body: { reason: 'Charged twice by mistake' }, idem: 'rv-ok' });
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.id, paid.id);
  assert.equal(reversed.body.status, 'reversed');
  assert.equal(reversed.body.amountTZS, paid.amountTZS);
  assert.equal(reversed.body.method, paid.method);

  const events = eventsAfter(before);
  assert.ok(events.some((e) => e.event.type === 'payment.reversed' && (e.event as any).item?.id === paid.id), 'payment.reversed emitted');

  const after = await call('GET', '/payments/history?limit=50');
  const row = after.body.find((p: any) => p.id === paid.id);
  assert.equal(row.status, 'reversed', 'history surfaces the reversal');

  const again = await call('POST', `/payments/${paid.id}/reverse`, { body: { reason: 'second try' }, idem: 'rv-dup' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'PAYMENT_ALREADY_REVERSED');
});

/* ================= Earnings pass (gap-09): reconciliation (contract shape) ================= */

test('finance/reconciliation: contract summary + per-day rows (days drift parity)', async () => {
  const res = await call('GET', '/finance/reconciliation?days=7');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.from, 'string');
  assert.match(res.body.from, /^\d{4}-\d{2}-\d{2}$/, 'from is a YYYY-MM-DD date');
  assert.equal(typeof res.body.to, 'string');
  assert.ok(Number.isInteger(res.body.orderTotalTZS), 'orderTotalTZS integer');
  assert.ok(Number.isInteger(res.body.paymentTotalTZS), 'paymentTotalTZS integer');
  assert.equal(typeof res.body.matched, 'number');
  assert.equal(typeof res.body.exceptions, 'number');
  assert.equal(res.body.days.length, 7, 'one row per day (legacy drift parity)');
  assert.equal(res.body.matched + res.body.exceptions, 7, 'matched + exceptions = days');
  for (const d of res.body.days) {
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof d.ledgerGross, 'number');
    assert.equal(typeof d.settlementGross, 'number');
    assert.equal(typeof d.diff, 'number');
    assert.equal(typeof d.ok, 'boolean');
  }

  const dated = await call('GET', '/finance/reconciliation?from=2026-01-01&to=2026-01-03');
  assert.equal(dated.status, 200);
  assert.equal(dated.body.from, dated.body.days[0].day);
  assert.equal(dated.body.to, dated.body.days[dated.body.days.length - 1].day);

  const noAuth = await call('GET', '/finance/reconciliation', { auth: false });
  assert.equal(noAuth.status, 401);
});

/* ================= Earnings pass (gap-09): dispute holds ================= */

test('finance/dispute-holds: requested refunds project held amounts (integer TZS)', async () => {
  const res = await call('GET', '/finance/dispute-holds');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.holds));
  assert.ok(res.body.holds.length >= 1, 'seeded requested refund held');
  assert.ok(Number.isInteger(res.body.totalTZS), 'totalTZS integer');
  assert.equal(res.body.totalTZS, res.body.holds.reduce((s: number, h: any) => s + h.amountTZS, 0));
  for (const h of res.body.holds) {
    assert.equal(typeof h.id, 'string');
    assert.equal(typeof h.orderId, 'string');
    assert.ok(Number.isInteger(h.amountTZS), 'amountTZS integer');
    assert.equal(h.status, 'disputed');
    assert.equal(typeof h.disputedAt, 'number');
  }
});

/* ================= Earnings pass (gap-09): wallet commercial cadence ================= */

test('wallet: commissionRateBps + payoutCycleDays served from the API (never client-recomputed)', async () => {
  const res = await call('GET', '/wallet');
  assert.equal(res.status, 200);
  assert.equal(res.body.commissionRateBps, 600, '6% seeded rate as basis points');
  assert.equal(res.body.payoutCycleDays, 3, 'contract default cadence');
  assert.ok(Number.isInteger(res.body.withdrawableTZS));
  assert.ok(Number.isInteger(res.body.totalTZS));
});

/* ================= Earnings pass (gap-09): withdrawal error-code parity ================= */

test('withdrawals: contract codes (WITHDRAWAL_BELOW_MINIMUM / WALLET_INSUFFICIENT_BALANCE / WITHDRAWAL_ALREADY_PROCESSED) + legacy WITHDRAWAL_PENDING alias', async () => {
  const below = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 100 }, idem: 'wd-below' });
  assert.equal(below.status, 400);
  assert.equal(below.body.error.code, 'WITHDRAWAL_BELOW_MINIMUM');

  const tooBig = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 99999999 }, idem: 'wd-big' });
  assert.equal(tooBig.status, 409);
  assert.equal(tooBig.body.error.code, 'WALLET_INSUFFICIENT_BALANCE');
  assert.equal(tooBig.body.error.details?.legacyCode, 'INSUFFICIENT', 'legacy code kept as an alias in details');

  const processed = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 50000 }, idem: 'wd-already' });
  assert.equal(processed.status, 409, 'seeded pending row with the same amount is a duplicate');
  assert.equal(processed.body.error.code, 'WITHDRAWAL_ALREADY_PROCESSED');

  const created = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 5000 }, idem: 'wd-ok' });
  assert.equal(created.status, 201);
  assert.equal(created.body.amountTZS, 5000);

  const inFlight = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 5000 }, idem: 'wd-dup' });
  assert.equal(inFlight.status, 409);
  assert.equal(inFlight.body.error.code, 'WITHDRAWAL_PENDING', 'legacy in-flight alias kept (p6d-gaps parity)');
});

/* ================= Earnings pass (gap-09): settlement.paid / payout.paid / invoice.issued events ================= */

test('events: settlement.paid + payout.paid on payout; invoice.issued on issue', async () => {
  const list = await call('GET', '/finance/settlements/daily');
  assert.equal(list.status, 200);
  const pending = list.body.settlements.find((s: any) => s.payoutStatus === 'pending');
  assert.ok(pending, 'a pending seeded settlement exists');

  const beforePayout = latestSeq();
  const paid = await call('POST', `/finance/settlements/${pending.id}/payout`, { body: {}, idem: 'ev-payout' });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.payout, 'paid');

  const payoutEvents = eventsAfter(beforePayout);
  assert.ok(
    payoutEvents.some((e) => e.event.type === 'settlement.paid' && (e.event as any).settlement?.id === pending.id),
    'settlement.paid emitted for the settlement',
  );
  assert.ok(
    payoutEvents.some((e) => e.event.type === 'payout.paid' && (e.event as any).payout?.id === pending.id),
    'payout.paid emitted for the payout',
  );

  const replay = await call('POST', `/finance/settlements/${pending.id}/payout`, { body: {}, idem: 'ev-payout-2' });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'SETTLEMENT_ALREADY_PAID', 'double payout blocked with the contract code');

  const created = await call('POST', '/finance/invoices', { body: { amountTZS: 100000 }, idem: 'ev-inv' });
  assert.equal(created.status, 201);
  const beforeIssue = latestSeq();
  const issued = await call('POST', `/finance/invoices/${created.body.id}/issue`, { body: {}, idem: 'ev-inv-issue' });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.invoice.status, 'issued');

  const issueEvents = eventsAfter(beforeIssue);
  assert.ok(
    issueEvents.some((e) => e.event.type === 'invoice.issued' && (e.event as any).invoice?.id === created.body.id),
    'invoice.issued emitted on requested → issued',
  );
});
