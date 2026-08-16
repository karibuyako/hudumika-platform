/* In-memory group-buy repository — GET /group-buys, GET /group-buys/{id},
 * POST /group-buys/{id}/purchase. Vouchers are GB-XXXX-XXXX (GROUP-BUY.md). */
import { ApiError } from '@/api/client';
import { clone, getState, nowIso } from './mockState';
import type { GroupBuyDeal, Voucher } from '@hudumika/contract';
import type { GroupBuyRepository } from '../index';

/** Voucher code format GB-XXXX-XXXX (GROUP-BUY.md; Voucher.code). */
export function mockVoucherCode(): string {
  const block = (n: number) =>
    Array.from({ length: n }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
  return `GB-${block(4)}-${block(4)}`;
}

export class MockGroupBuyRepository implements GroupBuyRepository {
  async list(params?: { cityId?: string; cursor?: string; limit?: number }): Promise<GroupBuyDeal[]> {
    const state = getState();
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(state.groupBuys.filter((g) => g.status === 'live').slice(offset, offset + limit));
  }

  async get(groupId: string): Promise<GroupBuyDeal> {
    const deal = getState().groupBuys.find((g) => g.id === groupId);
    if (!deal) throw new ApiError(404, 'GROUP_BUY_NOT_FOUND', 'Deal not found');
    return clone(deal);
  }

  async purchase(groupId: string, quantity: number, _idempotencyKey: string): Promise<Voucher[]> {
    const state = getState();
    const deal = state.groupBuys.find((g) => g.id === groupId);
    if (!deal) throw new ApiError(404, 'GROUP_BUY_NOT_FOUND', 'Deal not found');
    if (deal.status === 'ended' || deal.status === 'rejected' || deal.status === 'delisted') {
      throw new ApiError(422, 'GROUP_BUY_ENDED', 'This deal has ended');
    }
    if (deal.status !== 'live') throw new ApiError(409, 'GROUP_BUY_STATUS_CONFLICT', 'This deal is not purchasable');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new ApiError(422, 'GROUP_BUY_QUANTITY_EXCEEDED', 'Quantity must be between 1 and 20');
    }
    const vouchers: Voucher[] = Array.from({ length: quantity }, () => ({
      code: mockVoucherCode(),
      groupBuyId: groupId,
      title: deal.title,
      priceTZS: deal.priceTZS,
      status: 'unused',
      purchasedAt: nowIso(),
      expiresAt: new Date(Date.now() + (deal.validityDays ?? 90) * 86400_000).toISOString(),
    }));
    state.vouchers.push(...vouchers);
    deal.soldCount = (deal.soldCount ?? 0) + quantity;
    return clone(vouchers);
  }
}
