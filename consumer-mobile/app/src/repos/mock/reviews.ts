/* In-memory reviews repository — POST /reviews (eligibility-gated),
 * GET /reviews/me, PATCH /reviews/{id}, DELETE /reviews/{id},
 * POST /reviews/{id}/helpful, POST /reviews/{id}/report.
 *
 * Helpful-vote state is module-local (never in mockState.ts). Seeds live here
 * too and are idempotent across resetMockState() so the reviews list has
 * content on first load.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import type { Review, ReviewCreate, ReviewReport, ReviewReply, VoteReviewHelpful200 } from '@hudumika/contract';
import type { ReviewsRepository, ReviewUpdate } from '../index';
import { earnReviewPoints } from './memberships';

const ELIGIBLE_ORDER_STATUSES = ['delivered', 'completed'];

/** Stored reviews may carry fields the customer Review DTO omits (mock-only
 * extensions, same pattern as MockIntent.orderId). `dimensions` is create-
 * input only and stays mock-internal (stripped by toDto). `verified` and
 * `reply` are DISPLAY data — they survive toDto so the UI can render them,
 * and are documented additions the live wire can never carry until the
 * contract exposes them (docs/CONTRACT-ADDITIONS.md #15 reply, #18 verified).
 * The live repo returns contract-faithful Review objects, so the UI hides
 * both surfaces when the data is absent. */
type StoredReview = Review & {
  dimensions?: ReviewCreate['dimensions'];
  verified?: boolean;
  reply?: ReviewReply | null;
};

/** POST /reviews/{id}/helpful toggle state (no GET endpoint in the contract). */
const helpfulVotes = new Map<string, VoteReviewHelpful200>();

function voteState(reviewId: string): VoteReviewHelpful200 {
  return helpfulVotes.get(reviewId) ?? { helpfulCount: 0, notHelpfulCount: 0, myVote: null };
}

function toDto(r: StoredReview): Review {
  const { dimensions: _dimensions, ...dto } = r;
  return clone(dto);
}

/** Module-local seeds (mockState.ts stays untouched): published reviews for a
 * merchant + a provider and one own pending review. Idempotent after resets.
 * Stored reviews may carry dimensions the Review DTO omits (see StoredReview).
 * One published seed carries the mock-only verified flag + merchant reply so
 * the trust-loop UI (REVIEWS.md / Meituan 必吃榜 parity) has real data to
 * render; the own published seed proves the badge on the user's own review. */
function ensureSeeds(): void {
  const state = getState();
  if (state.reviews.some((r) => r.id.startsWith('rev_seed_'))) return;
  const merchantId = state.merchants[0].id;
  state.reviews.unshift(
    {
      id: 'rev_seed_merchant_1',
      targetType: 'merchant',
      targetId: merchantId,
      authorName: 'Neema M.',
      rating: 5,
      body: 'Delicious pilau, arrived hot. Asante!',
      state: 'published',
      createdAt: nowIso(),
      verified: true,
      reply: {
        id: 'rev_reply_seed_1',
        reviewId: 'rev_seed_merchant_1',
        authorRole: 'merchant',
        body: 'Asante sana Neema! Karibu tena.',
        createdAt: nowIso(),
      },
    } as StoredReview,
    {
      id: 'rev_seed_merchant_2',
      targetType: 'merchant',
      targetId: merchantId,
      authorName: 'Baraka K.',
      rating: 4,
      body: 'Great food, but the delivery took a bit longer than expected.',
      state: 'published',
      createdAt: nowIso(),
    } as StoredReview,
    {
      id: 'rev_seed_provider_1',
      targetType: 'provider',
      targetId: 'prov_001',
      authorName: 'Juma H.',
      rating: 5,
      body: 'Punctual and professional — fixed the leak quickly and cleaned up after.',
      dimensions: {
        professionalism: 5,
        punctuality: 5,
        quality: 5,
        communication: 4,
        priceTransparency: 5,
        cleanliness: 5,
        wouldRecommend: true,
      },
      state: 'published',
      createdAt: nowIso(),
    } as StoredReview,
    {
      id: 'rev_seed_own_published',
      targetType: 'merchant',
      targetId: state.merchants[2].id,
      authorName: state.user.fullName,
      rating: 5,
      body: 'Went above and beyond — the rider and the kitchen both did great.',
      state: 'published',
      createdAt: nowIso(),
      verified: true,
    } as StoredReview,
    {
      id: 'rev_seed_own_pending',
      targetType: 'merchant',
      targetId: state.merchants[1].id,
      authorName: state.user.fullName,
      rating: 4,
      body: 'Order arrived on time — review is being moderated.',
      state: 'pending',
      createdAt: nowIso(),
    } as StoredReview,
  );
}

function assertEligible(input: ReviewCreate): void {
  const state = getState();
  if (input.targetType === 'merchant') {
    const eligible = state.orders.some((o) => o.merchantId === input.targetId && ELIGIBLE_ORDER_STATUSES.includes(o.status));
    if (!eligible) throw new ApiError(422, 'REVIEW_NOT_ELIGIBLE', 'You can review after your order is delivered');
  } else if (input.targetType === 'provider') {
    const eligible = state.bookings.some((b) => b.providerId === input.targetId && b.status === 'completed');
    if (!eligible) throw new ApiError(422, 'REVIEW_NOT_ELIGIBLE', 'You can review after the service is completed');
  }
  // rider: policy-driven, mock accepts once any order was delivered (rider
  // identity is not on the consumer Order DTO).
  const already = state.reviews.some(
    (r) => r.targetType === input.targetType && r.targetId === input.targetId && r.authorName === state.user.fullName,
  );
  if (already) throw new ApiError(422, 'REVIEW_ALREADY_EXISTS', 'You already reviewed this');
}

export class MockReviewsRepository implements ReviewsRepository {
  async create(input: ReviewCreate, _idempotencyKey: string): Promise<Review> {
    ensureSeeds();
    const state = getState();
    assertEligible(input);
    const review: StoredReview = {
      id: uid('rev'),
      targetType: input.targetType,
      targetId: input.targetId,
      authorName: state.user.fullName,
      rating: input.rating,
      body: input.body,
      dimensions: input.dimensions ?? undefined,
      state: 'pending',
      createdAt: nowIso(),
    };
    state.reviews.unshift(review);
    // Points accrual (P6d, docs/CONTRACT-ADDITIONS.md #28): engagement points
    // for the review — the mock awards on create (the demo has no moderation
    // transition, REVIEWS.md pending → published is a live-backend concern; a
    // live server awards when the review is published).
    earnReviewPoints(review);
    return toDto(review);
  }

  async update(reviewId: string, input: ReviewUpdate, _idempotencyKey: string): Promise<Review> {
    ensureSeeds();
    const state = getState();
    const review = state.reviews.find((r) => r.id === reviewId) as StoredReview | undefined;
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    if (review.authorName !== state.user.fullName) throw new ApiError(403, 'FORBIDDEN', 'You can only edit your own reviews');
    if (input.rating !== undefined) review.rating = input.rating;
    if (input.body !== undefined) review.body = input.body;
    if (input.dimensions !== undefined) review.dimensions = input.dimensions;
    return toDto(review);
  }

  async remove(reviewId: string, _idempotencyKey: string): Promise<void> {
    ensureSeeds();
    const state = getState();
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    if (review.authorName !== state.user.fullName) throw new ApiError(403, 'FORBIDDEN', 'You can only delete your own reviews');
    review.state = 'deleted';
  }

  async helpful(reviewId: string, helpful: boolean, _idempotencyKey: string): Promise<VoteReviewHelpful200> {
    ensureSeeds();
    const state = getState();
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    const current = voteState(reviewId);
    let next: VoteReviewHelpful200;
    if (current.myVote === helpful) {
      // Toggle off: remove the existing vote.
      next = {
        helpfulCount: Math.max(0, current.helpfulCount - (helpful ? 1 : 0)),
        notHelpfulCount: Math.max(0, current.notHelpfulCount - (helpful ? 0 : 1)),
        myVote: null,
      };
    } else {
      // New vote (or switch): remove the old vote (if any), add the new one.
      next = {
        helpfulCount: current.helpfulCount + (helpful ? 1 : 0) - (current.myVote === true ? 1 : 0),
        notHelpfulCount: current.notHelpfulCount + (helpful ? 0 : 1) - (current.myVote === false ? 1 : 0),
        myVote: helpful,
      };
    }
    helpfulVotes.set(reviewId, next);
    return clone(next);
  }

  async listMine(): Promise<Review[]> {
    ensureSeeds();
    const state = getState();
    return state.reviews.filter((r) => r.authorName === state.user.fullName).map(toDto);
  }

  async listFor(targetType: string, targetId: string): Promise<Review[]> {
    ensureSeeds();
    const state = getState();
    // Public listings surface published reviews only (REVIEWS.md display rules).
    return state.reviews.filter((r) => r.targetType === targetType && r.targetId === targetId && r.state === 'published').map(toDto);
  }

  async report(reviewId: string, reason: string, _idempotencyKey: string): Promise<ReviewReport> {
    ensureSeeds();
    const state = getState();
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    if (review.state !== 'published') throw new ApiError(422, 'REVIEW_NOT_REPORTABLE', 'This review cannot be reported');
    return { id: uid('rr'), reviewId, reason, state: 'open' };
  }
}
