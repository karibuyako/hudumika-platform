import './shims';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { runSweeperJobs } from '@/mock/sweeper';
import { createSession } from '@/mock/security';
import { eventsAfter } from '@/mock/events';
import { getRefreshToken, setRefreshToken, setToken } from '@/api/client';
import { useSessionStore, setRefreshTokenPersister } from '@/store/session';

/* P8b security/risk contract tests (STAFF-AND-DEVICES.md, ENTERPRISE-STAFF.md,
 * TASKS-RISK.md, SECURITY.md): the 5-role RBAC matrix (cashier/kitchen/waiter
 * enforcement + suspension), invite → activation on first login, refresh-token
 * rotation + store refresh flow, risk review decisions, sweeper detections
 * (login-risk / unusual-order-pattern), print-failure codes, setup guide. */

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;
let ownerToken: string | null = null;

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

async function loginAs(phone: string): Promise<{ status: number; body: any }> {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok;
}

async function inviteAs(phone: string, role: string, name: string): Promise<void> {
  const res = await call('POST', '/merchants/me/staff', { body: { name, phone, role }, idem: `t-inv-${phone}` });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'invited');
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const ok = await loginAs('+255700000000');
  ownerToken = ok.body.accessToken;
  token = ownerToken;
});

after(() => {
  server.close();
});

/* ================= 1. RBAC matrix (owner/manager/cashier/kitchen/waiter) ================= */

test('rbac: cashier gets the documented matrix + legacy grants; team scope denied with STAFF_ROLE_FORBIDDEN', async () => {
  const ok = await loginAs('+255700000003');
  const kaiToken = ok.body.accessToken;
  token = kaiToken;

  // Cashier scope: redemption works.
  const redemptions = await call('GET', '/redemptions');
  assert.equal(redemptions.status, 200, 'cashier may verify redemptions');

  // Cashier limitation: no team management (403 STAFF_ROLE_FORBIDDEN).
  const shifts = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_3', role: 'cashier', startAt: Date.now() + 86400000, endAt: Date.now() + 86400000 + 3600000 },
    idem: 't-rbac-cashier-shift',
  });
  assert.equal(shifts.status, 403);
  assert.equal(shifts.body.error.code, 'STAFF_ROLE_FORBIDDEN');
  const staffList = await call('GET', '/merchants/me/staff');
  assert.equal(staffList.status, 403);
  assert.equal(staffList.body.error.code, 'STAFF_ROLE_FORBIDDEN');
  const devices = await call('POST', '/devices', { body: { type: 'printer', label: 'Rogue printer' } });
  assert.equal(devices.status, 403);
  assert.equal(devices.body.error.code, 'STAFF_ROLE_FORBIDDEN');

  // Legacy grant stays additive: the seeded staff row still allows accept.
  const accept = await call('POST', '/orders/o_seed_0/accept', { body: { expectedVersion: 1 }, idem: 't-rbac-cashier-accept' });
  assert.equal(accept.status, 200, 'legacy orders:accept grant remains additive for legacy staff rows');

  // /auth/me exposes the merged scopes.
  const me = await call('GET', '/auth/me');
  assert.ok(me.body.me.permissions.includes('redemption'), 'cashier matrix scope present');
  assert.ok(me.body.me.permissions.includes('dine_in:billing'), 'cashier matrix scope present');
  token = null;
});

test('rbac: invited kitchen/waiter enforce the pure matrix (no legacy grants) on orders + redemptions', async () => {
  token = ownerToken;
  await inviteAs('+255714141414', 'kitchen', 'Kitchen K');
  await inviteAs('+255714242424', 'waiter', 'Waiter W');

  const kitchenLogin = await loginAs('+255714141414');
  const kitchenToken = kitchenLogin.body.accessToken;
  token = kitchenToken;
  const kMe = await call('GET', '/auth/me');
  assert.ok(kMe.body.me.permissions.includes('dine_in:prep'), 'kitchen has dine_in:prep');
  assert.ok(!kMe.body.me.permissions.includes('redemption'), 'kitchen has no redemption scope');

  const redeem = await call('GET', '/redemptions');
  assert.equal(redeem.status, 403);
  assert.equal(redeem.body.error.code, 'STAFF_ROLE_FORBIDDEN');
  const accept = await call('POST', '/orders/o_seed_0/accept', { body: { expectedVersion: 1 }, idem: 't-rbac-kitchen-accept' });
  assert.equal(accept.status, 403, 'kitchen cannot accept orders — cashier limitation applies to non-granted roles');
  assert.equal(accept.body.error.code, 'STAFF_ROLE_FORBIDDEN');
  const manage = await call('GET', '/merchants/me/staff');
  assert.equal(manage.status, 403);
  assert.equal(manage.body.error.code, 'STAFF_ROLE_FORBIDDEN');

  const waiterLogin = await loginAs('+255714242424');
  token = waiterLogin.body.accessToken;
  const wMe = await call('GET', '/auth/me');
  assert.ok(wMe.body.me.permissions.includes('orders:view') && wMe.body.me.permissions.includes('dine_in:serve'), 'waiter has view/serve scopes');
  const wRedeem = await call('GET', '/redemptions');
  assert.equal(wRedeem.status, 403);
  assert.equal(wRedeem.body.error.code, 'STAFF_ROLE_FORBIDDEN');
  token = null;
});

test('rbac: suspended staff are blocked at login and on every action (STAFF_SUSPENDED)', async () => {
  token = ownerToken;
  await inviteAs('+255715151515', 'cashier', 'Suspended S');
  const login = await loginAs('+255715151515');
  const staffToken = login.body.accessToken;
  const roster = await call('GET', '/merchants/me/staff');
  const s = roster.body.find((r: any) => r.phone === '+255715151515');
  assert.equal(s.status, 'active', 'first login activated the invited row');

  // Owner suspends → sessions revoked immediately.
  const suspend = await call('PATCH', `/merchants/me/staff/${s.id}`, { body: { status: 'suspended' }, idem: 't-rbac-suspend-1' });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.status, 'suspended');

  // The pre-suspension token is dead for every action.
  token = staffToken;
  const acting = await call('GET', '/redemptions');
  assert.equal(acting.status, 403);
  assert.equal(acting.body.error.code, 'STAFF_SUSPENDED');

  // Login is blocked too.
  const relogin = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255715151515', purpose: 'login' } });
  const verify = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: relogin.body.requestId, code: relogin.body.debugCode, purpose: 'login' } });
  assert.equal(verify.status, 403);
  assert.equal(verify.body.error.code, 'STAFF_SUSPENDED');
  token = null;
});

/* ================= 2. Invite → activation ================= */

test('invite: first login activates invited staff (invited → active), creates the backing row, emits staff.activated', async () => {
  const logBefore = eventsAfter(0).map((e) => e.id).sort((a, b) => a - b);
  const seqBefore = logBefore.length ? logBefore[logBefore.length - 1] : 0;
  token = ownerToken;
  await inviteAs('+255724242424', 'waiter', 'Neema New');

  const roster = await call('GET', '/merchants/me/staff');
  const row = roster.body.find((r: any) => r.phone === '+255724242424');
  assert.equal(row.status, 'invited');
  assert.equal(row.role, 'waiter');
  assert.ok(!db.table('staff').find(row.id), 'no legacy row before activation');

  const login = await loginAs('+255724242424');
  assert.equal(login.status, 200);
  assert.ok(login.body.accessToken);
  assert.equal(login.body.me.staff.role, 'staff', 'legacy backing row uses the closest legacy role');

  const after = await call('GET', '/merchants/me/staff');
  const activated = after.body.find((r: any) => r.id === row.id);
  assert.equal(activated.status, 'active', 'invited → active on first login');
  const legacy = db.table('staff').find(row.id);
  assert.ok(legacy, 'backing legacy staff row created');
  assert.equal(legacy!.phone, '+255724242424');

  const newEvents = eventsAfter(seqBefore).map((e) => e.event);
  const activatedEvent = newEvents.find((e) => e.type === 'staff.activated') as
    | { type: 'staff.activated'; staff: { phone: string; status: string } }
    | undefined;
  assert.ok(activatedEvent, 'staff.activated event emitted on first login');
  assert.equal(activatedEvent!.staff.phone, '+255724242424');
  assert.equal(activatedEvent!.staff.status, 'active');
  token = null;
});

/* ================= 3. Session lifecycle (refresh rotation + store flow) ================= */

test('session: refresh rotates tokens; reusing the old refresh token is rejected; store refresh() persists and restores', async () => {
  // API level
  const login = await loginAs('+255700000002');
  const rt1 = login.body.refreshToken;
  const at1 = login.body.accessToken;
  assert.ok(rt1 && at1);

  const refreshed = await call('POST', '/auth/refresh', { auth: false, body: { refreshToken: rt1 } });
  assert.equal(refreshed.status, 200);
  const rt2 = refreshed.body.refreshToken;
  assert.ok(rt2 && rt2 !== rt1, 'refresh token rotates');
  assert.ok(refreshed.body.accessToken !== at1, 'access token rotates');
  assert.ok(refreshed.body.me.staff.phone === '+255700000002');

  const reuse = await call('POST', '/auth/refresh', { auth: false, body: { refreshToken: rt1 } });
  assert.equal(reuse.status, 401, 'rotated-away refresh token is rejected');
  assert.equal(reuse.body.error.code, 'UNAUTHORIZED');

  // Store level: verifyOtp persists the refresh token (client storage + the
  // native-style persister); refresh() swaps the tokens and state.
  let storedRefresh: string | null = null;
  setRefreshTokenPersister({ get: async () => storedRefresh, set: async (t) => { storedRefresh = t; } });
  setToken(null);
  setRefreshToken(null);
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000002', purpose: 'login' } });
  await useSessionStore.getState().verifyOtp(req.body.requestId, req.body.debugCode, 'login');
  assert.equal(useSessionStore.getState().status, 'authed');
  assert.ok(getRefreshToken(), 'refresh token persisted through the client storage');
  assert.ok(storedRefresh, 'refresh token persisted through the native-style persister');
  const atBefore = useSessionStore.getState().token;

  const ok = await useSessionStore.getState().refresh();
  assert.equal(ok, true);
  assert.equal(useSessionStore.getState().status, 'authed');
  assert.notEqual(useSessionStore.getState().token, atBefore, 'refresh swapped the access token');
  assert.ok(storedRefresh && storedRefresh !== rt1, 'rotated refresh token re-persisted');

  // Failed refresh clears stored credentials → anon.
  setRefreshToken('expired-refresh-token');
  const failed = await useSessionStore.getState().refresh();
  assert.equal(failed, false);
  assert.equal(useSessionStore.getState().status, 'anon');
  assert.equal(useSessionStore.getState().token, null);
  assert.equal(getRefreshToken(), null, 'failed refresh clears stored credentials');
  assert.equal(storedRefresh, null, 'failed refresh clears the native persister');
  setRefreshTokenPersister(null);
});

/* ================= 4. Risk review contract ================= */

test('risk: review requires decision + reason; resolved/dismissed map to statuses; repeats → RISK_ALREADY_REVIEWED', async () => {
  token = ownerToken;

  const list = await call('GET', '/risk/events');
  const open = list.body.events.filter((e: any) => e.status === 'open');
  assert.ok(open.length >= 1, 'seeded open event (rk2 large-refund)');

  const rk2 = open.find((e: any) => e.id === 'rk2');

  const noBody = await call('POST', `/risk/${rk2.id}/review`, { body: {} });
  assert.equal(noBody.status, 400);
  assert.equal(noBody.body.error.code, 'INVALID_DECISION');

  const noReason = await call('POST', `/risk/${rk2.id}/review`, { body: { decision: 'resolved' } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'RISK_REASON_REQUIRED');

  const tooLong = await call('POST', `/risk/${rk2.id}/review`, { body: { decision: 'resolved', reason: 'x'.repeat(501) } });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'REASON_TOO_LONG');

  const done = await call('POST', `/risk/${rk2.id}/review`, { body: { decision: 'resolved', reason: 'Customer story verified with delivery partner.' }, idem: 't-risk-resolve' });
  assert.equal(done.status, 200);
  assert.equal(done.body.event.status, 'resolved');
  assert.equal(done.body.event.decision, 'resolved');
  assert.equal(done.body.event.reason, 'Customer story verified with delivery partner.');
  assert.ok(done.body.event.reviewedBy);
  assert.ok(done.body.event.reviewedAt);

  const again = await call('POST', `/risk/${rk2.id}/review`, { body: { decision: 'dismissed', reason: 'second look' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'RISK_ALREADY_REVIEWED');
  assert.equal(again.body.error.details.status, 'resolved', 'conflict surfaces the prior decision');

  // Dismiss a fresh event → stays `reviewed` with decision dismissed.
  db.table('riskEvents').insert({ id: 'rk_test_dismiss', merchantId: 'm_demo', level: 'low', type: 'withdrawal-anomaly', detail: 'test', ts: Date.now(), status: 'open' });
  const dismissed = await call('POST', '/risk/rk_test_dismiss/review', { body: { decision: 'dismissed', reason: 'Internal test transfer — not suspicious.' }, idem: 't-risk-dismiss' });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.event.status, 'reviewed');
  assert.equal(dismissed.body.event.decision, 'dismissed');

  const audit = await call('GET', '/audit');
  assert.ok(audit.body.logs.some((l: any) => l.action === 'risk:review' && l.detail.includes('resolved')), 'risk decision audited');
});

/* ================= 5. Sweeper detections ================= */

test('risk: sweeper flags new-device login (login-risk) and order-velocity (unusual-order-pattern)', async () => {
  token = ownerToken;

  // New device session for an existing staff member (no prior session on it).
  createSession('m_demo', 's2', 'manager', 'New Android tablet', '198.51.100.42');
  // A burst of completed orders in the last 30 minutes.
  const orders = db.table('orders');
  for (let i = 0; i < 8; i++) {
    orders.insert({ id: `rbac_burst_${i}`, merchantId: 'm_demo', status: 'completed', total: 1000, createdAt: Date.now() - 100000, completedAt: Date.now() - 100000 + i * 1000 });
  }

  runSweeperJobs();

  const events = await call('GET', '/risk/events');
  assert.ok(
    events.body.events.some((e: any) => e.type === 'login-risk' && e.status === 'open' && e.detail.includes('New Android tablet')),
    'new-device login flagged with device attribution',
  );
  assert.ok(
    events.body.events.some((e: any) => e.type === 'unusual-order-pattern' && e.status === 'open'),
    'order-velocity burst flagged',
  );

  // Dedupe: a second sweep must not double-flag the same open event.
  const before = events.body.events.filter((e: any) => e.type === 'login-risk' && e.status === 'open').length;
  runSweeperJobs();
  const after = await call('GET', '/risk/events');
  const afterCount = after.body.events.filter((e: any) => e.type === 'login-risk' && e.status === 'open').length;
  assert.equal(afterCount, before, 'no duplicate open flag on re-sweep');

  // Cleanup the burst rows so later assertions in other suites stay stable.
  for (let i = 0; i < 8; i++) orders.remove(`rbac_burst_${i}`);
});

/* ================= 6. Print failure contract ================= */

test('print jobs: DEVICE_OFFLINE with queue-until-online/fallback, DEVICE_NOT_FOUND, PRINT_QUEUE_FULL with backoff', async () => {
  token = ownerToken;

  const offline = await call('POST', '/print-jobs', { body: { jobType: 'receipt', deviceId: 'dev_seed_3', copies: 1 } });
  assert.equal(offline.status, 409);
  assert.equal(offline.body.error.code, 'DEVICE_OFFLINE');
  assert.equal(offline.body.error.retriable, true);
  assert.equal(offline.body.error.details.status, 'error');
  assert.ok(offline.body.error.details.options.includes('queue_until_online'), 'dialog options present');
  assert.equal(typeof offline.body.error.details.retryAfterSeconds, 'number');

  const stale = await call('POST', '/print-jobs', { body: { jobType: 'receipt', deviceId: 'dev_gone', copies: 1 } });
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'DEVICE_NOT_FOUND');

  const online = await call('POST', '/print-jobs', { body: { jobType: 'receipt', deviceId: 'dev_seed_1', copies: 1 } });
  assert.equal(online.status, 201, 'online device queues normally');
  assert.equal(online.body.status, 'queued');

  const queueOffline = await call('POST', '/print-jobs', { body: { jobType: 'label', deviceId: 'dev_seed_3', copies: 1, queueIfOffline: true } });
  assert.equal(queueOffline.status, 201, 'queue-until-online option accepts the job');
  assert.match(String(queueOffline.body.error ?? ''), /offline/, 'job notes the offline target');

  // Fill the queue past capacity → PRINT_QUEUE_FULL (retriable with backoff).
  const jobs = db.table('printJobs');
  const created: { id: string }[] = [];
  for (let i = 0; i < 25; i++) {
    const row = { id: `rbac_full_${i}`, merchantId: 'm_demo', jobType: 'receipt', status: 'queued', error: null, createdAt: Date.now(), completedAt: null, copies: 1 };
    jobs.insert(row);
    created.push({ id: row.id });
  }
  const full = await call('POST', '/print-jobs', { body: { jobType: 'receipt', copies: 1 } });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'PRINT_QUEUE_FULL');
  assert.equal(full.body.error.retriable, true);
  assert.equal(typeof full.body.error.details.retryAfterSeconds, 'number');
  assert.equal(full.body.error.details.capacity, 20);

  for (const c of created) jobs.remove(c.id);
});

/* ================= 7. Setup guide (8 steps) ================= */

test('setup guide: 8 seeded steps in order with deep links', async () => {
  token = ownerToken;
  const res = await call('GET', '/tasks/setup-guide');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 8, 'eight-step checklist (TASKS-RISK.md round-2 §90)');
  assert.deepEqual(
    res.body.map((s: any) => s.order),
    [1, 2, 3, 4, 5, 6, 7, 8],
    'steps are ordered',
  );
  const last = res.body.find((s: any) => s.id === 'step_seed_8');
  assert.ok(last && typeof last.deepLink === 'string' && !last.completed, 'eighth step: invite your team');
  const seventh = res.body.find((s: any) => s.id === 'step_seed_7');
  assert.ok(seventh && typeof seventh.deepLink === 'string', 'seventh step: store hours + delivery settings');
});
