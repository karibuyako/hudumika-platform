/* Live API coupons repository — GET /coupons/me, POST /coupons/{id}/claim,
 * POST /coupons/suggest (mock-only-until-adopted, docs/CONTRACT-ADDITIONS.md
 * #26 — the generated contract ships no suggest endpoint, so this path lives
 * on the parity harness allow-list until Team 6 adds it). */
import { api } from '@/api/client';
import type { Coupon } from '@hudumika/contract';
import type { CouponsRepository, CouponSuggestionInput } from '../index';

export class ApiCouponsRepository implements CouponsRepository {
  async list(status?: string): Promise<Coupon[]> {
    return api.get<Coupon[]>(`/coupons/me${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  }

  async claim(couponId: string, idempotencyKey: string): Promise<Coupon> {
    return api.post<Coupon>(`/coupons/${couponId}/claim`, {}, { idempotencyKey });
  }

  async suggestForCart(input: CouponSuggestionInput): Promise<Coupon | null> {
    // Mock-only-until-adopted path (docs/CONTRACT-ADDITIONS.md #26): a live
    // backend that has not shipped it errors the call and the checkout hides
    // the advisory suggestion chip (silent catch — the chip is never blocking).
    return api.post<Coupon | null>('/coupons/suggest', input);
  }
}
