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

  /** GET /home/recommendations — mock-only-until-adopted path
   * (docs/CONTRACT-ADDITIONS.md #25, parity harness allow-list): the consumer
   * contract exposes no recommendations surface, so a live backend that has
   * not adopted the path errors the section into its error/retry state (the
   * consent-gated home rail degrades to the enable-recommendations hint). */
  async getRecommendations(): Promise<RecommendedMerchant[]> {
    return api.get<RecommendedMerchant[]>('/home/recommendations');
  }
}
