/* In-memory inventory repository. Mirrors GET/POST /providers/me/inventory and
 * POST /providers/me/inventory/{id}/adjust against module state in mockState.ts.
 * Adjustments require a reason (422 INVENTORY_ADJUSTMENT_REASON_REQUIRED) and
 * cannot drive stock below zero (422 INVENTORY_NEGATIVE_STOCK); unknown items
 * throw 404 INVENTORY_ITEM_NOT_FOUND.
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso } from './mockState';
import { uid } from '@/lib/format';
import type { InventoryRepository } from '../index';
import type { ProviderInventoryItem } from '@hudumika/contract';

export class MockInventoryRepository implements InventoryRepository {
  async list(): Promise<ProviderInventoryItem[]> {
    return clone(getState().inventory);
  }

  async create(input: ProviderInventoryItem): Promise<ProviderInventoryItem> {
    const state = getState();
    const item: ProviderInventoryItem = {
      ...clone(input),
      id: uid('inv'),
      updatedAt: nowIso(),
    };
    state.inventory.push(item);
    return clone(item);
  }

  async adjust(itemId: string, delta: number, reason: string): Promise<ProviderInventoryItem> {
    const state = getState();
    const item = state.inventory.find((i) => i.id === itemId);
    if (!item) throw new ApiError(404, 'INVENTORY_ITEM_NOT_FOUND', `Inventory item ${itemId} not found`);
    if (!reason.trim()) {
      throw new ApiError(422, 'INVENTORY_ADJUSTMENT_REASON_REQUIRED', 'A reason is required for stock adjustments');
    }
    const next = item.stockOnHand + delta;
    if (next < 0) {
      throw new ApiError(422, 'INVENTORY_NEGATIVE_STOCK', 'Adjustment would drive stock below zero');
    }
    item.stockOnHand = next;
    item.updatedAt = nowIso();
    return clone(item);
  }
}
