/* Live API group-buy repository — GET /group-buys, POST /group-buys/{id}/purchase. */
import { api } from '@/api/client';
import type { GroupBuyDeal, Voucher } from '@hudumika/contract';
import type { GroupBuyRepository } from '../index';

export class ApiGroupBuyRepository implements GroupBuyRepository {
  async list(params?: { cityId?: string; cursor?: string; limit?: number }): Promise<GroupBuyDeal[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<GroupBuyDeal[]>(`/group-buys${qs ? `?${qs}` : ''}`);
  }

  async get(groupId: string): Promise<GroupBuyDeal> {
    return api.get<GroupBuyDeal>(`/group-buys/${groupId}`);
  }

  async purchase(groupId: string, quantity: number, idempotencyKey: string): Promise<Voucher[]> {
    return api.post<Voucher[]>(`/group-buys/${groupId}/purchase`, { quantity }, { idempotencyKey });
  }
}
