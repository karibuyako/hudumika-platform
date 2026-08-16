/* Live API memberships repository — GET /memberships/me, POST /check-in,
 * GET /loyalty-transactions, POST /loyalty/redemptions (mock-only-until-
 * adopted). */
import { api } from '@/api/client';
import type { MembershipsRepository, RedeemPointsInput } from '../index';
import type { CustomerMembership, DailyCheckIn200, ListLoyaltyTransactions200Item } from '@hudumika/contract';

export class ApiMembershipsRepository implements MembershipsRepository {
  async get(): Promise<CustomerMembership> {
    return api.get<CustomerMembership>('/memberships/me');
  }

  /** POST /check-in — no request body in the contract; the idempotency key
   * rides the header so a retried tap never double-awards. */
  async checkIn(idempotencyKey: string): Promise<DailyCheckIn200> {
    return api.post<DailyCheckIn200>('/check-in', undefined, { idempotencyKey });
  }

  async listLoyaltyTransactions(params?: { cursor?: string; limit?: number }): Promise<ListLoyaltyTransactions200Item[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<ListLoyaltyTransactions200Item[]>(`/loyalty-transactions${qs ? `?${qs}` : ''}`);
  }

  /** POST /loyalty/redemptions — body {points, reward}, idempotency key in
   * the header. Mock-only until the contract ships the redemption mutation
   * (docs/CONTRACT-ADDITIONS.md #16): the parity harness allow-lists this
   * path. */
  async redeemPoints(input: RedeemPointsInput, idempotencyKey: string): Promise<CustomerMembership> {
    return api.post<CustomerMembership>('/loyalty/redemptions', input, { idempotencyKey });
  }

  // Mock-only until the contract exposes per-order/per-review points accrual
  // (docs/CONTRACT-ADDITIONS.md #28): no wire path exists, so the live repo
  // reports null — the order-detail / review-success earn pills hide against
  // a live backend that has not shipped the surface.
  async earningsFor(_orderId: string): Promise<{ points: number } | null> {
    return null;
  }

  async earningsForReview(_reviewId: string): Promise<{ points: number } | null> {
    return null;
  }
}
