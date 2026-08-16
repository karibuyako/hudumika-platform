/* M6b — Reviews surface: dimensions round-trip, edit, delete, helpful vote
 * toggle, report (REVIEW_NOT_REPORTABLE), own-review listing (pending state)
 * and the mock-only target-scoped listing. Social layer (m6c): the verified-
 * purchase flag and merchant reply travel as mock-only display extensions on
 * the Review DTO (contract Review has neither — CONTRACT-ADDITIONS #15/#18). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { MockReviewsRepository } from '@/repos/mock/reviews';
import { getState } from '@/repos/mock/mockState';
import type { ReviewReply } from '@hudumika/contract';

const reviews = new MockReviewsRepository();

beforeEach(() => resetMockState());

const merchantId = () => getState().orders.find((o) => o.status === 'delivered')!.merchantId;

test('create with dimensions round-trips through the mock store', async () => {
  const created = await reviews.create(
    { targetType: 'merchant', targetId: merchantId(), rating: 4, body: 'nzuri sana', dimensions: { professionalism: 5, cleanliness: 4, wouldRecommend: true } },
    'k1',
  );
  assert.equal(created.state, 'pending');
  assert.equal(created.targetType, 'merchant');
  const stored = getState().reviews.find((r) => r.id === created.id) as { dimensions?: Record<string, unknown> } | undefined;
  assert.equal(stored?.dimensions?.professionalism, 5);
  assert.equal(stored?.dimensions?.cleanliness, 4);
  assert.equal(stored?.dimensions?.wouldRecommend, true);
});

test('edit updates rating/body/dimensions and stays the same review', async () => {
  const created = await reviews.create({ targetType: 'merchant', targetId: merchantId(), rating: 3, body: 'okay' }, 'k1');
  const updated = await reviews.update(created.id, { rating: 5, body: 'actually great', dimensions: { quality: 5, wouldRecommend: true } }, 'k2');
  assert.equal(updated.id, created.id);
  assert.equal(updated.rating, 5);
  assert.equal(updated.body, 'actually great');
  const stored = getState().reviews.find((r) => r.id === created.id) as { dimensions?: Record<string, unknown> } | undefined;
  assert.equal(stored?.dimensions?.quality, 5);
  assert.equal(stored?.dimensions?.wouldRecommend, true);
  await rejectsApiError(reviews.update('rev_missing', { rating: 4 }, 'k3'), 404, 'REVIEW_NOT_FOUND');
});

test('delete marks the review deleted and removes its actions', async () => {
  const created = await reviews.create({ targetType: 'merchant', targetId: merchantId(), rating: 4, body: 'x' }, 'k1');
  await reviews.remove(created.id, 'k2');
  assert.equal(getState().reviews.find((r) => r.id === created.id)?.state, 'deleted');
  const mine = await reviews.listMine();
  const after = mine.find((r) => r.id === created.id);
  assert.ok(after && after.state === 'deleted', 'deleted reviews stay listed for explanatory copy, without actions');
  await rejectsApiError(reviews.remove('rev_missing', 'k3'), 404, 'REVIEW_NOT_FOUND');
});

test('helpful vote toggles the count and myVote', async () => {
  await reviews.listMine(); // ensureSeeds
  const seed = getState().reviews.find((r) => r.id === 'rev_seed_merchant_1')!;
  const first = await reviews.helpful(seed.id, true, 'k1');
  assert.deepEqual(first, { helpfulCount: 1, notHelpfulCount: 0, myVote: true });
  const flipped = await reviews.helpful(seed.id, false, 'k2');
  assert.deepEqual(flipped, { helpfulCount: 0, notHelpfulCount: 1, myVote: false });
  const cleared = await reviews.helpful(seed.id, false, 'k3');
  assert.deepEqual(cleared, { helpfulCount: 0, notHelpfulCount: 0, myVote: null });
  await rejectsApiError(reviews.helpful('rev_missing', true, 'k4'), 404, 'REVIEW_NOT_FOUND');
});

test('report opens a moderation case and rejects non-published reviews', async () => {
  await reviews.listMine(); // ensureSeeds
  const seed = getState().reviews.find((r) => r.id === 'rev_seed_merchant_1')!;
  const report = await reviews.report(seed.id, 'Spam or promotional', 'k1');
  assert.equal(report.reviewId, seed.id);
  assert.equal(report.reason, 'Spam or promotional');
  assert.equal(report.state, 'open');
  const pending = getState().reviews.find((r) => r.id === 'rev_seed_own_pending')!;
  await rejectsApiError(reviews.report(pending.id, 'x', 'k2'), 422, 'REVIEW_NOT_REPORTABLE');
  await rejectsApiError(reviews.report('rev_missing', 'x', 'k3'), 404, 'REVIEW_NOT_FOUND');
});

test('listMine returns own reviews including the pending moderation state', async () => {
  const mine = await reviews.listMine();
  const pending = mine.find((r) => r.id === 'rev_seed_own_pending');
  assert.ok(pending, 'the own pending seed appears in the list');
  assert.equal(pending!.state, 'pending');
  assert.ok(mine.every((r) => r.authorName === 'Demo Customer'), 'only own reviews are listed');
});

test('listFor filters published reviews by target (mock-only listing)', async () => {
  await reviews.listMine(); // ensureSeeds
  const merchantId = getState().merchants[0].id;
  const merchantReviews = await reviews.listFor('merchant', merchantId);
  assert.ok(merchantReviews.length >= 2, 'seeded merchant reviews are listed');
  assert.ok(merchantReviews.every((r) => r.state === 'published'), 'public listing surfaces published only');
  const providerReviews = await reviews.listFor('provider', 'prov_001');
  assert.equal(providerReviews.length, 1);
  assert.equal(providerReviews[0].targetType, 'provider');
  const other = await reviews.listFor('merchant', getState().merchants[1].id);
  assert.equal(other.length, 0, 'no published seeds for that target');
});

test('provider reviews are eligibility-gated on a completed booking', async () => {
  const noCompleted = getState().bookings.some((b) => b.providerId === 'prov_001' && b.status === 'completed');
  assert.equal(noCompleted, false, 'no completed booking in the seed');
  await rejectsApiError(
    reviews.create({ targetType: 'provider', targetId: 'prov_001', rating: 5, body: 'fundi mzuri' }, 'k1'),
    422,
    'REVIEW_NOT_ELIGIBLE',
  );
});

test('seeded reviews carry the mock-only verified flag and merchant reply (published rendering path)', async () => {
  const merchantReviews = await reviews.listFor('merchant', getState().merchants[0].id);
  const withReply = merchantReviews.find((r) => r.id === 'rev_seed_merchant_1') as (Review & { verified?: boolean; reply?: ReviewReply }) | undefined;
  assert.ok(withReply, 'the replied-to seed review is listed');
  assert.equal(withReply!.verified, true, 'verified-purchase flag is present on the published seed');
  assert.ok(withReply!.reply, 'the merchant reply is present on the DTO');
  assert.equal(withReply!.reply!.authorRole, 'merchant');
  assert.ok(withReply!.reply!.body.length > 0, 'the reply carries the merchant text');
  assert.equal(withReply!.reply!.reviewId, withReply!.id);

  const withoutReply = merchantReviews.find((r) => r.id === 'rev_seed_merchant_2') as (Review & { reply?: ReviewReply }) | undefined;
  assert.ok(withoutReply, 'the plain seed review is listed');
  assert.equal(withoutReply!.reply, undefined, 'no reply field when the merchant never replied');
});

test('listMine exposes the own published review with the verified flag (badge data)', async () => {
  const mine = await reviews.listMine();
  const own = mine.find((r) => r.id === 'rev_seed_own_published') as (Review & { verified?: boolean }) | undefined;
  assert.ok(own, 'the own published seed appears in the list');
  assert.equal(own!.state, 'published');
  assert.equal(own!.verified, true, 'own published review carries the verified flag');
});
