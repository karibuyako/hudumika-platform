import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { adminDecision } from '@/mock/handlers/group-buy';
import type { GroupBuyDeal, GroupBuyVoucher, VerifyHistoryEntry } from '@/api/types';

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

let ownerToken: string | null = null;

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
  ownerToken = await loginAs('+255700000000');
});

beforeEach(() => {
  token = ownerToken;
});

after(() => {
  server.close();
});

const DEAL_BODY = {
  title: 'Lunch skewer bundle',
  description: 'Ten mixed skewers for two.',
  priceTZS: 35000,
  originalPriceTZS: 55000,
  quantity: 40,
  validityDays: 60,
  salesStartAt: Date.now(),
  salesEndAt: Date.now() + 7 * 86400000,
};

/* ================= Deal lifecycle ================= */

test('group-buy: create deal -> 201 draft; idempotency key returns the same deal', async () => {
  const idem = 't-gb-create-1';
  const first = await call('POST', '/group-buys', { body: DEAL_BODY, idem });
  assert.equal(first.status, 201);
  assert.equal(first.body.deal.status, 'draft');
  assert.equal(first.body.deal.merchantId, 'm_demo');
  assert.equal(first.body.deal.soldCount, 0);
  assert.ok(first.body.deal.id);

  const replay = await call('POST', '/group-buys', { body: DEAL_BODY, idem });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.deal.id, first.body.deal.id, 'idempotent replay returns the original deal');
  const deals = await call('GET', '/group-buys');
  assert.equal(deals.body.deals.filter((d: GroupBuyDeal) => d.id === first.body.deal.id).length, 1, 'no duplicate rows');
});

test('group-buy: title missing -> 400 GROUP_BUY_TITLE_REQUIRED', async () => {
  const res = await call('POST', '/group-buys', { body: { ...DEAL_BODY, title: '' }, idem: 't-gb-title' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'GROUP_BUY_TITLE_REQUIRED');
});

test('group-buy: price range invalid -> 400 GROUP_BUY_PRICE_RANGE_INVALID', async () => {
  const res = await call('POST', '/group-buys', { body: { ...DEAL_BODY, priceTZS: 60000, originalPriceTZS: 50000 }, idem: 't-gb-price' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'GROUP_BUY_PRICE_RANGE_INVALID');
});

test('group-buy: merchant cannot self-publish -> 409 GROUP_BUY_ALREADY_LIVE', async () => {
  const res = await call('POST', '/group-buys', { body: { ...DEAL_BODY, status: 'live' }, idem: 't-gb-live' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'GROUP_BUY_ALREADY_LIVE');
});

test('group-buy: update draft -> pending_review; moderation approval -> live', async () => {
  const created = await call('POST', '/group-buys', { body: DEAL_BODY, idem: 't-gb-update' });
  const id = created.body.deal.id as string;

  const updated = await call('PATCH', `/group-buys/${id}`, { body: { ...DEAL_BODY, title: 'Lunch skewer bundle v2', priceTZS: 32000 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.deal.status, 'pending_review');
  assert.equal(updated.body.deal.title, 'Lunch skewer bundle v2');

  const live = adminDecision(id, 'approved');
  assert.equal(live.status, 'live');

  const detail = await call('GET', `/group-buys/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.deal.status, 'live');
});

test('group-buy: editing a live deal -> 409 GROUP_BUY_STATUS_CONFLICT', async () => {
  const res = await call('PATCH', '/group-buys/gb_seed_live', { body: { ...DEAL_BODY } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'GROUP_BUY_STATUS_CONFLICT');
});

test('group-buy: list filtered by status', async () => {
  const res = await call('GET', '/group-buys?status=live');
  assert.equal(res.status, 200);
  const live = res.body.deals as GroupBuyDeal[];
  assert.ok(live.length >= 1);
  assert.ok(live.every((d) => d.status === 'live'));
  const draft = await call('GET', '/group-buys?status=draft');
  assert.ok((draft.body.deals as GroupBuyDeal[]).every((d) => d.status === 'draft'));
});

/* ================= Extend / delist / relist ================= */

test('group-buy: extend live deal -> 200 with new end date', async () => {
  const before = await call('GET', '/group-buys/gb_seed_live');
  const newEndsAt = (before.body.deal.salesEndAt as number) + 7 * 86400000;
  const res = await call('POST', '/group-buys/gb_seed_live/extend', { body: { newEndsAt } });
  assert.equal(res.status, 200);
  assert.equal(res.body.deal.salesEndAt, newEndsAt);
  assert.equal(res.body.deal.status, 'extended');
});

test('group-buy: extend a draft deal -> 409 GROUP_BUY_STATUS_CONFLICT', async () => {
  const res = await call('POST', '/group-buys/gb_seed_draft/extend', { body: { newEndsAt: Date.now() + 10 * 86400000 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'GROUP_BUY_STATUS_CONFLICT');
});

test('group-buy: delist -> relist -> moderation approve; invalid transitions conflict', async () => {
  const created = await call('POST', '/group-buys', { body: DEAL_BODY, idem: 't-gb-delist' });
  const id = created.body.deal.id as string;
  adminDecision(id, 'approved');

  const delisted = await call('POST', `/group-buys/${id}/delist`, {});
  assert.equal(delisted.status, 200);
  assert.equal(delisted.body.deal.status, 'delisted');

  const delistAgain = await call('POST', `/group-buys/${id}/delist`, {});
  assert.equal(delistAgain.status, 409);
  assert.equal(delistAgain.body.error.code, 'GROUP_BUY_STATUS_CONFLICT');

  const relisted = await call('POST', `/group-buys/${id}/relist`, {});
  assert.equal(relisted.status, 200);
  assert.equal(relisted.body.deal.status, 'pending_review');

  const relistAgain = await call('POST', `/group-buys/${id}/relist`, {});
  assert.equal(relistAgain.status, 409);
  assert.equal(relistAgain.body.error.code, 'GROUP_BUY_STATUS_CONFLICT');

  adminDecision(id, 'approved');
  const detail = await call('GET', `/group-buys/${id}`);
  assert.equal(detail.body.deal.status, 'live');
});

/* ================= Vouchers ================= */

test('voucher: verify unused -> redeemed (200); verify again -> VOUCHER_ALREADY_USED (409)', async () => {
  const res = await call('POST', '/vouchers/GB-7K2M-9QX4/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.voucher.status, 'redeemed');
  assert.equal(res.body.voucher.code, 'GB-7K2M-9QX4');
  assert.equal(res.body.voucher.redeemedByMerchantId, 'm_demo');
  assert.ok(res.body.voucher.redeemedAt);

  const again = await call('POST', '/vouchers/GB-7K2M-9QX4/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'VOUCHER_ALREADY_USED');
});

test('voucher: expired -> VOUCHER_EXPIRED (409)', async () => {
  db.table<GroupBuyVoucher>('vouchers').update('GB-3N8P-5TZ7', { expiresAt: Date.now() - 3600000 });
  const res = await call('POST', '/vouchers/GB-3N8P-5TZ7/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VOUCHER_EXPIRED');
});

test('voucher: unknown code -> VOUCHER_INVALID_CODE (409)', async () => {
  const res = await call('POST', '/vouchers/GB-XX00-0000/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VOUCHER_INVALID_CODE');
});

test('voucher: merchant vouchers list with status filter', async () => {
  const all = await call('GET', '/vouchers/me');
  assert.equal(all.status, 200);
  const codes = (all.body.vouchers as GroupBuyVoucher[]).map((v) => v.code);
  assert.ok(codes.includes('GB-7K2M-9QX4'));
  assert.ok(codes.includes('GB-9W1R-2C6V'));

  const used = await call('GET', '/vouchers/me?status=redeemed');
  assert.ok((used.body.vouchers as GroupBuyVoucher[]).every((v) => v.status === 'redeemed'));
});

test('voucher: deal vouchers list scoped to own deal', async () => {
  const res = await call('GET', '/group-buys/gb_seed_live/vouchers');
  assert.equal(res.status, 200);
  const rows = res.body.vouchers as GroupBuyVoucher[];
  assert.equal(rows.length, 4);
  assert.ok(rows.every((v) => v.groupBuyId === 'gb_seed_live'));
});

test('voucher: verify-history rows carry voucherCode, verifiedAt and verifiedBy', async () => {
  await call('POST', '/vouchers/GB-7K2M-9QX4/verify', { body: { merchantId: 'm_demo' } });
  await call('POST', '/vouchers/GB-XX00-0000/verify', { body: { merchantId: 'm_demo' } });

  const res = await call('GET', '/vouchers/verify-history');
  assert.equal(res.status, 200);
  const rows = res.body.history as (VerifyHistoryEntry & { id: string })[];
  const redeemed = rows.find((r) => r.voucherCode === 'GB-7K2M-9QX4' && r.result === 'redeemed');
  assert.ok(redeemed, 'history contains the redeemed attempt');
  assert.equal(redeemed!.result, 'redeemed');
  assert.ok(redeemed!.verifiedAt, 'verifiedAt present');
  assert.ok(redeemed!.verifiedBy, 'verifiedBy present');
  const invalid = rows.find((r) => r.voucherCode === 'GB-XX00-0000');
  assert.ok(invalid, 'history records failed attempts too');
  assert.equal(invalid!.result, 'invalid');
  assert.equal(invalid!.verifiedBy, 's1', 'verifiedBy is the acting staff id');
});

/* ================= RBAC ================= */

test('group-buy: staff can verify vouchers but cannot manage deals (403)', async () => {
  token = await loginAs('+255700000003');

  const verify = await call('POST', '/vouchers/GB-9W1R-2C6V/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(verify.status, 409);
  assert.equal(verify.body.error.code, 'VOUCHER_ALREADY_USED', 'staff has the redemption permission and reaches the conflict path');

  const list = await call('GET', '/group-buys');
  assert.equal(list.status, 403, 'staff cannot list deals (campaigns:manage required)');
});