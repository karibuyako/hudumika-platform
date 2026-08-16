/* M15 — Red packets (P6c): received list, claim → wallet credit + transaction
 * row (integer TZS), double-claim 409, expired 422, promotional share
 * creation with a shareCode, and the deep-link allow-list accepting
 * hudumika://red-packet/{shareCode}. Mock-only until the contract ships the
 * red-packet resource (docs/CONTRACT-ADDITIONS.md #12). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAndValidateDeepLink } from '@/lib/deep-link';
import { idempotencyKey } from '@/lib/idempotency';
import { useSessionStore } from '@/store/session';
import { resetMockState } from '@/repos/mock/mockState';
import { MockRedPacketRepository, redPacketsForTests, resetMockRedPacketState, expireRedPacketForTests } from '@/repos/mock/redPackets';
import { MockWalletRepository } from '@/repos/mock/wallet';
import { rejectsApiError } from './helpers';
import type { User } from '@hudumika/contract';

const redPackets = new MockRedPacketRepository();
const wallet = new MockWalletRepository();

beforeEach(() => {
  resetMockState();
  resetMockRedPacketState();
});

test('listReceived returns the two seeded packets — one claimable, one already claimed', async () => {
  const list = await redPackets.listReceived();
  assert.equal(list.length, 2);

  const claimable = list.find((p) => p.id === 'rpk_promo_001');
  assert.ok(claimable, 'the claimable promo seed exists');
  assert.equal(claimable.claimed, false);
  assert.equal(claimable.totalTZS, 10000);
  assert.equal(claimable.count, 5);
  assert.equal(claimable.claimedCount, 0);
  assert.ok(Number.isInteger(claimable.totalTZS));
  assert.ok(!Number.isNaN(Date.parse(claimable.expiresAt)), 'expiry is a parseable ISO stamp');

  const claimed = list.find((p) => p.id === 'rpk_promo_002');
  assert.ok(claimed);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.claimedCount, claimed.count, 'a claimed packet shows a full claim ledger');
});

test('claim credits the wallet balance and appends an integer-TZS red_packet transaction', async () => {
  const before = await wallet.getWallet();
  const txsBefore = await wallet.getTransactions();

  const claim = await redPackets.claim('rpk_promo_001', idempotencyKey('cus_0001', 'red-packet-claim'));
  assert.ok(claim.id.startsWith('rpclaim'));
  assert.equal(claim.creditedTZS, 10000 / 5, 'each claim credits totalTZS / count');
  assert.ok(Number.isInteger(claim.creditedTZS));

  const after = await wallet.getWallet();
  assert.equal(after.totalTZS, before.totalTZS + claim.creditedTZS);
  assert.equal(after.withdrawableTZS, before.withdrawableTZS + claim.creditedTZS);

  const txs = await wallet.getTransactions();
  assert.equal(txs.length, txsBefore.length + 1);
  assert.equal(txs[0].amountTZS, claim.creditedTZS, 'the row carries the credited amount');
  assert.equal(txs[0].balanceTZS, after.totalTZS, 'balanceTZS follows the credit');
  assert.equal(txs[0].referenceType, 'red_packet');
  assert.equal(txs[0].type, 'adjustment'); // contract WalletTransactionType has no red-packet value
  assert.equal(txs[0].referenceId, 'rpk_promo_001');
});

test('claiming the same packet twice 409s with CONFLICT', async () => {
  await redPackets.claim('rpk_promo_001', idempotencyKey('cus_0001', 'red-packet-claim'));
  await rejectsApiError(redPackets.claim('rpk_promo_001', idempotencyKey('cus_0001', 'red-packet-claim-2')), 409, 'CONFLICT');
});

test('an already-claimed packet 409s and an unknown packet 404s', async () => {
  await rejectsApiError(redPackets.claim('rpk_promo_002', 'k1'), 409, 'CONFLICT');
  await rejectsApiError(redPackets.claim('rpk_nope', 'k2'), 404, 'NOT_FOUND');
});

test('an expired packet rejects with 422 VALIDATION_FAILED and credits nothing', async () => {
  expireRedPacketForTests('rpk_promo_001');
  const before = await wallet.getWallet();
  await rejectsApiError(redPackets.claim('rpk_promo_001', 'k1'), 422, 'VALIDATION_FAILED');
  assert.equal((await wallet.getWallet()).totalTZS, before.totalTZS, 'no credit lands on an expired claim');
});

test('createSharePacket creates a promotional packet with a shareCode', async () => {
  const created = await redPackets.createSharePacket(
    { title: 'Dinner with friends', amountTZS: 10000, count: 5, expiresInHours: 48 },
    idempotencyKey('cus_0001', 'red-packet-share'),
  );
  assert.ok(created.id.startsWith('rpk'));
  assert.match(created.shareCode ?? '', /^PK-[A-Z0-9]+$/, 'share links carry a PK- shareCode');
  assert.equal(created.totalTZS, 10000);
  assert.equal(created.count, 5);
  assert.equal(created.claimedCount, 0);
  assert.equal(created.claimed, false);
  const inList = await redPackets.listReceived();
  assert.ok(inList.some((p) => p.id === created.id), 'the created packet lands in the received list');
});

test('createSharePacket validates amount, count and expiry bounds', async () => {
  await rejectsApiError(redPackets.createSharePacket({ amountTZS: 0, count: 3, expiresInHours: 48 }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(redPackets.createSharePacket({ amountTZS: 5000.5, count: 3, expiresInHours: 48 }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(redPackets.createSharePacket({ amountTZS: 5000, count: 0, expiresInHours: 48 }, 'k3'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(redPackets.createSharePacket({ amountTZS: 5000, count: 6, expiresInHours: 48 }, 'k4'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(redPackets.createSharePacket({ amountTZS: 5000, count: 3, expiresInHours: 0 }, 'k5'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(redPackets.createSharePacket({ amountTZS: 5000, count: 3, expiresInHours: 24 * 7 + 1 }, 'k6'), 422, 'VALIDATION_FAILED');
});

test('the deep-link allow-list accepts hudumika://red-packet/{shareCode}', () => {
  assert.equal(parseAndValidateDeepLink('hudumika://red-packet/PK-7D2F'), 'red-packet/PK-7D2F');
  assert.equal(parseAndValidateDeepLink('hudumika://red-packet/PK-7D2F?utm_source=whatsapp'), 'red-packet/PK-7D2F', 'query strings are stripped');
  assert.equal(parseAndValidateDeepLink('https://app.hudumika.tz/red-packet/PK-7D2F'), 'red-packet/PK-7D2F');
  assert.equal(parseAndValidateDeepLink('red-packet/'), null, 'a shareCode id is required');
  assert.equal(parseAndValidateDeepLink('admin/red-packet/PK-7D2F'), null, 'unknown routes still no-op');
});

test('claim idempotency keys follow the session-user discipline', () => {
  useSessionStore.setState({ user: { id: 'cus_0001' } as User });
  const key = idempotencyKey('ignored', 'red-packet-claim');
  assert.match(key, /^hk_cus_0001_red-packet-claim_/);
  useSessionStore.setState({ user: null });
});
