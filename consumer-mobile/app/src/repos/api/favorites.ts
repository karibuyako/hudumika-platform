/* Live API favorites repository — GET /favorites, POST/DELETE /favorites{/merchantId},
 * plus the favorites-lists surface (mock-only-until-adopted paths,
 * docs/CONTRACT-ADDITIONS.md #14, OPERATIONS-COVERAGE #120): GET /favorites/lists,
 * POST /favorites/lists, POST /favorites/lists/{id}/merchants,
 * DELETE /favorites/lists/{id}/merchants/{merchantId}, DELETE /favorites/lists/{id}.
 *
 * The consumer contract exposes NO favorites-lists resource yet, so a live
 * backend that has not adopted the paths fails these calls — the favorites
 * lists surface renders its error/retry state against it, the same degrade
 * path as the other app-only surfaces (disputes, payments mutations, red
 * packets). */
import { api } from '@/api/client';
import type { FavoriteList, FavoriteListCreateInput, FavoritesRepository } from '../index';
import type { MerchantPublic } from '@hudumika/contract';

export class ApiFavoritesRepository implements FavoritesRepository {
  async list(): Promise<MerchantPublic[]> {
    return api.get<MerchantPublic[]>('/favorites');
  }

  async add(merchantId: string, idempotencyKey: string): Promise<void> {
    await api.post<void>('/favorites', { merchantId }, { idempotencyKey });
  }

  async remove(merchantId: string, idempotencyKey: string): Promise<void> {
    await api.delete<void>(`/favorites/${merchantId}`, { idempotencyKey });
  }

  async listLists(): Promise<FavoriteList[]> {
    return api.get<FavoriteList[]>('/favorites/lists');
  }

  async createList(input: FavoriteListCreateInput, idempotencyKey: string): Promise<FavoriteList> {
    return api.post<FavoriteList>('/favorites/lists', input, { idempotencyKey });
  }

  async addToList(listId: string, merchantId: string, idempotencyKey: string): Promise<FavoriteList> {
    return api.post<FavoriteList>(`/favorites/lists/${listId}/merchants`, { merchantId }, { idempotencyKey });
  }

  async removeFromList(listId: string, merchantId: string, idempotencyKey: string): Promise<FavoriteList> {
    return api.delete<FavoriteList>(`/favorites/lists/${listId}/merchants/${merchantId}`, { idempotencyKey });
  }

  async deleteList(listId: string, idempotencyKey: string): Promise<void> {
    await api.delete<void>(`/favorites/lists/${listId}`, { idempotencyKey });
  }
}
