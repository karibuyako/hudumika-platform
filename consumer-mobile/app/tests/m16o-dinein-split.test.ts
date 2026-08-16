/* M16o — Dine-in split bill (mock-first, docs/CONTRACT-ADDITIONS.md #25):
 * splitBill server validation (bill 404 DINE_IN_ORDER_NOT_FOUND, payable-bill
 * guard, share count 2–8, amounts ≥ 1, sum == bill total, one split per
 * bill → second create 409 CONFLICT), the initiator's share seeded pending
 * with co-diner shares PRE-PAID (simulated diners), payMyShare transitions
 * (my share → paid, every share covered → completed, bill settles via the
 * mock webhook, a share-scoped intent lands in the payments history) with the
 * double-pay 409, the provider-outage path, and per-key idempotency. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { getState, resetMockState, simulatePaymentFailure } from '@/repos/mock/mockState';
import { MockDineInRepository, resetMockDineInSplitState } from '@/repos/mock/dineIn';

const repo = new MockDineInRepository();

// Seeded dine-in bills (mockState): an open bill (dine_open_001, Table 1,
// total 33,000 TZS) and a settled one (dine_paid_002 — used for the
// payable-bill guard).
const OPEN_BILL = 'dine_open_001';
const OPEN_TOTAL = 33000;
const PAID_BILL = 'dine_paid_002';

beforeEach(() => {
  resetMockState();
  resetMockDineInSplitState();
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

function twoShares(total = OPEN_TOTAL): { label: string; amountTZS: number }[] {
  return [
    { label: 'You', amountTZS: 20000 },
    { label: 'Amina', amountTZS: total - 20000 },
  ];
}

test('splitBill returns an open split: my share pending, co-diners pre-paid, totals match the bill', async () => {
  const split = await repo.splitBill(OPEN_BILL, { shares: twoShares() }, 'k-create');
  assert.equal(split.status, 'open');
  assert.equal(split.dineInOrderId, OPEN_BILL);
  assert.equal(split.totalTZS, OPEN_TOTAL, 'split total is the bill total');
  assert.equal(split.shares.length, 2);
  const mine = split.shares.find((s) => s.id === split.myShareId);
  assert.ok(mine, 'myShareId resolves to a share');
  assert.equal(split.shares[0].id, split.myShareId, 'the initiator share is the FIRST share (mock rule)');
  assert.equal(mine!.status, 'pending');
  assert.equal(mine!.amountTZS, 20000);
  assert.equal(split.shares.filter((s) => s.status === 'paid').length, 1, 'co-diner shares seed PRE-PAID (simulated diners)');
  assert.ok(Number.isInteger(split.totalTZS) && Number.isInteger(split.shares[1].amountTZS));
  const fetched = await repo.getSplit(OPEN_BILL);
  assert.deepEqual(fetched, split, 'getSplit round-trips the split');
  const bill = await repo.getOrder(OPEN_BILL);
  assert.equal(bill.status, 'open', 'creating a split does not change the bill');
});

test('splitBill validates the bill, share count, labels and amounts', async () => {
  await rejectsApiError(repo.splitBill('dine_missing', { shares: twoShares() }, 'k1'), 404, 'DINE_IN_ORDER_NOT_FOUND');
  // A settled bill cannot be split (payable-bill guard).
  await rejectsApiError(repo.splitBill(PAID_BILL, { shares: twoShares(4000) }, 'k2'), 409, 'DINE_IN_ORDER_STATUS_CONFLICT');
  // Sum mismatch vs the bill total.
  await rejectsApiError(
    repo.splitBill(OPEN_BILL, { shares: [{ label: 'A', amountTZS: 10000 }, { label: 'B', amountTZS: 10000 }] }, 'k3'),
    422,
    'VALIDATION_FAILED',
  );
  // Amounts < 1 and non-integer amounts.
  await rejectsApiError(
    repo.splitBill(OPEN_BILL, { shares: [{ label: 'A', amountTZS: 0 }, { label: 'B', amountTZS: OPEN_TOTAL }] }, 'k4'),
    422,
    'VALIDATION_FAILED',
  );
  await rejectsApiError(
    repo.splitBill(OPEN_BILL, { shares: [{ label: 'A', amountTZS: 7100.5 }, { label: 'B', amountTZS: OPEN_TOTAL - 7100.5 }] }, 'k5'),
    422,
    'VALIDATION_FAILED',
  );
  // One share is not a split; nine is too many diners (2–8 bound).
  await rejectsApiError(
    repo.splitBill(OPEN_BILL, { shares: [{ label: 'A', amountTZS: OPEN_TOTAL }] }, 'k6'),
    422,
    'VALIDATION_FAILED',
  );
  await rejectsApiError(
    repo.splitBill(OPEN_BILL, { shares: Array.from({ length: 9 }, () => ({ label: 'A', amountTZS: 3667 })) }, 'k7'),
    422,
    'VALIDATION_FAILED',
  );
  // Blank labels.
  await rejectsApiError(
    repo.splitBill(OPEN_BILL, { shares: [{ label: ' ', amountTZS: 16500 }, { label: 'B', amountTZS: 16500 }] }, 'k8'),
    422,
    'VALIDATION_FAILED',
  );
});

test('one split per bill: a second create 409s, the same key replays', async () => {
  const a = await repo.splitBill(OPEN_BILL, { shares: twoShares() }, 'k-create');
  const b = await repo.splitBill(OPEN_BILL, { shares: [{ label: 'x', amountTZS: 1 }, { label: 'y', amountTZS: OPEN_TOTAL - 1 }] }, 'k-create');
  assert.equal(a.id, b.id, 'same key replays the recorded split');
  assert.equal(b.shares[0].amountTZS, 20000, 'the replay wins over the new body');
  await rejectsApiError(repo.splitBill(OPEN_BILL, { shares: twoShares() }, 'k-create-2'), 409, 'CONFLICT');
});

test('payMyShare transitions my share to paid, completes the split and settles the bill (webhook)', async () => {
  const split = await repo.splitBill(OPEN_BILL, { shares: twoShares() }, 'k-create');
  const mine = split.shares.find((s) => s.id === split.myShareId)!;
  const paid = await repo.payMyShare(OPEN_BILL, 'k-pay');
  const myShare = paid.shares.find((s) => s.id === split.myShareId)!;
  assert.equal(myShare.status, 'paid');
  // Co-diners are pre-paid in the mock, so my pay covers every share.
  assert.equal(paid.status, 'completed', 'every share covered → the split completes');
  // Mock "webhook": the full total is covered — the bill settles like a
  // merchant confirm-payment would.
  const bill = await repo.getOrder(OPEN_BILL);
  assert.equal(bill.status, 'paid');
  assert.ok(bill.paidAt, 'paidAt is set');
  // My share rides the normal intent lifecycle: a real intent for the SHARE
  // amount landed in the payments history.
  const intent = getState().intents.find((i) => i.orderId === OPEN_BILL);
  assert.ok(intent, 'an intent was created for the split bill');
  assert.equal(intent!.amountTZS, mine.amountTZS, 'intent amount is MY share, not the bill total');
  assert.equal(intent!.status, 'paid');
  assert.ok(intent!.providerReference);
  // A settled bill is no longer payable through the full-bill flow either.
  await rejectsApiError(repo.payMyShare(OPEN_BILL, 'k-pay-2'), 409, 'CONFLICT', 'double-pay 409');
  const fetched = await repo.getSplit(OPEN_BILL);
  assert.equal(fetched.status, 'completed', 'getSplit reflects the completed split');
});

test('payMyShare honors the provider-outage path and replays per key; unknown bills 404', async () => {
  await repo.splitBill(OPEN_BILL, { shares: twoShares() }, 'k-create');
  simulatePaymentFailure('PAYMENT_PROVIDER_ERROR', 10);
  const err = await rejectsApiError(repo.payMyShare(OPEN_BILL, 'k-pay-1'), 429, 'PAYMENT_PROVIDER_ERROR');
  assert.equal(err.details?.retryAfterSeconds, 10);
  assert.equal((await repo.getSplit(OPEN_BILL)).status, 'open', 'the failed attempt leaves the split untouched');
  const retried = await repo.payMyShare(OPEN_BILL, 'k-pay-2');
  assert.equal(retried.shares.find((s) => s.id === retried.myShareId)!.status, 'paid');
  // Same key replays (idempotent).
  const replay = await repo.payMyShare(OPEN_BILL, 'k-pay-2');
  assert.deepEqual(replay, retried);
  // Unknown bill → DINE_IN_ORDER_NOT_FOUND from both reads.
  await rejectsApiError(repo.payMyShare('dine_missing', 'k-pay-3'), 404, 'DINE_IN_ORDER_NOT_FOUND');
  await rejectsApiError(repo.getSplit('dine_missing'), 404, 'DINE_IN_ORDER_NOT_FOUND');
  // A bill without a split → generic 404 (the sheet maps it to "create").
  await rejectsApiError(repo.getSplit(PAID_BILL), 404, 'NOT_FOUND');
});
