/* In-memory search repository — GET /search + /search/suggest + history +
 * POST /search/voice + POST /search/image.
 * Results are built from the seeded merchants/catalogues/providers so a
 * search round-trips to real merchant detail screens.
 *
 * The mock IS the server: price/rating/distance filters and sort run here
 * (mock-only until the contract ships them on UnifiedSearchParams —
 * docs/CONTRACT-ADDITIONS.md #3). Results missing a field never satisfy a
 * bound on that field (defensive, mirrors src/lib/search.ts).
 */
import { getState, clone } from './mockState';
import type { SearchQueryOptions, SearchRepository } from '../index';
import type { ImageSearchBody, SearchResults, SearchResultsResultsItem } from '@hudumika/contract';
import { SearchResultsResultsItemEntityType } from '@hudumika/contract';

/** Seeded image-identifier keywords for the mock visual-search wire (POST
 * /search/image): a picked photo's URI is the upload-less demo key — the
 * first keyword found in the URI selects the curated dish corpus. The real
 * server matches the uploaded image's visual content; a live app uploads the
 * photo first and sends the returned URL (contract ImageSearchBody.imageUrl).
 * Unknown images return an honest empty result set (never fabricated hits). */
const IMAGE_SEARCH_KEYWORDS = ['chicken', 'pilau', 'smoothie', 'fish', 'choma', 'mandazi', 'tea', 'rice'] as const;

/** Server-side filter+sort for the mock wire (CONTRACT-ADDITIONS.md #3 —
 * the live server will implement the same semantics once Team 6 ships the
 * params). Missing fields are dropped by the bound that needs them, and sort
 * on a missing key sorts last. */
export function applyServerSideSearchOpts(results: SearchResultsResultsItem[], opts?: SearchQueryOptions): SearchResultsResultsItem[] {
  const { priceMaxTZS, minRating, maxDistanceKm, sort } = opts ?? {};
  let out = results.filter((r) => {
    if (priceMaxTZS !== undefined && (r.priceTZS == null || r.priceTZS > priceMaxTZS)) return false;
    if (minRating !== undefined && (r.rating == null || r.rating < minRating)) return false;
    if (maxDistanceKm !== undefined && (r.distanceKm == null || r.distanceKm > maxDistanceKm)) return false;
    return true;
  });
  switch (sort) {
    case 'rating':
      out = out.sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity));
      break;
    case 'price_asc':
      out = out.sort((a, b) => (a.priceTZS ?? Infinity) - (b.priceTZS ?? Infinity));
      break;
    case 'price_desc':
      out = out.sort((a, b) => (b.priceTZS ?? -Infinity) - (a.priceTZS ?? -Infinity));
      break;
    case 'distance':
      out = out.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      break;
    default:
      break; // 'relevance' keeps the natural scan order
  }
  return out;
}

export class MockSearchRepository implements SearchRepository {
  async search(query: string, opts?: SearchQueryOptions): Promise<SearchResults> {
    const state = getState();
    const q = query.trim().toLowerCase();
    const results: SearchResultsResultsItem[] = [];
    if (!q) return { query, results, total: 0, nextCursor: null };

    for (const m of state.merchants) {
      if (!opts?.entityType || opts.entityType === 'restaurant') {
        if (m.businessName.toLowerCase().includes(q)) {
          results.push({
            entityType: SearchResultsResultsItemEntityType.restaurant,
            id: m.id,
            title: m.businessName,
            subtitle: m.categories?.join(' · '),
            rating: m.rating,
            distanceKm: 2.4,
            etaMinutes: m.deliveryMinutes,
          });
        }
      }
    }

    for (const [merchantId, catalogue] of state.catalogues) {
      const merchant = state.merchants.find((m) => m.id === merchantId);
      for (const item of catalogue.items) {
        if (!opts?.entityType || opts.entityType === 'dish') {
          if (item.name.toLowerCase().includes(q)) {
            results.push({
              entityType: SearchResultsResultsItemEntityType.dish,
              id: item.id,
              title: item.name,
              subtitle: merchant?.businessName,
              priceTZS: item.priceTZS,
              imageUrl: item.imageUrl,
            });
          }
        }
      }
    }

    for (const p of state.home.providers ?? []) {
      if (!opts?.entityType || opts.entityType === 'provider') {
        if (p.name.toLowerCase().includes(q) || p.trade.toLowerCase().includes(q)) {
          results.push({
            entityType: SearchResultsResultsItemEntityType.provider,
            id: p.id,
            title: p.name,
            subtitle: p.trade,
            rating: p.rating,
            priceTZS: p.baseRateTZS,
          });
        }
      }
    }

    // Server-side filter + sort (mock-only until the contract ships the params).
    const filtered = applyServerSideSearchOpts(results, opts);

    const offset = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 20;
    const page = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? String(offset + limit) : null;
    return { query, results: page, total: filtered.length, nextCursor };
  }

  async suggest(query: string): Promise<string[]> {
    const state = getState();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of state.merchants) {
      if (m.businessName.toLowerCase().includes(q) && !seen.has(m.businessName)) {
        seen.add(m.businessName);
        out.push(m.businessName);
      }
    }
    for (const catalogue of state.catalogues.values()) {
      for (const item of catalogue.items) {
        if (item.name.toLowerCase().includes(q) && !seen.has(item.name)) {
          seen.add(item.name);
          out.push(item.name);
        }
        if (out.length >= 6) return out;
      }
    }
    return out.slice(0, 6);
  }

  async history(): Promise<string[]> {
    return clone(getState().searchHistory);
  }

  async addToHistory(query: string): Promise<void> {
    const state = getState();
    const q = query.trim();
    if (!q) return;
    state.searchHistory = [q, ...state.searchHistory.filter((h) => h !== q)].slice(0, 10);
  }

  async clearHistory(): Promise<void> {
    getState().searchHistory = [];
  }

  /** POST /search/voice — the mock IS the server: a voice transcript runs the
   * exact same corpus scan as search() (results mirror /search). */
  async voiceSearch(query: string): Promise<SearchResults> {
    return this.search(query);
  }

  /** POST /search/image — deterministic visual search: the imageUrl acts as
   * the image key (upload-less mock; a live app uploads first). A known
   * keyword selects the curated dish corpus; an unknown image returns an
   * honest empty result set. */
  async imageSearch(input: ImageSearchBody): Promise<SearchResults> {
    const url = (input.imageUrl ?? '').toLowerCase();
    const key = IMAGE_SEARCH_KEYWORDS.find((k) => url.includes(k)) ?? '';
    if (!key) return { query: 'Image search', results: [], total: 0, nextCursor: null };
    const hits = (await this.search(key)).results.filter((r) => r.entityType === SearchResultsResultsItemEntityType.dish);
    // Curated plate: top dishes only — visual search never returns whole stores.
    return { query: 'Image search', results: hits.slice(0, 6), total: hits.length, nextCursor: null };
  }
}
