/* M8b — Loyalty (check-in, points ledger, redemption) + help center + ticket
 * categories. Repo-level: check-in awards points once per day, streak math,
 * the /loyalty-transactions ledger, the mock-only /loyalty/redemptions
 * mutation (docs/CONTRACT-ADDITIONS.md #16), /help/articles search, and the
 * TicketCreate category that flows into ticket creation. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { clone, getState } from '@/repos/mock/mockState';
import { earnOrderPoints, earnReviewPoints, MockMembershipsRepository, resetMockMembershipsState, setMockCheckInState } from '@/repos/mock/memberships';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { MockReviewsRepository } from '@/repos/mock/reviews';
import { MockWalletRepository } from '@/repos/mock/wallet';
import { MockSupportRepository, mockTicketCategory } from '@/repos/mock/support';
import { nextBonusDay, streakDots, WEEKLY_STREAK_BONUS_POINTS } from '@/lib/streak';
import { ListLoyaltyTransactions200ItemType } from '@hudumika/contract';

const memberships = new MockMembershipsRepository();
const wallet = new MockWalletRepository();
const support = new MockSupportRepository();
const orders = new MockOrdersRepository();
const reviews = new MockReviewsRepository();

const dayAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** A valid COD order against the seeded merchant (paid at create — the point
 * where the mock's accrual engine fires, docs/CONTRACT-ADDITIONS.md #28). */
function paidOrderInput() {
  const state = getState();
  const merchantId = state.merchants[0].id;
  const item = state.catalogues.get(merchantId)!.items[0]!;
  return {
    merchantId,
    items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS }],
    paymentMethod: 'cod' as const,
    deliveryAddress: { label: 'Home', lines: '12 Makunganya St', contactPhone: '+255700000000' },
  };
}

beforeEach(() => {
  resetMockState();
  resetMockMembershipsState();
});

test('check-in awards points once per day; the same-day second tap is a 409 CONFLICT', async () => {
  const before = (await memberships.get()).points;
  const result = await memberships.checkIn('k1');
  assert.equal(result.pointsEarned, 10);
  assert.equal(result.streakDays, 2, 'seeded yesterday check-in extends the streak to 2');
  assert.equal(result.bonusPoints, undefined, 'no bonus outside a 7-day streak');
  const after = await memberships.get();
  assert.equal(after.points, before + 10);

  await rejectsApiError(memberships.checkIn('k2'), 409, 'CONFLICT');
  assert.equal((await memberships.get()).points, before + 10, 'the failed tap awards nothing');
});

test('redeemPoints with sufficient balance debits points, credits the wallet for wallet-credit rewards, and appends a redeem ledger row', async () => {
  // Arrange a balance the seed (240) cannot cover — the mock is the server,
  // so the test sets the store it would seed (resetMockState re-seeds next
  // case). Arranged BEFORE the first repo call so the seeded ledger's
  // balance column stays consistent with membership.points.
  getState().membership.points = 1000;
  const walletBefore = await wallet.getWallet();
  const txsBefore = await wallet.getTransactions();

  const result = await memberships.redeemPoints({ points: 500, reward: 'wallet_credit' }, 'k1');
  assert.equal(result.points, 500, 'redemption returns the updated membership');
  assert.equal((await memberships.get()).points, 500, 'membership.points debited by exactly 500');

  const walletAfter = await wallet.getWallet();
  assert.equal(walletAfter.totalTZS, walletBefore.totalTZS + 5000, 'wallet-credit reward credits integer TZS 5,000');
  assert.equal(walletAfter.withdrawableTZS, walletBefore.withdrawableTZS + 5000);
  assert.ok(Number.isInteger(walletAfter.totalTZS));

  const txs = await wallet.getTransactions();
  assert.equal(txs.length, txsBefore.length + 1);
  assert.equal(txs[0].amountTZS, 5000);
  assert.equal(txs[0].balanceTZS, walletAfter.totalTZS);
  assert.equal(txs[0].referenceType, 'points_redeem');
  assert.equal(txs[0].type, 'adjustment', 'contract WalletTransactionType has no redeem value — adjustment like top-up');

  const ledger = await memberships.listLoyaltyTransactions();
  assert.equal(ledger[0].type, ListLoyaltyTransactions200ItemType.redeem);
  assert.equal(ledger[0].points, -500, 'the ledger row is signed negative');
  assert.equal(ledger[0].balance, 500, 'ledger balance follows the debit');
  assert.equal(ledger[0].reference, 'wallet_credit');
  assert.ok(Number.isInteger(ledger[0].points) && Number.isInteger(ledger[0].balance));
  assert.equal(txs[0].referenceId, ledger[0].id, 'the wallet row links to the ledger row');

  // Non-credit rewards never touch the wallet.
  const walletBeforeFree = await wallet.getWallet();
  await memberships.redeemPoints({ points: 300, reward: 'free_delivery' }, 'k2');
  assert.equal((await memberships.get()).points, 200);
  assert.equal((await wallet.getWallet()).totalTZS, walletBeforeFree.totalTZS, 'free delivery credits no wallet balance');
});

test('redeemPoints rejects an insufficient balance with 422 MEMBER_INSUFFICIENT_BALANCE and no side effects', async () => {
  const walletBefore = await wallet.getWallet();
  const err = await rejectsApiError(
    memberships.redeemPoints({ points: 300, reward: 'free_delivery' }, 'k1'),
    422,
    'MEMBER_INSUFFICIENT_BALANCE',
  );
  assert.ok(err.message.length > 0);
  assert.equal((await memberships.get()).points, 240, 'the rejected redemption debits nothing');
  assert.equal((await memberships.listLoyaltyTransactions()).length, 5, 'no ledger row appended');
  const walletAfter = await wallet.getWallet();
  assert.equal(walletAfter.totalTZS, walletBefore.totalTZS, 'no wallet credit');
  assert.equal(walletAfter.withdrawableTZS, walletBefore.withdrawableTZS, 'no withdrawable credit');
});

test('redeemPoints rejects an unknown reward and a cost mismatch with 422 VALIDATION_FAILED', async () => {
  await rejectsApiError(memberships.redeemPoints({ points: 500, reward: 'gold_voucher' }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(memberships.redeemPoints({ points: 1, reward: 'free_delivery' }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(memberships.redeemPoints({ points: 0, reward: 'free_delivery' }, 'k3'), 422, 'VALIDATION_FAILED');
  assert.equal((await memberships.get()).points, 240, 'nothing was spent');
});

test('redeemPoints is idempotent per key — the same key replays the same redemption, never a double debit', async () => {
  getState().membership.points = 1000;
  const txsBefore = await wallet.getTransactions();
  const ledgerBefore = await memberships.listLoyaltyTransactions();

  const first = await memberships.redeemPoints({ points: 500, reward: 'wallet_credit' }, 'k1');
  const replay = await memberships.redeemPoints({ points: 500, reward: 'wallet_credit' }, 'k1');
  assert.equal(replay.points, first.points, 'the replay returns the same membership');
  assert.equal((await memberships.get()).points, 500, 'the debit happened exactly once');

  const ledger = await memberships.listLoyaltyTransactions();
  assert.equal(ledger.length, ledgerBefore.length + 1, 'exactly one ledger row');
  assert.equal((await wallet.getTransactions()).length, txsBefore.length + 1, 'exactly one wallet credit');

  // A different key with a different body is a NEW redemption — never a replay.
  const different = await memberships.redeemPoints({ points: 250, reward: 'delivery_discount' }, 'k2');
  assert.equal(different.points, 250);
});

test('streak resets after a gap and grows only on consecutive days', async () => {
  // Two days since the last check-in → streak restarts at 1.
  setMockCheckInState(dayAgoIso(2), 6);
  const gap = await memberships.checkIn('k1');
  assert.equal(gap.streakDays, 1);

  // A yesterday check-in continues the run.
  setMockCheckInState(dayAgoIso(1), 4);
  const next = await memberships.checkIn('k2');
  assert.equal(next.streakDays, 5);

  // A fresh session (reset) seeds yesterday's check-in again → streak 2.
  resetMockMembershipsState();
  const fresh = await memberships.checkIn('k3');
  assert.equal(fresh.streakDays, 2);
});

test('7-day streak pays the bonus points', async () => {
  setMockCheckInState(dayAgoIso(1), 6);
  const result = await memberships.checkIn('k1');
  assert.equal(result.streakDays, 7);
  assert.equal(result.bonusPoints, 10);
  assert.equal(result.pointsEarned, 20);
});

test('streakDots maps the streak to a capped 7-day strip', () => {
  assert.deepEqual(streakDots(0), [false, false, false, false, false, false, false], 'no streak = all empty');
  assert.deepEqual(streakDots(1), [true, false, false, false, false, false, false], 'day 1 fills the first dot');
  assert.deepEqual(streakDots(3), [true, true, true, false, false, false, false]);
  assert.deepEqual(streakDots(7), [true, true, true, true, true, true, true], 'a full week fills every dot');
  assert.deepEqual(streakDots(12), [true, true, true, true, true, true, true], 'beyond the cap stays full');
  assert.deepEqual(streakDots(-2), [false, false, false, false, false, false, false], 'negative input clamps to empty');
  assert.deepEqual(streakDots(Number.NaN), [false, false, false, false, false, false, false], 'NaN never crashes the strip');
  assert.deepEqual(streakDots(2, 3), [true, true, false], 'custom cap is honored');
});

test('nextBonusDay points at the next 7-day weekly bonus milestone', () => {
  assert.equal(nextBonusDay(0), 7, 'a fresh streak targets day 7');
  assert.equal(nextBonusDay(1), 7);
  assert.equal(nextBonusDay(6), 7, 'the day before the milestone targets it');
  assert.equal(nextBonusDay(7), 14, 'the bonus day itself has already earned it — next is 14');
  assert.equal(nextBonusDay(13), 14);
  assert.equal(nextBonusDay(14), 21);
  assert.equal(WEEKLY_STREAK_BONUS_POINTS, 10, 'the hint mirrors the mock bonus amount');
});

test('loyalty transactions list returns the seeded ledger newest-first with cursor pagination', async () => {
  const all = await memberships.listLoyaltyTransactions();
  assert.equal(all.length, 5);
  assert.equal(all[0].type, ListLoyaltyTransactions200ItemType.check_in);
  assert.equal(all[0].balance, (await memberships.get()).points, 'ledger balance matches membership points');
  assert.ok(all.some((r) => r.type === 'earn' && r.points > 0));
  assert.ok(all.some((r) => r.type === 'redeem' && r.points < 0));
  assert.ok(all.every((r) => Number.isInteger(r.points) && Number.isInteger(r.balance)));

  const page1 = await memberships.listLoyaltyTransactions({ limit: 2 });
  assert.equal(page1.length, 2);
  assert.deepEqual(page1.map((r) => r.id), all.slice(0, 2).map((r) => r.id));
  const page2 = await memberships.listLoyaltyTransactions({ limit: 2, cursor: '2' });
  assert.deepEqual(page2.map((r) => r.id), all.slice(2, 4).map((r) => r.id));

  // A successful check-in lands at the top of the ledger.
  await memberships.checkIn('k1');
  const after = await memberships.listLoyaltyTransactions();
  assert.equal(after[0].type, ListLoyaltyTransactions200ItemType.check_in);
  assert.equal(after[0].points, 10);
  assert.equal(after[0].balance, after[1].balance + 10);
});

test('membership screen data path: get() reflects the checked-in balance', async () => {
  const before = await memberships.get();
  assert.equal(before.level, 'bronze');
  await memberships.checkIn('k1');
  const after = await memberships.get();
  assert.equal(after.points, before.points + 10);
  const ledger = await memberships.listLoyaltyTransactions();
  assert.equal(ledger[0].balance, after.points);
});

test('help articles: full list, query filter, unknown query is empty', async () => {
  const all = await support.listArticles();
  assert.ok(all.length >= 5, 'seeded knowledge base has 5+ articles');
  assert.ok(all.every((a) => a.id && a.title && a.category));
  for (const a of all) assert.ok(typeof a.title === 'string' && a.title.length > 0);

  const refund = await support.listArticles('refund');
  assert.ok(refund.length >= 1);
  assert.ok(refund.every((a) => a.title.toLowerCase().includes('refund') || a.body!.toLowerCase().includes('refund')));

  const orders = await support.listArticles('track');
  assert.ok(orders.length >= 1, 'tracking article matches');

  const none = await support.listArticles('zzzz-no-such-topic');
  assert.deepEqual(none, []);

  // Case-insensitive and whitespace-trimmed.
  const mixed = await support.listArticles('  REFUND  ');
  assert.deepEqual(mixed.map((a) => a.id), refund.map((a) => a.id));
});

test('ticket create carries the selected contract category', async () => {
  const t1 = await support.createTicket(
    { subject: 'Payment failed', body: 'M-Pesa charge went through twice', category: 'payment' },
    'k1',
  );
  assert.equal(mockTicketCategory(t1.id), 'payment');

  const t2 = await support.createTicket(
    { subject: 'Order issue', body: 'Missing item', category: 'order' },
    'k2',
  );
  assert.equal(mockTicketCategory(t2.id), 'order');

  const t3 = await support.createTicket({ subject: 'Hello', body: 'Just a question' }, 'k3');
  assert.equal(mockTicketCategory(t3.id), undefined, 'omitted category stays omitted');
  assert.equal(getState().tickets.length, 4, 'seed ticket + 3 new ones');
});

/* ---------------- P6d — points accrual on orders + reviews ---------------- */

test('accrual engine: 1 point per TZS 1,000 of the order total (floored, integer); 50 per review', async () => {
  const state = getState();
  const membership = state.membership;
  const before = membership.points;

  const order = clone(state.orders[0]);
  order.id = 'ord_engine_test';
  order.no = 'HD-OR-ENGINE';
  order.status = 'paid';
  order.totals.totalTZS = 28300;
  assert.equal(earnOrderPoints(order, membership), 28, 'floor(28300 / 1000) = 28');
  assert.equal(membership.points, before + 28);
  const ledger = await memberships.listLoyaltyTransactions();
  assert.equal(ledger[0].type, ListLoyaltyTransactions200ItemType.earn);
  assert.equal(ledger[0].points, 28);
  assert.equal(ledger[0].balance, before + 28, 'the ledger balance follows the award');
  assert.equal(ledger[0].reference, 'order HD-OR-ENGINE');
  assert.ok(Number.isInteger(ledger[0].points) && Number.isInteger(ledger[0].balance));

  // Replaying the same order replays the same award — never a double credit.
  assert.equal(earnOrderPoints(order, membership), 28);
  assert.equal(membership.points, before + 28);

  // Floored: an order just under the next TZS 1,000 earns the lower integer.
  order.id = 'ord_engine_floor';
  order.totals.totalTZS = 2799;
  assert.equal(earnOrderPoints(order, membership), 2, 'floor(2799 / 1000) = 2');

  // Under TZS 1,000: no award, no ledger row.
  const ledgerLen = (await memberships.listLoyaltyTransactions()).length;
  order.id = 'ord_engine_zero';
  order.totals.totalTZS = 999;
  assert.equal(earnOrderPoints(order, membership), 0);
  assert.equal((await memberships.listLoyaltyTransactions()).length, ledgerLen, 'no ledger row for a sub-1k order');

  // Unpaid statuses never accrue.
  order.id = 'ord_engine_pending';
  order.status = 'pending_payment';
  order.totals.totalTZS = 50000;
  assert.equal(earnOrderPoints(order, membership), 0, 'pending_payment earns nothing');

  // Reviews: 50 points per review, idempotent per review id.
  const review = { id: 'rev_engine_test', targetType: 'merchant' as const, targetId: 'm1', rating: 5, body: 'Great', state: 'pending' as const, createdAt: new Date().toISOString() };
  assert.equal(earnReviewPoints(review), 50);
  assert.equal(earnReviewPoints(review), 50, 'the same review never double-awards');
  assert.equal(membership.points, before + 28 + 2 + 50);
});

test('creating a paid (COD) order accrues spend points and appends an earn ledger row', async () => {
  const before = (await memberships.get()).points;
  const created = await orders.create(paidOrderInput(), 'k-order-1');
  assert.equal(created.status, 'paid');
  const expected = Math.floor(created.totals.totalTZS / 1000);
  assert.ok(expected >= 1, 'the seeded item order totals above TZS 1,000');

  assert.equal((await memberships.get()).points, before + expected);
  const ledger = await memberships.listLoyaltyTransactions();
  assert.equal(ledger[0].type, ListLoyaltyTransactions200ItemType.earn);
  assert.equal(ledger[0].points, expected);
  assert.equal(ledger[0].balance, before + expected);
  assert.equal(ledger[0].reference, `order ${created.no ?? created.id}`);

  // The same key replays the stored order — never a double accrual.
  await orders.create(paidOrderInput(), 'k-order-1');
  assert.equal((await memberships.get()).points, before + expected, 'replay never double-accrues');
});

test('creating a review accrues 50 engagement points and appends an earn ledger row', async () => {
  const merchantId = getState().merchants[0].id;
  const before = (await memberships.get()).points;
  const created = await reviews.create({ targetType: 'merchant', targetId: merchantId, rating: 5, body: 'Delicious!' }, 'k-review-1');
  assert.equal(created.state, 'pending');

  assert.equal((await memberships.get()).points, before + 50);
  const ledger = await memberships.listLoyaltyTransactions();
  assert.equal(ledger[0].type, ListLoyaltyTransactions200ItemType.earn);
  assert.equal(ledger[0].points, 50);
  assert.equal(ledger[0].balance, before + 50);
  assert.equal(ledger[0].reference, `review ${created.id}`);
});

test('earningsFor / earningsForReview report the recorded awards; unknown ids are null', async () => {
  assert.equal(await memberships.earningsFor('ord_unknown'), null);
  assert.equal(await memberships.earningsForReview('rev_unknown'), null);

  const created = await orders.create(paidOrderInput(), 'k-order-getter');
  assert.deepEqual(await memberships.earningsFor(created.id), { points: Math.floor(created.totals.totalTZS / 1000) });

  const merchantId = getState().merchants[0].id;
  const review = await reviews.create({ targetType: 'merchant', targetId: merchantId, rating: 4, body: 'Asante' }, 'k-review-getter');
  assert.deepEqual(await memberships.earningsForReview(review.id), { points: 50 });

  // A non-paid order never records an award.
  const unpaid = await orders.create({ ...paidOrderInput(), paymentMethod: 'mpesa' }, 'k-order-unpaid');
  assert.equal(unpaid.status, 'pending_payment');
  assert.equal(await memberships.earningsFor(unpaid.id), null);
});
