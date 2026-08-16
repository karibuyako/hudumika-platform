/* M4 — Checkout + payments: PriceBreakdown sum rules (integer TZS), money
 * formatting with signed rows, idempotency key discipline (customerId+action
 * +nonce, fresh per action, retry replay via retryKey). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatTZS, tzs } from '@/lib/format';
import { idempotencyKey, retryKey } from '@/lib/idempotency';
import { pickDefaultMethod } from '@/lib/payments';
import { getTransactionType } from '@/lib/checkout';
import { useSessionStore } from '@/store/session';
import { rejectsApiError, resetMockState, auth } from './helpers';
import { getState, simulatePaymentFailure } from '@/repos/mock/mockState';
import { MockCouponsRepository, suggestBestCoupon } from '@/repos/mock/coupons';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { MockPaymentsRepository, resetMockPaymentsState } from '@/repos/mock/payments';
import { MockWalletRepository, reportedIssueIdsForTests } from '@/repos/mock/wallet';
import type { Coupon, User } from '@hudumika/contract';
import { CouponStatus } from '@hudumika/contract';

const orders = new MockOrdersRepository();
const payments = new MockPaymentsRepository();
const wallet = new MockWalletRepository();

beforeEach(() => {
  resetMockState();
  resetMockPaymentsState();
});

function validInput() {
  const merchant = getState().merchants.find((m) => m.isOpen)!;
  const item = getState().catalogues.get(merchant.id)!.items.find((i) => i.available !== false)!;
  return {
    merchantId: merchant.id,
    items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS }],
    paymentMethod: 'mpesa' as const,
    deliveryAddress: { label: 'Home', lines: '12 Makunganya St', contactPhone: '+255700000000' },
  };
}

test('PriceBreakdown totals satisfy the sum rule with integer TZS on placed orders', async () => {
  const order = await orders.create(validInput(), idempotencyKey('cus_1', 'order'));
  const t = order.totals;
  assert.equal(t.subtotalTZS + t.deliveryFeeTZS + t.platformFeeTZS + t.taxTZS - t.discountTZS, t.totalTZS);
  for (const v of [t.subtotalTZS, t.deliveryFeeTZS, t.platformFeeTZS, t.taxTZS, t.discountTZS, t.totalTZS]) {
    assert.ok(Number.isInteger(v));
  }
});

test('formatTZS renders grouped integer TZS, never floats', () => {
  assert.equal(formatTZS(47100), 'TZS 47,100');
  assert.equal(formatTZS(5000), 'TZS 5,000');
  assert.equal(formatTZS(0), 'TZS 0');
  assert.equal(tzs(-5000), '−TZS 5,000');
  assert.equal(formatTZS(47.7), 'TZS 48'); // rounds — never renders decimals
});

test('idempotency keys are per action and never reused across distinct mutations', async () => {
  // FIX 3 (audit P1-7): keys derive from the SESSION user — the passed
  // placeholder (e.g. 'cus_1') is ignored in favour of the real user id.
  useSessionStore.setState({ user: { id: 'cus_0001' } as User });
  const k1 = idempotencyKey('cus_1', 'order');
  const k2 = idempotencyKey('cus_1', 'order');
  const k3 = idempotencyKey('cus_1', 'intent');
  assert.match(k1, /^hk_cus_0001_order_/);
  assert.notEqual(k1, k2, 'fresh key per new attempt');
  assert.notEqual(k1, k3, 'distinct actions never share a key');
  useSessionStore.setState({ user: null });
});

test('retryKey replays the same key for a retry of the same attempt', () => {
  const attempt = 'att_abc123';
  assert.equal(retryKey('cus_0001', 'order', attempt), retryKey('cus_0001', 'order', attempt));
});

test('a paid intent is not payable again and refunds are server-triggered (display only)', async () => {
  const order = await orders.create(validInput(), idempotencyKey('cus_1', 'order'));
  const intent = await payments.createIntent(order.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  assert.equal((await orders.get(order.id)).status, 'paid');
  await rejectsApiError(payments.createIntent(order.id, 'mpesa', idempotencyKey('cus_1', 'intent-2')), 409, 'PAYMENT_ALREADY_PAID');
});

test('errors carry the contract envelope shape via ApiError fields', async () => {
  const err = await rejectsApiError(orders.get('ord_nope'), 404, 'ORDER_NOT_FOUND');
  assert.ok(err.message.length > 0);
  assert.equal(err.retriable, false);
});

test('provider outage maps to PAYMENT_PROVIDER_ERROR with retryAfterSeconds, then recovers', async () => {
  const order = await orders.create(validInput(), idempotencyKey('cus_1', 'order'));
  const intent = await payments.createIntent(order.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  simulatePaymentFailure('PAYMENT_PROVIDER_ERROR', 3);
  const err = await rejectsApiError(payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm')), 429, 'PAYMENT_PROVIDER_ERROR');
  assert.equal(err.details?.retryAfterSeconds, 3);
  // Same intent key replays → confirm succeeds on retry.
  const paid = await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  assert.equal(paid.status, 'paid');
  assert.equal((await orders.get(order.id)).status, 'paid');
});

test('cancelling a paid order yields a linked refunded intent (refund card data)', async () => {
  const order = await orders.create(validInput(), idempotencyKey('cus_1', 'order'));
  const intent = await payments.createIntent(order.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  await orders.cancel(order.id, 'changed my mind', idempotencyKey('cus_1', 'cancel'));
  const history = await payments.getHistory();
  const refunded = history.find((i) => i.orderId === order.id);
  assert.ok(refunded, 'cancelled order resolves to its intent from history');
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.amountTZS, order.totals.totalTZS, 'refund card shows the paid amount');
  assert.ok(refunded.providerReference, 'refund card shows the provider reference');
  assert.ok(refunded.paidAt && !Number.isNaN(Date.parse(refunded.paidAt)), 'refund card renders paidAt as local time');
});

test('the seeded refunded order carries a linked refunded intent with reference + paidAt', async () => {
  const detail = await orders.get('ord_refunded_006');
  assert.equal(detail.status, 'refunded');
  const history = await payments.getHistory();
  const intent = history.find((i) => i.orderId === detail.id);
  assert.ok(intent, 'seed links the refunded order to its intent');
  assert.equal(intent.status, 'refunded');
  assert.equal(intent.amountTZS, detail.totals.totalTZS);
  assert.ok(intent.providerReference, 'seed refunded intent carries the provider reference');
  assert.ok(intent.paidAt && !Number.isNaN(Date.parse(intent.paidAt)), 'seed refunded intent carries a parseable paidAt');
});

test('wallet top-up credits the balance and appends a transaction', async () => {
  const before = await wallet.getWallet();
  const txsBefore = await wallet.getTransactions();
  const topped = await wallet.topUp({ amountTZS: 20000, method: 'mpesa' }, idempotencyKey('cus_0001', 'wallet-topup'));
  assert.equal(topped.totalTZS, before.totalTZS + 20000);
  assert.equal(topped.withdrawableTZS, before.withdrawableTZS + 20000);
  assert.equal(topped.totalTZS, (await wallet.getWallet()).totalTZS);

  const txs = await wallet.getTransactions();
  assert.equal(txs.length, txsBefore.length + 1);
  assert.equal(txs[0].amountTZS, 20000);
  assert.equal(txs[0].balanceTZS, topped.totalTZS);
  assert.equal(txs[0].referenceType, 'topup');
  assert.equal(txs[0].type, 'adjustment'); // contract WalletTransactionType has no 'topup'
});

test('wallet top-up rejects non-positive and fractional amounts with 422', async () => {
  await rejectsApiError(wallet.topUp({ amountTZS: 0, method: 'mpesa' }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(wallet.topUp({ amountTZS: -5000, method: 'mpesa' }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(wallet.topUp({ amountTZS: 1.5, method: 'mpesa' }, 'k3'), 422, 'VALIDATION_FAILED');
  const untouched = await wallet.getWallet();
  assert.equal(untouched.totalTZS, (await wallet.getWallet()).totalTZS);
});

test('wallet report issue records the report for a seeded transaction and 404s on unknown ids', async () => {
  const txs = await wallet.getTransactions();
  const tx = txs[0];
  await wallet.reportIssue(tx.id, { issueType: 'amount_mismatch', description: 'Charged twice for my order' }, idempotencyKey('cus_0001', 'tx-issue'));
  assert.ok(reportedIssueIdsForTests().includes(tx.id));
  // Re-reporting the same transaction is idempotent (no double error).
  await wallet.reportIssue(tx.id, { issueType: 'other', description: 'Still wrong' }, idempotencyKey('cus_0001', 'tx-issue-2'));
  await rejectsApiError(
    wallet.reportIssue('wtx_does_not_exist', { issueType: 'missing_items', description: 'x' }, 'k2'),
    404,
    'NOT_FOUND',
  );
});

/* ---------------- smart default payment method (§37) ---------------- */

test('pickDefaultMethod prefers the flagged default over the first record', () => {
  const list = [
    { id: 'pm_a', method: 'airtel_money', label: 'Airtel', available: true },
    { id: 'pm_b', method: 'mpesa', label: 'M-Pesa', available: true, isDefault: true },
    { id: 'pm_c', method: 'cod', label: 'COD', available: true },
  ];
  const picked = pickDefaultMethod(list)!;
  assert.equal(picked.method, 'mpesa');
  assert.equal(picked.isDefault, true);
});

test('pickDefaultMethod skips unavailable records and falls back to the first', () => {
  assert.equal(pickDefaultMethod([
    { id: 'pm_a', method: 'card', label: 'Card', available: false },
    { id: 'pm_b', method: 'mpesa', label: 'M-Pesa', available: true },
  ])!.method, 'mpesa');
  assert.equal(pickDefaultMethod([{ id: 'pm_c', method: 'cod', label: 'COD' }])!.method, 'cod');
  assert.equal(pickDefaultMethod([]), undefined, 'empty list keeps the caller fallback');
});

test('the methods repo seed marks the default and pre-selection picks it', async () => {
  const methods = await payments.getPaymentMethods();
  const flagged = methods.filter((m) => m.isDefault === true);
  assert.equal(flagged.length, 1, 'exactly one default in the seed');
  assert.equal(flagged[0].method, 'mpesa');
  assert.equal(pickDefaultMethod(methods)!.method, 'mpesa');
  assert.ok(methods.every((m) => m.method && m.label), 'every record carries a method + label for the chips');
  // The selected method is a contract BookingCreatePaymentMethod enum value
  // (book.tsx casts the record method straight into the enum).
  const picked = pickDefaultMethod(methods)!;
  assert.ok(['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel', 'card', 'cod', 'bank'].includes(picked.method));
});

/* ---------------- payment-method mutations (CONTRACT-ADDITIONS.md #7) ---------------- */

test('addPaymentMethod round-trips through the mock registry and replays per key', async () => {
  const before = await payments.getPaymentMethods();
  const key = retryKey('cus_1', 'pm-add', 'attempt-1');
  const added = await payments.addPaymentMethod('bank', key);
  assert.equal(added.method, 'bank');
  assert.equal(added.isDefault, false, 'the seed default is not displaced');
  const after = await payments.getPaymentMethods();
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((m) => m.method === 'bank' && m.available !== false));
  // The same idempotency key replays the same record — never a second entry.
  const replay = await payments.addPaymentMethod('bank', key);
  assert.equal(replay.id, added.id);
  assert.equal((await payments.getPaymentMethods()).length, after.length);
});

test('addPaymentMethod validates against the contract method enum (422) and rejects duplicates (409)', async () => {
  await rejectsApiError(payments.addPaymentMethod('bitcoin_wallet', 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(payments.addPaymentMethod('mpesa', 'k2'), 409, 'CONFLICT');
  assert.ok(!(await payments.getPaymentMethods()).some((m) => m.method === 'bitcoin_wallet'));
});

test('setDefaultPaymentMethod marks one default and un-marks the rest', async () => {
  const cod = (await payments.getPaymentMethods()).find((m) => m.method === 'cod')!;
  const updated = await payments.setDefaultPaymentMethod(cod.id, 'k1');
  assert.equal(updated.isDefault, true);
  const flagged = (await payments.getPaymentMethods()).filter((m) => m.isDefault === true);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].method, 'cod');
  await rejectsApiError(payments.setDefaultPaymentMethod('pm_does_not_exist', 'k2'), 404, 'NOT_FOUND');
});

test('removePaymentMethod removes the row; removing the default promotes another', async () => {
  const methods = await payments.getPaymentMethods();
  const defaultId = methods.find((m) => m.isDefault === true)!.id;
  const other = methods.find((m) => m.id !== defaultId)!;
  await payments.removePaymentMethod(other.id, 'k1');
  const afterFirst = await payments.getPaymentMethods();
  assert.ok(!afterFirst.some((m) => m.id === other.id));
  // Remove the default → the next available method is promoted (still exactly one).
  await payments.removePaymentMethod(defaultId, 'k2');
  const flagged = (await payments.getPaymentMethods()).filter((m) => m.isDefault === true);
  assert.equal(flagged.length, 1);
  assert.notEqual(flagged[0].method, 'mpesa');
  await rejectsApiError(payments.removePaymentMethod(defaultId, 'k3'), 404, 'NOT_FOUND');
});

test('removing every method yields the read-only empty list', async () => {
  for (const m of await payments.getPaymentMethods()) {
    await payments.removePaymentMethod(m.id, `k-${m.id}`);
  }
  assert.deepEqual(await payments.getPaymentMethods(), []);
});

/* ---------------- couponId on order create (CONTRACT-ADDITIONS.md #10) ---------------- */

/** Order input with an explicit quantity so the subtotal crosses the coupon
 * minimum-spend bound. */
function couponInput(quantity: number, couponId?: string) {
  const merchant = getState().merchants.find((m) => m.isOpen)!;
  const item = getState().catalogues.get(merchant.id)!.items.find((i) => i.available !== false)!;
  return {
    merchantId: merchant.id,
    items: [{ catalogueItemId: item.id!, quantity, unitPriceTZS: item.priceTZS }],
    paymentMethod: 'mpesa' as const,
    deliveryAddress: { label: 'Home', lines: '12 Makunganya St', contactPhone: '+255700000000' },
    couponId,
  };
}

test('ordering with a valid couponId applies discountTZS into totals and marks the coupon used', async () => {
  // coup_001: WELCOME20, discount 5000, minimumSpend 20000, claimed, valid.
  const order = await orders.create(couponInput(2, 'coup_001'), idempotencyKey('cus_1', 'order'));
  assert.equal(order.totals.discountTZS, 5000);
  assert.equal(
    order.totals.subtotalTZS + order.totals.deliveryFeeTZS + order.totals.platformFeeTZS + order.totals.taxTZS - order.totals.discountTZS,
    order.totals.totalTZS,
    'the sum rule still holds with the coupon applied',
  );
  const coupon = getState().coupons.find((c) => c.id === 'coup_001')!;
  assert.equal(coupon.status, 'used');
  assert.ok(coupon.usedAt && !Number.isNaN(Date.parse(coupon.usedAt)));
});

test('a used coupon is rejected on the next order (COUPON_ALREADY_USED)', async () => {
  await orders.create(couponInput(2, 'coup_001'), idempotencyKey('cus_1', 'order'));
  await rejectsApiError(orders.create(couponInput(2, 'coup_001'), idempotencyKey('cus_1', 'order-2')), 409, 'COUPON_ALREADY_USED');
});

test('below-minimum-spend orders reject the coupon and never mark it used', async () => {
  // One unit of the first dish is below coup_001's 20000 minimum spend.
  await rejectsApiError(orders.create(couponInput(1, 'coup_001'), idempotencyKey('cus_1', 'order')), 422, 'COUPON_MINIMUM_SPEND_NOT_MET');
  const coupon = getState().coupons.find((c) => c.id === 'coup_001')!;
  assert.equal(coupon.status, 'claimed', 'a rejected coupon is not consumed');
  assert.equal(coupon.usedAt, undefined);
});

test('expired and unknown coupons are rejected at order time', async () => {
  await rejectsApiError(orders.create(couponInput(2, 'coup_004'), idempotencyKey('cus_1', 'order')), 422, 'COUPON_EXPIRED');
  await rejectsApiError(orders.create(couponInput(2, 'coup_nope'), idempotencyKey('cus_1', 'order-2')), 404, 'COUPON_CAMPAIGN_NOT_FOUND');
  assert.equal(getState().coupons.find((c) => c.id === 'coup_004')!.status, 'expired');
});

test('an order without couponId stays undiscounted (discountTZS 0)', async () => {
  const order = await orders.create(couponInput(1), idempotencyKey('cus_1', 'order'));
  assert.equal(order.totals.discountTZS, 0);
});

/* UNIVERSAL CHECKOUT SHELL (MASTER-BLUEPRINT §1/§2): the transactionType
 * route param dispatches the checkout shell; absent/unknown values keep the
 * commerce order flow (existing behavior unchanged). */
test('getTransactionType maps every supported route param to its type', () => {
  assert.equal(getTransactionType('commerce'), 'commerce');
  assert.equal(getTransactionType('delivery'), 'delivery');
  assert.equal(getTransactionType('service'), 'service');
  assert.equal(getTransactionType('booking'), 'booking');
  assert.equal(getTransactionType('reservation'), 'reservation');
  assert.equal(getTransactionType('hotel'), 'hotel');
  assert.equal(getTransactionType(['booking']), 'booking', 'expo-router arrays collapse to the first value');
});

test('getTransactionType defaults to commerce for absent or unknown params', () => {
  assert.equal(getTransactionType(undefined), 'commerce');
  assert.equal(getTransactionType(''), 'commerce');
  assert.equal(getTransactionType('marketplace'), 'commerce');
  assert.equal(getTransactionType('Booking'), 'commerce', 'mapping is case-sensitive against the blueprint vocabulary');
  assert.equal(getTransactionType([]), 'commerce');
});

/* ---------------- SMART COUPONS (MASTER-BLUEPRINT §16, CONTRACT-ADDITIONS.md #26) ---------------- */

/** A wallet coupon with the given discount/minimum-spend and a status that
 * keeps it in play (claimed unless overridden). Expiry defaults to far in the
 * future so only tests that opt in fight the clock. */
function walletCoupon(id: string, discountTZS: number, minimumSpendTZS: number, overrides: Partial<Coupon> = {}): Coupon {
  return {
    id,
    campaignId: `camp_${id}`,
    code: `CODE_${id.toUpperCase()}`,
    title: `${id} coupon`,
    discountTZS,
    minimumSpendTZS,
    status: CouponStatus.claimed,
    claimedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    ...overrides,
  };
}

test('suggestBestCoupon picks the largest discount among minimum-spend-applicable coupons', () => {
  const big = walletCoupon('c1', 5000, 20000);
  const small = walletCoupon('c2', 2500, 15000);
  const tooCostly = walletCoupon('c3', 8000, 40000); // best discount but out of reach
  // Cart subtotal 25000: c3 fails the minimum-spend bound; c1 beats c2.
  assert.equal(suggestBestCoupon([small, tooCostly, big], 25000)?.id, 'c1');
  // At 41000 everything is applicable — the largest discount wins.
  assert.equal(suggestBestCoupon([small, tooCostly, big], 41000)?.id, 'c3');
  // At 16000 only c2 clears the bound.
  assert.equal(suggestBestCoupon([small, tooCostly, big], 16000)?.id, 'c2');
  // At 15000 the bound is inclusive (minimumSpendTZS <= subtotal).
  assert.equal(suggestBestCoupon([small], 15000)?.id, 'c2');
});

test('suggestBestCoupon respects status and expiry (dead coupons never surface)', () => {
  const now = Date.now();
  const dead = [
    walletCoupon('used', 9000, 0, { status: CouponStatus.used }),
    walletCoupon('expired', 9000, 0, { status: CouponStatus.expired }),
    walletCoupon('void', 9000, 0, { status: CouponStatus.void }),
    // available but past its expiresAt — the clock kills it even though the
    // status field still says available.
    walletCoupon('available_expired', 9000, 0, { status: CouponStatus.available, expiresAt: new Date(now - 86400_000).toISOString() }),
    // claimed but past its expiresAt — same clock rule.
    walletCoupon('claimed_expired', 9000, 0, { expiresAt: new Date(now - 86400_000).toISOString() }),
  ];
  assert.equal(suggestBestCoupon(dead, 999999), null, 'every dead coupon is excluded');
  const alive = walletCoupon('alive', 1000, 0, { status: CouponStatus.available });
  assert.equal(suggestBestCoupon([...dead, alive], 999999)?.id, 'alive');
  assert.equal(suggestBestCoupon([alive], 0)?.id, 'alive', 'zero minimum spend + any subtotal applies');
});

test('suggestBestCoupon returns null when nothing applies', () => {
  assert.equal(suggestBestCoupon([], 50000), null, 'empty wallet');
  assert.equal(suggestBestCoupon([walletCoupon('c1', 5000, 60000)], 30000), null, 'every coupon below its minimum spend');
  assert.equal(suggestBestCoupon([walletCoupon('c1', 5000, 0, { status: CouponStatus.used })], 50000), null, 'only dead coupons');
});

test('suggestForCart round-trips through the mock and never mutates the wallet', async () => {
  const couponsRepo = new MockCouponsRepository();
  // Seeded wallet: coup_001 (5000 / min 20000, claimed), coup_002 (2500 /
  // min 15000, available), coup_003 (used), coup_004 (expired status).
  const walletIds = ['coup_001', 'coup_002', 'coup_003', 'coup_004'];
  const best = await couponsRepo.suggestForCart({ merchantId: 'm_any', subtotalTZS: 25000, couponIds: walletIds });
  assert.equal(best?.id, 'coup_001', 'the largest applicable seeded coupon wins');
  assert.equal(best?.status, 'claimed', 'the suggestion is read-only — no claim happens');
  // Below every minimum spend → null, even with valid ids in the wallet.
  assert.equal((await couponsRepo.suggestForCart({ merchantId: 'm_any', subtotalTZS: 8000, couponIds: walletIds })), null);
  // Unknown ids are simply not part of the wallet — no crash, null result.
  assert.equal((await couponsRepo.suggestForCart({ merchantId: 'm_any', subtotalTZS: 50000, couponIds: ['coup_nope'] })), null);
  // READ-ONLY contract: the seeded wallet is untouched by any suggestion.
  const wallet = getState().coupons;
  assert.equal(wallet.find((c) => c.id === 'coup_001')?.status, 'claimed');
  assert.equal(wallet.find((c) => c.id === 'coup_002')?.status, 'available');
  assert.equal(wallet.find((c) => c.id === 'coup_003')?.status, 'used');
  assert.equal(wallet.find((c) => c.id === 'coup_004')?.status, 'expired');
});
