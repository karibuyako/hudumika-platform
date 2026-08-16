/* Live API inventory repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/inventory                          → ProviderInventoryItem[]
 *   POST /providers/me/inventory                          → ProviderInventoryItem
 *   POST /providers/me/inventory/items/{itemId}/adjust    → ProviderInventoryItem
 */
import { api } from '@/api/client';
import type { InventoryRepository } from '../index';
import type { AdjustInventoryItemBody, ProviderInventoryItem } from '@hudumika/contract';

export class ApiInventoryRepository implements InventoryRepository {
  async list(): Promise<ProviderInventoryItem[]> {
    return api.get<ProviderInventoryItem[]>('/providers/me/inventory');
  }

  async create(input: ProviderInventoryItem): Promise<ProviderInventoryItem> {
    return api.post<ProviderInventoryItem>('/providers/me/inventory', input);
  }

  async adjust(itemId: string, delta: number, reason: string): Promise<ProviderInventoryItem> {
    const body: AdjustInventoryItemBody = { delta, reason };
    return api.post<ProviderInventoryItem>(`/providers/me/inventory/items/${itemId}/adjust`, body);
  }
}
