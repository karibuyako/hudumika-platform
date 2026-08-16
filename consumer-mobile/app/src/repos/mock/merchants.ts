/* In-memory merchants repository — GET /merchants, /merchants/{id},
 * /catalogues/{merchantId}, /promotions?merchantId=.
 */
import { getState, clone, findMerchant } from './mockState';
import type { MerchantsRepository } from '../index';
import type { Catalogue, MerchantPublic, Promotion } from '@hudumika/contract';
import { ApiError } from '@/api/client';

export class MockMerchantsRepository implements MerchantsRepository {
  async list(params?: { cityId?: string; category?: string; cursor?: string; limit?: number }): Promise<MerchantPublic[]> {
    const state = getState();
    let list = state.merchants;
    if (params?.category) list = list.filter((m) => (m.categories ?? []).includes(params.category as string));
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(list.slice(offset, offset + limit));
  }

  async get(merchantId: string): Promise<MerchantPublic> {
    return clone(findMerchant(merchantId));
  }

  async getCatalogue(merchantId: string): Promise<Catalogue> {
    findMerchant(merchantId);
    const catalogue = getState().catalogues.get(merchantId);
    if (!catalogue) throw new ApiError(404, 'NOT_FOUND', `Catalogue for merchant ${merchantId} not found`);
    return clone(catalogue);
  }

  async getPromotions(merchantId: string): Promise<Promotion[]> {
    findMerchant(merchantId);
    return clone(getState().promotions.get(merchantId) ?? []);
  }
}
