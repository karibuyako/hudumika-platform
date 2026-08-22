/* Live API home repository — GET /home (BFF) + GET /cities +
 * GET /home/recommendations (mock-only-until-adopted path,
 * docs/CONTRACT-ADDITIONS.md #25). */
import { api } from '@/api/client';
import type { HomeRepository, RecommendedMerchant } from '../index';
import type { City, GetConsumerHome200 } from '@hudumika/contract';

export class ApiHomeRepository implements HomeRepository {
  async getHomeFeed(): Promise<GetConsumerHome200> {
    return api.get<GetConsumerHome200>('/home');
  }

  async listCities(): Promise<City[]> {
    return api.get<City[]>('/cities', { headers: { 'x-country': 'TZ' } });
  }

  /** GET /home/recommendations — live engine (time/place/session/cold/warm).
   * The live backend returns {items: RecommendedMerchant[], nextCursor} — the
   * mock returns a plain array. Handle both shapes for parity during rollout. */
  async getRecommendations(opts?: { cityId?: string; lat?: number; lon?: number; limit?: number }): Promise<RecommendedMerchant[]> {
    const params = new URLSearchParams();
    if (opts?.cityId) params.set('cityId', opts.cityId);
    if (opts?.lat != null) params.set('lat', String(opts.lat));
    if (opts?.lon != null) params.set('lon', String(opts.lon));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await api.get<RecommendedMerchant[] | { items: RecommendedMerchant[] }>(`/home/recommendations${qs}`);
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object' && 'items' in res) {
      return (res as { items: RecommendedMerchant[] }).items ?? [];
    }
    return [];
  }
}
