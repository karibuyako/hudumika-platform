/* Client-side search result transform — filters + sort + result dispatch.
 *
 * The contract UnifiedSearchParams (packages/contract/src/generated/model/
 * unifiedSearchParams.ts) ships q/lat/lon/entityType/category/limit/cursor
 * only — price/rating/distance/sort params are Team-6 gated (MASTER-BLUEPRINT
 * §6, docs/CONTRACT-ADDITIONS.md #3). Since the mock-first batch, the app
 * passes those params through to the repo (the mock implements them
 * server-side); the pure helpers below remain as the DEFENSIVE client-side
 * pass for fields a result may be missing (a result without a rating cannot
 * satisfy a rating bound, so it is dropped — never crashes), and for a live
 * backend that has not yet adopted the params.
 */
import type { SearchResultsResultsItem } from '@hudumika/contract';
import { SearchResultsResultsItemEntityType as ET } from '@hudumika/contract';
import type { SearchSort } from '@/repos';

export type { SearchSort };

export interface SearchFilters {
  minRating?: number;
  maxPriceTZS?: number;
  entityType?: string;
}

export function filterResults(items: SearchResultsResultsItem[], filters: SearchFilters): SearchResultsResultsItem[] {
  const { minRating, maxPriceTZS, entityType } = filters;
  return items.filter((item) => {
    if (minRating !== undefined && (item.rating == null || item.rating < minRating)) return false;
    if (maxPriceTZS !== undefined && (item.priceTZS == null || item.priceTZS > maxPriceTZS)) return false;
    if (entityType !== undefined && item.entityType !== entityType) return false;
    return true;
  });
}

export function sortResults(items: SearchResultsResultsItem[], sort: SearchSort): SearchResultsResultsItem[] {
  const copy = [...items];
  switch (sort) {
    case 'rating':
      return copy.sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity));
    case 'price_asc':
      return copy.sort((a, b) => (a.priceTZS ?? Infinity) - (b.priceTZS ?? Infinity));
    case 'price_desc':
      return copy.sort((a, b) => (b.priceTZS ?? -Infinity) - (a.priceTZS ?? -Infinity));
    case 'distance':
      return copy.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    case 'relevance':
      return copy;
  }
}

export function activeFilterCount(filters: SearchFilters): number {
  let n = 0;
  if (filters.minRating !== undefined) n += 1;
  if (filters.maxPriceTZS !== undefined) n += 1;
  if (filters.entityType !== undefined) n += 1;
  return n;
}

/** Screen destinations for a search result (MASTER-BLUEPRINT §6 "Result type
 * dispatch"). The contract result carries no merchantId/groupBuyId linkage
 * (searchResultsResultsItem.ts: entityType/id/title/subtitle/rating/
 * priceTZS/distanceKm/etaMinutes/imageUrl/badges — nothing merchant-scoped),
 * so dish results cannot route to /product/[merchantId]/[catalogueItemId]:
 * the id IS the catalogueItemId but the merchant context is only the
 * businessName subtitle (not an id). They keep the re-search behavior;
 * product/store/service_package/hotel/deal have no destination yet — they
 * resolve to null safely. */
export type ResultDispatch =
  | { kind: 'merchant'; id: string }
  | { kind: 'provider'; id: string }
  | { kind: 'dishSearch'; q: string }
  | null;

export function resolveResultRoute(item: SearchResultsResultsItem): ResultDispatch {
  if (!item.id) return null;
  switch (item.entityType) {
    case ET.restaurant:
      return { kind: 'merchant', id: item.id };
    case ET.provider:
      return { kind: 'provider', id: item.id };
    case ET.dish:
      return item.subtitle ? { kind: 'dishSearch', q: item.subtitle } : null;
    default:
      return null;
  }
}
