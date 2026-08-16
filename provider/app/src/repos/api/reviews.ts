/* Live API reviews repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /reviews                   → Review
 *   POST /reviews/{reviewId}/report → ReviewReport
 *
 * listReceived() is blocked until the received-reviews read lands (Team 6
 * gate), so it throws ApiError(404, NOT_IMPLEMENTED) instead of calling a path.
 */
import { api, ApiError } from '@/api/client';
import type { ReviewsRepository } from '../index';
import type { ReportReviewBody, Review, ReviewCreate } from '@hudumika/contract';

export class ApiReviewsRepository implements ReviewsRepository {
  async createForCustomer(bookingId: string, review: ReviewCreate): Promise<Review> {
    return api.post<Review>('/reviews', { ...review, targetId: bookingId });
  }

  async report(reviewId: string, reason: string): Promise<void> {
    const body: ReportReviewBody = { reason };
    await api.post<void>(`/reviews/${reviewId}/report`, body);
  }

  async listReceived(): Promise<never> {
    throw new ApiError(404, 'NOT_IMPLEMENTED', 'Received reviews are not available yet (GET /reviews/me — Team 6 gate)');
  }
}
