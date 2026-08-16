import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

/* P6e round-2 flow: store switcher source, store-scoped analytics, contract
 * dashboard live strip payload, forecast + review analytics contract shapes,
 * and the permissioned/limited export flow — as the analytics screen drives
 * them (analytics-flow). */

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${opts.token ?? token ?? ''}`;
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

const DAY = 86400000;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const FROM = iso(new Date(Date.now() - 6 * DAY));
const TO = iso(new Date());

before(async () => {
  server.use(rawHttp.get('http://localhost/api/ping', () => Response.json({ pong: true })));
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  token = await loginAs('+255700000000');
});

beforeEach(() => {
  token = token;
});

after(() => {
  server.close();
});

test('store switcher: GET /merchants/me/stores lists the chain locations', async () => {
  const res = await call('GET', '/merchants/me/stores');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.stores) && res.body.stores.length >= 2, 'chain store list present');
  const ids = res.body.stores.map((s: any) => s.id);
  assert.ok(ids.includes('s_demo') && ids.includes('s_demo_2'), 'both seeded locations listed');
  for (const s of res.body.stores) {
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.open, 'boolean');
  }
});

test('flow: switching storeId scopes the contract dashboard, revenue, forecast and funnel', async () => {
  const storeQ = 'storeId=s_demo_2';
  const dashboard = await call('GET', `/analytics/dashboard?live=1&${storeQ}`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dashboard.body.today.orderCount, 0, 'scoped to the empty store');
  assert.equal(typeof dashboard.body.live.activeOrders, 'number');

  const revenue = await call('GET', `/analytics/revenue?from=${FROM}&to=${TO}&${storeQ}`);
  assert.equal(revenue.body.totalTZS, 0);

  const forecast = await call('GET', `/analytics/forecast?horizonDays=3&${storeQ}`);
  assert.ok(Array.isArray(forecast.body) && forecast.body.length === 3);
  for (const p of forecast.body) {
    assert.equal(Number.isInteger(p.predictedRevenueTZS), true);
    assert.ok(p.confidence >= 0 && p.confidence <= 1);
  }

  const funnel = await call('GET', `/analytics/funnel?from=${FROM}&to=${TO}&${storeQ}`);
  assert.equal(funnel.body.steps.find((s: any) => s.name === 'orders').count, 0);

  const all = await call('GET', '/analytics/dashboard');
  assert.ok(all.body.today.orderCount > 0, 'clearing the selection restores chain-wide data');
});

test('flow: review analytics contract shape reconciles with the legacy consumer shape', async () => {
  const contract = await call('GET', `/analytics/reviews?from=${FROM}&to=${TO}`);
  assert.equal(contract.status, 200);
  assert.equal(typeof contract.body.ratingAverage, 'number');
  assert.equal(typeof contract.body.reviewCount, 'number');
  assert.equal(typeof contract.body.replyRate, 'number');
  assert.ok(Array.isArray(contract.body.trendByDay));
  const sum = contract.body.trendByDay.reduce((s: number, d: any) => s + d.count, 0);
  assert.equal(sum, contract.body.reviewCount, 'trend days reconcile');

  const legacy = await call('GET', '/analytics/reviews');
  assert.equal(legacy.status, 200);
  assert.equal(typeof legacy.body.total, 'number');
  assert.deepEqual(legacy.body, (await call('GET', '/reviews/analytics')).body, 'legacy alias parity kept');
});

test('flow: chain summary is ranked by revenue and filterable by store', async () => {
  const chain = await call('GET', `/chain/analytics?from=${FROM}&to=${TO}`);
  assert.equal(chain.status, 200);
  assert.ok(chain.body.length >= 2);
  const revenues = chain.body.map((s: any) => s.revenueTZS);
  assert.deepEqual([...revenues].sort((a: number, b: number) => b - a), revenues, 'chain rows ranked by revenue');
  const one = await call('GET', `/chain/analytics?from=${FROM}&to=${TO}&storeId=s_demo_2`);
  assert.equal(one.body.length, 1);
  assert.equal(one.body[0].storeId, 's_demo_2');
});

test('flow: export lifecycle — denied role, oversized range, async NOT_READY then ready', async () => {
  const staffToken = await loginAs('+255700000003');
  const denied = await call('POST', '/analytics/reports/export', { body: { reportType: 'revenue', from: FROM, to: TO }, token: staffToken });
  assert.equal(denied.status, 403, 'staff role is not permissioned to export');
  assert.equal(denied.body.error.code, 'STAFF_ROLE_FORBIDDEN');

  const wide = iso(new Date(Date.now() - 100 * DAY));
  const oversized = await call('POST', '/analytics/reports/export', { body: { reportType: 'traffic', from: wide, to: TO } });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.error.code, 'ANALYTICS_REPORT_EXCEEDS_LIMIT');

  const from65 = iso(new Date(Date.now() - 65 * DAY));
  const first = await call('POST', '/analytics/reports/export', { body: { reportType: 'orders', from: from65, to: TO } });
  assert.equal(first.status, 503);
  assert.equal(first.body.error.code, 'ANALYTICS_EXPORT_NOT_READY');
  await new Promise((r) => setTimeout(r, 150));
  const ready = await call('POST', '/analytics/reports/export', { body: { reportType: 'orders', from: from65, to: TO } });
  assert.equal(ready.status, 200);
  assert.ok(ready.body.downloadUrl.startsWith('data:'));

  const auditRows = db.table('auditLogs').where((a: any) => a.action === 'report:export');
  assert.ok(auditRows.length >= 1, 'export audited');
});

test('flow: analytics screen fetches the exact insight payloads it renders', async () => {
  const [benchmarks, market, products, orderAnalytics, hourly] = await Promise.all([
    call('GET', '/analytics/benchmarks'),
    call('GET', `/analytics/market?category=${encodeURIComponent('BBQ & Grill')}`),
    call('GET', `/analytics/products?from=${FROM}&to=${TO}&limit=20`),
    call('GET', `/analytics/order-analytics?from=${FROM}&to=${TO}`),
    call('GET', '/analytics/hourly-trends?days=7'),
  ]);
  assert.equal(benchmarks.status, 200);
  assert.equal(typeof benchmarks.body.merchantScore, 'number');
  assert.equal(typeof benchmarks.body.percentileRank, 'number');
  assert.equal(market.status, 200);
  assert.ok(market.body.topSearches.length >= 1, 'top searches derived from seeded orders');
  assert.equal(products.status, 200);
  assert.ok(products.body.length >= 1);
  assert.equal(orderAnalytics.status, 200);
  assert.ok(Array.isArray(orderAnalytics.body.byPriceBand) && orderAnalytics.body.byPriceBand.length >= 1);
  assert.equal(hourly.status, 200);
  assert.ok(Array.isArray(hourly.body.days) && hourly.body.days.length === 7);
});
