import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
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

let ownerToken: string | null = null;
let staffToken: string | null = null;

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

const DAY = 86400000;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TO = iso(new Date());

/* Assert a successful body's key set and primitive shape without requiring
 * deep equality on volatile values (server-owned ids, timestamps). */
function sameShape(a: any, b: any): void {
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'top-level keys match');
  for (const k of Object.keys(a)) {
    if (Array.isArray(a[k])) {
      assert.ok(Array.isArray(b[k]), `${k} is an array on both`);
    } else if (typeof a[k] === 'object' && a[k] !== null) {
      sameShape(a[k], b[k]);
    } else {
      assert.equal(typeof a[k], typeof b[k], `${k} has the same type`);
    }
  }
}

before(async () => {
  server.use(rawHttp.get('http://localhost/api/ping', () => Response.json({ pong: true })));
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  ownerToken = await loginAs('+255700000000');
  staffToken = await loginAs('+255700000003');
});

beforeEach(() => {
  token = ownerToken;
});

after(() => {
  server.close();
});

/* ================= Drift-D: campaigns ================= */

test('campaigns: GET /coupon-campaigns ≡ GET /campaigns (list parity + auth)', async () => {
  const contract = await call('GET', '/coupon-campaigns');
  const legacy = await call('GET', '/campaigns');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'contract path returns the same campaign list');
  const anon = await call('GET', '/coupon-campaigns', { auth: false });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'UNAUTHORIZED');
});

test('campaigns: POST /coupon-campaigns ≡ POST /campaigns (create parity + errors + auth)', async () => {
  const input = { type: 'coupon', title: 'Drift-D create', budget: 50, couponAmount: 8, target: 'All customers', productIds: [] };
  const contract = await call('POST', '/coupon-campaigns', { body: input });
  const legacy = await call('POST', '/campaigns', { body: input });
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  sameShape(contract.body, legacy.body);
  assert.equal(contract.body.campaign.status, legacy.body.campaign.status);
  assert.equal(contract.body.campaign.title, legacy.body.campaign.title);
  assert.equal(contract.body.campaign.budget, legacy.body.campaign.budget);
  assert.equal(contract.body.campaign.type, legacy.body.campaign.type);
  assert.equal(contract.body.campaign.spent, 0);

  const badBudget = await call('POST', '/coupon-campaigns', { body: { type: 'coupon', budget: 0 } });
  const badBudgetLegacy = await call('POST', '/campaigns', { body: { type: 'coupon', budget: 0 } });
  assert.equal(badBudget.status, badBudgetLegacy.status);
  assert.equal(badBudget.body.error.code, badBudgetLegacy.body.error.code);

  const badTiers = await call('POST', '/coupon-campaigns', { body: { type: 'group_buy', budget: 50, groupBuyTargets: [{ buyers: 2, discountRate: 0.1 }] } });
  const badTiersLegacy = await call('POST', '/campaigns', { body: { type: 'group_buy', budget: 50, groupBuyTargets: [{ buyers: 2, discountRate: 0.1 }] } });
  assert.equal(badTiers.status, badTiersLegacy.status);
  assert.equal(badTiers.body.error.code, badTiersLegacy.body.error.code);

  const anon = await call('POST', '/coupon-campaigns', { auth: false, body: input });
  assert.equal(anon.status, 401);
});

test('platform events: GET /marketing/platform-events ≡ GET /campaigns/platform (parity + auth)', async () => {
  const contract = await call('GET', '/marketing/platform-events');
  const legacy = await call('GET', '/campaigns/platform');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same platform campaign list');
  const anon = await call('GET', '/marketing/platform-events', { auth: false });
  assert.equal(anon.status, 401);
});

test('platform events: POST /marketing/platform-events/{id}/enroll ≡ POST /campaigns/platform/:id/signup (success/error parity + auth)', async () => {
  const joined = await call('POST', '/marketing/platform-events/pc1/enroll', { body: {} });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.campaign.id, 'pc1');
  assert.equal(joined.body.campaign.status, 'signed');

  const joinedLegacy = await call('POST', '/campaigns/platform/pc2/signup', { body: {} });
  assert.equal(joinedLegacy.status, 200);
  sameShape(joined.body, joinedLegacy.body);
  assert.equal(joinedLegacy.body.campaign.status, 'signed');

  const closed = await call('POST', '/marketing/platform-events/pc1/enroll', { body: {} });
  const closedLegacy = await call('POST', '/campaigns/platform/pc1/signup', { body: {} });
  assert.equal(closed.status, closedLegacy.status);
  assert.equal(closed.body.error.code, closedLegacy.body.error.code);

  const missing = await call('POST', '/marketing/platform-events/nope/enroll', { body: {} });
  const missingLegacy = await call('POST', '/campaigns/platform/nope/signup', { body: {} });
  assert.equal(missing.status, missingLegacy.status);
  assert.equal(missing.body.error.code, missingLegacy.body.error.code);

  const anon = await call('POST', '/marketing/platform-events/pc2/enroll', { auth: false, body: {} });
  assert.equal(anon.status, 401);
});

test('segments: GET /segments ≡ GET /customers/segments (parity + auth)', async () => {
  const contract = await call('GET', '/segments');
  const legacy = await call('GET', '/customers/segments');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same segment list');
  const anon = await call('GET', '/segments', { auth: false });
  assert.equal(anon.status, 401);
});

test('segments: POST /segments ≡ POST /customers/segments/:id/coupons (coupon send parity + errors + auth)', async () => {
  const contract = await call('POST', '/segments', { body: { segmentId: 'seg_lapsed', amount: 15 } });
  const legacy = await call('POST', '/customers/segments/seg_lapsed/coupons', { body: { amount: 15 } });
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  sameShape(contract.body, legacy.body);
  assert.equal(contract.body.sent, legacy.body.sent);
  assert.equal(contract.body.campaign.type, legacy.body.campaign.type);
  assert.equal(contract.body.campaign.couponAmount, legacy.body.campaign.couponAmount);
  assert.equal(contract.body.campaign.title, legacy.body.campaign.title);

  const missing = await call('POST', '/segments', { body: { segmentId: 'seg_nope', amount: 15 } });
  const missingLegacy = await call('POST', '/customers/segments/seg_nope/coupons', { body: { amount: 15 } });
  assert.equal(missing.status, missingLegacy.status);
  assert.equal(missing.body.error.code, missingLegacy.body.error.code);

  const anon = await call('POST', '/segments', { auth: false, body: { segmentId: 'seg_vip', amount: 10 } });
  assert.equal(anon.status, 401);
});

/* ================= Drift-D: analytics ================= */

test('analytics: GET /analytics/dashboard?storeId= ≡ GET /analytics/overview; no-param keeps the contract shape', async () => {
  const contract = await call('GET', '/analytics/dashboard?storeId=');
  const legacy = await call('GET', '/analytics/overview');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'dashboard summary matches the legacy overview payload');
  for (const key of ['gmv', 'todayRevenue', 'prevRevenue', 'todayOrders', 'prevOrders', 'aov', 'conversion', 'repeatRate', 'praiseRate']) {
    assert.equal(typeof contract.body[key], 'number', `overview.${key} numeric`);
  }

  const perStore = await call('GET', '/analytics/dashboard?storeId=s_demo');
  const perStoreLegacy = await call('GET', '/analytics/overview?storeId=s_demo');
  assert.deepEqual(perStore.body, perStoreLegacy.body, 'store-filtered summary matches the legacy overview');

  const contractShape = await call('GET', '/analytics/dashboard');
  assert.equal(contractShape.status, 200);
  assert.match(contractShape.body.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const key of ['orderCount', 'dineInCount', 'groupBuyCount', 'revenueTZS', 'newCustomers', 'averageOrderValueTZS']) {
    assert.equal(typeof contractShape.body.today[key], 'number', `today.${key} numeric`);
  }
  for (const key of ['activeOrders', 'activeDineInTables', 'openAlerts']) {
    assert.equal(typeof contractShape.body.live[key], 'number', `live.${key} numeric`);
  }

  const anon = await call('GET', '/analytics/dashboard', { auth: false });
  assert.equal(anon.status, 401);
});

test('analytics: GET /analytics/hourly-trends?days=7 ≡ GET /analytics/trend?days=7; ?date= keeps the contract shape', async () => {
  const contract = await call('GET', '/analytics/hourly-trends?days=7');
  const legacy = await call('GET', '/analytics/trend?days=7');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'hourly strip matches the legacy trend payload');
  assert.ok(Array.isArray(contract.body.days) && contract.body.days.length === 7);

  const contractShape = await call('GET', `/analytics/hourly-trends?date=${TO}`);
  assert.equal(contractShape.status, 200);
  assert.ok(Array.isArray(contractShape.body) && contractShape.body.length === 24, 'contract shape: 24 hourly points');
  for (const p of contractShape.body) {
    assert.equal(typeof p.hour, 'number');
    assert.equal(typeof p.revenueTZS, 'number');
    assert.equal(typeof p.orderCount, 'number');
  }

  const anon = await call('GET', '/analytics/hourly-trends?days=7', { auth: false });
  assert.equal(anon.status, 401);
});

test('analytics: GET /analytics/reviews ≡ GET /reviews/analytics (parity + auth)', async () => {
  const contract = await call('GET', '/analytics/reviews');
  const legacy = await call('GET', '/reviews/analytics');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'review analytics payload identical');
  for (const key of ['total', 'avgRating', 'praiseRate', 'replyRate']) {
    assert.equal(typeof contract.body[key], 'number', `${key} numeric`);
  }
  assert.ok(Array.isArray(contract.body.distribution) && Array.isArray(contract.body.weeklyAvg));
  const anon = await call('GET', '/analytics/reviews', { auth: false });
  assert.equal(anon.status, 401);
});

test('analytics: benchmarks + order-analytics already on contract paths — shape + legacy intact + auth', async () => {
  const benchmarks = await call('GET', '/analytics/benchmarks');
  assert.equal(benchmarks.status, 200);
  assert.equal(typeof benchmarks.body.category, 'string');
  assert.equal(typeof benchmarks.body.merchantScore, 'number');
  assert.ok(Array.isArray(benchmarks.body.metrics) && benchmarks.body.metrics.length >= 1);
  const legacyBench = await call('GET', '/analytics/benchmark');
  assert.equal(legacyBench.status, 200);
  assert.ok(Array.isArray(legacyBench.body.percentiles) && legacyBench.body.percentiles.length === 4);

  const orderAnalytics = await call('GET', `/analytics/order-analytics?from=${iso(new Date(Date.now() - 6 * DAY))}&to=${TO}`);
  assert.equal(orderAnalytics.status, 200);
  assert.equal(typeof orderAnalytics.body.totalOrders, 'number');
  assert.ok(Array.isArray(orderAnalytics.body.byHour) && orderAnalytics.body.byHour.length === 24);
  assert.ok(Array.isArray(orderAnalytics.body.byPriceBand) && orderAnalytics.body.byPriceBand.length >= 1);
  const legacyOrders = await call('GET', '/analytics/orders?days=7&limit=20');
  assert.equal(legacyOrders.status, 200);
  assert.ok(Array.isArray(legacyOrders.body.orders));

  for (const p of ['/analytics/benchmarks', '/analytics/order-analytics']) {
    const anon = await call('GET', p, { auth: false });
    assert.equal(anon.status, 401, `${p} requires auth`);
  }
});

/* ================= Drift-D: messaging (conversations + notifications) ================= */

test('conversations: GET /conversations ≡ GET /chat/threads (parity + auth)', async () => {
  const contract = await call('GET', '/conversations');
  const legacy = await call('GET', '/chat/threads');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same thread list');
  const anon = await call('GET', '/conversations', { auth: false });
  assert.equal(anon.status, 401);
});

test('conversations: POST /conversations/{id}/messages ≡ POST /chat/threads/:id/messages (parity + errors + auth)', async () => {
  const contract = await call('POST', '/conversations/ch1/messages', { body: { text: 'Drift-D hello' } });
  const legacy = await call('POST', '/chat/threads/ch1/messages', { body: { text: 'Drift-D hello' } });
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  sameShape(contract.body, legacy.body);
  assert.equal(contract.body.message.from, 'merchant');
  assert.equal(contract.body.message.text, 'Drift-D hello');
  assert.equal(contract.body.thread.lastMessage, 'Drift-D hello');
  assert.equal(contract.body.thread.id, 'ch1');
  assert.equal(contract.body.message.from, legacy.body.message.from, 'same author role');

  const empty = await call('POST', '/conversations/ch1/messages', { body: { text: '  ' } });
  const emptyLegacy = await call('POST', '/chat/threads/ch1/messages', { body: { text: '  ' } });
  assert.equal(empty.status, emptyLegacy.status);
  assert.equal(empty.body.error.code, emptyLegacy.body.error.code);

  const missing = await call('POST', '/conversations/nope/messages', { body: { text: 'x' } });
  const missingLegacy = await call('POST', '/chat/threads/nope/messages', { body: { text: 'x' } });
  assert.equal(missing.status, missingLegacy.status);
  assert.equal(missing.body.error.code, missingLegacy.body.error.code);

  const anon = await call('POST', '/conversations/ch1/messages', { auth: false, body: { text: 'x' } });
  assert.equal(anon.status, 401);
});

test('conversations: POST /conversations/{id}/read ≡ POST /chat/threads/:id/read (parity + 404 + auth)', async () => {
  const contract = await call('POST', '/conversations/ch1/read', { body: {} });
  const legacy = await call('POST', '/chat/threads/ch1/read', { body: {} });
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same read acknowledgement');

  const missing = await call('POST', '/conversations/nope/read', { body: {} });
  const missingLegacy = await call('POST', '/chat/threads/nope/read', { body: {} });
  assert.equal(missing.status, missingLegacy.status);
  assert.equal(missing.body.error.code, missingLegacy.body.error.code);

  const anon = await call('POST', '/conversations/ch2/read', { auth: false, body: {} });
  assert.equal(anon.status, 401);
});

test('notifications: GET /notifications/me ≡ GET /notifications (parity + auth)', async () => {
  const contract = await call('GET', '/notifications/me');
  const legacy = await call('GET', '/notifications');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same notification list');
  assert.ok(Array.isArray(contract.body.notifications));
  assert.equal(typeof contract.body.unread, 'number');
  const anon = await call('GET', '/notifications/me', { auth: false });
  assert.equal(anon.status, 401);
});

test('notifications: POST /notifications/{id}/read (204) marks one; POST /notifications/read-all ≡ POST /notifications/read', async () => {
  const before = await call('GET', '/notifications/me');
  const unread = before.body.notifications.find((n: any) => !n.read);
  if (unread) {
    const mark = await call('POST', `/notifications/${unread.id}/read`, { body: {} });
    assert.equal(mark.status, 204);
    const after = await call('GET', '/notifications/me');
    assert.equal(after.body.unread, before.body.unread - 1, 'per-item read reduced the unread count');
  }
  const missing = await call('POST', '/notifications/nope/read', { body: {} });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const all = await call('POST', '/notifications/read-all', { body: {} });
  const allLegacy = await call('POST', '/notifications/read', { body: {} });
  assert.equal(all.status, 200);
  assert.equal(allLegacy.status, 200);
  assert.deepEqual(all.body, allLegacy.body, 'same read-all acknowledgement');
  const afterAll = await call('GET', '/notifications/me');
  assert.equal(afterAll.body.unread, 0, 'read-all cleared unread on the contract path');

  const anon = await call('POST', '/notifications/read-all', { auth: false, body: {} });
  assert.equal(anon.status, 401);
});

/* ================= Drift-D: reviews, support, audit, print jobs ================= */

test('reviews: GET /reviews/me ≡ GET /reviews (parity + auth)', async () => {
  const contract = await call('GET', '/reviews/me');
  const legacy = await call('GET', '/reviews');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same review list');
  assert.ok(Array.isArray(contract.body.reviews) && contract.body.reviews.length > 0);
  assert.equal(typeof contract.body.avgRating, 'number');
  const anon = await call('GET', '/reviews/me', { auth: false });
  assert.equal(anon.status, 401);
});

test('support: GET /support/tickets/me ≡ GET /support/tickets (parity + auth)', async () => {
  const contract = await call('GET', '/support/tickets/me');
  const legacy = await call('GET', '/support/tickets');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same ticket list');
  assert.ok(Array.isArray(contract.body.tickets));
  const anon = await call('GET', '/support/tickets/me', { auth: false });
  assert.equal(anon.status, 401);
});

test('audit: GET /audit/me ≡ GET /audit (parity + staff 403 + auth)', async () => {
  const contract = await call('GET', '/audit/me?limit=200');
  const legacy = await call('GET', '/audit?limit=200');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(contract.body, legacy.body, 'same audit trail');
  assert.ok(Array.isArray(contract.body.logs));

  token = staffToken;
  const forbidden = await call('GET', '/audit/me');
  const forbiddenLegacy = await call('GET', '/audit');
  assert.equal(forbidden.status, forbiddenLegacy.status);
  assert.equal(forbidden.body.error.code, forbiddenLegacy.body.error.code);
  token = ownerToken;

  const anon = await call('GET', '/audit/me', { auth: false });
  assert.equal(anon.status, 401);
});

test('print jobs: GET /print-jobs already on the contract path — list + auth', async () => {
  const res = await call('GET', '/print-jobs');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'print job history is an array');
  const anon = await call('GET', '/print-jobs', { auth: false });
  assert.equal(anon.status, 401);
});
