/* Drift-C contract tests — store module. For every drifted path the app now
 * calls (payment accounts, receipt templates, QR codes, compliance recheck,
 * store logs, dine-in tables, device pair/test, closure protection, store
 * update) this asserts the contract path serves the SAME behavior the legacy
 * path serves: same success shape, same error codes (400/404/409/422/204) and
 * auth required. Legacy handlers stay registered and keep their tests
 * (contract.test.ts); these tests pin the contract-path twins.
 *
 * Harness mirrors store-settings.test.ts / contract-aliases.test.ts.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
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
  return ok.body.session?.accessToken ?? ok.body.accessToken;
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  token = await loginAs('+255700000000');
  assert.ok(token, 'owner session token issued');
});

beforeEach(() => {
  token = token;
});

after(() => {
  server.close();
});

/* ================= Payment accounts (contract /store/payment-accounts) ================= */

test('payment accounts: GET /store/payment-accounts mirrors GET /payment-accounts; auth required', async () => {
  const legacy = await call('GET', '/payment-accounts?storeId=s_demo');
  assert.equal(legacy.status, 200);
  const contract = await call('GET', '/store/payment-accounts?storeId=s_demo');
  assert.equal(contract.status, 200);
  assert.ok('accounts' in contract.body, 'same success shape as legacy: {accounts}');
  assert.deepEqual(contract.body.accounts.map((a: any) => a.id), legacy.body.accounts.map((a: any) => a.id), 'same rows as legacy list');
  assert.ok(contract.body.accounts.every((a: any) => a.account === a.accountMasked), 'accounts are masked');

  const crossStore = await call('GET', '/store/payment-accounts?storeId=s_demo_2');
  assert.equal(crossStore.status, 200);
  assert.ok(crossStore.body.accounts.every((a: any) => a.storeId === 's_demo_2'));

  const anon = await call('GET', '/store/payment-accounts', { auth: false });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'UNAUTHORIZED');
});

test('payment accounts: create/verify/delete at /store/payment-accounts match legacy codes', async () => {
  const created = await call('POST', '/store/payment-accounts', {
    body: { storeId: 's_demo', type: 'mobile_money', provider: 'mpesa', name: 'Drift M-Pesa', account: '987654321098' },
  });
  assert.equal(created.status, 200, 'same success shape as legacy POST /payment-accounts');
  assert.equal(created.body.account.name, 'Drift M-Pesa');
  assert.equal(created.body.account.status, 'pending');
  assert.equal(created.body.account.accountMasked, '****1098');
  const id = created.body.account.id;

  const bad = await call('POST', '/store/payment-accounts', {
    body: { storeId: 's_demo', type: 'bank', name: 'Bad', account: '123' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_ACCOUNT');

  const noName = await call('POST', '/store/payment-accounts', { body: { storeId: 's_demo', type: 'bank', name: ' ', account: '1234567890' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'NAME_REQUIRED');

  const unknownStore = await call('POST', '/store/payment-accounts', {
    body: { storeId: 's_nope', type: 'bank', name: 'X', account: '1234567890' },
  });
  assert.equal(unknownStore.status, 404);

  const verified = await call('POST', `/store/payment-accounts/${id}/verify`);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.account.status, 'active', 'verify flips pending → active like the legacy path');
  const again = await call('POST', `/store/payment-accounts/${id}/verify`);
  assert.equal(again.status, 200, 'verifying an active account is idempotent');

  const verifyUnknown = await call('POST', '/store/payment-accounts/nope/verify');
  assert.equal(verifyUnknown.status, 404);

  const deleted = await call('DELETE', `/store/payment-accounts/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true, 'same shape as legacy DELETE (default promotion included)');
  const after = await call('GET', '/store/payment-accounts?storeId=s_demo');
  assert.ok(!after.body.accounts.some((a: any) => a.id === id));

  const delUnknown = await call('DELETE', '/store/payment-accounts/nope');
  assert.equal(delUnknown.status, 404);

  const anon = await call('POST', '/store/payment-accounts', { auth: false, body: { storeId: 's_demo', type: 'bank', name: 'x', account: '1234567890' } });
  assert.equal(anon.status, 401);
});

/* ================= Receipt templates (contract /store/receipt-templates) ================= */

test('receipt templates: contract GET list (contract shape) matches legacy rows; auth required', async () => {
  const legacy = await call('GET', '/receipt-templates?storeId=s_demo');
  assert.equal(legacy.status, 200);
  const contract = await call('GET', '/store/receipt-templates?storeId=s_demo');
  assert.equal(contract.status, 200);
  assert.ok(Array.isArray(contract.body), 'contract path serves the array shape');
  assert.deepEqual(
    contract.body.map((t: any) => t.id).sort(),
    legacy.body.templates.map((t: any) => t.id).sort(),
    'same template ids as the legacy list',
  );
  const rt1 = contract.body.find((t: any) => t.id === 'rt1');
  assert.ok(rt1);
  assert.equal(rt1.isActive, true, 'seeded rt1 is the active default');
  assert.equal(rt1.fields.logo, true, 'contract fields map onto the app toggles');
  assert.ok(typeof rt1.paperSize === 'string' && typeof rt1.copies === 'number');

  const anon = await call('GET', '/store/receipt-templates', { auth: false });
  assert.equal(anon.status, 401);
});

test('receipt templates: contract POST requires name+headerText (422) and creates a contract-shaped row', async () => {
  const noHeader = await call('POST', '/store/receipt-templates', { body: { name: 'No header' } });
  assert.equal(noHeader.status, 422);
  assert.equal(noHeader.body.error.code, 'VALIDATION_FAILED');

  const created = await call('POST', '/store/receipt-templates', { body: { name: 'Drift Template', headerText: 'Skewer House BBQ · Drift', paperSize: '58mm', copies: 2 } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Drift Template');
  assert.equal(created.body.headerText, 'Skewer House BBQ · Drift');
  assert.equal(created.body.paperSize, '58mm');
  assert.equal(created.body.copies, 2);
  assert.equal(created.body.isActive, false, 'new templates start inactive');
  assert.ok(created.body.id);

  const badCopies = await call('POST', '/store/receipt-templates', { body: { name: 'x', headerText: 'y', copies: 9 } });
  assert.equal(badCopies.status, 422);

  const badName = await call('POST', '/store/receipt-templates', { body: { name: '  ', headerText: 'y' } });
  assert.equal(badName.status, 422);

  const list = await call('GET', '/store/receipt-templates?storeId=s_demo');
  assert.ok(list.body.some((t: any) => t.id === created.body.id));

  const anon = await call('POST', '/store/receipt-templates', { auth: false, body: { name: 'x', headerText: 'y' } });
  assert.equal(anon.status, 401);

  db.table('receiptTemplates').remove(created.body.id);
});

test('receipt templates: contract PUT/activate/DELETE at /store/receipt-templates/{templateId} match legacy codes', async () => {
  const created = await call('POST', '/store/receipt-templates', { body: { name: 'Drift Active', headerText: 'Skewer House BBQ · Active' } });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const put = await call('PUT', `/store/receipt-templates/${id}`, { body: { name: 'Drift Active 2', headerText: 'Skewer House BBQ · Active 2', footerText: 'Bye', paperSize: '80mm', copies: 1 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.name, 'Drift Active 2');
  assert.equal(put.body.footerText, 'Bye');
  assert.equal(put.body.isActive, false, 'update never flips the active flag');

  const putUnknown = await call('PUT', '/store/receipt-templates/nope', { body: { name: 'x', headerText: 'y' } });
  assert.equal(putUnknown.status, 404);
  assert.equal(putUnknown.body.error.code, 'RECEIPT_TEMPLATE_NOT_FOUND');

  const activate = await call('POST', `/store/receipt-templates/${id}/activate`);
  assert.equal(activate.status, 200);
  assert.equal(activate.body.isActive, true);
  const list = await call('GET', '/store/receipt-templates?storeId=s_demo');
  assert.equal(list.body.find((t: any) => t.id === 'rt1').isActive, false, 'previous default cleared');
  assert.equal(list.body.find((t: any) => t.id === id).isActive, true);

  const activateUnknown = await call('POST', '/store/receipt-templates/nope/activate');
  assert.equal(activateUnknown.status, 404);

  // restore the seeded default BEFORE deleting — the contract DELETE 409s when
  // the template is still the store's assigned default (TEMPLATE_IN_USE)
  await call('POST', '/store/receipt-templates/rt1/activate');
  const del = await call('DELETE', `/store/receipt-templates/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true, 'contract DELETE keeps the legacy {deleted} shape');
  const after = await call('GET', '/store/receipt-templates?storeId=s_demo');
  assert.ok(!after.body.some((t: any) => t.id === id));

  const delUnknown = await call('DELETE', '/store/receipt-templates/nope');
  assert.equal(delUnknown.status, 404);

  const anon = await call('DELETE', `/store/receipt-templates/${id}`, { auth: false });
  assert.equal(anon.status, 401);
});

/* ================= Store QR codes (contract /store/qr-codes) ================= */

test('store qr-codes: contract list/create/delete serve the pinned P6b behavior; auth required', async () => {
  const list = await call('GET', '/store/qr-codes');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body[0].id, 'sq_seed_2', 'newest first');
  assert.ok(list.body.some((q: any) => q.kind === 'ordering'), 'seeded ordering QR backs the store-QR card');

  const created = await call('POST', '/store/qr-codes', { body: { kind: 'download' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, 'download');
  assert.match(created.body.qrPayload, /^https:\/\/hudumika\.app\/qr\//);

  const bad = await call('POST', '/store/qr-codes', { body: { kind: 'poster' } });
  assert.equal(bad.status, 422);

  const del = await call('DELETE', `/store/qr-codes/${created.body.id}`);
  assert.equal(del.status, 204, 'contract DELETE answers 204');
  const after = await call('GET', '/store/qr-codes');
  assert.ok(!after.body.some((q: any) => q.id === created.body.id));

  const miss = await call('DELETE', '/store/qr-codes/does-not-exist');
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error.code, 'STORE_QR_NOT_FOUND');

  const anon = await call('GET', '/store/qr-codes', { auth: false });
  assert.equal(anon.status, 401);
});

/* ================= Compliance recheck (contract POST /store/compliance/recheck) ================= */

test('compliance: POST /store/compliance/recheck mirrors the legacy recheck result; auth required', async () => {
  const legacy = await call('POST', '/stores/s_demo/compliance/recheck');
  assert.equal(legacy.status, 200);
  const contract = await call('POST', '/store/compliance/recheck?storeId=s_demo');
  assert.equal(contract.status, 200);
  const { updatedAt: _lu, ...legacyShape } = legacy.body.compliance;
  const { updatedAt: _cu, ...contractShape } = contract.body.compliance;
  assert.deepEqual(contractShape, legacyShape, 'identical compliance payload on both paths (updatedAt is a fresh timestamp)');
  assert.ok(contract.body.compliance.checks.some((c: any) => c.key === 'payment-account'));

  const otherLegacy = await call('POST', '/stores/s_demo_2/compliance/recheck');
  assert.equal(otherLegacy.status, 200);
  const other = await call('POST', '/store/compliance/recheck?storeId=s_demo_2');
  assert.equal(other.status, 200);
  const { updatedAt: _ou, ...otherLegacyShape } = otherLegacy.body.compliance;
  const { updatedAt: _vu, ...otherContractShape } = other.body.compliance;
  assert.deepEqual(otherContractShape, otherLegacyShape, 'storeId query scopes the recheck to the same store as the legacy path');

  const anon = await call('POST', '/store/compliance/recheck', { auth: false });
  assert.equal(anon.status, 401);
});

/* ================= Store logs (contract GET /store/logs) ================= */

test('logs: GET /store/logs mirrors GET /stores/{id}/logs; auth required', async () => {
  await call('POST', '/store/compliance/recheck?storeId=s_demo');
  const legacy = await call('GET', '/stores/s_demo/logs');
  assert.equal(legacy.status, 200);
  const contract = await call('GET', '/store/logs?storeId=s_demo');
  assert.equal(contract.status, 200);
  assert.ok('logs' in contract.body, 'same {logs} success shape as the legacy path');
  assert.ok(Array.isArray(contract.body.logs));
  assert.deepEqual(contract.body.logs.map((l: any) => l.id), legacy.body.logs.map((l: any) => l.id), 'same log rows');
  assert.ok(contract.body.logs.some((l: any) => l.action === 'compliance:recheck'), 'recheck was recorded');

  const other = await call('GET', '/store/logs?storeId=s_demo_2');
  assert.equal(other.status, 200);
  assert.ok(other.body.logs.every((l: any) => l.storeId === 's_demo_2'), 'storeId query scopes the log list');

  const anon = await call('GET', '/store/logs', { auth: false });
  assert.equal(anon.status, 401);
});

/* ================= Dine-in tables (contract /dine-in/tables) ================= */

test('tables: GET /dine-in/tables mirrors GET /tables; auth required', async () => {
  const legacy = await call('GET', '/tables?storeId=s_demo');
  assert.equal(legacy.status, 200);
  const contract = await call('GET', '/dine-in/tables?storeId=s_demo');
  assert.equal(contract.status, 200);
  assert.deepEqual(contract.body.tables.map((t: any) => t.id), legacy.body.tables.map((t: any) => t.id), 'same rows as the legacy list');

  const anon = await call('GET', '/dine-in/tables', { auth: false });
  assert.equal(anon.status, 401);
});

test('tables: POST/PATCH/DELETE at /dine-in/tables match legacy shapes and error codes', async () => {
  const created = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', name: 'Drift D1', zone: 'Patio', capacity: 6 } });
  assert.equal(created.status, 200, 'same success shape as legacy POST /tables');
  assert.equal(created.body.table.name, 'Drift D1');
  assert.equal(created.body.table.label, 'Drift D1', 'contract label alias emitted (DI-02)');
  assert.equal(created.body.table.capacity, 6);
  assert.equal(created.body.table.status, 'idle');
  assert.equal(created.body.table.active, true, 'contract active alias emitted (DI-02)');
  assert.match(created.body.table.qrUrl, /^https:\/\/order\.example\.com\/q\//);
  const id = created.body.table.id;

  const bad = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', name: 'Bad', capacity: 0 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_TABLE');

  const patched = await call('PATCH', `/dine-in/tables/${id}`, { body: { name: 'Drift D1 Updated', zone: 'Garden' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.table.name, 'Drift D1 Updated');
  assert.equal(patched.body.table.label, 'Drift D1 Updated', 'label follows the name');
  assert.equal(patched.body.table.zone, 'Garden');

  /* DI-02: occupancy can no longer be fabricated via PATCH — table status is
   * derived from the open bill, so any status patch is a 409 conflict. */
  const statusPatch = await call('PATCH', `/dine-in/tables/${id}`, { body: { status: 'reserved' } });
  assert.equal(statusPatch.status, 409);
  assert.equal(statusPatch.body.error.code, 'DINE_IN_TABLE_IN_USE');
  const badStatus = await call('PATCH', `/dine-in/tables/${id}`, { body: { status: 'floating' } });
  assert.equal(badStatus.status, 409, 'any status patch is rejected');

  const patchUnknown = await call('PATCH', '/dine-in/tables/nope', { body: { name: 'x' } });
  assert.equal(patchUnknown.status, 404);

  const del = await call('DELETE', `/dine-in/tables/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  const after = await call('GET', '/dine-in/tables?storeId=s_demo');
  assert.ok(!after.body.tables.some((t: any) => t.id === id));

  const delUnknown = await call('DELETE', '/dine-in/tables/nope');
  assert.equal(delUnknown.status, 404);

  const anon = await call('POST', '/dine-in/tables', { auth: false, body: { storeId: 's_demo', name: 'x', capacity: 2 } });
  assert.equal(anon.status, 401);
});

/* ================= Devices (contract POST /devices/{deviceId}/pair|test) ================= */

test('devices: pair + test at contract paths mirror printer connect/test (incl. 409 offline, 404)', async () => {
  const offlineTest = await call('POST', '/devices/pr2/test');
  assert.equal(offlineTest.status, 409, 'offline printer test fails like the legacy path');
  assert.equal(offlineTest.body.error.code, 'PRINTER_OFFLINE');

  const paired = await call('POST', '/devices/pr2/pair');
  assert.equal(paired.status, 200, 'pairing an offline printer connects it (legacy connect behavior)');
  assert.equal(paired.body.printer.id, 'pr2');
  assert.equal(paired.body.printer.status, 'connected');

  const again = await call('POST', '/devices/pr2/pair');
  assert.equal(again.status, 200, 'pairing an already-connected device is idempotent');

  const tested = await call('POST', '/devices/pr1/test');
  assert.equal(tested.status, 200);
  assert.equal(tested.body.printed, true, 'same success shape as the legacy test print');
  assert.ok(tested.body.jobId);

  const missingPair = await call('POST', '/devices/nope/pair');
  assert.equal(missingPair.status, 404);
  const missingTest = await call('POST', '/devices/nope/test');
  assert.equal(missingTest.status, 404);

  const anon = await call('POST', '/devices/pr1/pair', { auth: false });
  assert.equal(anon.status, 401);
  const anonTest = await call('POST', '/devices/pr1/test', { auth: false });
  assert.equal(anonTest.status, 401);

  db.table('printers').update('pr2', { status: 'offline' });
});

/* ================= Closure protection (contract POST /merchants/me/closure-protection) ================= */

test('closure: POST /merchants/me/closure-protection applies (active:true) and cancels (active:false) like legacy', async () => {
  const now = Date.now();
  const noReason = await call('POST', `/merchants/me/closure-protection?storeId=s_demo`, {
    body: { active: true, from: now + 3600000, to: now + 2 * 3600000 },
  });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'REASON_REQUIRED');

  const apply = await call('POST', `/merchants/me/closure-protection?storeId=s_demo`, {
    body: { active: true, reason: 'Drift maintenance', from: now + 3600000, to: now + 2 * 3600000 },
  });
  assert.equal(apply.status, 200, 'same success shape as legacy POST /closure/apply');
  assert.equal(apply.body.protection.status, 'active');
  assert.equal(apply.body.protection.reason, 'Drift maintenance');
  assert.equal(apply.body.protection.storeId, 's_demo');

  const store = db.table('stores').find('s_demo');
  assert.equal(store?.open, false, 'applying closes the store like the legacy path');

  const overlap = await call('POST', `/merchants/me/closure-protection?storeId=s_demo`, {
    body: { active: true, reason: 'Second window', from: now + 3600000, to: now + 2 * 3600000 },
  });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error.code, 'PROTECTION_ACTIVE');

  const cancel = await call('POST', `/merchants/me/closure-protection?storeId=s_demo`, {
    body: { active: false, reason: 'Done early' },
  });
  assert.equal(cancel.status, 200, 'same success shape as legacy POST /closure/cancel');
  assert.equal(cancel.body.cancelled, true);

  const cancelAgain = await call('POST', `/merchants/me/closure-protection?storeId=s_demo`, { body: { active: false, reason: 'x' } });
  assert.equal(cancelAgain.status, 404, 'no active protection → 404 like the legacy cancel');

  const anon = await call('POST', '/merchants/me/closure-protection', { auth: false, body: { active: true, reason: 'x' } });
  assert.equal(anon.status, 401);

  db.table('stores').update('s_demo', { open: true });
});

/* ================= Store update (contract PATCH /merchants/me) ================= */

test('store update: PATCH /merchants/me mirrors the legacy PATCH /store settings update', async () => {
  const legacy = await call('PATCH', '/store', { body: { announcement: 'Legacy announcement' } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.store.announcement, 'Legacy announcement');

  const contract = await call('PATCH', '/merchants/me', { body: { announcement: 'Contract announcement' } });
  assert.equal(contract.status, 200, 'same success shape as legacy: {store}');
  assert.equal(contract.body.store.announcement, 'Contract announcement');

  const readBack = await call('GET', '/merchants/me/settings');
  assert.equal(readBack.status, 200);

  const nested = await call('PATCH', '/merchants/me', { body: { orderSettings: { autoAccept: true } } });
  assert.equal(nested.status, 200);
  assert.equal(nested.body.store.orderSettings.autoAccept, true, 'nested objects merge with existing settings');

  const anon = await call('PATCH', '/merchants/me', { auth: false, body: { announcement: 'x' } });
  assert.equal(anon.status, 401);

  await call('PATCH', '/store', { body: { announcement: '' } });
  await call('PATCH', '/store', { body: { orderSettings: { autoAccept: false } } });
});
