/* Live API merchants repository — GET /merchants, /merchants/{id},
 * /catalogues/{merchantId}, /promotions?merchantId=. */
import { api } from '@/api/client';
import type { MerchantsRepository } from '../index';
import type { Catalogue, MerchantPublic, Promotion } from '@hudumika/contract';

export class ApiMerchantsRepository implements MerchantsRepository {
  async list(params?: { cityId?: string; category?: string; cursor?: string; limit?: number }): Promise<MerchantPublic[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<MerchantPublic[]>(`/merchants${qs ? `?${qs}` : ''}`);
  }

  async get(merchantId: string): Promise<MerchantPublic> {
    return api.get<MerchantPublic>(`/merchants/${merchantId}`);
  }

  async getCatalogue(merchantId: string): Promise<Catalogue> {
    return api.get<Catalogue>(`/catalogues/${merchantId}`);
  }

  async getPromotions(merchantId: string): Promise<Promotion[]> {
    return api.get<Promotion[]>(`/promotions?merchantId=${encodeURIComponent(merchantId)}`);
  }
}
