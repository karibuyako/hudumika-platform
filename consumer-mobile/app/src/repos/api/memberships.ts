/* Live API memberships repository — GET /memberships/me, POST /check-in,
 * GET /loyalty-transactions, POST /loyalty/redemptions (mock-only-until-
 * adopted), GET /loyalty/rewards | /loyalty/catalog (server-driven catalog). */
import { api } from '@/api/client';
import { REDEMPTION_CATALOG } from '../index';
import type { MembershipsRepository, RedeemPointsInput, RedemptionReward } from '../index';
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

  async getRedemptionCatalog(): Promise<RedemptionReward[]> {
    const extract = (data: unknown): RedemptionReward[] | null => {
      if (Array.isArray(data)) return data as RedemptionReward[];
      if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        for (const key of ['rewards', 'catalog', 'data', 'items', 'results']) {
          const v = obj[key];
          if (Array.isArray(v)) return v as RedemptionReward[];
        }
      }
      return null;
    };
    const tryPath = async (path: string): Promise<RedemptionReward[] | null> => {
      try {
        const res = await api.get<unknown>(path);
        const catalog = extract(res);
        if (catalog !== null) {
          // Basic shape guard — accept only arrays of {reward, points}
          const valid = catalog.every(
            (r) => typeof (r as unknown as Record<string, unknown>).reward === 'string' && typeof (r as unknown as Record<string, unknown>).points === 'number',
          );
          if (catalog.length === 0 || valid) return catalog;
          // Fall through to null if shape is unexpected — fallback to static
        }
        return null;
      } catch {
        return null;
      }
    };
    const fromRewards = await tryPath('/loyalty/rewards');
    if (fromRewards !== null) return fromRewards.length ? fromRewards : REDEMPTION_CATALOG;
    const fromCatalog = await tryPath('/loyalty/catalog');
    if (fromCatalog !== null) return fromCatalog.length ? fromCatalog : REDEMPTION_CATALOG;
    return REDEMPTION_CATALOG;
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
