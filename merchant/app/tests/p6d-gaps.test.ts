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

/* ================= P6d: wallet & withdrawals (contract /wallet*) ================= */

test('wallet: balance and transaction list have integer TZS shapes', async () => {
  const wallet = await call('GET', '/wallet');
  assert.equal(wallet.status, 200);
  assert.ok(Number.isInteger(wallet.body.withdrawableTZS), 'withdrawableTZS integer');
  assert.ok(Number.isInteger(wallet.body.totalTZS), 'totalTZS integer');
  assert.equal(wallet.body.withdrawableTZS + (wallet.body.pendingTZS ?? 0), wallet.body.totalTZS);

  const tx = await call('GET', '/wallet/transactions?limit=50');
  assert.equal(tx.status, 200);
  assert.ok(Array.isArray(tx.body));
  assert.ok(tx.body.length > 0);
  for (const row of tx.body) {
    assert.equal(typeof row.id, 'string');
    assert.ok(Number.isInteger(row.amountTZS), 'amountTZS signed integer');
    assert.ok(Number.isInteger(row.balanceTZS), 'balanceTZS integer');
    assert.equal(typeof row.type, 'string');
    assert.equal(typeof row.createdAt, 'number');
  }
});

test('withdrawals: seeded list shape (pending + paid)', async () => {
  const list = await call('GET', '/wallet/withdrawals');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.length >= 2, 'seeded withdrawal rows present');
  for (const w of list.body) {
    assert.equal(typeof w.id, 'string');
    assert.ok(Number.isInteger(w.amountTZS), 'amountTZS integer');
    assert.ok(['pending', 'processing', 'paid', 'failed', 'exception'].includes(w.status), `status ${w.status}`);
    assert.equal(typeof w.createdAt, 'number');
    assert.equal(w.merchantId, undefined, 'merchant scoping field not leaked');
  }
  const statuses = new Set(list.body.map((w: any) => w.status));
  assert.ok(statuses.has('pending') && statuses.has('paid'), 'both a pending and a paid row exist');
});

test('withdrawal request: integer TZS validation (400), request, pending conflict (409)', async () => {
  const bad1 = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 'abc' }, idem: 'wd-bad1' });
  assert.equal(bad1.status, 400);
  assert.equal(bad1.body.error.code, 'INVALID_AMOUNT');

  const bad2 = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 100.5 }, idem: 'wd-bad2' });
  assert.equal(bad2.status, 400);

  const bad3 = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 0 }, idem: 'wd-bad3' });
  assert.equal(bad3.status, 400);

  const created = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 5000 }, idem: 'wd-ok1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.amountTZS, 5000);
  assert.ok(Number.isInteger(created.body.amountTZS));
  assert.equal(typeof created.body.id, 'string');
  assert.equal(created.body.merchantId, undefined, 'merchant scoping field not leaked');

  const dup = await call('POST', '/wallet/withdrawals', { body: { amountTZS: 5000 }, idem: 'wd-dup' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'WITHDRAWAL_PENDING');

  const list = await call('GET', '/wallet/withdrawals');
  const found = list.body.find((w: any) => w.id === created.body.id);
  assert.ok(found, 'created withdrawal appears in history');
});

/* ================= P6d: device registry (contract /devices) ================= */

test('devices: seeded registry shape and statuses', async () => {
  const list = await call('GET', '/devices');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.length >= 3, 'seeded devices present');
  for (const d of list.body) {
    assert.equal(typeof d.id, 'string');
    assert.ok(['printer', 'pos', 'kitchen_display', 'cashier_terminal'].includes(d.type), `type ${d.type}`);
    assert.ok(typeof d.label === 'string' && d.label.length <= 80);
    assert.ok(['online', 'offline', 'error', 'pairing'].includes(d.status), `status ${d.status}`);
    assert.equal(d.merchantId, undefined, 'merchant scoping field not leaked');
  }
  const types = new Set(list.body.map((d: any) => d.type));
  for (const t of ['pos', 'kitchen_display', 'printer']) {
    assert.ok(types.has(t), `seeded a ${t} device`);
  }
});

test('devices: register (201, pairing), validation 400, duplicate 409', async () => {
  const created = await call('POST', '/devices', { body: { type: 'printer', label: 'Test Thermal 80', purpose: 'receipt', paperSize: '80mm', copies: 2 }, idem: 'dev-ok1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'printer');
  assert.equal(created.body.label, 'Test Thermal 80');
  assert.equal(created.body.status, 'pairing');
  assert.equal(created.body.copies, 2);

  const dup = await call('POST', '/devices', { body: { type: 'printer', label: 'test thermal 80' }, idem: 'dev-dup' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DEVICE_EXISTS');

  const badType = await call('POST', '/devices', { body: { type: 'fax', label: 'Nope' }, idem: 'dev-bad1' });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, 'INVALID_DEVICE_TYPE');

  const noLabel = await call('POST', '/devices', { body: { type: 'pos' }, idem: 'dev-bad2' });
  assert.equal(noLabel.status, 400);
  assert.equal(noLabel.body.error.code, 'LABEL_REQUIRED');

  const badCopies = await call('POST', '/devices', { body: { type: 'pos', label: 'POS 2', copies: 6 }, idem: 'dev-bad3' });
  assert.equal(badCopies.status, 400);
  assert.equal(badCopies.body.error.code, 'INVALID_COPIES');
});

test('devices: update (200), delete (204), stale ref (404)', async () => {
  const updated = await call('PATCH', '/devices/dev_seed_1', { body: { type: 'pos', label: 'Front counter POS 2', purpose: 'receipt' }, idem: 'dev-upd1' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.label, 'Front counter POS 2');

  const missing = await call('PATCH', '/devices/dev_missing', { body: { type: 'pos', label: 'X' }, idem: 'dev-upd2' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'DEVICE_NOT_FOUND');

  const removed = await call('DELETE', '/devices/dev_seed_3');
  assert.equal(removed.status, 204);

  const after = await call('DELETE', '/devices/dev_seed_3');
  assert.equal(after.status, 404);

  const list = await call('GET', '/devices');
  assert.ok(!list.body.some((d: any) => d.id === 'dev_seed_3'), 'unregistered device no longer listed');
});

/* ================= P6d: staff invite / remove (contract /merchants/me/staff) ================= */

test('staff: seeded list includes invited row with contract shape', async () => {
  const list = await call('GET', '/merchants/me/staff');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.length >= 4, 'seeded staff rows present');
  for (const s of list.body) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.phone, 'string');
    assert.ok(['owner', 'manager', 'cashier', 'kitchen', 'waiter'].includes(s.role), `role ${s.role}`);
    assert.ok(['invited', 'active', 'suspended'].includes(s.status), `status ${s.status}`);
    assert.equal(typeof s.createdAt, 'number');
    assert.equal(s.merchantId, undefined, 'merchant scoping field not leaked');
  }
  const invited = list.body.filter((s: any) => s.status === 'invited');
  assert.equal(invited.length, 1, 'exactly one seeded invited row');
  assert.equal(invited[0].role, 'waiter');
});

test('staff: invite → invited status, duplicate phone 409, invalid role 400', async () => {
  const invite = await call('POST', '/merchants/me/staff', { body: { name: 'Baraka Kessy', phone: '+255714141414', role: 'waiter' }, idem: 'st-inv1' });
  assert.equal(invite.status, 201);
  assert.equal(invite.body.status, 'invited');
  assert.equal(invite.body.role, 'waiter');
  assert.equal(invite.body.name, 'Baraka Kessy');
  assert.equal(invite.body.merchantId, undefined);

  const dup = await call('POST', '/merchants/me/staff', { body: { name: 'Copy', phone: '+255714141414', role: 'cashier' }, idem: 'st-inv2' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'STAFF_EXISTS');

  const badPhone = await call('POST', '/merchants/me/staff', { body: { name: 'No Phone', phone: '123', role: 'cashier' }, idem: 'st-inv3' });
  assert.equal(badPhone.status, 400);
  assert.equal(badPhone.body.error.code, 'INVALID_PHONE');

  const badRole = await call('POST', '/merchants/me/staff', { body: { name: 'Rogue', phone: '+255714242424', role: 'admin' }, idem: 'st-inv4' });
  assert.equal(badRole.status, 400);
  assert.equal(badRole.body.error.code, 'INVALID_ROLE');
});

test('staff: role change, status change, last-owner protection, remove lifecycle', async () => {
  const list = await call('GET', '/merchants/me/staff');
  const kai = list.body.find((s: any) => s.role === 'cashier' && s.status === 'active');

  const promote = await call('PATCH', `/merchants/me/staff/${kai.id}`, { body: { role: 'kitchen' }, idem: 'st-up1' });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.role, 'kitchen');

  const suspend = await call('PATCH', `/merchants/me/staff/${kai.id}`, { body: { status: 'suspended' }, idem: 'st-up2' });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.status, 'suspended');

  const owner = list.body.find((s: any) => s.role === 'owner');
  const demoteOwner = await call('PATCH', `/merchants/me/staff/${owner.id}`, { body: { role: 'cashier' }, idem: 'st-up3' });
  assert.equal(demoteOwner.status, 409);
  assert.equal(demoteOwner.body.error.code, 'STAFF_LAST_OWNER');

  const removeOwner = await call('DELETE', `/merchants/me/staff/${owner.id}`);
  assert.equal(removeOwner.status, 409);
  assert.equal(removeOwner.body.error.code, 'STAFF_LAST_OWNER');

  const removed = await call('DELETE', `/merchants/me/staff/${kai.id}`);
  assert.equal(removed.status, 204);

  const after = await call('GET', '/merchants/me/staff');
  assert.ok(!after.body.some((s: any) => s.id === kai.id), 'removed staff no longer listed');

  const stale = await call('PATCH', `/merchants/me/staff/${kai.id}`, { body: { role: 'waiter' }, idem: 'st-up4' });
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'STAFF_NOT_FOUND');
});
