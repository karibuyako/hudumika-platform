/* Gamification badges (MASTER-BLUEPRINT §35: first order, 10 orders,
 * 100 points, verified rater, first/5/10 published reviews). Derived ONLY
 * from real, already-shipped data (orders / membership points / published
 * reviews) — nothing fabricated. Counts are supplied by the profile screen
 * from the repos; the thresholds live here so they are unit-testable and
 * stay consistent. The review milestones are count-based on published
 * reviews (no fake streak math — the contract Review has no streak data). */
export type BadgeId = 'first_order' | 'regular' | 'points_100' | 'verified_rater' | 'reviewer_first' | 'reviewer_regular' | 'reviewer_expert';

export interface Badge {
  id: BadgeId;
  earned: boolean;
}

export interface BadgeCounts {
  /** Orders in a terminal completed state (status 'completed'). */
  completedOrders: number;
  /** Current membership points balance (CustomerMembership.points). */
  points: number;
  /** Own reviews with state 'published'. */
  publishedReviews: number;
}

export function computeBadges({ completedOrders, points, publishedReviews }: BadgeCounts): Badge[] {
  return [
    { id: 'first_order', earned: completedOrders >= 1 },
    { id: 'regular', earned: completedOrders >= 10 },
    { id: 'points_100', earned: points >= 100 },
    { id: 'verified_rater', earned: publishedReviews >= 1 },
    { id: 'reviewer_first', earned: publishedReviews >= 1 },
    { id: 'reviewer_regular', earned: publishedReviews >= 5 },
    { id: 'reviewer_expert', earned: publishedReviews >= 10 },
  ];
}
