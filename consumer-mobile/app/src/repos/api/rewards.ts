/* Live API rewards repository — GET /referrals/me, POST /referrals/claim
 * (Idempotency-Key), GET /rewards/birthday, POST /rewards/birthday/claim.
 * All four paths are contract surfaces (generated endpoints users.ts,
 * backend/API-CONTRACT.yaml) — nothing mock-only on the live wire. */
import { api } from '@/api/client';
import type { BirthdayReward, ClaimReferralBody, ReferralReward, ReferralSummary } from '@hudumika/contract';
import type { RewardsRepository } from '../index';

export class ApiRewardsRepository implements RewardsRepository {
  async getMyReferral(): Promise<ReferralSummary> {
    return api.get<ReferralSummary>('/referrals/me');
  }

  async claimReferral(code: string, idempotencyKey: string): Promise<ReferralReward> {
    // Contract ClaimReferralBody {code} — maxLength 20.
    const body: ClaimReferralBody = { code };
    return api.post<ReferralReward>('/referrals/claim', body, { idempotencyKey });
  }

  async getBirthdayReward(): Promise<BirthdayReward> {
    return api.get<BirthdayReward>('/rewards/birthday');
  }

  async claimBirthdayReward(idempotencyKey: string): Promise<BirthdayReward> {
    // The generated claimBirthdayReward endpoint takes no body.
    return api.post<BirthdayReward>('/rewards/birthday/claim', {}, { idempotencyKey });
  }
}
