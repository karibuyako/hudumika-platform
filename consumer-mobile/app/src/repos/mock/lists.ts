/* In-memory curated-lists repository (必吃榜-lite) — mock-only until the
 * contract ships the Lists resource (docs/CONTRACT-ADDITIONS.md #14): GET
 * /lists, GET /lists/{id}.
 *
 * The seed is the constant in src/lib/lists.ts (the read-only seam that the
 * home rail also renders directly); the mock IS the server for it — the repo
 * returns the same lists the app previously read from the constant. The
 * merchant ids are resolved against the merchants repo by the screens (the
 * resolveList pure helper in src/lib/lists.ts), so fixture drift degrades a
 * list to fewer entries — never a crash. */
import { ApiError } from '@/api/client';
import { CURATED_LISTS } from '@/lib/lists';
import type { CuratedList } from '@/lib/lists';
import { clone } from './mockState';
import type { ListsRepository } from '../index';

export class MockListsRepository implements ListsRepository {
  async listCurated(): Promise<CuratedList[]> {
    return clone(CURATED_LISTS);
  }

  async getCurated(listId: string): Promise<CuratedList> {
    const list = CURATED_LISTS.find((l) => l.id === listId);
    if (!list) throw new ApiError(404, 'NOT_FOUND', `Curated list ${listId} not found`);
    return clone(list);
  }
}
