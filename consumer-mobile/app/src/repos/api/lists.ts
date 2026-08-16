/* Live API curated-lists repository — mock-only-until-adopted paths
 * (docs/CONTRACT-ADDITIONS.md #14): GET /lists, GET /lists/{id}.
 *
 * The consumer contract exposes NO Lists resource yet (必吃榜 parity), so a
 * live backend that has not adopted the paths fails these calls — the
 * curated-lists screens render their error/retry state against it, the same
 * degrade path as the other app-only surfaces. The CuratedList payload
 * (i18n-keyed title/tagline + ranked merchant ids) is defined app-side in
 * src/lib/lists.ts; the pure helpers there resolve the ids against the
 * merchants repo. */
import { api } from '@/api/client';
import type { ListsRepository } from '../index';
import type { CuratedList } from '@/lib/lists';

export class ApiListsRepository implements ListsRepository {
  async listCurated(): Promise<CuratedList[]> {
    return api.get<CuratedList[]>('/lists');
  }

  async getCurated(listId: string): Promise<CuratedList> {
    return api.get<CuratedList>(`/lists/${listId}`);
  }
}
