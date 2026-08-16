/* M5c — Universal activity center data paths (§13): every segment's repo
 * returns seeded items (active first, history below is the screen's concern),
 * and the home feed carries the membership + recent-orders data the dashboard
 * cards render. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState } from './helpers';
import { getState } from '@/repos/mock/mockState';
import { MockBookingsRepository } from '@/repos/mock/bookings';
import { MockReservationsRepository } from '@/repos/mock/reservations';
import { MockVouchersRepository } from '@/repos/mock/vouchers';
import { MockDineInRepository } from '@/repos/mock/dineIn';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { MockHomeRepository } from '@/repos/mock/home';
import { MockMerchantsRepository } from '@/repos/mock/merchants';
import { isActiveOrder } from '@/lib/order';
import { PromotionType } from '@hudumika/contract';

const bookings = new MockBookingsRepository();
const reservations = new MockReservationsRepository();
const vouchers = new MockVouchersRepository();
const dineIn = new MockDineInRepository();
const orders = new MockOrdersRepository();
const home = new MockHomeRepository();
const merchants = new MockMerchantsRepository();

beforeEach(() => resetMockState());

test('activity orders segment: seeded orders with active first', async () => {
  const all = await orders.list({ limit: 50 });
  assert.ok(all.length >= 8, 'seeded order volume');
  const firstActive = all.findIndex((o) => isActiveOrder(o.status));
  const firstHistory = all.findIndex((o) => !isActiveOrder(o.status));
  assert.ok(firstActive >= 0 && firstHistory >= 0, 'both groups present');
  assert.ok(firstActive < firstHistory, 'active orders lead the list');
  for (const o of all) {
    assert.ok(Number.isInteger(o.totals.totalTZS), 'integer TZS totals');
    assert.ok(o.createdAt, 'rows render a timestamp');
  }
});

test('activity bookings segment: seeded bookings across active and history', async () => {
  const all = await bookings.list({ limit: 50 });
  assert.ok(all.length >= 4, 'seeded booking volume');
  const statuses = all.map((b) => b.status);
  assert.ok(statuses.includes('provider_accepted'), 'active booking seeded');
  assert.ok(statuses.some((s) => ['quote_submitted', 'declined', 'no_show'].includes(s)), 'history bookings seeded');
  for (const b of all) {
    assert.ok(b.id && b.scheduledFor, 'id + time present');
    if (b.price) assert.ok(Number.isInteger(b.price.totalTZS), 'integer TZS price');
  }
});

test('activity reservations segment: seeded reservations with pending + confirmed', async () => {
  const all = await reservations.list();
  assert.ok(all.length >= 2, 'seeded reservation volume');
  const statuses = all.map((r) => r.status);
  assert.ok(statuses.includes('pending'), 'pending reservation seeded');
  assert.ok(statuses.includes('confirmed'), 'confirmed reservation seeded');
  for (const r of all) {
    assert.ok(r.merchantId && r.partySize > 0 && r.scheduledFor, 'row fields present');
  }
});

test('activity vouchers segment: seeded wallet with statuses the pill maps', async () => {
  const all = await vouchers.list();
  assert.ok(all.length >= 5, 'one voucher per status');
  const statuses = new Set(all.map((v) => v.status));
  for (const s of ['unused', 'redeemed', 'expired', 'refunded', 'void']) {
    assert.ok(statuses.has(s), `voucher status ${s} seeded`);
  }
  assert.ok(all.some((v) => Number.isInteger(v.priceTZS)), 'integer TZS price');
  assert.ok(all.every((v) => v.purchasedAt), 'purchasedAt renders the time');
});

test('activity dine-in segment: seeded bills, open bill leads', async () => {
  const all = await dineIn.listMyOrders();
  assert.ok(all.length >= 2, 'seeded dine-in bills');
  const open = all.filter((o) => ['open', 'billing'].includes(o.status));
  const paid = all.filter((o) => o.status === 'paid');
  assert.ok(open.length >= 1 && paid.length >= 1, 'open + paid bills seeded');
  for (const o of all) {
    assert.ok(o.tableId && o.createdAt, 'row fields present');
    assert.ok(Number.isInteger(o.totals.totalTZS), 'integer TZS total');
  }
});

test('home feed: membership and recentOrders present for the seed', async () => {
  const feed = await home.getHomeFeed();
  assert.ok(feed.membership, 'membership card data present');
  assert.equal(typeof feed.membership!.points, 'number');
  assert.ok(feed.membership!.level.length > 0, 'level name renders');
  assert.ok(Array.isArray(feed.recentOrders) && (feed.recentOrders ?? []).length > 0, 'reorder strip has orders');
  const recent = feed.recentOrders![0];
  assert.ok(recent.no ?? recent.id, 'order number renders');
  assert.ok(recent.status && Number.isInteger(recent.totals.totalTZS), 'status + amount render');
});

test('campaign pill source: only the seeded merchant has a live coupon promotion', async () => {
  const feed = await home.getHomeFeed();
  const merchantsWithCoupon: string[] = [];
  for (const m of (feed.merchants ?? []).slice(0, 6)) {
    const promos = await merchants.getPromotions(m.id);
    if (promos.some((p) => p.type === PromotionType.coupon && p.status === 'live')) {
      merchantsWithCoupon.push(m.id);
    }
  }
  const state = getState();
  assert.deepEqual(merchantsWithCoupon, [state.merchants[0].id], 'pill renders only for merchant 0');
  const first = await merchants.getPromotions(state.merchants[0].id);
  const coupon = first.find((p) => p.type === PromotionType.coupon);
  assert.ok(coupon?.title, 'pill text comes from the promotion title');
});
