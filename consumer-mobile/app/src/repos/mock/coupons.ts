/* In-memory coupons repository — GET /coupons/me, POST /coupons/{id}/claim,
 * POST /coupons/suggest (mock-only-until-adopted, docs/CONTRACT-ADDITIONS.md
 * #26: the generated contract has no suggest endpoint — the mock is the
 * server for the smart-coupon suggestion; a live backend that has not shipped
 * it errors the api call and the checkout hides the advisory chip). */
import { ApiError } from '@/api/client';
import { clone, getState, nowIso } from './mockState';
import type { Coupon } from '@hudumika/contract';
import { CouponStatus } from '@hudumika/contract';
import type { CouponsRepository, CouponSuggestionInput } from '../index';

/** Pure smart-coupon engine (MASTER-BLUEPRINT §16): among the wallet coupons
 * pick the best APPLICABLE one for a cart. Applicable = minimumSpendTZS <=
 * subtotalTZS, status claimed/available (used/expired/void are dead), and
 * not past expiresAt (expiresAt equal to now counts as expired). Best =
 * largest discountTZS; ties resolve to the first in input order (stable
 * sort). The contract Coupon payload carries NO merchant linkage, so the
 * rank is purely discount-vs-minimum-spend — a merchant-scoped rank is a
 * server-side concern once the contract ships the suggest endpoint. Exported
 * for the test suites. Returns null when nothing applies. */
export function suggestBestCoupon(coupons: Coupon[], subtotalTZS: number): Coupon | null {
  const now = Date.now();
  return (
    coupons
      .filter((c) => c.status === CouponStatus.claimed || c.status === CouponStatus.available)
      .filter((c) => (c.minimumSpendTZS ?? 0) <= subtotalTZS)
      .filter((c) => !c.expiresAt || Date.parse(c.expiresAt) > now)
      .sort((a, b) => (b.discountTZS ?? 0) - (a.discountTZS ?? 0))[0] ?? null
  );
}

export class MockCouponsRepository implements CouponsRepository {
  async list(status?: string): Promise<Coupon[]> {
    const state = getState();
    let list = state.coupons;
    if (status) list = list.filter((c) => c.status === status);
    return clone(list);
  }

  async claim(couponId: string, _idempotencyKey: string): Promise<Coupon> {
    const state = getState();
    const coupon = state.coupons.find((c) => c.id === couponId);
    if (!coupon) throw new ApiError(404, 'COUPON_CAMPAIGN_NOT_FOUND', 'Coupon not found');
    if (coupon.status === CouponStatus.claimed || coupon.status === CouponStatus.used) {
      throw new ApiError(409, 'COUPON_ALREADY_CLAIMED', 'You already claimed this coupon');
    }
    if (coupon.status === CouponStatus.expired) throw new ApiError(422, 'COUPON_EXPIRED', 'This coupon has expired');
    coupon.status = CouponStatus.claimed;
    coupon.claimedAt = nowIso();
    return clone(coupon);
  }

  async suggestForCart(input: CouponSuggestionInput): Promise<Coupon | null> {
    // READ-ONLY suggestion: only the caller's wallet coupon ids are in play
    // (unknown ids are simply not part of the wallet) — nothing is claimed or
    // consumed here; the coupon is applied later at order create.
    const wallet = getState().coupons.filter((c) => input.couponIds.includes(c.id));
    return clone(suggestBestCoupon(wallet, input.subtotalTZS));
  }
}
