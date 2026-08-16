/* In-memory home repository — GET /home (BFF) + GET /cities +
 * GET /home/recommendations (mock-only-until-adopted path,
 * docs/CONTRACT-ADDITIONS.md #25).
 * Feed sections come from the deterministic fixtureHomeFeed(); per-section
 * loading/empty/error states are driven by the screen, not here.
 */
import { getState, clone } from './mockState';
import type { HomeRepository, RecommendedMerchant } from '../index';
import type { City, GetConsumerHome200, MerchantPublic } from '@hudumika/contract';

/* Recommendation reason copy — SERVER-owned (the mock is the server here):
 * screens render these strings verbatim, never through i18n. A live
 * recommender owns the same copy on adoption. */
export const RECOMMENDATION_REASON_ORDERED = 'Because you ordered from them';
export const RECOMMENDATION_REASON_TOP_RATED = 'Top rated in your city';

const MIN_RECOMMENDATIONS = 3;
const MAX_RECOMMENDATIONS = 5;

/** Order statuses that carry no personalization signal — a cancelled,
 * refunded or failed order says nothing about what the user likes. */
const NON_SIGNAL_ORDER_STATUSES = new Set(['cancelled', 'refunded', 'failed']);

function toRecommended(merchant: MerchantPublic, reason: string): RecommendedMerchant {
  return {
    merchantId: merchant.id,
    businessName: merchant.businessName,
    rating: merchant.rating,
    reviewCount: merchant.reviewCount,
    reason,
    deliveryMinutes: merchant.deliveryMinutes ?? undefined,
  };
}

/** Deterministic recommendation algorithm (mock-as-server,
 * docs/CONTRACT-ADDITIONS.md #25): the user's order history is the signal —
 * merchants they ordered from (cancelled/refunded/failed orders excluded),
 * ranked by order count desc, ties by rating desc then name asc — padded with
 * top-rated merchants (rating desc, reviewCount desc, name asc) only up to
 * the 3–5 range (a rich history ships exactly the ordered merchants, a thin
 * one gets top-rated discovery rows). NO order history → the top-rated
 * fallback only. Pure + exported so the m2 suite can pin the semantics
 * against any state. */
export function buildRecommendations(orders: { merchantId: string; status: string }[], merchants: MerchantPublic[]): RecommendedMerchant[] {
  const byId = new Map(merchants.map((m) => [m.id, m]));
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (NON_SIGNAL_ORDER_STATUSES.has(order.status)) continue;
    counts.set(order.merchantId, (counts.get(order.merchantId) ?? 0) + 1);
  }

  const ordered = [...counts.entries()]
    .map(([id, n]) => ({ merchant: byId.get(id), n }))
    .filter((x): x is { merchant: MerchantPublic; n: number } => Boolean(x.merchant))
    .sort(
      (a, b) =>
        b.n - a.n ||
        b.merchant.rating - a.merchant.rating ||
        a.merchant.businessName.localeCompare(b.merchant.businessName),
    )
    .map((x) => toRecommended(x.merchant, RECOMMENDATION_REASON_ORDERED));

  if (ordered.length === 0) {
    const topRated = [...merchants]
      .sort(
        (a, b) =>
          b.rating - a.rating ||
          b.reviewCount - a.reviewCount ||
          a.businessName.localeCompare(b.businessName),
      )
      .map((m) => toRecommended(m, RECOMMENDATION_REASON_TOP_RATED));
    return topRated.slice(0, MAX_RECOMMENDATIONS);
  }

  const seen = new Set(ordered.map((r) => r.merchantId));
  const fill = [...merchants]
    .filter((m) => !seen.has(m.id))
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        b.reviewCount - a.reviewCount ||
        a.businessName.localeCompare(b.businessName),
    )
    .map((m) => toRecommended(m, RECOMMENDATION_REASON_TOP_RATED));
  const result = [...ordered];
  for (const row of fill) {
    if (result.length >= MIN_RECOMMENDATIONS) break;
    result.push(row);
  }
  return result.slice(0, MAX_RECOMMENDATIONS);
}

export class MockHomeRepository implements HomeRepository {
  async getHomeFeed(): Promise<GetConsumerHome200> {
    const state = getState();
    return {
      ...clone(state.home),
      unreadCount: state.notifications.filter((n) => !n.read).length,
      recentOrders: clone(state.orders.slice(0, 3)),
      membership: clone(state.membership),
    };
  }

  async listCities(): Promise<City[]> {
    return clone(getState().cities);
  }

  async getRecommendations(): Promise<RecommendedMerchant[]> {
    const state = getState();
    return buildRecommendations(state.orders, state.merchants);
  }
}
