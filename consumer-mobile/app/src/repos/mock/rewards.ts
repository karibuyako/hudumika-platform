/* In-memory rewards repository — GET /referrals/me, POST /referrals/claim,
 * GET /rewards/birthday, POST /rewards/birthday/claim. All four surfaces are
 * in the regenerated contract (backend/API-CONTRACT.yaml), so this mock is
 * the server the demo app talks to (same module-local pattern as
 * mock/reviews.ts + mock/redPackets.ts — mockState.ts stays untouched):
 *
 * - The demo user's own referral summary is seeded (code HUDU-DEMO-25,
 *   3 invited, reward pending, TZS 5,000 total earned).
 * - Referral claims resolve against a module-local registry of known codes
 *   and a per-user claim ledger; claims are idempotent per key (a repeated
 *   key + same code replays the stored reward; a key reused with a different
 *   code is a 422 — the server treats keys as one-shot per body).
 * - The contract User DTO carries NO birthday field (verified against the
 *   generated model/user.ts), so the mock treats every demo user as
 *   in-window: availability is seeded with a fixed future expiry. */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone } from './mockState';
import type { BirthdayReward, ReferralReward, ReferralSummary } from '@hudumika/contract';
import type { RewardsRepository } from '../index';

/** The demo user's own referral code (derived from the demo user seed). */
export const MOCK_REFERRAL_CODE = 'HUDU-DEMO-25';
const MOCK_INVITED_COUNT = 3;
const MOCK_TOTAL_REWARD_TZS = 5000;

/** Known claimable referral codes → reward amountTZS (a friend's invite). */
const KNOWN_CODES = new Map<string, number>([
  ['HUDU-FRIEND-07', 7500],
]);

/** ClaimReferralBody.code shape: 6–20 chars of A–Z, 0–9 and dashes, starting
 * with a letter or digit (contract maxLength 20). */
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{5,19}$/;

/** Referral codes already claimed by this user (a code is usable once). */
const claimedCodes = new Set<string>();

/** Idempotency ledger: key → {code, reward} so a retry replays the SAME
 * reward (never a double claim) and a key reuse with a different body 422s. */
const claimReplays = new Map<string, { code: string; reward: ReferralReward }>();

/** Birthday reward state — seeded lazily (module-local, like the red-packet
 * registry); `available` stays true while claimed, mirroring the contract
 * BirthdayReward shape (available + claimed are independent flags). */
let birthday: BirthdayReward | null = null;

/** Idempotency ledger for birthday claims. */
const birthdayReplays = new Map<string, BirthdayReward>();

function seedBirthday(): void {
  if (birthday) return;
  birthday = {
    available: true,
    claimed: false,
    rewardTitle: 'Birthday treat',
    rewardTZS: 10000,
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
}

/** Tests re-seed the module-local rewards state between cases
 * (resetMockState() covers the shared store; this clears the claim ledgers +
 * birthday state — same pattern as resetMockRedPacketState). */
export function resetMockRewardsState(): void {
  claimedCodes.clear();
  claimReplays.clear();
  birthdayReplays.clear();
  birthday = null;
}

/** Test hook — the seeded birthday reward (read-only snapshot). */
export function birthdayRewardForTests(): BirthdayReward | null {
  seedBirthday();
  return birthday ? clone(birthday) : null;
}

export class MockRewardsRepository implements RewardsRepository {
  async getMyReferral(): Promise<ReferralSummary> {
    return {
      code: MOCK_REFERRAL_CODE,
      invitedCount: MOCK_INVITED_COUNT,
      rewardStatus: 'pending',
      totalRewardTZS: MOCK_TOTAL_REWARD_TZS,
    };
  }

  async claimReferral(code: string, idempotencyKey: string): Promise<ReferralReward> {
    const raw = code.trim();
    // Strict format check on the RAW input: lowercase or stray characters are
    // 422 (a strict server rejects malformed codes — the UI normalizes case).
    if (!CODE_RE.test(raw)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Referral codes are 6–20 letters, digits and dashes');
    }
    const trimmed = raw.toUpperCase();
    if (trimmed === MOCK_REFERRAL_CODE) {
      throw new ApiError(409, 'CONFLICT', 'You cannot use your own referral code', false, { reason: 'self' });
    }
    const replay = claimReplays.get(idempotencyKey);
    if (replay) {
      if (replay.code !== trimmed) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'This idempotency key was already used for a different request');
      }
      return clone(replay.reward);
    }
    if (claimedCodes.has(trimmed)) {
      throw new ApiError(409, 'CONFLICT', 'This referral code was already claimed', false, { reason: 'already_claimed' });
    }
    const amountTZS = KNOWN_CODES.get(trimmed);
    if (amountTZS === undefined) {
      throw new ApiError(404, 'NOT_FOUND', 'Referral code not found');
    }
    claimedCodes.add(trimmed);
    const reward: ReferralReward = {
      id: uid('ref'),
      amountTZS,
      // Pending → credited later (server-side). The contract allows
      // creditedAt null while the reward awaits crediting.
      status: 'pending',
      creditedAt: null,
    };
    claimReplays.set(idempotencyKey, { code: trimmed, reward: clone(reward) });
    return clone(reward);
  }

  async getBirthdayReward(): Promise<BirthdayReward> {
    seedBirthday();
    return clone(birthday!);
  }

  async claimBirthdayReward(idempotencyKey: string): Promise<BirthdayReward> {
    seedBirthday();
    const replay = birthdayReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    if (!birthday || birthday.claimed) {
      throw new ApiError(409, 'CONFLICT', 'You already claimed your birthday reward');
    }
    birthday = { ...birthday, claimed: true };
    birthdayReplays.set(idempotencyKey, clone(birthday));
    return clone(birthday);
  }
}
