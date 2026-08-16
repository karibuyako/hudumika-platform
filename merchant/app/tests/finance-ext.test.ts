import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

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

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  token = await loginAs('+255700000000');
});

after(() => {
  server.close();
});

/* ================= P5: payouts (contract GET /payouts/me) ================= */

test('payouts/me: array of PayoutSummary with integer TZS and status enum', async () => {
  const res = await call('GET', '/payouts/me');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'array response');
  assert.ok(res.body.length >= 2, 'seeded payout rows present (withdrawals feed the history)');
  for (const p of res.body) {
    assert.equal(typeof p.id, 'string');
    assert.ok(Number.isInteger(p.amountTZS), 'amountTZS integer');
    assert.ok(['pending', 'processing', 'paid', 'failed', 'exception'].includes(p.status), `status ${p.status}`);
    assert.equal(typeof p.method, 'string');
    assert.equal(typeof p.createdAt, 'number');
    assert.ok(p.paidAt === null || typeof p.paidAt === 'number');
    assert.equal(p.merchantId, undefined, 'merchant scoping field not leaked');
  }
  const statuses = new Set(res.body.map((p: any) => p.status));
  assert.ok(statuses.has('pending') && statuses.has('paid'), 'both a pending and a paid payout exist');
});

test('payouts/me: respects limit and cursor pagination', async () => {
  const first = await call('GET', '/payouts/me?limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.length, 1);
  const rest = await call('GET', `/payouts/me?limit=1&cursor=${first.body[0].id}`);
  assert.equal(rest.status, 200);
  assert.ok(rest.body.every((p: any) => p.id !== first.body[0].id), 'cursor skips the first row');
});

/* ================= P5: bank cards (contract /finance/bank-cards) ================= */

test('bank-cards: seeded list shape with one default card', async () => {
  const res = await call('GET', '/finance/bank-cards');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1, 'seeded bank card present');
  for (const c of res.body) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.bankName, 'string');
    assert.match(c.last4, /^\d{4}$/, 'last4 is 4 digits');
    assert.equal(typeof c.isDefault, 'boolean');
    assert.equal(typeof c.createdAt, 'number');
    assert.equal(c.merchantId, undefined, 'merchant scoping field not leaked');
  }
  assert.equal(res.body.filter((c: any) => c.isDefault).length, 1, 'exactly one default card');
});

test('bank-cards: add (201, non-default when one exists), duplicate 409, bad input 400', async () => {
  const created = await call('POST', '/finance/bank-cards', { body: { bankName: 'CRDB Bank', last4: '0017', accountHolderName: 'Juma Mwenda' }, idem: 'bc-ok1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.bankName, 'CRDB Bank');
  assert.equal(created.body.last4, '0017');
  assert.equal(created.body.isDefault, false, 'first card keeps default; new cards do not steal it');
  assert.equal(created.body.merchantId, undefined);

  const dup = await call('POST', '/finance/bank-cards', { body: { bankName: 'crdb bank', last4: '0017' }, idem: 'bc-dup' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'BANK_CARD_EXISTS');

  const badLast4 = await call('POST', '/finance/bank-cards', { body: { bankName: 'NMB', last4: '49' }, idem: 'bc-bad1' });
  assert.equal(badLast4.status, 400);
  assert.equal(badLast4.body.error.code, 'INVALID_BANK_CARD');

  const noName = await call('POST', '/finance/bank-cards', { body: { last4: '1234' }, idem: 'bc-bad2' });
  assert.equal(noName.status, 400);

  const list = await call('GET', '/finance/bank-cards');
  assert.ok(list.body.some((c: any) => c.id === created.body.id), 'added card appears in the list');
});

test('bank-cards: set default (204) flips flags; missing card 404', async () => {
  const res = await call('GET', '/finance/bank-cards');
  const secondary = res.body.find((c: any) => !c.isDefault);
  assert.ok(secondary, 'a non-default card exists to promote');

  const set = await call('PUT', `/finance/bank-cards/${secondary.id}/default`);
  assert.equal(set.status, 204);

  const after = await call('GET', '/finance/bank-cards');
  const promoted = after.body.find((c: any) => c.id === secondary.id);
  assert.equal(promoted.isDefault, true, 'promoted card is now default');
  assert.equal(after.body.filter((c: any) => c.isDefault).length, 1, 'still exactly one default');

  const missing = await call('PUT', '/finance/bank-cards/bc_missing/default');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'BANK_CARD_NOT_FOUND');
});

test('bank-cards: delete (204), gone on second delete (404), removed from list', async () => {
  const res = await call('GET', '/finance/bank-cards');
  const target = res.body.find((c: any) => !c.isDefault) ?? res.body[0];

  const removed = await call('DELETE', `/finance/bank-cards/${target.id}`);
  assert.equal(removed.status, 204);

  const again = await call('DELETE', `/finance/bank-cards/${target.id}`);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'BANK_CARD_NOT_FOUND');

  const list = await call('GET', '/finance/bank-cards');
  assert.ok(!list.body.some((c: any) => c.id === target.id), 'deleted card no longer listed');
});

/* ================= P5: expenses (contract /finance/expenses) ================= */

test('expenses: seeded list shape with integer TZS', async () => {
  const res = await call('GET', '/finance/expenses');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1, 'seeded expense present');
  for (const e of res.body) {
    assert.equal(typeof e.id, 'string');
    assert.ok(
      ['ingredients', 'delivery', 'packaging', 'platform_fees', 'rent', 'utilities', 'staff', 'marketing', 'equipment', 'other'].includes(e.category),
      `category ${e.category}`,
    );
    assert.ok(Number.isInteger(e.amountTZS), 'amountTZS integer');
    assert.equal(typeof e.incurredAt, 'number');
    assert.equal(typeof e.createdAt, 'number');
    assert.equal(e.merchantId, undefined, 'merchant scoping field not leaked');
  }
});

test('expenses: add (201), invalid category/amount 400, delete (204 + 404)', async () => {
  const created = await call('POST', '/finance/expenses', { body: { category: 'staff', amountTZS: 120000, note: 'Weekend overtime' }, idem: 'exp-ok1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.category, 'staff');
  assert.equal(created.body.amountTZS, 120000);
  assert.equal(created.body.note, 'Weekend overtime');
  assert.equal(created.body.merchantId, undefined);

  const badCat = await call('POST', '/finance/expenses', { body: { category: 'gambling', amountTZS: 1000 }, idem: 'exp-bad1' });
  assert.equal(badCat.status, 400);
  assert.equal(badCat.body.error.code, 'INVALID_CATEGORY');

  const badAmount = await call('POST', '/finance/expenses', { body: { category: 'rent', amountTZS: 500.5 }, idem: 'exp-bad2' });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error.code, 'INVALID_AMOUNT');

  const zero = await call('POST', '/finance/expenses', { body: { category: 'rent', amountTZS: 0 }, idem: 'exp-bad3' });
  assert.equal(zero.status, 400);

  const removed = await call('DELETE', `/finance/expenses/${created.body.id}`);
  assert.equal(removed.status, 204);

  const again = await call('DELETE', `/finance/expenses/${created.body.id}`);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'EXPENSE_NOT_FOUND');

  const list = await call('GET', '/finance/expenses');
  assert.ok(!list.body.some((e: any) => e.id === created.body.id), 'deleted expense no longer listed');
});

test('expenses: from/to window filters by incurredAt', async () => {
  const now = Date.now();
  const made = await call('POST', '/finance/expenses', { body: { category: 'utilities', amountTZS: 40000, incurredAt: now }, idem: 'exp-win' });
  assert.equal(made.status, 201);

  const past = await call('GET', `/finance/expenses?from=0&to=${now - 86400000}`);
  assert.equal(past.status, 200);
  assert.ok(!past.body.some((e: any) => e.id === made.body.id), 'fresh expense outside the window');

  const present = await call('GET', `/finance/expenses?from=${now - 60000}&to=${now + 60000}`);
  assert.ok(present.body.some((e: any) => e.id === made.body.id), 'expense inside the window');
});

/* ================= P5: invoices (contract /finance/invoices) ================= */

test('invoices: create (201) returns contract shape; tax computed from taxRateBps', async () => {
  const res = await call('GET', '/finance/invoices');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'contract list is an array');
  assert.equal(res.body.length, 0, 'no contract invoices seeded yet');

  const created = await call('POST', '/finance/invoices', { body: { amountTZS: 500000, kind: 'vat', taxRateBps: 1800, taxId: 'TIN-123-456' }, idem: 'inv-ok1' });
  assert.equal(created.status, 201);
  assert.equal(typeof created.body.id, 'string');
  assert.match(created.body.number, /^INV-\d{8}-\d{4}$/);
  assert.equal(created.body.amountTZS, 500000);
  assert.ok(Number.isInteger(created.body.amountTZS), 'amountTZS integer');
  assert.equal(created.body.kind, 'vat');
  assert.equal(created.body.taxRateBps, 1800);
  assert.equal(created.body.taxAmountTZS, 90000, 'tax = amount * rate / 10000');
  assert.equal(created.body.taxId, 'TIN-123-456');
  assert.equal(created.body.status, 'requested');
  assert.equal(created.body.issuedAt, null);
  assert.equal(created.body.merchantId, undefined, 'merchant scoping field not leaked');

  const standard = await call('POST', '/finance/invoices', { body: { amountTZS: 100000, kind: 'standard' }, idem: 'inv-ok2' });
  assert.equal(standard.status, 201);
  assert.equal(standard.body.kind, 'standard');
  assert.equal(standard.body.taxAmountTZS, null);

  const badAmount = await call('POST', '/finance/invoices', { body: { amountTZS: 0 }, idem: 'inv-bad1' });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error.code, 'INVALID_AMOUNT');

  const list = await call('GET', '/finance/invoices');
  assert.ok(list.body.some((i: any) => i.id === created.body.id), 'created invoice appears in the list');
});

test('invoices: download (200) returns downloadUrl + expiresInSeconds; 404 for missing', async () => {
  const created = await call('POST', '/finance/invoices', { body: { amountTZS: 250000 }, idem: 'inv-dl1' });
  assert.equal(created.status, 201);

  const dl = await call('GET', `/finance/invoices/${created.body.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(typeof dl.body.downloadUrl, 'string');
  assert.ok(dl.body.downloadUrl.startsWith('https://'), 'download URL is absolute');
  assert.ok(Number.isInteger(dl.body.expiresInSeconds));
  assert.equal(dl.body.expiresInSeconds, 900);

  const legacy = await call('GET', '/invoices');
  assert.equal(legacy.status, 200);
  assert.ok(legacy.body.invoices.length > 0, 'seeded legacy invoices exist');
  const dlLegacy = await call('GET', `/finance/invoices/${legacy.body.invoices[0].id}/download`);
  assert.equal(dlLegacy.status, 200, 'legacy settlement invoice is downloadable');
  assert.equal(typeof dlLegacy.body.downloadUrl, 'string');

  const missing = await call('GET', '/finance/invoices/inv_missing/download');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'INVOICE_NOT_FOUND');
});

/* ================= P5: transaction issue (contract POST /finance/transactions/{id}/issue) ================= */

test('transaction issue: 201 ticket, invalid type 400, unknown tx 404, duplicate 409', async () => {
  const tx = await call('GET', '/wallet/transactions?limit=1');
  assert.equal(tx.status, 200);
  const txId = tx.body[0].id;

  const bad = await call('POST', `/finance/transactions/${txId}/issue`, { body: { issueType: 'fraud', description: 'x' }, idem: 'ti-bad1' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_ISSUE_TYPE');

  const noDesc = await call('POST', `/finance/transactions/${txId}/issue`, { body: { issueType: 'other', description: '' }, idem: 'ti-bad2' });
  assert.equal(noDesc.status, 400);
  assert.equal(noDesc.body.error.code, 'DESCRIPTION_REQUIRED');

  const missing = await call('POST', '/finance/transactions/l_missing/issue', { body: { issueType: 'other', description: 'gone' }, idem: 'ti-404' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'TRANSACTION_NOT_FOUND');

  const created = await call('POST', `/finance/transactions/${txId}/issue`, { body: { issueType: 'amount_mismatch', description: 'Charged more than the order total' }, idem: 'ti-ok1' });
  assert.equal(created.status, 201);
  assert.equal(typeof created.body.ticketId, 'string');
  assert.equal(created.body.status, 'open');

  const dup = await call('POST', `/finance/transactions/${txId}/issue`, { body: { issueType: 'other', description: 'second report' }, idem: 'ti-dup' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ISSUE_ALREADY_REPORTED');
});

/* ================= Earnings pass (gap-09): settlement payout 409 parity ================= */

test('settlement payout: double payout returns 409 SETTLEMENT_ALREADY_PAID (contract code)', async () => {
  const list = await call('GET', '/finance/settlements/daily');
  assert.equal(list.status, 200);
  const pending = list.body.settlements.find((s: any) => s.payoutStatus === 'pending');
  assert.ok(pending, 'a pending seeded settlement exists');

  const first = await call('POST', `/finance/settlements/${pending.id}/payout`, { body: {}, idem: 'fp-pay-1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.payout, 'paid');

  const replay = await call('POST', `/finance/settlements/${pending.id}/payout`, { body: {}, idem: 'fp-pay-2' });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'SETTLEMENT_ALREADY_PAID');
});
