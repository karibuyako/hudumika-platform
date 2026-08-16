/* M16f — Referral + birthday rewards (contract surfaces shipped in the
 * regenerated spec): GET /referrals/me seeded summary, POST /referrals/claim
 * (format 422 / own code 409 / already-claimed 409 / unknown 404 / success
 * shape + idempotent per key), GET /rewards/birthday + POST
 * /rewards/birthday/claim (flow, double-claim 409, idempotent per key), and
 * the deep-link allow-list accepting hudumika://referral/{code}. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { deepLinkHref, parseAndValidateDeepLink } from '@/lib/deep-link';
import { idempotencyKey } from '@/lib/idempotency';
import { useSessionStore } from '@/store/session';
import { resetMockState } from '@/repos/mock/mockState';
import { birthdayRewardForTests, MOCK_REFERRAL_CODE, MockRewardsRepository, resetMockRewardsState } from '@/repos/mock/rewards';
import { rejectsApiError } from './helpers';
import type { User } from '@hudumika/contract';

const rewards = new MockRewardsRepository();

beforeEach(() => {
  resetMockState();
  resetMockRewardsState();
  useSessionStore.setState({ user: { id: 'cus_0001' } as User });
});

test('getMyReferral returns the seeded summary for the demo user', async () => {
  const summary = await rewards.getMyReferral();
  assert.equal(summary.code, MOCK_REFERRAL_CODE);
  assert.equal(summary.invitedCount, 3);
  assert.equal(summary.rewardStatus, 'pending');
  assert.equal(summary.totalRewardTZS, 5000);
  assert.ok(Number.isInteger(summary.totalRewardTZS), 'money is integer TZS');
});

test('claimReferral claims a known code and returns a pending ReferralReward', async () => {
  const reward = await rewards.claimReferral('HUDU-FRIEND-07', idempotencyKey('cus_0001', 'referral-claim'));
  assert.ok(reward.id.startsWith('ref'));
  assert.equal(reward.amountTZS, 7500);
  assert.ok(Number.isInteger(reward.amountTZS), 'money is integer TZS');
  assert.equal(reward.status, 'pending', 'the reward lands pending and is credited later');
  assert.equal(reward.creditedAt, null, 'creditedAt stays null while pending');
});

test('claimReferral is idempotent per key (same key replays the same reward)', async () => {
  const key = idempotencyKey('cus_0001', 'referral-claim');
  const first = await rewards.claimReferral('HUDU-FRIEND-07', key);
  const replay = await rewards.claimReferral('HUDU-FRIEND-07', key);
  assert.equal(replay.id, first.id, 'the replay returns the stored reward, not a second claim');
  assert.equal(replay.amountTZS, first.amountTZS);
  assert.equal(replay.status, first.status);
});

test('claimReferral rejects bad formats, own code, double-claim and unknown codes', async () => {
  await rejectsApiError(rewards.claimReferral('tiny', 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(rewards.claimReferral('hudu-friend-07', 'k2'), 422, 'VALIDATION_FAILED');
  const own = await rejectsApiError(rewards.claimReferral(MOCK_REFERRAL_CODE, 'k3'), 409, 'CONFLICT');
  assert.equal(own.details?.reason, 'self');
  await rewards.claimReferral('HUDU-FRIEND-07', 'k4');
  const dup = await rejectsApiError(rewards.claimReferral('HUDU-FRIEND-07', 'k5'), 409, 'CONFLICT');
  assert.equal(dup.details?.reason, 'already_claimed');
  await rejectsApiError(rewards.claimReferral('NOPE-123456', 'k6'), 404, 'NOT_FOUND');
});

test('a reused key with a different code is rejected', async () => {
  await rewards.claimReferral('HUDU-FRIEND-07', 'shared-key');
  await rejectsApiError(rewards.claimReferral('HUDU-OTHER-99', 'shared-key'), 422, 'VALIDATION_FAILED');
});

test('getBirthdayReward is available for the demo user with a seeded future expiry', async () => {
  const reward = await rewards.getBirthdayReward();
  assert.equal(reward.available, true);
  assert.equal(reward.claimed, false);
  assert.equal(reward.rewardTitle, 'Birthday treat');
  assert.equal(reward.rewardTZS, 10000);
  assert.ok(Number.isInteger(reward.rewardTZS), 'money is integer TZS');
  assert.ok(reward.expiresAt && Date.parse(reward.expiresAt) > Date.now(), 'expiry is a future ISO stamp');
});

test('claimBirthdayReward flips the state to claimed and a second claim 409s', async () => {
  const claimed = await rewards.claimBirthdayReward(idempotencyKey('cus_0001', 'birthday-claim'));
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.available, true, 'available stays true — the reward existed and was taken');
  assert.equal(claimed.rewardTitle, 'Birthday treat');
  assert.equal(claimed.rewardTZS, 10000);
  assert.ok(claimed.expiresAt && Date.parse(claimed.expiresAt) > Date.now());
  const after = await rewards.getBirthdayReward();
  assert.equal(after.claimed, true, 'the GET reflects the claim');
  const state = birthdayRewardForTests();
  assert.equal(state?.claimed, true);
  await rejectsApiError(rewards.claimBirthdayReward(idempotencyKey('cus_0001', 'birthday-claim-2')), 409, 'CONFLICT');
});

test('claimBirthdayReward is idempotent per key', async () => {
  const key = idempotencyKey('cus_0001', 'birthday-claim');
  const first = await rewards.claimBirthdayReward(key);
  const replay = await rewards.claimBirthdayReward(key);
  assert.equal(replay.claimed, true);
  assert.equal(replay.rewardTZS, first.rewardTZS);
  assert.equal(replay.expiresAt, first.expiresAt, 'the replay returns the stored reward');
});

test('the deep-link allow-list accepts hudumika://referral/{code}', () => {
  assert.equal(parseAndValidateDeepLink('hudumika://referral/HUDU-FRIEND-07'), 'referral/HUDU-FRIEND-07');
  assert.equal(parseAndValidateDeepLink('hudumika://referral/HUDU-FRIEND-07?utm_source=whatsapp'), 'referral/HUDU-FRIEND-07', 'query strings are stripped');
  assert.equal(parseAndValidateDeepLink('https://app.hudumika.tz/referral/HUDU-FRIEND-07'), 'referral/HUDU-FRIEND-07');
  assert.equal(parseAndValidateDeepLink('referral/'), null, 'a code id is required');
  assert.equal(parseAndValidateDeepLink('admin/referral/HUDU-FRIEND-07'), null, 'unknown routes still no-op');
  assert.deepEqual(deepLinkHref('referral/HUDU-FRIEND-07'), { pathname: '/referrals', params: { code: 'HUDU-FRIEND-07' } });
});

test('claim idempotency keys follow the session-user discipline', () => {
  const key = idempotencyKey('ignored', 'referral-claim');
  assert.match(key, /^hk_cus_0001_referral-claim_/);
});
