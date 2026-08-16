/* M2 — Home + discovery: feed sections render contract-shaped data with
 * per-section empty-state safety; search returns typed results + suggestions +
 * history; merchant list filters by category and paginates by cursor; provider
 * list/detail + service categories resolve. (Endpoint parity:
 * consumer-contract.test.ts — this suite pins screen-level semantics.) */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState, loginAsDemo } from './helpers';
import { getState, findMerchant } from '@/repos/mock/mockState';
import { MockHomeRepository, RECOMMENDATION_REASON_ORDERED, RECOMMENDATION_REASON_TOP_RATED } from '@/repos/mock/home';
import { MockSearchRepository } from '@/repos/mock/search';
import { MockMerchantsRepository } from '@/repos/mock/merchants';
import { MockProvidersRepository } from '@/repos/mock/providers';
import { canShowRecommendations } from '@/repos';
import { activeFilterCount, filterResults, resolveResultRoute, sortResults } from '@/lib/search';
import type { SearchResultsResultsItem } from '@hudumika/contract';
import { SearchResultsResultsItemEntityType } from '@hudumika/contract';

const home = new MockHomeRepository();
const search = new MockSearchRepository();
const merchants = new MockMerchantsRepository();
const providers = new MockProvidersRepository();

beforeEach(() => {
  resetMockState();
});

test('home feed renders contract sections — categories, merchants, promotions, providers', async () => {
  const feed = await home.getHomeFeed();
  assert.ok((feed.categories ?? []).length >= 4, 'categories section');
  assert.ok((feed.merchants ?? []).length >= 5, 'nearby merchants section');
  assert.ok((feed.promotions ?? []).length >= 1, 'promotions section');
  assert.ok(Array.isArray(feed.providers), 'providers section present (may be empty)');

  const cat = feed.categories![0];
  assert.ok(cat.id.length > 0 && cat.name.length > 0);

  const merchant = feed.merchants![0];
  assert.ok(merchant.businessName.length > 0);
  assert.equal(typeof merchant.rating, 'number');
  assert.equal(typeof merchant.reviewCount, 'number');
  assert.equal(typeof merchant.isOpen, 'boolean');

  const promo = feed.promotions![0];
  assert.equal(typeof promo.id, 'string');
  assert.ok(promo.title.length > 0);
});

test('feed reflects mock state — unreadCount, recentOrders, membership come from state', async () => {
  const state = getState();
  state.notifications.push({ id: 'ntf_extra', type: 'order.status', title: 'x', body: 'y', deepLink: null, read: false, createdAt: new Date().toISOString() });

  const feed = await home.getHomeFeed();
  assert.equal(feed.unreadCount, state.notifications.filter((n) => !n.read).length);
  assert.ok(Array.isArray(feed.recentOrders));
  assert.equal(feed.membership?.points, state.membership.points);
});

test('promotions section is empty-state safe (EmptyState renders, no crash)', async () => {
  getState().home.promotions = [];
  const feed = await home.getHomeFeed();
  assert.equal((feed.promotions ?? []).length, 0);
});

test('merchant list filters by category and paginates by cursor', async () => {
  const firstCategory = (await home.getHomeFeed()).categories![0];
  const all = await merchants.list({ category: firstCategory.name });
  for (const m of all) assert.ok((m.categories ?? []).includes(firstCategory.name));

  const page1 = await merchants.list({ limit: 3 });
  assert.ok(page1.length <= 3);
  const cursor = String(page1.length);
  const page2 = await merchants.list({ limit: 3, cursor });
  if (page2.length > 0) {
    assert.notEqual(page2[0].id, page1[0].id);
  }
});

test('merchant detail resolves and unknown ids 404 with NOT_FOUND', async () => {
  const feed = await home.getHomeFeed();
  const merchant = feed.merchants![0];
  const detail = await merchants.get(merchant.id);
  assert.equal(detail.id, merchant.id);
  assert.equal(detail.businessName, merchant.businessName);

  await rejectsApiError(merchants.get('merchant_does_not_exist'), 404, 'NOT_FOUND');
});

test('catalogue resolves per merchant with integer TZS prices', async () => {
  const feed = await home.getHomeFeed();
  const merchant = feed.merchants![0];
  const catalogue = await merchants.getCatalogue(merchant.id);
  assert.equal(catalogue.merchantId, merchant.id);
  assert.ok(catalogue.items.length >= 4);
  for (const item of catalogue.items) {
    assert.ok(Number.isInteger(item.priceTZS));
  }
  await rejectsApiError(merchants.getCatalogue('merchant_does_not_exist'), 404, 'NOT_FOUND');
});

test('search returns typed results by entityType and paginates', async () => {
  const feed = await home.getHomeFeed();
  const firstMerchant = feed.merchants![0];
  const q = firstMerchant.businessName.split(' ')[0];

  const results = await search.search(q);
  assert.equal(results.query, q);
  assert.ok(results.results.length > 0);
  assert.ok(results.results.some((r) => r.entityType === SearchResultsResultsItemEntityType.restaurant));
  for (const r of results.results) {
    assert.ok(r.title.length > 0);
    if (r.entityType === SearchResultsResultsItemEntityType.dish) assert.ok(Number.isInteger(r.priceTZS));
  }
});

test('search with a provider trade returns provider entities', async () => {
  const state = getState();
  if ((state.home.providers ?? []).length === 0) return; // provider count is seed-dependent (0..3)
  const provider = state.home.providers![0];
  const results = await search.search(provider.trade.split(' ')[0], { entityType: 'provider' });
  assert.ok(results.results.length > 0);
  assert.ok(results.results.every((r) => r.entityType === SearchResultsResultsItemEntityType.provider));
});

test('search for unknown text returns empty results, not an error', async () => {
  const results = await search.search('zzzz-not-a-thing');
  assert.equal(results.total, 0);
  assert.equal(results.results.length, 0);
});

test('search suggest + history round-trip with dedupe and cap', async () => {
  await loginAsDemo();
  const suggestions = await search.suggest('chai');
  assert.ok(Array.isArray(suggestions));
  assert.ok(suggestions.length <= 6);

  await search.addToHistory('pilau');
  await search.addToHistory('pilau');
  const history = await search.history();
  assert.equal(history[0], 'pilau');
  assert.equal(history.filter((h) => h === 'pilau').length, 1);
});

test('clearHistory empties recent searches and history() returns []', async () => {
  await loginAsDemo();
  assert.ok((await search.history()).length > 0, 'seeded history is non-empty');
  await search.addToHistory('pilau');
  await search.clearHistory();
  assert.deepEqual(await search.history(), []);
  assert.equal(getState().searchHistory.length, 0);
});

test('search paginates via nextCursor across pages', async () => {
  const page1 = await search.search('a', { limit: 3 });
  if ((page1.total ?? 0) <= 3) return; // seed-dependent volume
  assert.equal(page1.results.length, 3);
  assert.ok(page1.nextCursor, 'nextCursor present when more results remain');
  const page2 = await search.search('a', { limit: 3, cursor: page1.nextCursor! });
  assert.ok(page2.results.length > 0);
  assert.notEqual(page2.results[0].id, page1.results[0].id);
  assert.ok(!page2.results.some((r) => page1.results.some((p) => p.id === r.id)), 'no duplicates across pages');
});

test('provider list/detail and service categories resolve contract-shaped', async () => {
  const services = await providers.listServices();
  assert.ok(services.length >= 3);
  const plumbing = services.find((s) => s.name === 'Plumbing');
  assert.ok(plumbing, 'seeded plumbing category');
  assert.equal(plumbing!.pricingModel, 'hourly');
  assert.ok(Number.isInteger(plumbing!.defaultDurationMinutes));

  const state = getState();
  if ((state.home.providers ?? []).length > 0) {
    const provider = state.home.providers![0];
    const detail = await providers.get(provider.id);
    assert.equal(detail.id, provider.id);
    assert.ok(detail.name.length > 0);
  }
  await rejectsApiError(providers.get('provider_does_not_exist'), 404, 'NOT_FOUND');
});

test('findMerchant backstop: catalogue guards are the only 404 path for a valid id', () => {
  const feed = getState();
  const merchant = feed.merchants[0];
  assert.equal(findMerchant(merchant.id).id, merchant.id);
});

test('feed sections are per-section: an empty merchants list yields an empty-state-safe feed', async () => {
  getState().home.merchants = [];
  const feed = await home.getHomeFeed();
  assert.equal((feed.merchants ?? []).length, 0);
  assert.ok((feed.categories ?? []).length > 0, 'other sections still render');
});

// --- Personalized recommendations (MASTER-BLUEPRINT §5, docs/CONTRACT-ADDITIONS
// #25) — mock-only-until-adopted GET /home/recommendations. The mock-as-server
// derives rows from the demo user's order history (cancelled/refunded/failed
// orders carry no signal) with a top-rated fallback; the `reason` field is
// SERVER copy — asserted as literal strings, never i18n keys. The screen gates
// the section on the personalization consent via canShowRecommendations. ---

test('recommendations derive from the seeded order history with server-owned reasons', async () => {
  const state = getState();
  const orderedMerchantIds = new Set(
    state.orders
      .filter((o) => !['cancelled', 'refunded', 'failed'].includes(o.status))
      .map((o) => o.merchantId),
  );
  assert.ok(orderedMerchantIds.size >= 1, 'seeded history is non-empty');

  const recs = await home.getRecommendations();
  assert.ok(recs.length >= 3 && recs.length <= 5, '3-5 rows');
  for (const r of recs) {
    assert.ok(orderedMerchantIds.has(r.merchantId), `row ${r.merchantId} came from the order history`);
    assert.equal(r.reason, RECOMMENDATION_REASON_ORDERED, 'reason is server copy, not an i18n key');
    assert.ok(r.businessName.length > 0);
    assert.ok(Number.isFinite(r.rating) && Number.isInteger(r.reviewCount));
  }
  // Every ordered merchant appears exactly once (deterministic, no duplicates).
  assert.deepEqual(new Set(recs.map((r) => r.merchantId)), orderedMerchantIds);
});

test('recommendations with no order history fall back to the top-rated merchants only', async () => {
  getState().orders = [];
  const recs = await home.getRecommendations();
  assert.ok(recs.length >= 3 && recs.length <= 5, 'fallback stays in the 3-5 range');
  assert.ok(recs.every((r) => r.reason === RECOMMENDATION_REASON_TOP_RATED));
  const ratings = recs.map((r) => r.rating);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), 'top-rated first');
});

test('a thin order history is padded with top-rated merchants to the 3-5 range', async () => {
  const state = getState();
  state.orders = [state.orders[0]]; // one order → one merchant signal
  const recs = await home.getRecommendations();
  assert.equal(recs.length, 3);
  assert.deepEqual(
    recs.filter((r) => r.reason === RECOMMENDATION_REASON_ORDERED).map((r) => r.merchantId),
    [state.orders[0].merchantId],
  );
  assert.equal(recs.filter((r) => r.reason === RECOMMENDATION_REASON_TOP_RATED).length, 2);
  assert.equal(new Set(recs.map((r) => r.merchantId)).size, 3, 'no duplicate merchants');
});

test('canShowRecommendations gates the section on the personalization consent', () => {
  assert.equal(canShowRecommendations(false), false, 'no consent → no section');
  assert.equal(canShowRecommendations(true), true, 'consent → section renders');
});

// --- Client-side search filters/sort (MASTER-BLUEPRINT §6 — the contract
// UnifiedSearchParams has no price/rating/distance/sort yet, so these pure
// helpers are the honest interim surface; server-side sort lands with the
// contract param). ---

const fixture = (): SearchResultsResultsItem[] => [
  { entityType: SearchResultsResultsItemEntityType.restaurant, id: 'r1', title: 'Mama Ashura', rating: 4.6, priceTZS: 8000, distanceKm: 2 },
  { entityType: SearchResultsResultsItemEntityType.restaurant, id: 'r2', title: 'Nyama Choma', rating: 3.8, priceTZS: 4000, distanceKm: 5 },
  { entityType: SearchResultsResultsItemEntityType.dish, id: 'd1', title: 'Pilau', rating: 4.2, priceTZS: 2500, subtitle: 'Mama Ashura' },
  { entityType: SearchResultsResultsItemEntityType.provider, id: 'p1', title: 'Fundi', rating: 4.9, priceTZS: 15000, distanceKm: 1 },
  { entityType: SearchResultsResultsItemEntityType.dish, id: 'd2', title: 'Unpriced dish', rating: null, priceTZS: null },
  { entityType: SearchResultsResultsItemEntityType.deal, id: 'deal1', title: 'Deal' },
];

test('client-side sort orders results by rating high-first with missing ratings last', () => {
  const sorted = sortResults(fixture(), 'rating');
  assert.equal(sorted[0].id, 'p1');
  assert.equal(sorted[1].id, 'r1');
  assert.equal(sorted[2].id, 'd1');
  assert.equal(sorted[3].id, 'r2');
  assert.equal(sorted[4].id, 'd2');
  assert.equal(sorted[5].id, 'deal1');
});

test('client-side sort orders results by price asc/desc with missing prices last', () => {
  const asc = sortResults(fixture(), 'price_asc');
  assert.equal(asc[0].id, 'd1');
  assert.equal(asc[1].id, 'r2');
  assert.ok(asc[asc.length - 1].priceTZS == null, 'unpriced items sort last');
  const desc = sortResults(fixture(), 'price_desc');
  assert.equal(desc[0].id, 'p1');
  assert.equal(desc[1].id, 'r1');
  assert.ok(desc[desc.length - 1].priceTZS == null, 'unpriced items sort last');
});

test('client-side sort orders results by distance nearest-first', () => {
  const sorted = sortResults(fixture(), 'distance');
  assert.equal(sorted[0].id, 'p1');
  assert.equal(sorted[1].id, 'r1');
  assert.ok(sorted[sorted.length - 1].distanceKm == null, 'unknown-distance items sort last');
});

test('client-side sort relevance keeps the current page order', () => {
  const sorted = sortResults(fixture(), 'relevance');
  assert.deepEqual(sorted.map((r) => r.id), fixture().map((r) => r.id));
});

test('filters reduce results: min rating drops low/unrated items defensively', () => {
  const kept = filterResults(fixture(), { minRating: 4 });
  assert.deepEqual(kept.map((r) => r.id).sort(), ['d1', 'p1', 'r1']);
});

test('filters reduce results: max price drops over-budget and unpriced items', () => {
  const kept = filterResults(fixture(), { maxPriceTZS: 5000 });
  assert.deepEqual(kept.map((r) => r.id).sort(), ['d1', 'r2']);
});

test('filters reduce results: entity type narrows to that type', () => {
  const kept = filterResults(fixture(), { entityType: SearchResultsResultsItemEntityType.provider });
  assert.deepEqual(kept.map((r) => r.id), ['p1']);
});

test('filters combine with sort: max price + rating then price asc', () => {
  const kept = filterResults(fixture(), { minRating: 4, maxPriceTZS: 10000 });
  assert.deepEqual(kept.map((r) => r.id).sort(), ['d1', 'r1']);
  const sorted = sortResults(kept, 'price_asc');
  assert.deepEqual(sorted.map((r) => r.id), ['d1', 'r1']);
});

test('activeFilterCount counts only the dimensions actually set', () => {
  assert.equal(activeFilterCount({}), 0);
  assert.equal(activeFilterCount({ minRating: 4 }), 1);
  assert.equal(activeFilterCount({ minRating: 4, maxPriceTZS: 5000, entityType: 'dish' }), 3);
});

test('resolveResultRoute dispatches restaurant/provider and falls back safely on unknown types', () => {
  assert.deepEqual(resolveResultRoute(fixture()[0]), { kind: 'merchant', id: 'r1' });
  assert.deepEqual(resolveResultRoute(fixture()[3]), { kind: 'provider', id: 'p1' });
  assert.deepEqual(resolveResultRoute(fixture()[2]), { kind: 'dishSearch', q: 'Mama Ashura' });
  // deal (no groupBuyId field in the contract result) and id-less items → null, never crash.
  assert.equal(resolveResultRoute(fixture()[5]), null);
  assert.equal(resolveResultRoute({ entityType: SearchResultsResultsItemEntityType.deal, id: 'x', title: 'X' }), null);
  assert.equal(resolveResultRoute({ entityType: SearchResultsResultsItemEntityType.restaurant, title: 'No id' }), null);
});

// --- Server-side search filter/sort (mock-first, CONTRACT-ADDITIONS.md #3) ---
// The mock implements the not-yet-contract price/rating/distance/sort params
// the screen now sends; these tests pin the mock-as-server semantics (missing
// fields never satisfy a bound, and unpriced/unrated results sort last).

test('mock search filters by max price server-side (results missing priceTZS are dropped)', async () => {
  const none = await search.search('chicken', { priceMaxTZS: 10000 });
  assert.ok(none.results.every((r) => r.priceTZS != null && r.priceTZS <= 10000));
  const some = await search.search('chicken', { priceMaxTZS: 15000 });
  assert.ok(some.total! > 0, 'within budget the seeded dishes remain');
  assert.ok(some.results.every((r) => r.priceTZS != null && r.priceTZS <= 15000));
});

test('mock search filters by min rating server-side', async () => {
  const res = await search.search('a', { limit: 50, minRating: 4 });
  assert.ok(res.results.every((r) => r.rating == null || r.rating >= 4), 'no kept result rates below the bound');
  const strict = await search.search('a', { limit: 50, minRating: 5 });
  assert.ok(strict.results.every((r) => r.rating == null || r.rating >= 5));
});

test('mock search filters by max distance server-side (seeded distance is 2.4 km)', async () => {
  const none = await search.search('a', { maxDistanceKm: 1 });
  assert.equal(none.total, 0, 'no seeded result is within 1 km');
  const within = await search.search('a', { maxDistanceKm: 3 });
  assert.ok(within.results.every((r) => r.distanceKm != null && r.distanceKm <= 3));
});

test('mock search sorts by rating high-first server-side, missing ratings last', async () => {
  const res = await search.search('a', { limit: 50, sort: 'rating' });
  const ratings = res.results.filter((r) => r.rating != null).map((r) => r.rating!);
  assert.deepEqual(ratings, [...ratings].sort((x, y) => y - x), 'rated results are descending');
  assert.ok(
    res.results.slice(ratings.length).every((r) => r.rating == null),
    'results without a rating sort last',
  );
});

test('mock search sorts by price asc/desc server-side, unpriced last', async () => {
  const asc = await search.search('a', { limit: 50, sort: 'price_asc' });
  const ascPrices = asc.results.filter((r) => r.priceTZS != null).map((r) => r.priceTZS!);
  assert.deepEqual(ascPrices, [...ascPrices].sort((x, y) => x - y));
  assert.ok(asc.results.slice(ascPrices.length).every((r) => r.priceTZS == null), 'unpriced results sort last');

  const desc = await search.search('a', { limit: 50, sort: 'price_desc' });
  const descPrices = desc.results.filter((r) => r.priceTZS != null).map((r) => r.priceTZS!);
  assert.deepEqual(descPrices, [...descPrices].sort((x, y) => y - x));
  assert.ok(desc.results.slice(descPrices.length).every((r) => r.priceTZS == null));
});

test('mock search sorts by distance nearest-first server-side, unknown distance last', async () => {
  const res = await search.search('a', { limit: 50, sort: 'distance' });
  const dists = res.results.filter((r) => r.distanceKm != null).map((r) => r.distanceKm!);
  assert.deepEqual(dists, [...dists].sort((x, y) => x - y));
  assert.ok(res.results.slice(dists.length).every((r) => r.distanceKm == null));
});

test('mock search relevance keeps the natural result order, and entityType is server-side', async () => {
  const plain = await search.search('a', { limit: 50 });
  const rel = await search.search('a', { limit: 50, sort: 'relevance' });
  assert.deepEqual(rel.results.map((r) => r.id), plain.results.map((r) => r.id));
  const dishes = await search.search('chicken', { entityType: 'dish' });
  assert.ok(dishes.results.length > 0);
  assert.ok(dishes.results.every((r) => r.entityType === SearchResultsResultsItemEntityType.dish));
});

test('filters + sort combine server-side: max price then price_asc over the filtered set', async () => {
  const res = await search.search('a', { limit: 50, priceMaxTZS: 6000, sort: 'price_asc' });
  assert.ok(res.results.every((r) => r.priceTZS != null && r.priceTZS <= 6000));
  const prices = res.results.map((r) => r.priceTZS!);
  assert.deepEqual(prices, [...prices].sort((x, y) => x - y));
  if (res.total! > 0) assert.ok(res.results[0].priceTZS! <= 6000);
});
