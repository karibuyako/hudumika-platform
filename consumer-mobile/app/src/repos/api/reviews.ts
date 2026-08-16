/* Live API reviews repository — POST /reviews, GET /reviews/me,
 * PATCH /reviews/{id}, DELETE /reviews/{id}, POST /reviews/{id}/helpful,
 * POST /reviews/{id}/report. */
import { ApiError, api } from '@/api/client';
import type { Review, ReviewCreate, ReviewReport, VoteReviewHelpful200 } from '@hudumika/contract';
import type { ReviewsRepository, ReviewUpdate } from '../index';

export class ApiReviewsRepository implements ReviewsRepository {
  async create(input: ReviewCreate, idempotencyKey: string): Promise<Review> {
    return api.post<Review>('/reviews', input, { idempotencyKey });
  }

  async update(reviewId: string, input: ReviewUpdate, idempotencyKey: string): Promise<Review> {
    return api.patch<Review>(`/reviews/${reviewId}`, input, { idempotencyKey });
  }

  async remove(reviewId: string, idempotencyKey: string): Promise<void> {
    return api.delete<void>(`/reviews/${reviewId}`, { idempotencyKey });
  }

  async helpful(reviewId: string, helpful: boolean, idempotencyKey: string): Promise<VoteReviewHelpful200> {
    return api.post<VoteReviewHelpful200>(`/reviews/${reviewId}/helpful`, { helpful }, { idempotencyKey });
  }

  async listMine(): Promise<Review[]> {
    return api.get<Review[]>('/reviews/me');
  }

  async listFor(_targetType: string, _targetId: string): Promise<Review[]> {
    // Mock-only: the contract has no public target-scoped review listing
    // (GET /reviews?targetType=&targetId=) — the surface is absent, so reject
    // with the contract NOT_FOUND code (ERROR-CODES.md: 404 = resource missing
    // or not visible to the caller) rather than an undocumented 501.
    throw new ApiError(404, 'NOT_FOUND', 'Public review listing is not in the contract yet');
  }

  async report(reviewId: string, reason: string, idempotencyKey: string): Promise<ReviewReport> {
    return api.post<ReviewReport>(`/reviews/${reviewId}/report`, { reason }, { idempotencyKey });
  }
}
