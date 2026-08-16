/* In-memory reviews repository. Mirrors POST /reviews (customer-targeted) and
 * POST /reviews/{id}/report against module state in mockState.ts.
 *
 * Only 'customer' targets are allowed (422 otherwise) and a booking may only
 * receive one review (409 REVIEW_ALREADY_EXISTS). listReceived() is gated
 * behind the Team 6 contract endpoint and always throws 404 NOT_IMPLEMENTED.
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso } from './mockState';
import { uid } from '@/lib/format';
import type { ReviewsRepository } from '../index';
import type { Review, ReviewCreate } from '@hudumika/contract';

export class MockReviewsRepository implements ReviewsRepository {
  async createForCustomer(bookingId: string, review: ReviewCreate): Promise<Review> {
    const state = getState();
    if (review.targetType !== 'customer') {
      throw new ApiError(422, 'REVIEW_TARGET_TYPE_INVALID', 'Only customer reviews can be created here');
    }
    if (state.reviewsByBooking.has(bookingId)) {
      throw new ApiError(409, 'REVIEW_ALREADY_EXISTS', 'A review for this booking already exists');
    }
    const created: Review = {
      id: uid('rev'),
      targetType: review.targetType,
      targetId: review.targetId,
      authorName: state.profile.name,
      rating: review.rating,
      body: review.body,
      state: 'pending',
      createdAt: nowIso(),
    };
    state.reviewsByBooking.set(bookingId, created);
    state.reviews.push(created);
    return clone(created);
  }

  async report(reviewId: string, reason: string): Promise<void> {
    const review = getState().reviews.find((r) => r.id === reviewId);
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    if (!reason.trim()) throw new ApiError(422, 'REPORT_REASON_REQUIRED', 'A reason is required to report a review');
  }

  async listReceived(): Promise<never> {
    throw new ApiError(404, 'NOT_IMPLEMENTED', 'GET /reviews/me not in contract yet — Team 6 gate');
  }
}
