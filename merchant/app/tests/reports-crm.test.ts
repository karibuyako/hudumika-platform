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
/* Marketing seed rows were created up to 12 days ago — use a 30-day window. */
const FROM_30 = iso(new Date(Date.now() - 29 * DAY));

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

/* ================= P8c: scheduled reports (contract /reports) ================= */

test('GET /reports lists seeded reports with the ScheduledReport shape', async () => {
  const res = await call('GET', '/reports');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2, 'two seeded reports');
  const daily = res.body.find((r: any) => r.id === 'rep_seed_1');
  assert.ok(daily);
  assert.equal(daily.name, 'Daily revenue summary');
  assert.equal(daily.reportType, 'revenue');
  assert.equal(daily.cadence, 'daily');
  assert.equal(daily.format, 'csv');
  assert.equal(daily.enabled, true);
  assert.match(daily.lastRunAt, /^\d{4}-\d{2}-\d{2}T/, 'lastRunAt is an ISO date-time');
  assert.deepEqual(daily.recipients, ['owner@skewer-house.co.tz']);
  assert.deepEqual(daily.storeIds, ['s_demo', 's_demo_2']);
  assert.ok(daily.id, 'server-assigned id');
  assert.equal(res.body[0].merchantId, undefined, 'merchantId never leaks');
});

test('POST /reports creates a scheduled report (201); PATCH renames + reschedules; DELETE removes (204)', async () => {
  const created = await call('POST', '/reports', {
    idem: 't-rep-create',
    body: { name: 'Monthly product performance', reportType: 'products', cadence: 'monthly', format: 'xlsx', recipients: ['ops@skewer-house.co.tz'], enabled: true },
  });
  assert.equal(created.status, 201);
  const report = created.body;
  assert.equal(report.name, 'Monthly product performance');
  assert.equal(report.reportType, 'products');
  assert.equal(report.cadence, 'monthly');
  assert.equal(report.format, 'xlsx');
  assert.equal(report.enabled, true);
  assert.equal(report.lastRunAt, null, 'fresh report has no lastRunAt');
  assert.deepEqual(report.recipients, ['ops@skewer-house.co.tz']);

  const list = await call('GET', '/reports');
  assert.ok(list.body.some((r: any) => r.id === report.id), 'created report listed');

  const patched = await call('PATCH', `/reports/${report.id}`, { body: { name: 'Renamed digest', cadence: 'weekly', enabled: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Renamed digest');
  assert.equal(patched.body.cadence, 'weekly');
  assert.equal(patched.body.enabled, false);
  assert.equal(patched.body.reportType, 'products', 'PATCH merges — untouched fields kept');

  const deleted = await call('DELETE', `/reports/${report.id}`, {});
  assert.equal(deleted.status, 204);
  const after = await call('GET', '/reports');
  assert.ok(!after.body.some((r: any) => r.id === report.id), 'deleted report gone');

  const missing = await call('PATCH', '/reports/does-not-exist', { body: { name: 'x' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  const delMissing = await call('DELETE', '/reports/does-not-exist', {});
  assert.equal(delMissing.status, 404);
});

test('POST /reports validates enums and enforces idempotency', async () => {
  const badType = await call('POST', '/reports', { idem: 't-rep-bad-1', body: { name: 'x', reportType: 'magic', cadence: 'daily', format: 'csv' } });
  assert.equal(badType.status, 422);
  assert.equal(badType.body.error.code, 'REPORT_TYPE_INVALID');

  const badCadence = await call('POST', '/reports', { idem: 't-rep-bad-2', body: { name: 'x', reportType: 'revenue', cadence: 'hourly', format: 'csv' } });
  assert.equal(badCadence.status, 422);
  assert.equal(badCadence.body.error.code, 'CADENCE_INVALID');

  const badFormat = await call('POST', '/reports', { idem: 't-rep-bad-3', body: { name: 'x', reportType: 'revenue', cadence: 'daily', format: 'docx' } });
  assert.equal(badFormat.status, 422);
  assert.equal(badFormat.body.error.code, 'FORMAT_INVALID');

  const noName = await call('POST', '/reports', { idem: 't-rep-bad-4', body: { reportType: 'revenue', cadence: 'daily', format: 'csv' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'NAME_REQUIRED');

  const first = await call('POST', '/reports', { idem: 't-rep-idem', body: { name: 'Idempotent report', reportType: 'traffic', cadence: 'weekly', format: 'pdf' } });
  assert.equal(first.status, 201);
  const replay = await call('POST', '/reports', { idem: 't-rep-idem', body: { name: 'Idempotent report', reportType: 'traffic', cadence: 'weekly', format: 'pdf' } });
  assert.ok(replay.status === 200 || replay.status === 201, `replay accepted (got ${replay.status})`);
  assert.equal(replay.body.id, first.body.id, 'same idempotency key replays the same report');
  const list = await call('GET', '/reports');
  assert.equal(list.body.filter((r: any) => r.id === first.body.id).length, 1, 'no duplicate rows on replay');
});

/* ================= P8c: CRM journeys (contract /journeys) ================= */

test('GET /journeys lists the seeded journey; POST creates one (201) with actions', async () => {
  const list = await call('GET', '/journeys');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  const seed = list.body.find((j: any) => j.id === 'jrn_seed_1');
  assert.ok(seed, 'seeded journey present');
  assert.equal(seed.name, 'First order welcome');
  assert.equal(seed.trigger, 'order.completed');
  assert.equal(seed.status, 'active');
  assert.ok(Array.isArray(seed.actions));
  assert.equal(seed.actions[0].type, 'coupon');
  assert.equal(seed.actions[0].delayHours, 24);
  assert.equal(seed.actions[0].template, 'Welcome back — TZS 5,000 off your next order');

  const created = await call('POST', '/journeys', {
    idem: 't-jrn-create',
    body: {
      name: 'At-risk win back',
      trigger: 'customer.inactive',
      actions: [
        { type: 'sms', delayHours: 48, template: 'We miss you — 10% off your next order' },
        { type: 'coupon', delayHours: 96 },
      ],
    },
  });
  assert.equal(created.status, 201);
  const journey = created.body;
  assert.equal(journey.name, 'At-risk win back');
  assert.equal(journey.trigger, 'customer.inactive');
  assert.equal(journey.status, 'draft', 'new journeys default to draft');
  assert.equal(journey.actions.length, 2);
  assert.equal(journey.actions[1].type, 'coupon');
  assert.equal(journey.actions[1].delayHours, 96);
  assert.equal(journey.actions[1].template, undefined, 'template optional per action');
  assert.ok(journey.createdAt, 'createdAt timestamp present');
});

test('POST /journeys validates trigger/actions and is idempotent', async () => {
  const badTrigger = await call('POST', '/journeys', {
    idem: 't-jrn-bad-1',
    body: { name: 'x', trigger: 'not.a.real.trigger', actions: [{ type: 'push', delayHours: 1 }] },
  });
  assert.equal(badTrigger.status, 422);
  assert.equal(badTrigger.body.error.code, 'JOURNEY_TRIGGER_INVALID');

  const noName = await call('POST', '/journeys', {
    idem: 't-jrn-bad-2',
    body: { trigger: 'order.completed', actions: [{ type: 'push', delayHours: 1 }] },
  });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'JOURNEY_NAME_REQUIRED');

  const badDelay = await call('POST', '/journeys', {
    idem: 't-jrn-bad-3',
    body: { name: 'x', trigger: 'order.completed', actions: [{ type: 'push', delayHours: -3 }] },
  });
  assert.equal(badDelay.status, 422);
  assert.equal(badDelay.body.error.code, 'JOURNEY_DELAY_INVALID');

  const first = await call('POST', '/journeys', {
    idem: 't-jrn-idem',
    body: { name: 'Idem journey', trigger: 'first_order', actions: [{ type: 'email', delayHours: 2, template: 'Hi' }] },
  });
  assert.equal(first.status, 201);
  const replay = await call('POST', '/journeys', {
    idem: 't-jrn-idem',
    body: { name: 'Idem journey', trigger: 'first_order', actions: [{ type: 'email', delayHours: 2, template: 'Hi' }] },
  });
  assert.equal(replay.body.id, first.body.id, 'idempotent replay returns the same journey');
});

/* ================= P8c: data exports (contract /data/exports) ================= */

test('GET /data/exports lists jobs; POST requests one (202 queued → ready with downloadUrl)', async () => {
  const list = await call('GET', '/data/exports');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  const seeded = list.body.find((j: any) => j.id === 'dex_seed_1');
  assert.ok(seeded, 'seeded export job present');
  assert.equal(seeded.scope, 'orders');
  assert.equal(seeded.format, 'csv');
  assert.equal(seeded.status, 'ready');
  assert.ok(seeded.downloadUrl, 'ready job carries downloadUrl');
  assert.equal(seeded.expiresInSeconds, 900);
  assert.ok(seeded.createdAt);
  assert.ok(seeded.completedAt);

  const created = await call('POST', '/data/exports', { idem: 't-dex-create', body: { scope: 'customers', format: 'json' } });
  assert.equal(created.status, 202);
  const job = created.body;
  assert.equal(job.status, 'queued');
  assert.equal(job.scope, 'customers');
  assert.equal(job.format, 'json');
  assert.ok(job.id);
  assert.equal(job.downloadUrl, null);

  const badScope = await call('POST', '/data/exports', { idem: 't-dex-bad-1', body: { scope: 'payroll', format: 'json' } });
  assert.equal(badScope.status, 422);
  assert.equal(badScope.body.error.code, 'EXPORT_SCOPE_INVALID');

  const badFormat = await call('POST', '/data/exports', { idem: 't-dex-bad-2', body: { scope: 'all', format: 'xml' } });
  assert.equal(badFormat.status, 422);
  assert.equal(badFormat.body.error.code, 'EXPORT_FORMAT_INVALID');

  const dup = await call('POST', '/data/exports', { idem: 't-dex-create', body: { scope: 'customers', format: 'json' } });
  assert.equal(dup.body.id, job.id, 'idempotent replay returns the same job');

  // The export pipeline runs async: queued → processing → ready (poll ~6s)
  let ready = null;
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const poll = await call('GET', '/data/exports');
    ready = poll.body.find((j: any) => j.id === job.id);
    if (ready?.status === 'ready') break;
  }
  assert.equal(ready?.status, 'ready', 'job completes to ready');
  assert.ok(ready.downloadUrl, 'ready job gets a downloadUrl');
  assert.ok(ready.completedAt, 'completedAt set when ready');
});

/* ================= P8c: privacy export (contract POST /privacy/export) ================= */

test('POST /privacy/export accepts (202) with jobId + status', async () => {
  const res = await call('POST', '/privacy/export', { idem: 't-privacy-1' });
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId, 'jobId present');
  assert.equal(res.body.status, 'queued');
  assert.ok(['queued', 'processing', 'ready', 'failed'].includes(res.body.status));

  const replay = await call('POST', '/privacy/export', { idem: 't-privacy-1' });
  assert.equal(replay.body.jobId, res.body.jobId, 'idempotent replay returns the same jobId');
});

/* ================= P8c: analytics extensions ================= */

test('GET /analytics/store-score returns score, ratingAverage and integer breakdown factors', async () => {
  const res = await call('GET', '/analytics/store-score');
  assert.equal(res.status, 200);
  const score = res.body;
  assert.equal(typeof score.score, 'number');
  assert.equal(Number.isInteger(score.score), true, 'score is an integer');
  assert.ok(score.score >= 0 && score.score <= 100, 'score within 0-100');
  assert.equal(typeof score.ratingAverage, 'number');
  assert.ok(score.ratingAverage > 0, 'rating derived from seeded store ratings');
  assert.ok(Array.isArray(score.breakdown));
  assert.ok(score.breakdown.length >= 4, 'multiple factors');
  const speed = score.breakdown.find((b: any) => b.factor === 'delivery_speed');
  assert.ok(speed, 'delivery_speed factor present');
  for (const b of score.breakdown) {
    assert.equal(typeof b.factor, 'string');
    assert.equal(Number.isInteger(b.score), true, `factor ${b.factor} score is an integer`);
    assert.ok(b.score >= 0 && b.score <= 100, `factor ${b.factor} score within 0-100`);
  }
});

test('GET /analytics/customers returns integer counts + numeric retention, derived monthly trend', async () => {
  const res = await call('GET', `/analytics/customers?from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  const c = res.body;
  for (const key of ['newCustomers', 'returningCustomers']) {
    assert.equal(typeof c[key], 'number', `${key} numeric`);
    assert.equal(Number.isInteger(c[key]), true, `${key} integer`);
    assert.ok(c[key] >= 0);
  }
  assert.equal(typeof c.retentionRate, 'number');
  assert.ok(c.retentionRate >= 0 && c.retentionRate <= 100);
  assert.equal(typeof c.avgOrderFrequency, 'number');
  assert.equal(Number.isInteger(c.avgLifetimeValueTZS), true, 'avgLifetimeValueTZS is an integer');
  assert.ok(c.avgLifetimeValueTZS >= 0);
  assert.equal(typeof c.churnRate, 'number');
  assert.ok(Array.isArray(c.monthlyTrend));
  assert.equal(c.monthlyTrend.length, 6, 'six months of trend');
  for (const m of c.monthlyTrend) {
    assert.match(m.month, /^\d{4}-\d{2}$/, 'month is yyyy-mm');
    assert.equal(Number.isInteger(m.newCustomers), true);
    assert.equal(Number.isInteger(m.returningCustomers), true);
  }
});

test('GET /analytics/customer-distribution returns aggregated area counts (no PII)', async () => {
  const res = await call('GET', '/analytics/customer-distribution');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1, 'at least one area bucket');
  let total = 0;
  for (const row of res.body) {
    assert.equal(typeof row.area, 'string');
    assert.equal(Number.isInteger(row.customerCount), true, 'customerCount integer');
    assert.ok(row.customerCount >= 1);
    total += row.customerCount;
  }
  assert.ok(total >= 8, 'covers the seeded customers');
  for (const row of res.body) {
    assert.equal('phone' in row, false, 'no customer PII in the payload');
    assert.equal('name' in row, false, 'no customer PII in the payload');
  }
});

test('GET /analytics/marketing aggregates seeded campaign spend/revenue (integer TZS)', async () => {
  const res = await call('GET', `/analytics/marketing?from=${FROM_30}&to=${TO}`);
  assert.equal(res.status, 200);
  const m = res.body;
  // Derived from seeded rows: promotions spendTZS (120000 + 0 + 64000) + dianjin spendTZS (72000)
  assert.equal(m.totalSpendTZS, 256000, 'sum of seeded promotion + dianjin spend');
  // attributedRevenueTZS: 960000 (live) + 410000 (paused)
  assert.equal(m.attributedRevenueTZS, 1370000, 'sum of seeded attributed revenue');
  assert.equal(Number.isInteger(m.totalSpendTZS), true, 'totalSpendTZS integer');
  assert.equal(Number.isInteger(m.attributedRevenueTZS), true, 'attributedRevenueTZS integer');
  assert.equal(typeof m.roiPercent, 'number');
  assert.equal(Number.isInteger(m.activeCampaigns), true);
  assert.equal(m.activeCampaigns, 4, 'live promo + active dianjin + active brand display + live coupon campaign');
});
