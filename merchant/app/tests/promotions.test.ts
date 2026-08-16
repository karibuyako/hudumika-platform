import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { subscribe } from '@/mock/events';
import type { ServerEvent } from '@/api/types';

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

async function captureEvents(fn: () => Promise<unknown>): Promise<ServerEvent[]> {
  const seen: ServerEvent[] = [];
  const off = subscribe((e) => seen.push(e));
  try {
    await fn();
  } finally {
    off();
  }
  return seen;
}

before(async () => {
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

/* ================= Promotions (contract /promotions) ================= */

test('promotions: list returns seeded promotions (contract array shape), ?status= filters', async () => {
  const list = await call('GET', '/promotions');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body), 'contract GET /promotions returns a bare array');
  const ids = list.body.map((p: any) => p.id);
  for (const id of ['promo_seed_live', 'promo_seed_pending', 'promo_seed_paused']) {
    assert.ok(ids.includes(id), `seeded promotion ${id} present`);
  }
  const live = list.body.find((p: any) => p.id === 'promo_seed_live');
  assert.equal(live.status, 'live');
  assert.equal(live.type, 'discount');
  assert.equal(live.merchantId, 'm_demo');
  assert.equal(Number.isInteger(live.budgetTZS), true, 'integer TZS');
  assert.equal(Number.isInteger(live.spendTZS), true, 'integer TZS');
  assert.equal(Number.isInteger(live.attributedRevenueTZS), true, 'integer TZS');

  const byStatus = await call('GET', '/promotions?status=paused');
  assert.deepEqual(byStatus.body.map((p: any) => p.id), ['promo_seed_paused'], 'status filter narrows');

  const byType = await call('GET', '/promotions?type=coupon');
  assert.deepEqual(byType.body.map((p: any) => p.id), ['promo_seed_pending'], 'type filter narrows');
});

test('promotions: create -> 201 draft (or pending_review when requested), validated fields', async () => {
  const events = await captureEvents(async () => {
    const created = await call('POST', '/promotions', {
      body: {
        type: 'free_delivery',
        title: 'Free delivery weekend',
        description: 'Free delivery on carts above TZS 30,000.',
        budgetTZS: 120000,
        discountRateBps: 0,
        target: 'all',
        startsAt: Date.now(),
        endsAt: Date.now() + 3 * 86400000,
      },
    });
    assert.equal(created.status, 201);
    const p = created.body;
    assert.equal(p.status, 'draft', 'creates land in draft by default');
    assert.equal(p.merchantId, 'm_demo');
    assert.equal(p.type, 'free_delivery');
    assert.equal(p.redeemCount, 0);
    assert.equal(p.impressions, 0);
    assert.equal(p.spendTZS, 0);
    assert.equal(Number.isInteger(p.budgetTZS), true);
    assert.equal(p.couponAmountTZS, null);
  });
  assert.ok(events.some((e) => e.type === 'promotion.created'), 'promotion.created emitted');

  const pending = await call('POST', '/promotions', { body: { type: 'coupon', title: 'Send to review', status: 'pending_review', budgetTZS: 50000 } });
  assert.equal(pending.status, 201);
  assert.equal(pending.body.status, 'pending_review', 'explicit pending_review is honoured');

  const badTitle = await call('POST', '/promotions', { body: { type: 'discount', title: '' } });
  assert.equal(badTitle.status, 400);
  assert.equal(badTitle.body.error.code, 'TITLE_REQUIRED');

  const badType = await call('POST', '/promotions', { body: { type: 'bogus', title: 'X' } });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, 'INVALID_PROMOTION_TYPE');

  const floatBudget = await call('POST', '/promotions', { body: { type: 'discount', title: 'Float', budgetTZS: 12.5 } });
  assert.equal(floatBudget.status, 400);
  assert.equal(floatBudget.body.error.code, 'INVALID_AMOUNT', 'float TZS rejected — integer only');
});

test('promotions: PATCH updates own promotion and persists; 404 for others/ghosts', async () => {
  const patched = await call('PATCH', '/promotions/promo_seed_pending', { body: { title: 'Renamed welcome offer', budgetTZS: 250000, endsAt: Date.now() + 60 * 86400000 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title, 'Renamed welcome offer');
  assert.equal(patched.body.budgetTZS, 250000);

  const read = await call('GET', '/promotions?status=pending_review');
  const found = read.body.find((p: any) => p.id === 'promo_seed_pending');
  assert.equal(found.title, 'Renamed welcome offer', 'PATCH persists across GET');

  const missing = await call('PATCH', '/promotions/ghost', { body: { title: 'X' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PROMOTION_NOT_FOUND');

  const tooLong = await call('PATCH', '/promotions/promo_seed_live', { body: { title: 'x'.repeat(161) } });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'INVALID_TITLE', 'title capped at 160');
});

test('promotions: pause/resume toggles live<->paused; invalid states conflict', async () => {
  const events = await captureEvents(async () => {
    const paused = await call('POST', '/promotions/promo_seed_live/pause', { body: { paused: true } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');
  });
  assert.ok(events.some((e) => e.type === 'promotion.paused'), 'promotion.paused emitted');

  const resumed = await call('POST', '/promotions/promo_seed_live/pause', { body: { paused: false } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'live');

  const missingFlag = await call('POST', '/promotions/promo_seed_live/pause', { body: {} });
  assert.equal(missingFlag.status, 400);
  assert.equal(missingFlag.body.error.code, 'PAUSED_REQUIRED');

  const draftConflict = await call('POST', '/promotions/promo_seed_pending/pause', { body: { paused: true } });
  assert.equal(draftConflict.status, 409);
  assert.equal(draftConflict.body.error.code, 'PROMOTION_STATUS_CONFLICT', 'wrong-state pause/resume uses the contract code (PROMOTIONS.md)');

  const read = await call('GET', '/promotions');
  assert.equal(read.body.find((p: any) => p.id === 'promo_seed_live').status, 'live', 'toggle persists');
});

test('promotions: performance returns contract shape with integer TZS and roiPercent', async () => {
  const res = await call('GET', '/promotions/promo_seed_live/performance');
  assert.equal(res.status, 200);
  const perf = res.body;
  assert.equal(perf.promotionId, 'promo_seed_live');
  assert.equal(perf.impressions, 18600);
  assert.equal(perf.clicks, 1340);
  assert.equal(perf.redeemCount, 47);
  assert.equal(perf.spendTZS, 120000);
  assert.equal(perf.attributedRevenueTZS, 960000);
  assert.equal(Number.isInteger(perf.spendTZS), true);
  assert.equal(perf.roiPercent, 700, 'roiPercent = (revenue - spend) / spend * 100 = 700%');
  assert.equal(typeof perf.roiPercent, 'number');

  const zeroSpend = await call('GET', '/promotions/promo_seed_pending/performance');
  assert.equal(zeroSpend.status, 200);
  assert.equal(zeroSpend.body.roiPercent, 0, 'no spend -> roiPercent 0');

  const missing = await call('GET', '/promotions/ghost/performance');
  assert.equal(missing.status, 404);
});

/* ================= Brand display (contract /marketing/brand-display) ================= */

test('brand-display: GET returns the seeded campaign; POST upserts create + update', async () => {
  const get = await call('GET', '/marketing/brand-display');
  assert.equal(get.status, 200);
  assert.equal(get.body.id, 'bd_seed_1');
  assert.equal(get.body.active, true);
  assert.equal(get.body.name, 'BBQ brand awareness');
  assert.equal(Number.isInteger(get.body.budgetTZS), true);
  assert.equal(Number.isInteger(get.body.impressions), true);

  const events = await captureEvents(async () => {
    const updated = await call('POST', '/marketing/brand-display', {
      body: { name: 'BBQ awareness v2', budgetTZS: 500000, startsAt: Date.now(), endsAt: Date.now() + 30 * 86400000, active: true },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.id, 'bd_seed_1', 'upsert keeps the existing campaign id');
    assert.equal(updated.body.name, 'BBQ awareness v2');
    assert.equal(updated.body.budgetTZS, 500000);
    assert.equal(updated.body.impressions, 41200, 'impressions preserved across update');
  });
  assert.ok(events.some((e) => e.type === 'marketing.brand_display_updated'), 'marketing.brand_display_updated emitted');

  const badBudget = await call('POST', '/marketing/brand-display', { body: { name: 'X', budgetTZS: 0, startsAt: Date.now(), endsAt: Date.now() + 1000 } });
  assert.equal(badBudget.status, 400);
  assert.equal(badBudget.body.error.code, 'INVALID_BUDGET');

  const badDates = await call('POST', '/marketing/brand-display', { body: { name: 'X', budgetTZS: 100, startsAt: Date.now() + 1000, endsAt: Date.now() } });
  assert.equal(badDates.status, 400);
  assert.equal(badDates.body.error.code, 'INVALID_DATE_RANGE');
});

/* ================= DianJin (PPC) campaigns (contract /marketing/dianjin) ================= */

test('dianjin: list + create (201) + toggle active/paused with validation', async () => {
  const list = await call('GET', '/marketing/dianjin');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body), 'bare array per contract');
  assert.equal(list.body[0].id, 'dj_seed_1');
  assert.equal(list.body[0].active, true);
  assert.equal(Number.isInteger(list.body[0].budgetTZS), true);
  assert.equal(Number.isInteger(list.body[0].bidBps), true, 'bidBps integer');

  const events = await captureEvents(async () => {
    const created = await call('POST', '/marketing/dianjin', { body: { name: 'Weekend push', budgetTZS: 80000, bidBps: 300 } });
    assert.equal(created.status, 201);
    assert.equal(created.body.active, false, 'new campaigns default inactive');
    assert.equal(created.body.spendTZS, 0);
    assert.equal(created.body.clicks, 0);
  });
  assert.ok(events.some((e) => e.type === 'marketing.dianjin_created'), 'marketing.dianjin_created emitted');

  const toggled = await call('PATCH', '/marketing/dianjin/dj_seed_1/toggle', { body: { active: false } });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.active, false);

  const backOn = await call('PATCH', '/marketing/dianjin/dj_seed_1/toggle', { body: { active: true } });
  assert.equal(backOn.status, 200);
  assert.equal(backOn.body.active, true);

  const missingFlag = await call('PATCH', '/marketing/dianjin/dj_seed_1/toggle', { body: {} });
  assert.equal(missingFlag.status, 400);
  assert.equal(missingFlag.body.error.code, 'ACTIVE_REQUIRED');

  const badBudget = await call('POST', '/marketing/dianjin', { body: { name: 'X', budgetTZS: 10.5, bidBps: 300 } });
  assert.equal(badBudget.status, 400);
  assert.equal(badBudget.body.error.code, 'INVALID_AMOUNT', 'float budget rejected — integer TZS only');

  const badBid = await call('POST', '/marketing/dianjin', { body: { name: 'X', budgetTZS: 100, bidBps: 20000 } });
  assert.equal(badBid.status, 400);
  assert.equal(badBid.body.error.code, 'INVALID_BID');

  const ghost = await call('PATCH', '/marketing/dianjin/ghost/toggle', { body: { active: true } });
  assert.equal(ghost.status, 404);
});

/* ================= Flash sales (contract /marketing/flash-sales) ================= */

test('flash-sales: list + create (201, status derived from window) + PATCH update', async () => {
  const list = await call('GET', '/marketing/flash-sales');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body[0].id, 'fs_seed_live');
  assert.equal(list.body[0].status, 'live');
  assert.equal(list.body[0].discountBps, 2500);
  assert.equal(Number.isInteger(list.body[0].soldCount), true);

  const events = await captureEvents(async () => {
    const upcoming = await call('POST', '/marketing/flash-sales', {
      body: { itemIds: ['p1'], discountBps: 3000, startsAt: Date.now() + 86400000, endsAt: Date.now() + 3 * 86400000 },
    });
    assert.equal(upcoming.status, 201);
    assert.equal(upcoming.body.status, 'scheduled', 'future window -> scheduled');
    assert.equal(upcoming.body.soldCount, 0);
    assert.equal(upcoming.body.discountBps, 3000);
  });
  assert.ok(events.some((e) => e.type === 'marketing.flash_sale_created'), 'marketing.flash_sale_created emitted');

  const now = await call('POST', '/marketing/flash-sales', {
    body: { itemIds: ['p6'], discountBps: 1500, startsAt: Date.now() - 3600000, endsAt: Date.now() + 3600000 },
  });
  assert.equal(now.body.status, 'live', 'running window -> live');

  const patched = await call('PATCH', '/marketing/flash-sales/fs_seed_live', { body: { discountBps: 2000, quantityLimit: 50 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.discountBps, 2000);
  assert.equal(patched.body.quantityLimit, 50);

  const badItems = await call('POST', '/marketing/flash-sales', { body: { itemIds: [], discountBps: 1000, startsAt: Date.now(), endsAt: Date.now() + 1000 } });
  assert.equal(badItems.status, 400);
  assert.equal(badItems.body.error.code, 'ITEMS_REQUIRED');

  const badBps = await call('POST', '/marketing/flash-sales', { body: { itemIds: ['p1'], discountBps: 0, startsAt: Date.now(), endsAt: Date.now() + 1000 } });
  assert.equal(badBps.status, 400);
  assert.equal(badBps.body.error.code, 'INVALID_DISCOUNT');

  const ghost = await call('PATCH', '/marketing/flash-sales/ghost', { body: { discountBps: 1000 } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error.code, 'FLASH_SALE_NOT_FOUND');
});

/* ================= Precision campaigns (contract /marketing/precision) ================= */

test('precision: list + create (201 draft) + send marks sent with segment count; resend conflicts', async () => {
  const list = await call('GET', '/marketing/precision');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body[0].id, 'pc_seed_1');
  assert.equal(list.body[0].status, 'draft');
  assert.equal(list.body[0].offer.type, 'coupon');

  const events = await captureEvents(async () => {
    const created = await call('POST', '/marketing/precision', {
      body: { name: 'Lapsed buyers push', segmentId: 'seg_lapsed', offer: { type: 'discount', value: '10%' } },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.sentCount, 0);
    assert.equal(created.body.segmentLabel, 'Lapsed 30d+', 'segment label resolved server-side');
  });
  assert.ok(events.some((e) => e.type === 'marketing.precision_created'), 'marketing.precision_created emitted');

  const sent = await call('POST', '/marketing/precision/pc_seed_1/send');
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.sentCount, 23, 'sentCount = segment count (VIP has 23)');

  const resend = await call('POST', '/marketing/precision/pc_seed_1/send');
  assert.equal(resend.status, 409);
  assert.equal(resend.body.error.code, 'ALREADY_SENT');

  const badSegment = await call('POST', '/marketing/precision', { body: { name: 'X', segmentId: 'seg_ghost', offer: { type: 'message' } } });
  assert.equal(badSegment.status, 400);
  assert.equal(badSegment.body.error.code, 'INVALID_SEGMENT');

  const badOffer = await call('POST', '/marketing/precision', { body: { name: 'X', segmentId: 'seg_vip', offer: { type: 'bogus' } } });
  assert.equal(badOffer.status, 400);
  assert.equal(badOffer.body.error.code, 'INVALID_OFFER');

  const ghost = await call('POST', '/marketing/precision/ghost/send');
  assert.equal(ghost.status, 404);
});

/* ================= Self-service promotion (contract /marketing/self-service) ================= */

test('self-service: GET seeded status; POST toggles active and persists', async () => {
  const get = await call('GET', '/marketing/self-service');
  assert.equal(get.status, 200);
  assert.equal(get.body.active, true);
  assert.equal(get.body.package, 'basic');
  assert.equal(get.body.homepageExposure, true);
  assert.ok(get.body.startedAt > 0, 'startedAt epoch ms');

  const events = await captureEvents(async () => {
    const off = await call('POST', '/marketing/self-service', { body: { active: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);
    assert.equal(off.body.package, 'basic', 'package preserved on toggle');
  });
  assert.ok(events.some((e) => e.type === 'marketing.self_service_updated'), 'marketing.self_service_updated emitted');

  const on = await call('POST', '/marketing/self-service', { body: { active: true, package: 'premium', designUrl: 'https://example.com/promo' } });
  assert.equal(on.status, 200);
  assert.equal(on.body.active, true);
  assert.equal(on.body.package, 'premium');
  assert.equal(on.body.designUrl, 'https://example.com/promo');

  const read = await call('GET', '/marketing/self-service');
  assert.equal(read.body.active, true, 'toggle persists across GET');
  assert.equal(read.body.package, 'premium');

  const missingFlag = await call('POST', '/marketing/self-service', { body: {} });
  assert.equal(missingFlag.status, 400);
  assert.equal(missingFlag.body.error.code, 'ACTIVE_REQUIRED');
});

/* ================= Coupons (contract /marketing/coupons/verify + /stats) ================= */

test('coupons: stats GET returns claimed/used/conversionRate from real coupon rows', async () => {
  const res = await call('GET', '/marketing/coupons/cc_seed_1/stats');
  assert.equal(res.status, 200);
  const stats = res.body;
  assert.equal(stats.couponId, 'cc_seed_1');
  assert.equal(stats.claimed, 4, 'four seeded coupons');
  assert.equal(stats.used, 1, 'one used');
  assert.equal(stats.conversionRate, 25, '1/4 * 100 = 25');
  assert.equal(typeof stats.conversionRate, 'number');

  const missing = await call('GET', '/marketing/coupons/ghost/stats');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'COUPON_NOT_FOUND');
});

test('coupons: verify resolves codes — available/claimed 200, used/expired/invalid 409', async () => {
  const events = await captureEvents(async () => {
    const ok = await call('POST', '/marketing/coupons/verify', { body: { code: 'SAVE10' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.code, 'SAVE10');
    assert.equal(ok.body.status, 'available');
    assert.equal(ok.body.campaignId, 'cc_seed_1');
    assert.equal(ok.body.discountTZS, 5000, 'integer TZS');
  });
  assert.ok(events.some((e) => e.type === 'marketing.coupon_verified'), 'marketing.coupon_verified emitted');

  const claimed = await call('POST', '/marketing/coupons/verify', { body: { code: 'fresh15' } });
  assert.equal(claimed.status, 200, 'case-insensitive lookup');
  assert.equal(claimed.body.status, 'claimed');

  const used = await call('POST', '/marketing/coupons/verify', { body: { code: 'USED5K' } });
  assert.equal(used.status, 409);
  assert.equal(used.body.error.code, 'ALREADY_USED');

  const expired = await call('POST', '/marketing/coupons/verify', { body: { code: 'OLDSALE' } });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, 'EXPIRED');

  const invalid = await call('POST', '/marketing/coupons/verify', { body: { code: 'NOPE123' } });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.error.code, 'INVALID_CODE');

  const empty = await call('POST', '/marketing/coupons/verify', { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'CODE_REQUIRED');
});

test('auth: marketing endpoints require a session (401 without token)', async () => {
  const anon = await call('GET', '/promotions', { auth: false });
  assert.equal(anon.status, 401);
});
