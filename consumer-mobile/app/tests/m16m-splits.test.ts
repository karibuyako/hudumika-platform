/* M16m — Split payments (mock-first, docs/CONTRACT-ADDITIONS.md #22):
 * createSplit server validation (order 404, share sum == order total,
 * amounts ≥ 1, labels, ≥ 2 shares, one split per order), the initiator's
 * share seeded pending with co-payer shares PRE-PAID (simulated payers),
 * payMyShare transitions + double-pay 409 + ORDER_NOT_PAYABLE + provider
 * outage, completeSplit requires every share paid and settles the order,
 * per-key idempotency everywhere, the seeded demo split, and the
 * deep-link allow-list entry (hudumika://split/{id}). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { deepLinkHref, parseAndValidateDeepLink } from '@/lib/deep-link';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { getState, resetMockState, simulatePaymentFailure } from '@/repos/mock/mockState';
import { MockSplitPaymentsRepository, resetMockSplitPaymentsState, SEED_SPLIT_ID } from '@/repos/mock/splits';

const repo = new MockSplitPaymentsRepository();
const ordersRepo = new MockOrdersRepository();

beforeEach(() => {
  resetMockState();
  resetMockSplitPaymentsState();
});

async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal(caught.status, status);
  if (code) assert.equal(caught.code, code);
  return caught as ApiError;
}

/** The seeded rush order (ord_rush_008) — already occupied by the SEED split
 * (one split per order), so fresh-order helpers are used wherever a created
 * (not replayed) plan is asserted. The refunded seed covers the non-payable
 * guard. */
const RUSH_ORDER_ID = 'ord_rush_008';
const ACTIVE_TOTAL = 27300;
const ACTIVE_ORDER_ID = 'ord_active_001';

function rushShares(): { label: string; amountTZS: number }[] {
  return [
    { label: 'Me', amountTZS: 7100 },
    { label: 'Amina', amountTZS: 7100 },
    { label: 'Juma', amountTZS: 7100 },
  ];
}

/** A fresh pending-payment order with a deterministic total (1 × Chicken &
 * Chips base 12000 + 2500 delivery + 800 platform = 15300). */
async function freshOrder(key = 'k-order'): Promise<{ id: string; totalTZS: number }> {
  const order = await ordersRepo.create(
    {
      merchantId: getState().merchants[0].id,
      items: [{ catalogueItemId: `citem_${getState().merchants[0].id.slice(-6)}_0`, quantity: 1, unitPriceTZS: 12000 }],
      paymentMethod: 'mpesa',
    },
    key,
  );
  return { id: order.id, totalTZS: order.totals.totalTZS };
}

test('createSplit returns an open plan: my share pending, co-payers pre-paid, totals match the order', async () => {
  const order = await freshOrder('k-order-1');
  const plan = await repo.createSplit(
    { orderId: order.id, shares: [{ label: 'Me', amountTZS: 10000 }, { label: 'Amina', amountTZS: order.totalTZS - 10000 }] },
    'k-create',
  );
  assert.equal(plan.status, 'open');
  assert.equal(plan.orderId, order.id);
  assert.equal(plan.totalTZS, order.totalTZS, 'plan total is the order total');
  assert.equal(plan.shares.length, 2);
  const mine = plan.shares.find((s) => s.id === plan.myShareId);
  assert.ok(mine, 'myShareId resolves to a share');
  assert.equal(plan.shares[0].id, plan.myShareId, 'the initiator share is the FIRST share (mock rule)');
  assert.equal(mine!.status, 'pending');
  assert.equal(mine!.amountTZS, 10000);
  assert.equal(plan.shares.filter((s) => s.status === 'paid').length, 1, 'co-payer shares seed PRE-PAID (simulated payers)');
  assert.ok(Number.isInteger(plan.totalTZS) && Number.isInteger(plan.shares[1].amountTZS));
  const fetched = await repo.getSplit(plan.id);
  assert.deepEqual(fetched, plan, 'getSplit round-trips the plan');
});

test('createSplit validates the order, share count, labels and amounts', async () => {
  await rejectsApiError(repo.createSplit({ orderId: 'ord_nope', shares: rushShares() }, 'k1'), 404, 'ORDER_NOT_FOUND');
  // Sum mismatch vs the order total (ord_active_001 — no existing split).
  await rejectsApiError(
    repo.createSplit({ orderId: ACTIVE_ORDER_ID, shares: [{ label: 'A', amountTZS: 10000 }, { label: 'B', amountTZS: 10000 }] }, 'k2'),
    422,
    'VALIDATION_FAILED',
  );
  // Amounts < 1 and non-integer amounts.
  await rejectsApiError(
    repo.createSplit({ orderId: ACTIVE_ORDER_ID, shares: [{ label: 'A', amountTZS: 0 }, { label: 'B', amountTZS: ACTIVE_TOTAL }] }, 'k3'),
    422,
    'VALIDATION_FAILED',
  );
  await rejectsApiError(
    repo.createSplit({ orderId: ACTIVE_ORDER_ID, shares: [{ label: 'A', amountTZS: 7100.5 }, { label: 'B', amountTZS: ACTIVE_TOTAL - 7100.5 }] }, 'k4'),
    422,
    'VALIDATION_FAILED',
  );
  // One share is not a split.
  await rejectsApiError(
    repo.createSplit({ orderId: ACTIVE_ORDER_ID, shares: [{ label: 'A', amountTZS: ACTIVE_TOTAL }] }, 'k5'),
    422,
    'VALIDATION_FAILED',
  );
  // Blank labels.
  await rejectsApiError(
    repo.createSplit({ orderId: ACTIVE_ORDER_ID, shares: [{ label: ' ', amountTZS: 13650 }, { label: 'B', amountTZS: 13650 }] }, 'k6'),
    422,
    'VALIDATION_FAILED',
  );
});

test('createSplit is idempotent per key and an order carries one split', async () => {
  const order = await freshOrder('k-order-2');
  const shares = (total: number) => [{ label: 'Me', amountTZS: 10000 }, { label: 'Amina', amountTZS: total - 10000 }];
  const a = await repo.createSplit({ orderId: order.id, shares: shares(order.totalTZS) }, 'k-create');
  const b = await repo.createSplit({ orderId: order.id, shares: [{ label: 'x', amountTZS: 10000 }, { label: 'y', amountTZS: 5300 }] }, 'k-create');
  assert.equal(a.id, b.id, 'same key replays the recorded plan');
  assert.equal(b.shares[0].amountTZS, 10000, 'the replay wins over the new body');
  // A different key for the same order returns the EXISTING plan (no dupes).
  const c = await repo.createSplit({ orderId: order.id, shares: shares(order.totalTZS) }, 'k-create-2');
  assert.equal(c.id, a.id);
});

test('payMyShare transitions my share to paid, settles the split, and rides the intent flow', async () => {
  const plan = await repo.createSplit({ orderId: RUSH_ORDER_ID, shares: rushShares() }, 'k-create');
  const mine = plan.shares.find((s) => s.id === plan.myShareId)!;
  const paid = await repo.payMyShare(plan.id, 'mpesa', 'k-pay');
  const myShare = paid.shares.find((s) => s.id === plan.myShareId)!;
  assert.equal(myShare.status, 'paid');
  assert.equal(paid.status, 'paid', 'all shares paid → the split is fully paid');
  // The payer share rides the normal intent lifecycle: a real intent for the
  // SHARE amount landed in the payments history.
  const intent = getState().intents.find((i) => i.orderId === plan.orderId);
  assert.ok(intent, 'an intent was created for the split order');
  assert.equal(intent!.amountTZS, mine.amountTZS, 'intent amount is MY share, not the order total');
  assert.equal(intent!.status, 'paid');
  assert.ok(intent!.providerReference);
});

test('payMyShare guards: double-pay 409, non-payable order, unknown split', async () => {
  const plan = await repo.createSplit({ orderId: RUSH_ORDER_ID, shares: rushShares() }, 'k-create');
  await repo.payMyShare(plan.id, 'mpesa', 'k-pay');
  await rejectsApiError(repo.payMyShare(plan.id, 'mpesa', 'k-pay-2'), 409, 'CONFLICT');

  // A refunded order mirrors the intent guard (ORDER_NOT_PAYABLE).
  const refunded = await repo.createSplit({ orderId: 'ord_refunded_006', shares: [{ label: 'A', amountTZS: 13650 }, { label: 'B', amountTZS: 13650 }] }, 'k-create-2');
  await rejectsApiError(repo.payMyShare(refunded.id, 'mpesa', 'k-pay-3'), 409, 'ORDER_NOT_PAYABLE');

  await rejectsApiError(repo.payMyShare('spl_nope', 'mpesa', 'k-pay-4'), 404, 'NOT_FOUND');
});

test('payMyShare honors the provider-outage path and a retry succeeds', async () => {
  const plan = await repo.createSplit({ orderId: RUSH_ORDER_ID, shares: rushShares() }, 'k-create');
  simulatePaymentFailure('PAYMENT_PROVIDER_ERROR', 10);
  const err = await rejectsApiError(repo.payMyShare(plan.id, 'mpesa', 'k-pay-1'), 429, 'PAYMENT_PROVIDER_ERROR');
  assert.equal(err.details?.retryAfterSeconds, 10);
  assert.equal((await repo.getSplit(plan.id)).status, 'open', 'the failed attempt leaves the split untouched');
  const retried = await repo.payMyShare(plan.id, 'mpesa', 'k-pay-2');
  assert.equal(retried.shares.find((s) => s.id === plan.myShareId)!.status, 'paid');
  // Same key replays (idempotent).
  const replay = await repo.payMyShare(plan.id, 'mpesa', 'k-pay-2');
  assert.deepEqual(replay, retried);
});

test('completeSplit requires every share paid and settles the order', async () => {
  // Fresh pending-payment order (buildOrderFrom) — the completion webhook
  // settles it once the split is complete.
  const order = await ordersRepo.create(
    { merchantId: getState().merchants[0].id, items: [{ catalogueItemId: `citem_${getState().merchants[0].id.slice(-6)}_0`, quantity: 1, unitPriceTZS: 12000 }], paymentMethod: 'mpesa' },
    'k-order',
  );
  const total = order.totals.totalTZS;
  const half = Math.floor(total / 2);
  const plan = await repo.createSplit(
    { orderId: order.id, shares: [{ label: 'Me', amountTZS: total - half }, { label: 'Amina', amountTZS: half }] },
    'k-create',
  );
  await rejectsApiError(repo.completeSplit(plan.id, 'k-complete'), 409, 'CONFLICT', 'unpaid shares block completion');
  const paid = await repo.payMyShare(plan.id, 'mpesa', 'k-pay');
  assert.equal(paid.status, 'paid');
  const done = await repo.completeSplit(plan.id, 'k-complete');
  assert.equal(done.status, 'completed');
  assert.equal(done.shares.every((s) => s.status === 'paid'), true);
  assert.equal((await ordersRepo.get(order.id)).status, 'paid', 'completion settles the order (mock webhook)');
  // Idempotent per key + a re-complete returns the completed plan.
  const replay = await repo.completeSplit(plan.id, 'k-complete');
  assert.deepEqual(replay, done);
  const again = await repo.completeSplit(plan.id, 'k-complete-2');
  assert.equal(again.status, 'completed');
});

test('the seeded demo split is readable out of the box (deep-link target)', async () => {
  const seed = await repo.getSplit(SEED_SPLIT_ID);
  assert.equal(seed.status, 'open');
  assert.equal(seed.orderId, 'ord_rush_008');
  assert.equal(seed.totalTZS, 21300);
  assert.equal(seed.shares.length, 3);
  const mine = seed.shares.find((s) => s.id === seed.myShareId);
  assert.ok(mine && mine.status === 'pending');
  assert.equal(seed.shares.filter((s) => s.status === 'paid').length, 2);
});

test('deep-link allow-list accepts hudumika://split/{id} and maps to the route', () => {
  assert.equal(parseAndValidateDeepLink('hudumika://split/spl_abc'), 'split/spl_abc');
  assert.equal(parseAndValidateDeepLink('https://app.hudumika.tz/split/spl_abc'), 'split/spl_abc');
  assert.equal(parseAndValidateDeepLink('split/spl_abc'), 'split/spl_abc');
  assert.equal(parseAndValidateDeepLink('hudumika://nope/xyz'), null, 'unknown routes stay rejected');
  assert.equal(parseAndValidateDeepLink('hudumika://split/'), null, 'missing id stays rejected');
  const href = deepLinkHref('split/spl_abc');
  assert.deepEqual(href, { pathname: '/splits/[splitId]', params: { splitId: 'spl_abc' } });
});
