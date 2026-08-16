/* In-memory favorites repository — GET /favorites, POST/DELETE /favorites{/merchantId},
 * plus the favorites-lists surface (mock-only-until-adopted,
 * docs/CONTRACT-ADDITIONS.md #14, OPERATIONS-COVERAGE #120): GET
 * /favorites/lists, POST /favorites/lists, POST /favorites/lists/{id}/merchants,
 * DELETE /favorites/lists/{id}/merchants/{merchantId}, DELETE /favorites/lists/{id}.
 *
 * Lists keep a module-local registry (mockState.ts stays untouched — same
 * pattern as mock/reviews.ts and mock/redPackets.ts): lazily seeded with one
 * default list "My favorites" that snapshots the favorites that exist at
 * first access (the demo user's saved merchants; server copy, rendered
 * verbatim — never an i18n key). createList is idempotent per key (a replay
 * returns the stored list; a key reuse with a different name → 422). */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, findMerchant, getState, nowIso } from './mockState';
import type { FavoriteList, FavoriteListCreateInput, FavoritesRepository } from '../index';
import type { MerchantPublic } from '@hudumika/contract';

/** Module-local favorites-lists registry. */
let lists: FavoriteList[] = [];

/** Idempotency ledger for createList: key → stored list (replays return the
 * same list; a key reuse with a different body is a 422 — the server treats
 * keys as one-shot per body, same rule as mock/rewards.ts claims). */
const createReplays = new Map<string, FavoriteList>();

function ensureListsSeed(): void {
  if (lists.length > 0) return;
  lists = [
    {
      id: 'flist_my_favorites',
      name: 'My favorites',
      merchantIds: getState().favorites.map((m) => m.id),
      createdAt: nowIso(),
    },
  ];
}

function findList(listId: string): FavoriteList {
  const list = lists.find((l) => l.id === listId);
  if (!list) throw new ApiError(404, 'NOT_FOUND', `Favorites list ${listId} not found`);
  return list;
}

/** Tests re-seed the favorites-lists module between cases (resetMockState()
 * covers the shared favorites store; this clears the module-local registry +
 * create replay ledger). */
export function resetMockFavoritesListsState(): void {
  lists = [];
  createReplays.clear();
}

/** Test hook — the module-local lists registry (same pattern as
 * redPacketsForTests in mock/redPackets.ts). */
export function favoriteListsForTests(): FavoriteList[] {
  ensureListsSeed();
  return clone(lists);
}

export class MockFavoritesRepository implements FavoritesRepository {
  async list(): Promise<MerchantPublic[]> {
    return clone(getState().favorites);
  }

  async add(merchantId: string, _idempotencyKey: string): Promise<void> {
    const state = getState();
    if (!state.favorites.some((m) => m.id === merchantId)) {
      state.favorites.push(clone(findMerchant(merchantId)));
    }
  }

  async remove(merchantId: string, _idempotencyKey: string): Promise<void> {
    const state = getState();
    state.favorites = state.favorites.filter((m) => m.id !== merchantId);
  }

  async listLists(): Promise<FavoriteList[]> {
    ensureListsSeed();
    return clone(lists);
  }

  async createList(input: FavoriteListCreateInput, idempotencyKey: string): Promise<FavoriteList> {
    ensureListsSeed();
    const name = input.name.trim();
    if (!name) throw new ApiError(422, 'VALIDATION_FAILED', 'List name is required');
    if (name.length > 40) throw new ApiError(422, 'VALIDATION_FAILED', 'List name must be at most 40 characters');
    const replay = createReplays.get(idempotencyKey);
    if (replay) {
      if (replay.name !== name) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Idempotency-Key was reused with a different body');
      }
      return clone(replay);
    }
    // Unknown merchant ids in the optional seed are dropped (the server only
    // organizes existing favorites).
    const favorites = getState().favorites;
    const merchantIds = (input.merchantIds ?? []).filter((id) => favorites.some((m) => m.id === id));
    const list: FavoriteList = { id: uid('flist'), name, merchantIds, createdAt: nowIso() };
    lists.unshift(list);
    createReplays.set(idempotencyKey, list);
    return clone(list);
  }

  async addToList(listId: string, merchantId: string, _idempotencyKey: string): Promise<FavoriteList> {
    ensureListsSeed();
    const list = findList(listId);
    findMerchant(merchantId);
    if (!list.merchantIds.includes(merchantId)) list.merchantIds.push(merchantId);
    return clone(list);
  }

  async removeFromList(listId: string, merchantId: string, _idempotencyKey: string): Promise<FavoriteList> {
    ensureListsSeed();
    const list = findList(listId);
    findMerchant(merchantId);
    list.merchantIds = list.merchantIds.filter((id) => id !== merchantId);
    return clone(list);
  }

  async deleteList(listId: string, _idempotencyKey: string): Promise<void> {
    ensureListsSeed();
    const idx = lists.findIndex((l) => l.id === listId);
    if (idx === -1) throw new ApiError(404, 'NOT_FOUND', `Favorites list ${listId} not found`);
    lists.splice(idx, 1);
  }
}
