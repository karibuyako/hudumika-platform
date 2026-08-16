import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { runSweeperJobs } from '@/mock/sweeper';
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

const DAY = 86400000;
const DAYS = (n: number) => n * DAY;

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

/** Snapshot/restore the overdue seeded new orders so sweeper runs do not
 *  auto-cancel them (same pattern as tests/contract.test.ts). */
function preserveOrders() {
  const orders = db.table('orders');
  const saved = ['o_seed_0', 'o_seed_1', 'o_seed_2'].map((id) => ({ id, row: { ...orders.find(id)! } }));
  for (const s of saved) orders.update(s.id, { deadlineAt: Date.now() + 600000 });
  return () => {
    for (const s of saved) {
      const cur = orders.find(s.id);
      if (cur) orders.update(s.id, s.row);
    }
  };
}

/* ================= 1. Ads removal (PROMOTIONS.md — traffic phased, hidden) ================= */

test('campaigns: ads/traffic rows never surface in lists; no hardcoded ¥ titles', async () => {
  for (const path of ['/campaigns', '/coupon-campaigns']) {
    const res = await call('GET', path);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.campaigns));
    for (const c of res.body.campaigns) {
      assert.notEqual(c.type, 'ads', 'ads campaign type is not surfaced');
      assert.ok(!String(c.title).includes('¥'), 'no hardcoded ¥ in campaign titles');
    }
  }
  /* the seeded ads row stays in the store (sweeper attribution) but is hidden */
  const stored = db.table('campaigns').find('cp3');
  assert.ok(stored && stored.type === 'ads', 'ads row remains in the store for sweeper attribution');
});

/* ================= 2. Segments contract shape + rule-builder API (CRM.md) ================= */

test('segments: GET returns the contract CustomerSegment fields (name/rules/memberCount) additively', async () => {
  const res = await call('GET', '/segments');
  assert.equal(res.status, 200);
  const segs = res.body.segments;
  assert.ok(Array.isArray(segs) && segs.length >= 4);
  const vip = segs.find((s: any) => s.id === 'seg_vip');
  assert.ok(vip, 'seeded vip segment present');
  assert.equal(vip.name, 'VIP · 5+ orders', 'contract name field');
  assert.ok(vip.rules && typeof vip.rules === 'object', 'opaque rules bag present');
  assert.equal(Number.isInteger(vip.memberCount), true, 'memberCount computed server-side');
  assert.equal(vip.memberCount, vip.count, 'memberCount matches the computed count');
  assert.ok(vip.createdAt > 0);
});

test('segments: POST creates a segment (name + rules) with server-computed memberCount', async () => {
  const created = await call('POST', '/segments', {
    body: { name: 'High spenders', rules: { minSpendTZS: 150000, minOrders: 5, recencyDays: 60 } },
  });
  assert.equal(created.status, 200);
  const seg = created.body.segment;
  assert.equal(seg.name, 'High spenders');
  assert.deepEqual(seg.rules, { minSpendTZS: 150000, minOrders: 5, recencyDays: 60 });
  assert.ok(Number.isInteger(seg.memberCount), 'memberCount computed server-side, never client-estimated');
  assert.ok(seg.memberCount > 0);
  assert.ok(seg.id.startsWith('seg_'));

  const read = await call('GET', '/segments');
  assert.ok(read.body.segments.some((s: any) => s.id === seg.id), 'created segment listed');

  const badRule = await call('POST', '/segments', { body: { name: 'Bad', rules: { minSpendTZS: 12.5 } } });
  assert.equal(badRule.status, 422);
  assert.equal(badRule.body.error.code, 'SEGMENT_RULES_INVALID');
  assert.ok(badRule.body.error.details?.minSpendTZS, 'field error carried in details');

  const badKey = await call('POST', '/segments', { body: { name: 'Bad2', rules: { astroSign: 'leo' } } });
  assert.equal(badKey.status, 422);
  assert.equal(badKey.body.error.code, 'SEGMENT_RULES_INVALID', 'unsupported predicates rejected');

  const badName = await call('POST', '/segments', { body: { name: 'x'.repeat(81), rules: { minOrders: 2 } } });
  assert.equal(badName.status, 422);
  assert.equal(badName.body.error.code, 'SEGMENT_RULES_INVALID');
});

test('segments: legacy coupon-send body (segmentId + amount) still creates the campaign', async () => {
  const res = await call('POST', '/segments', { body: { segmentId: 'seg_lapsed', amount: 15 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.campaign.type, 'coupon');
  assert.equal(res.body.sent > 0, true);
  assert.ok(!String(res.body.campaign.title).includes('¥'), 'campaign title is TZS');
});

/* ================= 3. Promotion conflicts + moderation + budget ================= */

test('promotions: create/re-pause against an overlapping live promotion -> PROMOTION_CONFLICT_ACTIVE with details', async () => {
  /* A: live free_delivery promotion (pending_review -> admin approved) */
  const a = await call('POST', '/promotions', {
    body: { type: 'free_delivery', title: 'FD weekend A', status: 'pending_review', budgetTZS: 50000, startsAt: Date.now(), endsAt: Date.now() + DAYS(7) },
  });
  assert.equal(a.status, 201);
  const approved = await call('POST', `/admin/promotions/${a.body.id}/decision`, { body: { decision: 'approved' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'live');

  /* B: overlapping same-type -> conflict */
  const b = await call('POST', '/promotions', {
    body: { type: 'free_delivery', title: 'FD weekend B', status: 'pending_review', budgetTZS: 50000, startsAt: Date.now() + DAYS(1), endsAt: Date.now() + DAYS(8) },
  });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'PROMOTION_CONFLICT_ACTIVE');
  assert.equal(b.body.error.details.conflicting.id, a.body.id, 'conflicting campaign listed in details');
  assert.equal(b.body.error.details.conflicting.title, 'FD weekend A');

  /* C: non-overlapping window -> allowed */
  const c = await call('POST', '/promotions', {
    body: { type: 'free_delivery', title: 'FD weekend C', budgetTZS: 50000, startsAt: Date.now() + DAYS(30), endsAt: Date.now() + DAYS(37) },
  });
  assert.equal(c.status, 201);

  /* pause A; approve D (overlap with A's window); resuming A conflicts with D */
  const paused = await call('POST', `/promotions/${a.body.id}/pause`, { body: { paused: true } });
  assert.equal(paused.status, 200);
  const d = await call('POST', '/promotions', {
    body: { type: 'free_delivery', title: 'FD weekend D', status: 'pending_review', budgetTZS: 50000, startsAt: Date.now(), endsAt: Date.now() + DAYS(7) },
  });
  assert.equal(d.status, 201);
  await call('POST', `/admin/promotions/${d.body.id}/decision`, { body: { decision: 'approved' } });

  const resume = await call('POST', `/promotions/${a.body.id}/pause`, { body: { paused: false } });
  assert.equal(resume.status, 409);
  assert.equal(resume.body.error.code, 'PROMOTION_CONFLICT_ACTIVE', 'resuming a conflicting promotion is rejected');
  assert.equal(resume.body.error.details.conflicting.id, d.body.id);
});

test('promotions: moderation — adminPromotionDecision approved/rejected/paused + promotion.moderated + rejectReason', async () => {
  const pending = await call('POST', '/promotions', {
    body: { type: 'brand', title: 'Brand display review', status: 'pending_review', budgetTZS: 200000 },
  });
  assert.equal(pending.status, 201);
  assert.equal(pending.body.status, 'pending_review');

  const events = await captureEvents(async () => {
    const rejected = await call('POST', `/admin/promotions/${pending.body.id}/decision`, { body: { decision: 'rejected', reason: 'Budget cap too low for brand placement' } });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(rejected.body.rejectReason, 'Budget cap too low for brand placement');
  });
  assert.ok(events.some((e) => e.type === 'promotion.moderated' && e.decision === 'rejected'), 'promotion.moderated emitted');
  const notes = db.table('notifications').where((n: any) => n.merchantId === 'm_demo' && n.title === 'Promotion moderated');
  assert.ok(notes.length >= 1, 'merchant notification inserted on moderation');

  const rejectedList = await call('GET', '/promotions?status=rejected');
  assert.ok(rejectedList.body.some((p: any) => p.id === pending.body.id), 'rejected promotion listed with rejectReason');

  const invalid = await call('POST', '/admin/promotions/ghost/decision', { body: { decision: 'approved' } });
  assert.equal(invalid.status, 404);
  assert.equal(invalid.body.error.code, 'PROMOTION_NOT_FOUND');

  const badDecision = await call('POST', `/admin/promotions/${pending.body.id}/decision`, { body: { decision: 'bogus' } });
  assert.equal(badDecision.status, 400);
});

test('promotions: sweeper ticks live promotion spend; past budget -> ended + PROMOTION_BUDGET_EXCEEDED', async () => {
  const restore = preserveOrders();
  try {
    const created = await call('POST', '/promotions', {
      body: { type: 'spend_based', title: 'Budget tick target', status: 'pending_review', budgetTZS: 1000, startsAt: Date.now() - DAYS(1), endsAt: Date.now() + DAYS(7) },
    });
    assert.equal(created.status, 201);
    const approved = await call('POST', `/admin/promotions/${created.body.id}/decision`, { body: { decision: 'approved' } });
    assert.equal(approved.body.status, 'live');
    assert.equal(approved.body.spendTZS, 0);

    let row = db.table('promotions').find(created.body.id)!;
    for (let i = 0; i < 500 && row.status === 'live'; i++) {
      runSweeperJobs();
      row = db.table('promotions').find(created.body.id)!;
    }
    assert.equal(row.status, 'ended', 'promotion ended server-side once spend reached budget');
    assert.equal(row.budgetExceededReason, 'PROMOTION_BUDGET_EXCEEDED');
    assert.equal(row.spendTZS, 1000, 'spend capped at budget');
    assert.ok((row.impressions ?? 0) > 0, 'promotion gained impressions');
    assert.ok(row.clicks <= row.impressions, 'clicks <= impressions');
  } finally {
    restore();
  }
});

/* ================= 4. Coupon campaigns (POST /coupons -> CouponCampaign) ================= */

test('coupons: campaign-shaped POST /coupons creates a CouponCampaign with quantity/min-spend/validity/kind', async () => {
  const events = await captureEvents(async () => {
    const created = await call('POST', '/coupons', {
      body: { title: 'Weekend grill drop', kind: 'fixed', discountTZS: 5000, minimumSpendTZS: 25000, quantity: 100, validUntil: Date.now() + DAYS(14) },
    });
    assert.equal(created.status, 200);
    const cc = created.body.couponCampaign;
    assert.equal(cc.title, 'Weekend grill drop');
    assert.equal(cc.kind, 'fixed');
    assert.equal(cc.discountTZS, 5000);
    assert.equal(cc.minimumSpendTZS, 25000);
    assert.equal(cc.quantity, 100);
    assert.equal(cc.claimedCount, 0);
    assert.equal(cc.status, 'live');
    assert.equal(cc.merchantId, 'm_demo');
  });
  assert.ok(events.some((e) => e.type === 'marketing.coupon_campaign_created'), 'coupon_campaign_created emitted');

  const list = await call('GET', '/marketing/coupons');
  assert.equal(list.status, 200);
  assert.ok(list.body.coupons.some((c: any) => c.title === 'Weekend grill drop'), 'campaign listed');

  const stats = await call('GET', '/marketing/coupons/cc_seed_1/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.couponId, 'cc_seed_1');
  assert.equal(stats.body.claimed, 4);
  assert.equal(stats.body.used, 1);
  assert.equal(stats.body.conversionRate, 25);

  const badQty = await call('POST', '/coupons', { body: { title: 'X', quantity: 0, discountTZS: 500, minimumSpendTZS: 0, validUntil: Date.now() + DAYS(7) } });
  assert.equal(badQty.status, 422);
  assert.equal(badQty.body.error.code, 'INVALID_QUANTITY');

  const badKind = await call('POST', '/coupons', { body: { title: 'X', kind: 'bogus', quantity: 5, discountTZS: 500, minimumSpendTZS: 0, validUntil: Date.now() + DAYS(7) } });
  assert.equal(badKind.status, 422);
  assert.equal(badKind.body.error.code, 'INVALID_COUPON_KIND');

  /* legacy single-coupon body still works (contract-aliases parity) */
  const legacy = await call('POST', '/coupons', { body: { amountTZS: 5000 } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.coupon.amountTZS, 5000);
});

/* ================= 5. Loyalty tier discountBps + member redeem ================= */

test('loyalty: tier discountBps served alongside bonusRateBps; PUT persists it', async () => {
  const res = await call('GET', '/membership-tiers');
  assert.equal(res.status, 200);
  const gold = res.body.tiers.find((t: any) => t.id === 'tier_gold');
  assert.equal(gold.bonusRateBps, 500, 'bonusRateBps unchanged');
  assert.equal(gold.discountBps, 500, 'discountBps served (5%)');

  const put = await call('PUT', '/membership-tiers', {
    body: { tiers: [{ name: 'Silver', thresholdTZS: 10000, bonusRateBps: 250, discountBps: 400, benefits: ['Birthday bonus'] }] },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.tiers[0].discountBps, 400);

  const bad = await call('PUT', '/membership-tiers', {
    body: { tiers: [{ name: 'Silver', thresholdTZS: 10000, bonusRateBps: 250, discountBps: 2.5, benefits: [] }] },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'INVALID_TIER_CONFIG', 'float discountBps rejected');
});

test('loyalty: POST /members/{id}/redeem debits the balance ledger; insufficient -> 409 MEMBER_INSUFFICIENT_BALANCE', async () => {
  const before = db.table('members').find('m_seed_2')!;
  assert.equal(before.balanceTZS, 120000);

  const events = await captureEvents(async () => {
    const res = await call('POST', '/members/m_seed_2/redeem', { body: { amountTZS: 20000 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.member.balanceTZS, 100000);
    assert.equal(res.body.amountTZS, 20000);
  });
  assert.ok(events.some((e) => e.type === 'loyalty.redeemed'), 'loyalty.redeemed emitted');
  const ledger = db.table('loyaltyTransactions').where((tx: any) => tx.memberId === 'm_seed_2' && tx.type === 'redeem');
  assert.ok(ledger.length >= 1, 'append-only ledger redeem entry written');
  assert.equal(ledger[ledger.length - 1].balanceTZS, 100000);

  const insufficient = await call('POST', '/members/m_seed_3/redeem', { body: { amountTZS: 5000 } });
  assert.equal(insufficient.status, 409);
  assert.equal(insufficient.body.error.code, 'MEMBER_INSUFFICIENT_BALANCE');
  assert.equal(insufficient.body.error.details.balanceTZS, 0, 'details carry the balance');
  assert.equal(db.table('members').find('m_seed_3')?.balanceTZS, 0, 'nothing debited on rejection');

  const float = await call('POST', '/members/m_seed_2/redeem', { body: { amountTZS: 12.5 } });
  assert.equal(float.status, 400);
  assert.equal(float.body.error.code, 'INVALID_AMOUNT', 'integer TZS only');
});

/* ================= 6. Precision empty segment + journeys activate/pause ================= */

test('precision: send to an empty segment -> 409 PRECISION_SEGMENT_EMPTY', async () => {
  db.table('segments').insert({
    id: 'seg_empty',
    merchantId: 'm_demo',
    segment: 'new',
    label: 'Empty segment',
    count: 0,
    memberCount: 0,
    avgSpend: 0,
    lastOrderDaysAgo: 0,
    color: '#7B61FF',
    name: 'Empty segment',
    rules: { minOrders: 99 },
    createdAt: Date.now(),
  });
  const created = await call('POST', '/marketing/precision', {
    body: { name: 'Empty push', segmentId: 'seg_empty', offer: { type: 'message' } },
  });
  assert.equal(created.status, 201);
  const sent = await call('POST', `/marketing/precision/${created.body.id}/send`);
  assert.equal(sent.status, 409);
  assert.equal(sent.body.error.code, 'PRECISION_SEGMENT_EMPTY');

  /* non-empty segments still resolve to memberCount */
  const vip = await call('POST', '/marketing/precision', { body: { name: 'VIP push', segmentId: 'seg_vip', offer: { type: 'coupon' } } });
  const vipSent = await call('POST', `/marketing/precision/${vip.body.id}/send`);
  assert.equal(vipSent.status, 200);
  assert.equal(vipSent.body.sentCount, 23, 'sentCount = server-computed memberCount');
});

test('journeys: PATCH /journeys/{id} toggles active/paused; invalid status 422; ghost 404', async () => {
  const activated = await call('PATCH', '/journeys/jrn_seed_1', { body: { status: 'active' } });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.status, 'active');

  const paused = await call('PATCH', '/journeys/jrn_seed_1', { body: { status: 'paused' } });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');

  const read = await call('GET', '/journeys');
  assert.equal(read.body.find((j: any) => j.id === 'jrn_seed_1').status, 'paused', 'toggle persists across GET');

  const invalid = await call('PATCH', '/journeys/jrn_seed_1', { body: { status: 'deleted' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'JOURNEY_STATUS_INVALID');

  const ghost = await call('PATCH', '/journeys/nope', { body: { status: 'active' } });
  assert.equal(ghost.status, 404);
});

/* ================= 7. Platform-event lifecycle + DianJin budget stop ================= */

test('platform-events: enroll sets the enrolled flag (open -> signed + enrolled); closed events -> PLATFORM_EVENT_CLOSED', async () => {
  const joined = await call('POST', '/marketing/platform-events/pc1/enroll', { body: {} });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.campaign.id, 'pc1');
  assert.equal(joined.body.campaign.status, 'signed', 'legacy status vocabulary preserved');
  assert.equal(joined.body.campaign.enrolled, true, 'contract enrolled flag set');

  const closed = await call('POST', '/marketing/platform-events/pc4/enroll', { body: {} });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'PLATFORM_EVENT_CLOSED', 'closed window uses the contract code');

  const missing = await call('POST', '/marketing/platform-events/nope/enroll', { body: {} });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PLATFORM_EVENT_NOT_FOUND');
});

test('dianjin: sweeper ticks spend; past budget -> stopped with DIANJIN_BUDGET_EXCEEDED; reactivation clears it', async () => {
  const restore = preserveOrders();
  try {
    const created = await call('POST', '/marketing/dianjin', { body: { name: 'Budget stop target', budgetTZS: 500, bidBps: 400 } });
    assert.equal(created.status, 201);
    const activated = await call('PATCH', `/marketing/dianjin/${created.body.id}/toggle`, { body: { active: true } });
    assert.equal(activated.body.active, true);

    let row = db.table('dianjinCampaigns').find(created.body.id)!;
    for (let i = 0; i < 300 && row.active; i++) {
      runSweeperJobs();
      row = db.table('dianjinCampaigns').find(created.body.id)!;
    }
    assert.equal(row.active, false, 'delivery stopped past budget');
    assert.equal(row.stoppedReason, 'DIANJIN_BUDGET_EXCEEDED');
    assert.equal(row.spendTZS, 500, 'spend capped at budget');
    assert.ok(row.clicks > 0, 'clicks accrued');

    const toggled = await call('PATCH', `/marketing/dianjin/${created.body.id}/toggle`, { body: { active: true } });
    assert.equal(toggled.body.active, true);
    assert.equal(toggled.body.stoppedReason, null, 'raise-budget reactivation clears the stop reason');
  } finally {
    restore();
  }
});
