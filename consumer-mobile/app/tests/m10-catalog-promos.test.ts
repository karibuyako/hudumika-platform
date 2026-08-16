/* M10 — Catalogue product route + service detail + promo center + badges.
 * Data-path coverage for the new screens: catalogue item resolution via
 * getCatalogue + findCatalogueItem (the contract has no find-by-id
 * endpoint), service category → provider trade filtering, promo center
 * aggregation (platform promotions, per-merchant promotions, claimable
 * coupons, live group-buy deals) and the badge derivation thresholds.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockMerchantsRepository } from '@/repos/mock/merchants';
import { MockProvidersRepository } from '@/repos/mock/providers';
import { MockCouponsRepository } from '@/repos/mock/coupons';
import { MockGroupBuyRepository } from '@/repos/mock/groupBuy';
import { MockHomeRepository } from '@/repos/mock/home';
import { MockReviewsRepository } from '@/repos/mock/reviews';
import { findCatalogueItem, tradeStem } from '@/lib/catalogue';
import { computeBadges } from '@/lib/badges';
import { resolveResultRoute } from '@/lib/search';
import type { SearchResultsResultsItem } from '@hudumika/contract';
import { SearchResultsResultsItemEntityType } from '@hudumika/contract';
import { CouponStatus } from '@hudumika/contract';

const merchants = new MockMerchantsRepository();
const providers = new MockProvidersRepository();
const coupons = new MockCouponsRepository();
const groupBuys = new MockGroupBuyRepository();
const home = new MockHomeRepository();

beforeEach(() => resetMockState());

/* ---------- TASK 1: product route data path ---------- */

test('catalogue item resolves via getCatalogue + findCatalogueItem (no find-by-id endpoint)', async () => {
  const state = getState();
  const m = state.merchants[0];
  const catalogue = await merchants.getCatalogue(m.id);
  assert.ok(catalogue.items.length > 0, 'the merchant catalogue ships items');

  const item = catalogue.items[0];
  assert.ok(item.id, 'seeded items always carry an id (the route pushes id)');
  assert.equal(findCatalogueItem(m.id, item.id!, catalogue)?.id, item.id);
  assert.equal(findCatalogueItem(m.id, item.id!, null), null, 'no catalogue → null (honest not-found)');
  assert.equal(findCatalogueItem(m.id, 'does-not-exist', catalogue), null);
  assert.equal(findCatalogueItem('merchant_unknown', item.id!, catalogue), null);
  assert.equal(findCatalogueItem(state.merchants[1].id, item.id!, catalogue), null, 'item must come from ITS merchant');
});

test('the merchant sheet builds the same item id the product route resolves', async () => {
  const state = getState();
  const m = state.merchants[0];
  const catalogue = await merchants.getCatalogue(m.id);
  const item = catalogue.items[0];
  // Merchant sheet catalogueItemId fallback = id ?? name — both resolve.
  assert.equal(findCatalogueItem(m.id, item.id ?? item.name, catalogue)?.id, item.id);
});

test('dish search results carry NO merchant context — they stay re-search', () => {
  const dish: SearchResultsResultsItem = {
    entityType: SearchResultsResultsItemEntityType.dish,
    id: 'citem_000000_0',
    title: 'Chicken & Chips',
    subtitle: 'Sunrise Kitchen', // businessName, not an id
  };
  const route = resolveResultRoute(dish);
  assert.deepEqual(route, { kind: 'dishSearch', q: 'Sunrise Kitchen' });
  assert.ok(!('merchantId' in dish), 'SearchResultsResultsItem has no merchantId field (contract reality)');
});

/* ---------- TASK 2: service detail data path ---------- */

test('service categories resolve and their questionnaires ship', async () => {
  const categories = await providers.listServices();
  assert.deepEqual(categories.map((c) => c.id).sort(), ['svc_001', 'svc_002', 'svc_003']);
  assert.equal(categories[0].pricingModel, 'hourly');
  assert.ok(categories[0].defaultDurationMinutes && categories[0].cancellationRules, 'pricing/duration/cancellation are present');

  const questions = await providers.getQuestions('svc_001');
  assert.ok(questions.length >= 1 && questions[0].key === 'issue');
});

test('providers filter by trade via the category-name stem (no fabricated mapping)', async () => {
  // The mock filters by substring: 'plumbing' matches nothing, the stem
  // 'plumb' matches the seeded trade 'Plumber'.
  assert.equal(tradeStem('Plumbing'), 'plumb');
  assert.equal(tradeStem('Electrical'), 'electric');
  assert.equal(tradeStem('Cleaning'), 'clean');

  const plumbers = await providers.list({ trade: tradeStem('Plumbing') });
  assert.ok(plumbers.length >= 1);
  assert.ok(plumbers.every((p) => p.trade.toLowerCase().includes('plumb')));

  const electricians = await providers.list({ trade: tradeStem('Electrical') });
  assert.ok(electricians.every((p) => p.trade.toLowerCase().includes('electric')));

  const cleaners = await providers.list({ trade: tradeStem('Cleaning') });
  assert.ok(cleaners.every((p) => p.trade.toLowerCase().includes('clean')));

  // A category with no matching trade resolves honestly to an empty list.
  assert.deepEqual(await providers.list({ trade: tradeStem('Automotive') }), []);
});

/* ---------- TASK 3: promo center data path ---------- */

test('merchant promotions resolve per merchant — the demo merchant has live offers', async () => {
  const state = getState();
  const seeded = state.merchants;
  assert.ok(seeded.length >= 2, 'the seed ships a merchant list via the home feed');

  const withOffers = [];
  for (const m of seeded) {
    const promos = await merchants.getPromotions(m.id);
    if (promos.some((p) => p.status === 'live')) withOffers.push(m.id);
  }
  assert.ok(withOffers.length === 1, 'exactly the demo merchant carries live promotions');
  assert.equal(withOffers[0], seeded[0].id);
});

test('promo center aggregations: platform promos live, coupons claimable, deals live', async () => {
  const feed = await home.getHomeFeed();
  assert.ok((feed.promotions ?? []).length >= 1);
  assert.ok((feed.promotions ?? []).every((p) => p.status === 'live'), 'platform promos are live');

  const available = await coupons.list('available');
  assert.ok(available.some((c) => c.id === 'coup_002' && c.status === CouponStatus.available));

  const claimed = await coupons.claim('coup_002', 'k1');
  assert.equal(claimed.status, CouponStatus.claimed);
  const after = await coupons.list('available');
  assert.ok(!after.some((c) => c.id === 'coup_002'), 'claimed coupons leave the available list');

  const deals = await groupBuys.list();
  assert.ok(deals.length >= 1 && deals.every((d) => d.status === 'live'), 'group-buy list ships live deals only');
  assert.ok(deals.every((d) => d.salesEndAt), 'live deals carry a real salesEndAt for the countdown');
});

test('expired promotions are excluded from the promo center (endsAt is real)', async () => {
  const state = getState();
  // Force an ended promotion on the demo merchant — the screen filters
  // isLive() client-side (status live but endsAt in the past).
  const promos = state.promotions.get(state.merchants[0].id)!;
  promos[0].endsAt = new Date(Date.now() - 3600_000).toISOString();
  const live = (await merchants.getPromotions(state.merchants[0].id)).filter(
    (p) => p.status === 'live' && (!p.endsAt || Date.parse(p.endsAt) > Date.now()),
  );
  assert.ok(live.length < promos.length, 'ended promotions are dropped');
});

/* ---------- TASK 4: badge derivation ---------- */

test('computeBadges thresholds (first order, 10 orders, 100 points, verified rater, review milestones)', () => {
  assert.deepEqual(computeBadges({ completedOrders: 0, points: 99, publishedReviews: 0 }), [
    { id: 'first_order', earned: false },
    { id: 'regular', earned: false },
    { id: 'points_100', earned: false },
    { id: 'verified_rater', earned: false },
    { id: 'reviewer_first', earned: false },
    { id: 'reviewer_regular', earned: false },
    { id: 'reviewer_expert', earned: false },
  ]);
  assert.deepEqual(computeBadges({ completedOrders: 10, points: 100, publishedReviews: 1 }), [
    { id: 'first_order', earned: true },
    { id: 'regular', earned: true },
    { id: 'points_100', earned: true },
    { id: 'verified_rater', earned: true },
    { id: 'reviewer_first', earned: true },
    { id: 'reviewer_regular', earned: false },
    { id: 'reviewer_expert', earned: false },
  ]);
  assert.equal(computeBadges({ completedOrders: 1, points: 240, publishedReviews: 0 })[0].earned, true, 'first order at exactly 1');
});

test('review milestone badges follow the published-count thresholds', () => {
  const at = (n: number) => computeBadges({ completedOrders: 0, points: 0, publishedReviews: n });
  assert.deepEqual(
    at(1).filter((b) => b.id.startsWith('reviewer_')).map((b) => [b.id, b.earned]),
    [
      ['reviewer_first', true],
      ['reviewer_regular', false],
      ['reviewer_expert', false],
    ],
    '1 published review earns the first-review badge only',
  );
  assert.deepEqual(
    at(5).filter((b) => b.id.startsWith('reviewer_')).map((b) => [b.id, b.earned]),
    [
      ['reviewer_first', true],
      ['reviewer_regular', true],
      ['reviewer_expert', false],
    ],
    '5 published reviews earn the regular badge',
  );
  assert.deepEqual(
    at(10).filter((b) => b.id.startsWith('reviewer_')).map((b) => [b.id, b.earned]),
    [
      ['reviewer_first', true],
      ['reviewer_regular', true],
      ['reviewer_expert', true],
    ],
    '10 published reviews earn the expert badge',
  );
  assert.equal(at(4)[2].earned, false, '4 published reviews stay short of the 5-review badge');
  assert.equal(at(9)[2].earned, false, '9 published reviews stay short of the 10-review badge');
});

test('badges derive from REAL mock data (completed orders, points, published own reviews)', async () => {
  await new MockReviewsRepository().listMine(); // ensureSeeds — the own published seed is module-local
  const state = getState();
  const completed = state.orders.filter((o) => o.status === 'completed').length;
  const points = state.membership.points;
  const publishedMine = state.reviews.filter((r) => r.authorName === state.user.fullName && r.state === 'published').length;
  const badges = computeBadges({ completedOrders: completed, points, publishedReviews: publishedMine });
  const byId = Object.fromEntries(badges.map((b) => [b.id, b.earned]));

  assert.equal(byId.first_order, completed >= 1, 'first order = real completed orders');
  assert.equal(byId.regular, completed >= 10);
  assert.equal(byId.points_100, points >= 100);
  assert.equal(byId.verified_rater, publishedMine >= 1);
  assert.equal(byId.reviewer_first, publishedMine >= 1);
  assert.equal(byId.reviewer_regular, publishedMine >= 5);
  assert.equal(byId.reviewer_expert, publishedMine >= 10);
  // Seed reality: 1 completed order + 240 points; one own published review
  // (rev_seed_own_published — the pending seed alone would keep 0).
  assert.equal(byId.first_order, true);
  assert.equal(byId.regular, false);
  assert.equal(byId.points_100, true);
  assert.equal(byId.verified_rater, true);
  assert.equal(byId.reviewer_first, true);
  assert.equal(byId.reviewer_regular, false);
  assert.equal(byId.reviewer_expert, false);
});
