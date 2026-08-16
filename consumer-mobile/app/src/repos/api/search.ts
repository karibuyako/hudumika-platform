/* Live API search repository — GET /search, /search/suggest, /search/history,
 * POST /search/voice, POST /search/image. */
import { api } from '@/api/client';
import type { SearchQueryOptions, SearchRepository } from '../index';
import type { SearchResults, UnifiedSearchParams, VoiceSearchBody, ImageSearchBody } from '@hudumika/contract';

export class ApiSearchRepository implements SearchRepository {
  async search(query: string, opts?: SearchQueryOptions): Promise<SearchResults> {
    // Mock-only until the contract ships price/rating/distance/sort on
    // UnifiedSearchParams (docs/CONTRACT-ADDITIONS.md #3): these four params
    // are appended to the query string, but a live backend will ignore them
    // until Team 6 lands the contract change.
    const params: UnifiedSearchParams & { priceMaxTZS?: number; minRating?: number; maxDistanceKm?: number; sort?: string } = {
      q: query,
      ...(opts?.category ? { category: opts.category } : {}),
      ...(opts?.entityType ? { entityType: opts.entityType as UnifiedSearchParams['entityType'] } : {}),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
      ...(opts?.limit ? { limit: opts.limit } : {}),
      ...(opts?.priceMaxTZS !== undefined ? { priceMaxTZS: opts.priceMaxTZS } : {}),
      ...(opts?.minRating !== undefined ? { minRating: opts.minRating } : {}),
      ...(opts?.maxDistanceKm !== undefined ? { maxDistanceKm: opts.maxDistanceKm } : {}),
      ...(opts?.sort ? { sort: opts.sort } : {}),
    };
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    return api.get<SearchResults>(`/search${qs ? `?${qs}` : ''}`);
  }

  async suggest(query: string): Promise<string[]> {
    return api.get<string[]>(`/search/suggest?q=${encodeURIComponent(query)}`);
  }

  /** POST /search/voice — contract VoiceSearchBody {query}, response
   * SearchResults (429 RateLimitedResponse possible — client retries). */
  async voiceSearch(query: string): Promise<SearchResults> {
    const body: VoiceSearchBody = { query };
    return api.post<SearchResults>('/search/voice', body);
  }

  /** POST /search/image — contract ImageSearchBody {imageUrl}, response
   * SearchResults. The contract expects an already-uploaded imageUrl: a live
   * app uploads the picked photo first and passes the returned URL. */
  async imageSearch(input: ImageSearchBody): Promise<SearchResults> {
    return api.post<SearchResults>('/search/image', input);
  }

  async history(): Promise<string[]> {
    return api.get<string[]>('/search/history');
  }

  async addToHistory(query: string): Promise<void> {
    await api.post<void>('/search/history', { query });
  }

  async clearHistory(): Promise<void> {
    await api.delete<void>('/search/history');
  }
}
