import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
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
  ownerToken = await loginAs('+255700000000');
});

beforeEach(() => {
  token = ownerToken;
});

after(() => {
  server.close();
});

/* ================= P6e: analytics contract alignment ================= */

test('GET /analytics/dashboard returns the AnalyticsDashboard yaml shape', async () => {
  const res = await call('GET', '/analytics/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.body.date, /^\d{4}-\d{2}-\d{2}$/, 'date is yyyy-mm-dd');
  for (const key of ['orderCount', 'dineInCount', 'groupBuyCount', 'revenueTZS', 'newCustomers', 'averageOrderValueTZS']) {
    assert.equal(typeof res.body.today[key], 'number', `today.${key} numeric`);
    assert.equal(Number.isInteger(res.body.today[key]), true, `today.${key} integer`);
  }
  for (const key of ['activeOrders', 'activeDineInTables', 'openAlerts']) {
    assert.equal(typeof res.body.live[key], 'number', `live.${key} numeric`);
  }
});

test('GET /analytics/hourly-trends?date= returns [{hour, revenueTZS, orderCount}]', async () => {
  const res = await call('GET', `/analytics/hourly-trends?date=${TO}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body) && res.body.length === 24, '24 hourly points');
  for (const p of res.body) {
    assert.equal(typeof p.hour, 'number');
    assert.equal(typeof p.revenueTZS, 'number');
    assert.equal(typeof p.orderCount, 'number');
  }
});

test('GET /analytics/funnel?from&to returns yaml {steps:[{name,count}]} with the contract enum', async () => {
  const res = await call('GET', `/analytics/funnel?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  const names = res.body.steps.map((s: any) => s.name);
  const enumNames = ['impressions', 'store_visits', 'menu_views', 'carts', 'orders', 'completed'];
  assert.deepEqual(names, enumNames, 'step names match the contract enum (incl. carts)');
  for (const s of res.body.steps) {
    assert.equal(typeof s.count, 'number');
    assert.equal(Number.isInteger(s.count), true);
  }
  for (let i = 1; i < res.body.steps.length; i++) {
    assert.ok(res.body.steps[i].count <= res.body.steps[i - 1].count, 'funnel counts non-increasing');
  }
});

test('GET /analytics/benchmarks returns the BenchmarkSummary yaml shape', async () => {
  const res = await call('GET', '/analytics/benchmarks');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.category, 'string');
  assert.equal(typeof res.body.merchantScore, 'number');
  assert.ok(res.body.merchantScore >= 0 && res.body.merchantScore <= 100, 'merchantScore 0-100');
  assert.equal(typeof res.body.industryAverage, 'number');
  assert.equal(typeof res.body.percentileRank, 'number');
  assert.ok(Array.isArray(res.body.metrics) && res.body.metrics.length >= 1);
  for (const m of res.body.metrics) {
    assert.equal(typeof m.metric, 'string');
    assert.equal(typeof m.merchant, 'number');
    assert.equal(typeof m.average, 'number');
  }
});

test('GET /analytics/market?category= returns the yaml MarketAnalysis', async () => {
  const res = await call('GET', `/analytics/market?category=${encodeURIComponent('BBQ & Grill')}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.category, 'BBQ & Grill');
  assert.equal(typeof res.body.demandIndex, 'number');
  assert.ok(['growing', 'stable', 'declining'].includes(res.body.trend), 'trend enum');
  assert.ok(Array.isArray(res.body.topSearches));
  assert.equal(typeof res.body.competitorCount, 'number');
  assert.equal(typeof res.body.suggestedPriceBandTZS.low, 'number');
  assert.equal(typeof res.body.suggestedPriceBandTZS.high, 'number');
});

test('GET /analytics/products?from&to returns ProductPerformance[] (yaml array)', async () => {
  const res = await call('GET', `/analytics/products?from=${FROM}&to=${TO}&limit=20`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'response is an array');
  assert.ok(res.body.length >= 1);
  for (const p of res.body) {
    assert.equal(typeof p.catalogueItemId, 'string');
    assert.equal(typeof p.name, 'string');
    for (const key of ['unitsSold', 'revenueTZS', 'ordersCount']) {
      assert.equal(typeof p[key], 'number');
      assert.equal(Number.isInteger(p[key]), true, `${key} integer`);
    }
    assert.equal(typeof p.availabilityRate, 'number');
  }
});

test('GET /analytics/revenue?from&to returns the RevenueAnalysis yaml shape', async () => {
  const res = await call('GET', `/analytics/revenue?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.from, FROM);
  assert.equal(res.body.to, TO);
  assert.equal(typeof res.body.totalTZS, 'number');
  assert.equal(Number.isInteger(res.body.totalTZS), true);
  assert.ok(Array.isArray(res.body.byChannel));
  const channels = res.body.byChannel.map((c: any) => c.channel);
  assert.deepEqual(channels, ['delivery', 'dine_in', 'group_buy', 'pickup'], 'channel enum');
  for (const c of res.body.byChannel) {
    assert.equal(typeof c.amountTZS, 'number');
    assert.equal(Number.isInteger(c.amountTZS), true);
  }
});

test('GET /analytics/diagnostics is honest: no fabricated narrative, no forecast/weather', async () => {
  const res = await call('GET', '/analytics/diagnostics');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.issues), 'issues is an array');
  assert.ok(Array.isArray(res.body.highlights), 'highlights is an array');
  assert.equal(res.body.issues.length, 0, 'no invented diagnostics before the backend milestone');
  assert.equal(res.body.highlights.length, 1, 'only the honest gate note is present');
  assert.match(res.body.highlights[0].detail, /coming in a later release/i, 'highlight is the honest gate note');
  const serialized = JSON.stringify(res.body).toLowerCase();
  for (const marker of ['flash sale', 'ranking momentum', 'protect its stock', 'industry average', 'forecast', 'weather', 'rain', 'tomorrow', 'tips']) {
    assert.ok(!serialized.includes(marker), `diagnostics must not contain "${marker}"`);
  }
});

test('GET /analytics/order-analytics?from&to returns the yaml shape', async () => {
  const res = await call('GET', `/analytics/order-analytics?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.totalOrders, 'number');
  assert.equal(Number.isInteger(res.body.totalOrders), true);
  assert.ok(Array.isArray(res.body.byHour) && res.body.byHour.length === 24, 'byHour covers 24 hours');
  for (const h of res.body.byHour) {
    assert.equal(typeof h.hour, 'number');
    assert.equal(typeof h.count, 'number');
  }
  assert.ok(Array.isArray(res.body.byPriceBand) && res.body.byPriceBand.length >= 1);
  for (const b of res.body.byPriceBand) {
    assert.equal(typeof b.band, 'string');
    assert.equal(typeof b.count, 'number');
  }
  assert.equal(typeof res.body.avgOrderValueTZS, 'number');
  assert.equal(Number.isInteger(res.body.avgOrderValueTZS), true);
});

test('GET /chain/analytics?from&to returns ChainStorePerformance[]', async () => {
  const res = await call('GET', `/chain/analytics?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body) && res.body.length >= 1);
  for (const s of res.body) {
    assert.equal(typeof s.storeId, 'string');
    assert.equal(typeof s.businessName, 'string');
    for (const key of ['revenueTZS', 'orderCount', 'lowStockCount']) {
      assert.equal(typeof s[key], 'number');
    }
    assert.equal(typeof s.conversionRate, 'number');
    assert.ok(s.rating === null || typeof s.rating === 'number');
    assert.equal(typeof s.isOpen, 'boolean');
  }
});

test('POST /analytics/reports/export returns {downloadUrl, expiresInSeconds}; bad type 422', async () => {
  const ok = await call('POST', '/analytics/reports/export', { body: { reportType: 'revenue', from: FROM, to: TO } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.downloadUrl, 'string');
  assert.ok(ok.body.downloadUrl.startsWith('data:'), 'downloadUrl is a self-contained report');
  assert.equal(ok.body.expiresInSeconds, 900);

  const bad = await call('POST', '/analytics/reports/export', { body: { reportType: 'nope', from: FROM, to: TO } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'REPORT_TYPE_INVALID');
});

test('GET /analytics/top-dishes?from&to returns {top, bottom} of ProductPerformance', async () => {
  const res = await call('GET', `/analytics/top-dishes?from=${FROM}&to=${TO}&limit=10`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.top) && Array.isArray(res.body.bottom), 'top and bottom arrays');
  for (const list of [res.body.top, res.body.bottom]) {
    for (const d of list) {
      assert.equal(typeof d.catalogueItemId, 'string');
      assert.equal(typeof d.unitsSold, 'number');
      assert.equal(typeof d.revenueTZS, 'number');
      assert.equal(typeof d.ordersCount, 'number');
      assert.equal(typeof d.availabilityRate, 'number');
    }
  }
});

test('GET /analytics/traffic?from&to returns the TrafficAnalysis yaml shape', async () => {
  const res = await call('GET', `/analytics/traffic?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.from, FROM);
  assert.equal(res.body.to, TO);
  assert.equal(typeof res.body.totals.visits, 'number');
  assert.equal(typeof res.body.totals.orders, 'number');
  assert.ok(Array.isArray(res.body.byChannel));
  const enumChannels = ['search', 'category', 'promotion', 'group_buy', 'dine_in_qr', 'direct', 'referral'];
  assert.deepEqual(res.body.byChannel.map((c: any) => c.channel), enumChannels, 'channel enum');
  for (const c of res.body.byChannel) {
    assert.equal(typeof c.visits, 'number');
    assert.equal(typeof c.orders, 'number');
    assert.equal(typeof c.conversionRate, 'number');
    assert.ok(c.conversionRate >= 0 && c.conversionRate <= 1, 'conversionRate 0-1');
  }
});

test('GET /analytics/forecast keeps the advisory legacy shape without weather claims', async () => {
  const first = await call('GET', '/analytics/forecast');
  assert.equal(first.status, 200);
  assert.equal(first.body.tomorrow.rainExpected, false, 'no invented rain');
  assert.ok(Array.isArray(first.body.tomorrow.tips) && first.body.tomorrow.tips.length >= 1, 'advisory tip present');
  for (const tip of first.body.tomorrow.tips) {
    assert.ok(!/rain|weather|flash sale/i.test(tip), `tip has no weather/fabricated claim: ${tip}`);
  }
  const second = await call('GET', '/analytics/forecast');
  assert.deepEqual(second.body, first.body, 'forecast is deterministic (no randomness)');
});

test('legacy mock-only analytics paths keep parity for deferred adoption', async () => {
  const funnel = await call('GET', '/analytics/funnel?days=7');
  assert.equal(funnel.status, 200);
  assert.equal(funnel.body.steps.length, 5, 'legacy funnel keeps 5 steps');
  const bench = await call('GET', '/analytics/benchmark');
  assert.equal(bench.status, 200);
  assert.equal(bench.body.percentiles.length, 4);
  const market = await call('GET', '/analytics/market');
  assert.equal(market.status, 200);
  assert.ok(market.body.categoryTrend.length >= 3);
  const dishes = await call('GET', '/analytics/top-dishes');
  assert.equal(dishes.status, 200);
  assert.ok(dishes.body.dishes.length > 0, 'legacy top-dishes non-empty');
  const overview = await call('GET', '/analytics/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.body.gmv > 0);
});

/* ================= P6e: AI honesty — product assistant ================= */

test('assistant suggestions are transparent rule-based derivations from real product data', async () => {
  const first = await call('GET', '/products/assistant/suggestions?productId=p1');
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.body.suggestions) && first.body.suggestions.length >= 1);

  const second = await call('GET', '/products/assistant/suggestions?productId=p1');
  assert.deepEqual(second.body, first.body, 'suggestions are deterministic');

  const serialized = JSON.stringify(first.body);
  for (const marker of ['predict', 'trending', 'flash sale', 'AI-generated', 'weather']) {
    assert.ok(!serialized.includes(marker), `no fabricated narrative marker "${marker}"`);
  }

  const product = db.table('products').find('p1') as any;
  assert.ok(product, 'seeded product present');
  const nameSuggestion = first.body.suggestions.find((s: any) => s.type === 'name');
  if (nameSuggestion) {
    assert.equal(typeof nameSuggestion.value.name, 'string');
    assert.ok(nameSuggestion.value.name.includes(product.name), 'name suggestion derives from the real product name');
  }
  for (const s of first.body.suggestions) {
    assert.ok(['stock', 'price', 'name', 'description', 'specs', 'category'].includes(s.type), 'suggestion type is a rule type');
    assert.equal(typeof s.value, 'object');
  }
});

test('assistant: unknown product returns the honest 404 gate', async () => {
  const res = await call('GET', '/products/assistant/suggestions?productId=does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

/* ================= P6e round-2: forecast contract + review analytics + export gating ================= */

test('GET /analytics/forecast?horizonDays= returns the contract forecast array (rule-based, weather null)', async () => {
  const res = await call('GET', '/analytics/forecast?horizonDays=7');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body) && res.body.length === 7, '7 forecast points');
  for (const p of res.body) {
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/, 'date yyyy-mm-dd');
    assert.equal(typeof p.predictedRevenueTZS, 'number');
    assert.equal(Number.isInteger(p.predictedRevenueTZS), true, 'predictedRevenueTZS integer TZS');
    assert.ok(p.confidence >= 0 && p.confidence <= 1, 'confidence 0-1');
    assert.equal(p.weather, null, 'no fabricated weather');
  }
  const serialized = JSON.stringify(res.body).toLowerCase();
  for (const marker of ['"rain"', '"rain":', 'temperaturec', 'ai model']) {
    assert.ok(!serialized.includes(marker), `forecast has no "${marker}" claim`);
  }
  const custom = await call('GET', '/analytics/forecast?horizonDays=3');
  assert.equal(custom.body.length, 3, 'horizonDays is honored');
  const again = await call('GET', '/analytics/forecast?horizonDays=7');
  assert.deepEqual(again.body, res.body, 'forecast is deterministic');
});

test('forecast legacy {tomorrow} advisory shape still served without horizonDays (p6e parity)', async () => {
  const res = await call('GET', '/analytics/forecast');
  assert.equal(res.status, 200);
  assert.equal(res.body.tomorrow.rainExpected, false, 'no invented rain');
  assert.ok(Array.isArray(res.body.tomorrow.tips) && res.body.tomorrow.tips.length >= 1, 'advisory tip present');
  for (const tip of res.body.tomorrow.tips) {
    assert.ok(!/rain|weather|flash sale/i.test(tip), `tip has no weather/fabricated claim: ${tip}`);
  }
});

test('GET /analytics/reviews?from&to returns the contract ReviewAnalytics shape; legacy stays intact', async () => {
  const res = await call('GET', `/analytics/reviews?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.from, FROM);
  assert.equal(res.body.to, TO);
  assert.equal(typeof res.body.ratingAverage, 'number');
  assert.equal(typeof res.body.reviewCount, 'number');
  assert.equal(Number.isInteger(res.body.reviewCount), true, 'reviewCount integer');
  assert.equal(typeof res.body.replyRate, 'number');
  assert.ok(Array.isArray(res.body.trendByDay) && res.body.trendByDay.length >= 1, 'trendByDay present');
  for (const d of res.body.trendByDay) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/, 'trend day yyyy-mm-dd');
    assert.equal(typeof d.count, 'number');
    assert.equal(typeof d.avgRating, 'number');
  }
  const sumCount = res.body.trendByDay.reduce((s: number, d: any) => s + d.count, 0);
  assert.equal(sumCount, res.body.reviewCount, 'trendByDay counts reconcile with reviewCount');

  const legacy = await call('GET', '/analytics/reviews');
  assert.equal(legacy.status, 200);
  assert.equal(typeof legacy.body.total, 'number', 'legacy shape preserved for the reviews screen');
  assert.ok(Array.isArray(legacy.body.distribution) && Array.isArray(legacy.body.weeklyAvg));
});

test('POST /analytics/reports/export is permissioned, audited, and gated by range limits', async () => {
  const ok = await call('POST', '/analytics/reports/export', { body: { reportType: 'orders', from: FROM, to: TO } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.expiresInSeconds, 900);
  assert.ok(ok.body.downloadUrl.startsWith('data:'), 'downloadUrl self-contained');

  const auditRows = db.table('auditLogs').where((a: any) => a.action === 'report:export' && a.resource === 'analytics-report');
  assert.ok(auditRows.length >= 1, 'export is logged in the audit trail');
  assert.ok(auditRows.some((a: any) => a.detail.includes('orders')), 'audit detail names the report type');

  const anon = await call('POST', '/analytics/reports/export', { body: { reportType: 'revenue', from: FROM, to: TO }, auth: false });
  assert.equal(anon.status, 401, 'anonymous rejected');
});

test('export gating: non-permissioned staff role gets 403; oversized range gets EXCEEDS_LIMIT', async () => {
  const cashierToken = await loginAs('+255700000003');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cashierToken}` };
  const res = await fetch('http://localhost/api/analytics/reports/export', {
    method: 'POST',
    headers,
    body: JSON.stringify({ reportType: 'revenue', from: FROM, to: TO }),
  });
  const body = await res.json();
  assert.equal(res.status, 403, 'cashier/staff role cannot export');
  assert.equal(body.error.code, 'STAFF_ROLE_FORBIDDEN', 'shared requirePerm 403 code');

  const wide = iso(new Date(Date.now() - 100 * DAY));
  const oversized = await call('POST', '/analytics/reports/export', { body: { reportType: 'revenue', from: wide, to: TO } });
  assert.equal(oversized.status, 400, 'range > 90 days rejected');
  assert.equal(oversized.body.error.code, 'ANALYTICS_REPORT_EXCEEDS_LIMIT');
});

test('export async-ready semantics: big-but-legal range returns NOT_READY then the downloadUrl', async () => {
  const from65 = iso(new Date(Date.now() - 65 * DAY));
  const key = `revenue:${from65}:${TO}`;
  const first = await call('POST', '/analytics/reports/export', { body: { reportType: 'revenue', from: from65, to: TO } });
  assert.equal(first.status, 503, `first request for ${key} is still generating`);
  assert.equal(first.body.error.code, 'ANALYTICS_EXPORT_NOT_READY');
  assert.equal(first.body.error.retriable, true, 'NOT_READY is retriable (retry with backoff)');
  await new Promise((r) => setTimeout(r, 120));
  const ready = await call('POST', '/analytics/reports/export', { body: { reportType: 'revenue', from: from65, to: TO } });
  assert.equal(ready.status, 200, 'second request after backoff receives the report');
  assert.ok(ready.body.downloadUrl.startsWith('data:'));
});

test('GET /analytics/dashboard?live=1&storeId= serves the contract shape scoped to the store', async () => {
  const all = await call('GET', '/analytics/dashboard');
  assert.equal(all.status, 200);
  for (const key of ['orderCount', 'revenueTZS', 'newCustomers']) {
    assert.equal(typeof all.body.today[key], 'number');
  }
  const scoped = await call('GET', '/analytics/dashboard?live=1&storeId=s_demo_2');
  assert.equal(scoped.status, 200);
  assert.equal(typeof scoped.body.live.activeOrders, 'number', 'live shape preserved');
  assert.equal(scoped.body.today.orderCount, 0, 's_demo_2 has no seeded orders — server-side scoping works');
  assert.ok(all.body.today.orderCount > 0, 'all-stores dashboard sees orders');
});

test('store-scoped analytics: revenue/order-analytics/funnel/hourly-trends/products honor ?storeId=', async () => {
  const allRevenue = await call('GET', `/analytics/revenue?from=${FROM}&to=${TO}`);
  const scopedRevenue = await call('GET', `/analytics/revenue?from=${FROM}&to=${TO}&storeId=s_demo_2`);
  assert.equal(scopedRevenue.status, 200);
  assert.equal(scopedRevenue.body.totalTZS, 0, 'no seeded revenue for s_demo_2');
  assert.ok(allRevenue.body.totalTZS > 0, 'all-stores revenue non-zero');

  const scopedOrders = await call('GET', `/analytics/order-analytics?from=${FROM}&to=${TO}&storeId=s_demo_2`);
  assert.equal(scopedOrders.body.totalOrders, 0);

  const scopedFunnel = await call('GET', `/analytics/funnel?from=${FROM}&to=${TO}&storeId=s_demo_2`);
  assert.equal(scopedFunnel.body.steps.find((s: any) => s.name === 'orders').count, 0);

  const scopedTrend = await call('GET', `/analytics/hourly-trends?days=7&storeId=s_demo_2`);
  assert.ok(Array.isArray(scopedTrend.body.days) && scopedTrend.body.days.length === 7);
  assert.equal(scopedTrend.body.days.reduce((s: number, d: any) => s + d.orders, 0), 0);

  const scopedProducts = await call('GET', `/analytics/products?from=${FROM}&to=${TO}&limit=20&storeId=s_demo_2`);
  assert.ok(Array.isArray(scopedProducts.body));
});

test('GET /chain/analytics?storeId= filters to the selected location', async () => {
  const one = await call('GET', `/chain/analytics?from=${FROM}&to=${TO}&storeId=s_demo_2`);
  assert.equal(one.status, 200);
  assert.ok(Array.isArray(one.body) && one.body.length === 1, 'single store row');
  assert.equal(one.body[0].storeId, 's_demo_2');
  const all = await call('GET', `/chain/analytics?from=${FROM}&to=${TO}`);
  assert.ok(all.body.length >= 2, 'chain-wide list keeps all stores');
});
