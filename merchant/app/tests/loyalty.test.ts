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

/** Collect events of a given type while fn runs. */
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

/* ================= Loyalty members ================= */

test('loyalty: register member 201; duplicate phone -> 409 MEMBER_PHONE_EXISTS', async () => {
  const events = await captureEvents(async () => {
    const created = await call('POST', '/members', { body: { name: 'Zawadi Mwangi', phone: '+255788123456', birthday: '1995-04-12' } });
    assert.equal(created.status, 201);
    const m = created.body.member;
    assert.equal(m.name, 'Zawadi Mwangi');
    assert.equal(m.phone, '+255788123456', 'detail response carries the full phone');
    assert.equal(m.birthday, '1995-04-12');
    assert.equal(m.balanceTZS, 0);
    assert.equal(m.totalSpendTZS, 0);
    assert.equal(m.tierId, 'tier_bronze', 'new members start at the entry tier');
    assert.equal(Number.isInteger(m.balanceTZS), true);
    assert.ok(m.joinedAt > 0);
  });
  assert.ok(events.some((e) => e.type === 'loyalty.member_registered'), 'loyalty.member_registered emitted');

  const dup = await call('POST', '/members', { body: { name: 'Other', phone: '+255 788 123456' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'MEMBER_PHONE_EXISTS');
});

test('loyalty: list masks phone; ?search= finds by phone and by name', async () => {
  const list = await call('GET', '/members');
  assert.equal(list.status, 200);
  const ids = list.body.members.map((m: any) => m.id);
  assert.ok(ids.length >= 3, `three seeded members (got ${ids.length})`);
  for (const id of ['m_seed_1', 'm_seed_2', 'm_seed_3']) assert.ok(ids.includes(id), `seeded member ${id} present`);
  for (const m of list.body.members) {
    assert.equal(m.phone, undefined, 'list rows never carry the raw phone');
    assert.ok(m.maskedPhone, 'list rows carry maskedPhone');
    assert.equal(Number.isInteger(m.balanceTZS), true, 'integer TZS');
  }
  assert.equal(list.body.members.find((m: any) => m.id === 'm_seed_1').maskedPhone, '+2557…');

  const byPhone = await call('GET', '/members?search=713333444');
  assert.equal(byPhone.status, 200);
  assert.deepEqual(byPhone.body.members.map((m: any) => m.id), ['m_seed_2'], 'phone lookup narrows to the exact member');

  const byName = await call('GET', '/members?search=amina');
  assert.deepEqual(byName.body.members.map((m: any) => m.id), ['m_seed_3'], 'name lookup is case-insensitive');

  const none = await call('GET', '/members?search=zzz');
  assert.deepEqual(none.body.members, []);
});

test('loyalty: member detail shape — integer TZS, tier embedded, masked + raw phone', async () => {
  const res = await call('GET', '/members/m_seed_2');
  assert.equal(res.status, 200);
  const m = res.body.member;
  assert.equal(m.id, 'm_seed_2');
  assert.equal(m.name, 'Baraka Kessy');
  assert.equal(m.phone, '+255713333444', 'detail carries the full phone (cashier moment)');
  assert.equal(m.maskedPhone, '+2557…');
  assert.equal(m.balanceTZS, 120000);
  assert.equal(m.totalSpendTZS, 245000);
  assert.equal(Number.isInteger(m.balanceTZS), true);
  assert.equal(Number.isInteger(m.totalSpendTZS), true);
  assert.equal(m.tier.id, 'tier_gold');
  assert.equal(m.tier.name, 'Gold');
  assert.equal(m.tier.thresholdTZS, 200000);
  assert.equal(m.tier.bonusRateBps, 500, 'integer bps');
  assert.equal(Number.isInteger(m.tier.bonusRateBps), true);
  assert.ok(Array.isArray(m.tier.benefits));
  assert.ok(m.joinedAt > 0);

  const missing = await call('GET', '/members/ghost');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'MEMBER_NOT_FOUND');
});

test('loyalty: PATCH updates profile (name/phone/birthday) and persists', async () => {
  const patched = await call('PATCH', '/members/m_seed_3', { body: { name: 'Amina Juma Mhando', birthday: '1998-11-02', phone: '+255754111222' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.member.name, 'Amina Juma Mhando');

  const read = await call('GET', '/members/m_seed_3');
  assert.equal(read.body.member.name, 'Amina Juma Mhando', 'PATCH persists across GET');

  const badBirthday = await call('PATCH', '/members/m_seed_3', { body: { birthday: '04/12/1998' } });
  assert.equal(badBirthday.status, 400);
  assert.equal(badBirthday.body.error.code, 'INVALID_BIRTHDAY');

  const dupPhone = await call('PATCH', '/members/m_seed_3', { body: { phone: '+255712345678' } });
  assert.equal(dupPhone.status, 409);
  assert.equal(dupPhone.body.error.code, 'MEMBER_PHONE_EXISTS');

  const missing = await call('PATCH', '/members/ghost', { body: { name: 'X' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'MEMBER_NOT_FOUND');
});

test('loyalty: top-up below tier threshold -> 422 TOP_UP_BELOW_THRESHOLD', async () => {
  const res = await call('POST', '/members/m_seed_3/top-up', { body: { amountTZS: 10000, paymentMethod: 'mpesa' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'TOP_UP_BELOW_THRESHOLD');
  assert.equal(res.body.error.details.thresholdTZS, 20000, 'details carry the threshold');
  assert.equal(db.table('members').find('m_seed_3')?.balanceTZS, 0, 'nothing credited on rejection');

  const badAmount = await call('POST', '/members/m_seed_3/top-up', { body: { amountTZS: 12.5 } });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error.code, 'INVALID_AMOUNT', 'float amounts rejected — integer TZS only');

  const badMethod = await call('POST', '/members/m_seed_3/top-up', { body: { amountTZS: 30000, paymentMethod: 'bogus' } });
  assert.equal(badMethod.status, 400);
  assert.equal(badMethod.body.error.code, 'INVALID_PAYMENT_METHOD');
});

test('loyalty: top-up above threshold credits balance + bonus per tier bps (exact integer math)', async () => {
  const events = await captureEvents(async () => {
    const res = await call('POST', '/members/m_seed_1/top-up', { body: { amountTZS: 50000, paymentMethod: 'mpesa' }, idem: 'loy-tu-1' });
    assert.equal(res.status, 200);
    const topUp = res.body.topUp;
    assert.equal(topUp.amountTZS, 50000);
    assert.equal(topUp.bonusTZS, 1250, 'bonus = floor(50000 * 250 / 10000)');
    assert.equal(topUp.totalTZS, 51250);
    assert.equal(topUp.member.balanceTZS, 45000 + 50000 + 1250, 'balance credited with amount + bonus');
    assert.equal(topUp.member.totalSpendTZS, 85000 + 50000, 'spend includes the top-up principal');
    assert.equal(topUp.member.tierId, 'tier_bronze', 'spend 135k stays bronze');
    assert.equal(topUp.paymentMethod, 'mpesa');
    assert.ok(topUp.ts > 0);
  });
  assert.ok(events.some((e) => e.type === 'loyalty.topup_credited'), 'loyalty.topup_credited emitted');

  const read = await call('GET', '/members/m_seed_1');
  assert.equal(read.body.member.balanceTZS, 96250, 'credit persists across GET');
});

test('loyalty: top-up promoting past the gold threshold emits loyalty.tier_changed', async () => {
  const events = await captureEvents(async () => {
    const res = await call('POST', '/members/m_seed_3/top-up', { body: { amountTZS: 200000, paymentMethod: 'cash' }, idem: 'loy-tu-2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.topUp.bonusTZS, 5000, 'bonus = floor(200000 * 250 / 10000) at bronze rate');
    assert.equal(res.body.topUp.member.tierId, 'tier_gold', 'spend 215k crosses the gold threshold');
  });
  const changed = events.find((e) => e.type === 'loyalty.tier_changed');
  assert.ok(changed, 'loyalty.tier_changed emitted on promotion');
  if (changed && changed.type === 'loyalty.tier_changed') {
    assert.equal(changed.previousTierId, 'tier_bronze');
    assert.equal(changed.member.tierId, 'tier_gold');
  }
});

test('loyalty: top-up idempotency — same key replays without double-crediting', async () => {
  const before = db.table('members').find('m_seed_2')?.balanceTZS ?? 0;
  const first = await call('POST', '/members/m_seed_2/top-up', { body: { amountTZS: 250000, paymentMethod: 'card' }, idem: 'loy-tu-idem' });
  assert.equal(first.status, 200);
  const second = await call('POST', '/members/m_seed_2/top-up', { body: { amountTZS: 250000, paymentMethod: 'card' }, idem: 'loy-tu-idem' });
  assert.equal(second.status, 200);
  assert.equal(second.body.topUp.member.balanceTZS, first.body.topUp.member.balanceTZS, 'replay returns the cached result');
  assert.equal(db.table('members').find('m_seed_2')?.balanceTZS, before + 250000 + 12500, 'credited exactly once (gold rate 500bps)');
});

/* ================= Membership tiers ================= */

test('loyalty: tier config GET returns seeded tiers sorted by threshold', async () => {
  const res = await call('GET', '/membership-tiers');
  assert.equal(res.status, 200);
  assert.equal(res.body.tiers.length, 2);
  assert.deepEqual(res.body.tiers.map((t: any) => t.id), ['tier_bronze', 'tier_gold'], 'sorted ascending by thresholdTZS');
  const gold = res.body.tiers.find((t: any) => t.id === 'tier_gold');
  assert.equal(gold.thresholdTZS, 200000);
  assert.equal(gold.bonusRateBps, 500);
  assert.deepEqual(gold.benefits, ['Free delivery', 'Priority service']);
});

test('loyalty: PUT /membership-tiers replaces config and validates (422)', async () => {
  const bad = await call('PUT', '/membership-tiers', { body: { tiers: [] } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'INVALID_TIER_CONFIG');

  const badRate = await call('PUT', '/membership-tiers', { body: { tiers: [{ name: 'Silver', thresholdTZS: 10000, bonusRateBps: 2.5, benefits: [] }] } });
  assert.equal(badRate.status, 422);
  assert.equal(badRate.body.error.code, 'INVALID_TIER_CONFIG', 'float bps rejected');

  const dupName = await call('PUT', '/membership-tiers', {
    body: { tiers: [{ name: 'Silver', thresholdTZS: 10000, bonusRateBps: 250, benefits: [] }, { name: 'SILVER', thresholdTZS: 50000, bonusRateBps: 400, benefits: [] }] },
  });
  assert.equal(dupName.status, 422);
  assert.equal(dupName.body.error.code, 'INVALID_TIER_CONFIG', 'duplicate tier names rejected');

  const put = await call('PUT', '/membership-tiers', {
    body: { tiers: [{ name: 'Silver', thresholdTZS: 10000, bonusRateBps: 250, benefits: ['Birthday bonus'] }, { name: 'Platinum', thresholdTZS: 150000, bonusRateBps: 750, benefits: ['Free delivery', 'Chef table'] }] },
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.tiers.map((t: any) => t.name), ['Silver', 'Platinum']);
  assert.equal(put.body.tiers[1].bonusRateBps, 750);

  const read = await call('GET', '/membership-tiers');
  assert.deepEqual(read.body.tiers.map((t: any) => t.name), ['Silver', 'Platinum'], 'PUT persists across GET');

  // members of removed tiers are re-assigned to the entry tier
  const member = await call('GET', '/members/m_seed_2');
  assert.equal(member.body.member.tier.name, 'Silver', 'reassigned to the new entry tier');
});