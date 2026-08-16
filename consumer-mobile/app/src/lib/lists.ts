/* Curated merchant lists (Meituan 必吃榜-lite).
 *
 * Honest seam: the contract has NO Lists resource (verified — the generated
 * model/endpoints carry only paginated `list*Params` request shapes; favorites
 * "lists" are a PLANNED contract addition per OPERATIONS-COVERAGE.md op #120),
 * so this module carries the demo seed as a pure app-level constant.
 * Production feeds this module from a Lists API once the contract adds it.
 *
 * The seed references merchant ids that exist in the deterministic mock store
 * (fixtures seed 20260813 — src/repos/mock/mockState.ts, READ-ONLY). The ids
 * are resolved against whatever the repo actually returns (resolveList filters
 * to present merchants, preserving rank order), so any fixture drift degrades
 * a list to fewer entries — never a crash. */
import type { MerchantPublic } from '@hudumika/contract';
import type { I18nKey } from '@/i18n';

export interface CuratedList {
  id: string;
  /** i18n key for the list name (lists.*). */
  titleKey: I18nKey;
  /** i18n key for the one-line tagline. */
  taglineKey: I18nKey;
  /** Ranked merchant ids (index 0 = best). Verified present in the mock seed. */
  merchantIds: string[];
}

export const CURATED_LISTS: CuratedList[] = [
  {
    id: 'list_dar_top_rated',
    titleKey: 'lists.darTopRated',
    taglineKey: 'lists.darTopRatedTagline',
    merchantIds: [
      'd1f206e6-bb6a-455f-b437-ccf8aa274808',
      '14ce25f5-f8e2-43ba-9161-457fc471cd17',
      'a26cd7cd-652a-4e76-8be7-26b02d09fa54',
    ],
  },
  {
    id: 'list_fastest_delivery',
    titleKey: 'lists.fastestDelivery',
    taglineKey: 'lists.fastestDeliveryTagline',
    merchantIds: [
      'f5cc61c3-a431-4b32-95e5-7c329944c6e5',
      'a26cd7cd-652a-4e76-8be7-26b02d09fa54',
      'bec77d23-7a83-438d-aff7-d88a4e222273',
    ],
  },
  {
    id: 'list_mwanza_popular',
    titleKey: 'lists.mwanzaPopular',
    taglineKey: 'lists.mwanzaPopularTagline',
    merchantIds: [
      'f9baf8bb-1c6e-4998-b6f6-992b803bda89',
      '9fb7f83f-fe1b-492f-941a-84210795f140',
      'd1f206e6-bb6a-455f-b437-ccf8aa274808',
    ],
  },
];

export function getCuratedList(listId: string): CuratedList | undefined {
  return CURATED_LISTS.find((l) => l.id === listId);
}

export interface ResolvedCuratedList {
  list: CuratedList;
  /** Ranked merchants that exist in the provided list (seed rank order). */
  merchants: MerchantPublic[];
}

/** Resolve a curated list against the merchants the repo actually returned.
 * Unknown listId → null; seed ids missing from `merchants` are dropped (rank
 * order preserved) so fixture drift degrades gracefully. */
export function resolveList(listId: string, merchants: MerchantPublic[]): ResolvedCuratedList | null {
  const list = getCuratedList(listId);
  if (!list) return null;
  const byId = new Map(merchants.map((m) => [m.id, m] as const));
  const ranked: MerchantPublic[] = [];
  for (const id of list.merchantIds) {
    const merchant = byId.get(id);
    if (merchant) ranked.push(merchant);
  }
  return { list, merchants: ranked };
}
