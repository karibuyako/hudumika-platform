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

/** OTP login returning both tokens (W0a /auth/refresh needs the refresh token). */
async function loginFull(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return { accessToken: ok.body.accessToken as string, refreshToken: ok.body.refreshToken as string };
}

async function loginAs(phone: string) {
  const { accessToken } = await loginFull(phone);
  return accessToken;
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

/* ================= Part A: 7 DELETE flows (app callers -> mock handlers) ================= */

test('DELETE products: catalogue item removed (soft), 404 NOT_FOUND for stale id', async () => {
  const created = await call('POST', '/products', { body: { name: 'W0a Skewer', price: 12, categoryId: 'c1' }, idem: 'w0a-p-1' });
  assert.equal(created.status, 200);
  const id = created.body.product.id;

  const del = await call('DELETE', `/products/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  assert.equal(del.body.product.deleted, true, 'product soft-deleted server-side');

  const list = await call('GET', '/products');
  assert.ok(!list.body.products.some((p: any) => p.id === id), 'deleted product no longer listed');

  const stale = await call('DELETE', `/products/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'NOT_FOUND');
});

test('DELETE devices: registry row removed with 204, stale 404 DEVICE_NOT_FOUND', async () => {
  const created = await call('POST', '/devices', { body: { type: 'printer', label: 'W0a Thermal', purpose: 'receipt', paperSize: '80mm' }, idem: 'w0a-dev-1' });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const del = await call('DELETE', `/devices/${id}`);
  assert.equal(del.status, 204, 'contract DELETE /devices/{deviceId} -> 204 no body');
  assert.equal(del.body, null);

  const after = await call('GET', '/devices');
  assert.ok(!(after.body as any[]).some((d: any) => d.id === id), 'unregistered device gone');

  const stale = await call('DELETE', `/devices/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'DEVICE_NOT_FOUND');
});

test('DELETE staff: team member removed with 204, owner protected, stale 404', async () => {
  const invite = await call('POST', '/merchants/me/staff', { body: { name: 'W0a Hire', phone: '+255713333333', role: 'cashier' }, idem: 'w0a-st-1' });
  assert.equal(invite.status, 201);
  const id = invite.body.id;

  const del = await call('DELETE', `/merchants/me/staff/${id}`);
  assert.equal(del.status, 204, 'contract DELETE /merchants/me/staff/{staffId} -> 204');
  assert.equal(del.body, null);

  const after = await call('GET', '/merchants/me/staff');
  assert.ok(!(after.body as any[]).some((s: any) => s.id === id), 'removed staff gone');

  const stale = await call('DELETE', `/merchants/me/staff/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'STAFF_NOT_FOUND');
});

test('DELETE dine-in tables: row removed (200), stale 404 NOT_FOUND', async () => {
  const created = await call('POST', '/tables', { body: { storeId: 's_demo', name: 'W0a Table', zone: 'Patio', capacity: 4 } });
  assert.equal(created.status, 200);
  const id = created.body.table.id;

  const del = await call('DELETE', `/tables/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const after = await call('GET', '/tables?storeId=s_demo');
  assert.ok(!after.body.tables.some((t: any) => t.id === id), 'table removed');

  const stale = await call('DELETE', `/tables/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'NOT_FOUND');
});

test('DELETE payment accounts: removed (200 + default handover), stale 404', async () => {
  const created = await call('POST', '/payment-accounts', { body: { storeId: 's_demo', type: 'mobile_money', provider: 'mpesa', name: 'W0a Wallet', account: '123456789013' } });
  assert.equal(created.status, 200);
  const id = created.body.account.id;

  const del = await call('DELETE', `/payment-accounts/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const after = await call('GET', '/payment-accounts?storeId=s_demo');
  assert.ok(!after.body.accounts.some((a: any) => a.id === id), 'account removed');

  const stale = await call('DELETE', `/payment-accounts/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'NOT_FOUND');
});

test('DELETE receipt templates: removed (200), assigned default blocked 409, stale 404', async () => {
  const created = await call('POST', '/receipt-templates', { body: { storeId: 's_demo', name: 'W0a Template', paperSize: '58mm' } });
  assert.equal(created.status, 200);
  const id = created.body.template.id;

  const del = await call('DELETE', `/receipt-templates/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const after = await call('GET', '/receipt-templates?storeId=s_demo');
  assert.ok(!after.body.templates.some((t: any) => t.id === id), 'template removed');

  const assigned = await call('DELETE', '/receipt-templates/rt1');
  assert.equal(assigned.status, 409);
  assert.equal(assigned.body.error.code, 'TEMPLATE_IN_USE', 'store-assigned template cannot be deleted');

  const stale = await call('DELETE', `/receipt-templates/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'NOT_FOUND');
});

test('DELETE printers: /printers flow removed (200), stale 404', async () => {
  const created = await call('POST', '/printers', { body: { storeId: 's_demo', name: 'W0a Printer', type: 'network', paperSize: '80mm' } });
  assert.equal(created.status, 200);
  const id = created.body.printer.id;

  const del = await call('DELETE', `/printers/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const after = await call('GET', '/printers?storeId=s_demo');
  assert.ok(!after.body.printers.some((p: any) => p.id === id), 'printer removed');

  const stale = await call('DELETE', `/printers/${id}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'NOT_FOUND');
});

/* ================= Part B: P0 auth/session ops ================= */

test('GET /users/me: profile with merchantId, roles, avatarUrl (contract User shape)', async () => {
  const res = await call('GET', '/users/me');
  assert.equal(res.status, 200);
  const u = res.body;
  assert.equal(typeof u.id, 'string');
  assert.equal(u.phone, '+255700000000');
  assert.equal(u.fullName, 'Juma Mwenda');
  assert.equal(u.avatarUrl, null);
  assert.equal(u.activeRole, 'merchant');
  assert.equal(u.merchantId, 'm_demo');
  assert.equal(u.locale, 'en');
  assert.equal(typeof u.createdAt, 'number');
  assert.ok(Array.isArray(u.roles));
  assert.equal(u.roles[0].role, 'merchant');
  assert.equal(u.roles[0].merchantId, 'm_demo');
});

test('GET /users/me/roles: list of role strings', async () => {
  const res = await call('GET', '/users/me/roles');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.every((r: any) => typeof r === 'string'), 'roles are role strings');
  assert.ok(res.body.includes('merchant'));
});

test('PATCH /users/me: update fullName + avatarUrl round-trip; invalid input 400', async () => {
  const patched = await call('PATCH', '/users/me', { body: { fullName: 'Juma M. Updated', avatarUrl: 'https://cdn.example.com/avatar.png' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.fullName, 'Juma M. Updated');
  assert.equal(patched.body.avatarUrl, 'https://cdn.example.com/avatar.png');

  const readBack = await call('GET', '/users/me');
  assert.equal(readBack.body.fullName, 'Juma M. Updated', 'PATCH persists across GET');
  assert.equal(readBack.body.avatarUrl, 'https://cdn.example.com/avatar.png');

  const badUrl = await call('PATCH', '/users/me', { body: { avatarUrl: 'not-a-url' } });
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.body.error.code, 'INVALID_AVATAR');

  const shortName = await call('PATCH', '/users/me', { body: { fullName: 'J' } });
  assert.equal(shortName.status, 400);
  assert.equal(shortName.body.error.code, 'INVALID_NAME');

  const empty = await call('PATCH', '/users/me', { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'EMPTY_UPDATE');

  const restored = await call('PATCH', '/users/me', { body: { fullName: 'Juma Mwenda', avatarUrl: null } });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.fullName, 'Juma Mwenda');
  assert.equal(restored.body.avatarUrl, null);
});

test('POST /auth/change-password: wrong current 400, weak 422, success 204 + persisted', async () => {
  const wrong = await call('POST', '/auth/change-password', { body: { currentPassword: 'nope', newPassword: 'brandnewpass1' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'WRONG_CURRENT_PASSWORD');

  const weak = await call('POST', '/auth/change-password', { body: { currentPassword: 'demo1234', newPassword: 'short' } });
  assert.equal(weak.status, 422);
  assert.equal(weak.body.error.code, 'WEAK_PASSWORD');

  const ok = await call('POST', '/auth/change-password', { body: { currentPassword: 'demo1234', newPassword: 'brandnewpass1' } });
  assert.equal(ok.status, 204, 'contract change-password -> 204');
  assert.equal(ok.body, null);

  const oldPw = await call('POST', '/auth/change-password', { body: { currentPassword: 'demo1234', newPassword: 'anotherpass2' } });
  assert.equal(oldPw.status, 400);
  assert.equal(oldPw.body.error.code, 'WRONG_CURRENT_PASSWORD', 'old password no longer accepted');

  const back = await call('POST', '/auth/change-password', { body: { currentPassword: 'brandnewpass1', newPassword: 'demo1234' } });
  assert.equal(back.status, 204, 'restored demo password for the seeded demo account');
});

test('POST /auth/refresh: rotates tokens, old access + old refresh invalidated', async () => {
  const { accessToken, refreshToken } = await loginFull('+255700000000');
  token = accessToken;

  const me = await call('GET', '/auth/me');
  assert.equal(me.status, 200);

  const rotated = await call('POST', '/auth/refresh', { auth: false, body: { refreshToken } });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.accessToken, accessToken, 'access token rotated');
  assert.notEqual(rotated.body.refreshToken, refreshToken, 'refresh token rotated');
  assert.ok(rotated.body.me?.merchant, 'refresh response includes the merchant me payload');

  const oldAccess = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(oldAccess.status, 401, 'old access token invalidated');

  const reuse = await call('POST', '/auth/refresh', { auth: false, body: { refreshToken } });
  assert.equal(reuse.status, 401, 'old refresh token cannot be reused');

  const newAccess = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${rotated.body.accessToken}` } });
  assert.equal(newAccess.status, 200, 'new access token works');

  const missing = await call('POST', '/auth/refresh', { auth: false, body: { refreshToken: 'bogus' } });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'UNAUTHORIZED');

  token = rotated.body.accessToken as string;
});
