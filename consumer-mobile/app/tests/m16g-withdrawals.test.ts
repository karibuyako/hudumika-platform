/* M16g — Wallet withdrawals: request validates amount bounds, rejects
 * amounts above the withdrawable balance, decrements the balance and appends
 * a signed integer-TZS withdrawal transaction, is idempotent per key, and
 * the history lists created + seeded rows. POST /wallet/withdrawals
 * (requestWithdrawal) and GET /wallet/withdrawals (listWithdrawals) are LIVE
 * contract endpoints (packages/contract/src/generated/endpoints/payouts/
 * payouts.ts); the mock uses only ERROR-CODES.md codes. The seeded
 * withdrawable balance is random (fixture 2,500–85,000 TZS), so amounts are
 * derived from the live balance.
 *
 * Destination support (mock-first): the generated RequestWithdrawalBody only
 * carries {amountTZS} and the Withdrawal model has no destination field, so
 * the destination (M-Pesa number / bank account) is a mock-only extension —
 * the mock validates it when provided and stores it MASKED on the record
 * (server-side masking, same rule as the payout account). Withdrawing without
 * a destination stays backward compatible. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { idempotencyKey } from '@/lib/idempotency';
import { resetMockState } from '@/repos/mock/mockState';
import { MockWalletRepository, resetMockWithdrawalState, withdrawalsForTests } from '@/repos/mock/wallet';
import { rejectsApiError } from './helpers';
import { WithdrawalStatus } from '@hudumika/contract';

const wallet = new MockWalletRepository();

/** All withdrawal-related codes documented in backend/ERROR-CODES.md
 * (Wallet and withdrawals section + global VALIDATION_FAILED). */
const WITHDRAWAL_CODES = new Set([
  'VALIDATION_FAILED',
  'WALLET_INSUFFICIENT_BALANCE',
  'WALLET_WITHDRAWAL_UNAVAILABLE',
  'WITHDRAWAL_NOT_FOUND',
  'WITHDRAWAL_BELOW_MINIMUM',
  'WITHDRAWAL_ACCOUNT_MISSING',
  'WITHDRAWAL_ALREADY_PROCESSED',
  'WITHDRAWAL_RATE_LIMITED',
]);

beforeEach(() => {
  resetMockState();
  resetMockWithdrawalState();
});

test('withdraw validates amount bounds (integer ≥ 1) with 422 VALIDATION_FAILED', async () => {
  const before = await wallet.getWallet();
  const txsBefore = await wallet.getTransactions();
  await rejectsApiError(wallet.withdraw({ amountTZS: 0 }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(wallet.withdraw({ amountTZS: -5000 }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(wallet.withdraw({ amountTZS: 1.5 }, 'k3'), 422, 'VALIDATION_FAILED');
  const after = await wallet.getWallet();
  assert.equal(after.totalTZS, before.totalTZS, 'no debit on invalid amounts');
  assert.equal(after.withdrawableTZS, before.withdrawableTZS, 'no debit on invalid amounts');
  assert.equal((await wallet.getTransactions()).length, txsBefore.length, 'no transaction rows on invalid amounts');
});

test('withdraw above the withdrawable balance 422s WALLET_INSUFFICIENT_BALANCE and debits nothing', async () => {
  const before = await wallet.getWallet();
  const txsBefore = await wallet.getTransactions();
  const err = await rejectsApiError(wallet.withdraw({ amountTZS: before.withdrawableTZS + 1 }, 'k1'), 422);
  assert.equal(err.code, 'WALLET_INSUFFICIENT_BALANCE');
  const after = await wallet.getWallet();
  assert.equal(after.totalTZS, before.totalTZS);
  assert.equal(after.withdrawableTZS, before.withdrawableTZS);
  assert.equal((await wallet.getTransactions()).length, txsBefore.length);
  assert.equal((await wallet.listWithdrawals()).length, 1, 'only the seed exists — nothing created');
});

test('withdraw decrements the balance and appends a signed integer-TZS withdrawal transaction', async () => {
  const before = await wallet.getWallet();
  const amountTZS = before.withdrawableTZS;
  const txsBefore = await wallet.getTransactions();

  const withdrawal = await wallet.withdraw({ amountTZS }, idempotencyKey('cus_0001', 'wallet-withdraw'));
  assert.ok(withdrawal.id.startsWith('wdr'));
  assert.equal(withdrawal.amountTZS, amountTZS);
  assert.equal(withdrawal.feeTZS, 0);
  assert.equal(withdrawal.status, WithdrawalStatus.pending);
  assert.equal(withdrawal.paidAt, null);
  assert.ok(typeof withdrawal.method === 'string' && withdrawal.method.length > 0, 'the payout method rides the withdrawal');
  assert.ok(Number.isInteger(withdrawal.estimatedArrivalDays) && (withdrawal.estimatedArrivalDays ?? 0) >= 1);
  assert.ok(!Number.isNaN(Date.parse(withdrawal.createdAt)), 'createdAt is a parseable ISO stamp');

  const after = await wallet.getWallet();
  assert.equal(after.withdrawableTZS, 0, 'withdrawing the full balance empties the withdrawable');
  assert.equal(after.totalTZS, before.totalTZS - amountTZS);
  assert.ok(Number.isInteger(after.totalTZS), 'balance stays integer TZS');

  const txs = await wallet.getTransactions();
  assert.equal(txs.length, txsBefore.length + 1);
  assert.equal(txs[0].type, 'withdrawal');
  assert.equal(txs[0].amountTZS, -amountTZS, 'the debit row is signed negative');
  assert.ok(Number.isInteger(txs[0].amountTZS), 'transaction amounts stay integer TZS');
  assert.equal(txs[0].balanceTZS, after.totalTZS, 'balanceTZS follows the debit');
  assert.equal(txs[0].referenceType, 'withdrawal');
  assert.equal(txs[0].referenceId, withdrawal.id, 'the row links back to the withdrawal');
});

test('withdraw is idempotent per key — the replay returns the same withdrawal, never a double debit', async () => {
  const before = await wallet.getWallet();
  const amountTZS = Math.floor(before.withdrawableTZS / 2);
  const key = idempotencyKey('cus_0001', 'wallet-withdraw');

  const first = await wallet.withdraw({ amountTZS }, key);
  const replay = await wallet.withdraw({ amountTZS }, key);
  assert.equal(replay.id, first.id, 'same key → same withdrawal');
  assert.equal(replay.amountTZS, first.amountTZS);

  const after = await wallet.getWallet();
  assert.equal(after.withdrawableTZS, before.withdrawableTZS - amountTZS, 'debited exactly once');
  assert.equal(after.totalTZS, before.totalTZS - amountTZS);
  const txs = await wallet.getTransactions();
  assert.equal(txs.filter((tx) => tx.referenceId === first.id).length, 1, 'one transaction row for the withdrawal');
  const list = await wallet.listWithdrawals();
  assert.equal(list.filter((w) => w.id === first.id).length, 1, 'one history row for the withdrawal');
});

test('listWithdrawals returns created withdrawals + the seeded completed one', async () => {
  const seeded = await wallet.listWithdrawals();
  assert.equal(seeded.length, 1, 'history seeds one completed withdrawal');
  assert.equal(seeded[0].id, 'wdr_seed_001');
  assert.equal(seeded[0].status, WithdrawalStatus.paid, 'the seed is completed/paid');
  assert.ok(seeded[0].paidAt, 'a paid withdrawal carries paidAt');

  const before = await wallet.getWallet();
  const created = await wallet.withdraw({ amountTZS: Math.floor(before.withdrawableTZS / 2) }, 'k1');
  const list = await wallet.listWithdrawals();
  assert.equal(list.length, 2, 'created + seeded');
  assert.equal(list[0].id, created.id, 'newest first');
  assert.ok(list.some((w) => w.id === 'wdr_seed_001'));

  // The test hook exposes the same registry.
  assert.equal(withdrawalsForTests().length, 2);
});

test('the mock uses only ERROR-CODES.md withdrawal codes', async () => {
  const before = await wallet.getWallet();
  const validation = await rejectsApiError(wallet.withdraw({ amountTZS: 0 }, 'k1'), 422);
  const insufficient = await rejectsApiError(wallet.withdraw({ amountTZS: before.withdrawableTZS + 1 }, 'k2'), 422);
  assert.ok(WITHDRAWAL_CODES.has(validation.code), `invented code: ${validation.code}`);
  assert.ok(WITHDRAWAL_CODES.has(insufficient.code), `invented code: ${insufficient.code}`);
});

test('getPayoutDestination exposes the seeded payout method withdrawals are paid to', async () => {
  const dest = await wallet.getPayoutDestination();
  assert.ok(dest, 'the mock serves a payout destination');
  assert.equal(dest.method, 'mpesa');
  assert.ok(dest.maskedAccount.length > 0);

  const before = await wallet.getWallet();
  const w = await wallet.withdraw({ amountTZS: Math.floor(before.withdrawableTZS / 2) }, 'k1');
  assert.equal(w.method, dest.method, 'the withdrawal carries the same destination method');
});

test('withdraw with a valid destination succeeds — the record carries the masked destination and the list renders it', async () => {
  const before = await wallet.getWallet();
  const amountTZS = Math.floor(before.withdrawableTZS / 2);

  const w = await wallet.withdraw({ amountTZS, destination: '+255712345678', method: 'mpesa' }, 'k1');
  assert.equal(w.status, WithdrawalStatus.pending);
  assert.equal(w.method, 'mpesa', 'the requested method rides the withdrawal');
  assert.equal(w.destination, '****5678', 'the mock masks the destination server-side (last 4 digits) — the render data');

  // The local 0-prefix form is accepted too.
  const w2 = await wallet.withdraw({ amountTZS: Math.floor(before.withdrawableTZS / 4), destination: '0712345678' }, 'k2');
  assert.equal(w2.destination, '****5678', 'both Tanzanian number forms mask to the same reference');

  const list = await wallet.listWithdrawals();
  assert.equal(list[0].id, w2.id, 'newest first');
  assert.equal(list[0].destination, '****5678', 'the history row carries the masked destination');
  assert.equal(withdrawalsForTests().find((r) => r.id === w.id)?.destination, '****5678', 'the test hook exposes the same record');

  const after = await wallet.getWallet();
  assert.equal(after.withdrawableTZS, before.withdrawableTZS - w.amountTZS - w2.amountTZS, 'debited exactly the requested amounts');
});

test('withdraw rejects an invalid destination with 422 VALIDATION_FAILED and debits nothing', async () => {
  const before = await wallet.getWallet();
  const txsBefore = await wallet.getTransactions();
  const amountTZS = Math.floor(before.withdrawableTZS / 2);

  await rejectsApiError(wallet.withdraw({ amountTZS, destination: '   ' }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(wallet.withdraw({ amountTZS, destination: '07551234' }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(wallet.withdraw({ amountTZS, destination: '+25512345678' }, 'k3'), 422, 'VALIDATION_FAILED');

  const after = await wallet.getWallet();
  assert.equal(after.totalTZS, before.totalTZS, 'no debit on an invalid destination');
  assert.equal(after.withdrawableTZS, before.withdrawableTZS, 'no debit on an invalid destination');
  assert.equal((await wallet.getTransactions()).length, txsBefore.length, 'no transaction rows on an invalid destination');
  assert.equal((await wallet.listWithdrawals()).length, 1, 'only the seed remains — nothing created');
});

test('withdraw without a destination still works (backward compatible) and carries no destination', async () => {
  const before = await wallet.getWallet();
  const amountTZS = Math.floor(before.withdrawableTZS / 2);

  const w = await wallet.withdraw({ amountTZS }, 'k1');
  assert.equal(w.status, WithdrawalStatus.pending);
  assert.equal(w.destination, undefined, 'no destination → the record carries none');
  assert.equal(w.method, 'mpesa', 'the linked payout method defaults when none is sent');

  const after = await wallet.getWallet();
  assert.equal(after.withdrawableTZS, before.withdrawableTZS - amountTZS, 'the withdrawal debits as before');
  assert.equal((await wallet.listWithdrawals()).length, 2, 'created + seeded');
});
