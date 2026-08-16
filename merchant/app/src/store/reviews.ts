import { create } from 'zustand';

import { api } from '@/api/client';
import type { EditReviewBody, ReviewDto, ReviewReport } from '@/api/types';
import type { Review } from '@/types';

interface ReviewState {
  reviews: Review[];
  avgRating: number;
  /** reviewId → true once reported (MESSAGES.md §Reviews — one report per review). */
  reported: Record<string, boolean>;
  hydrate: () => Promise<void>;
  reply: (id: string, text: string) => Promise<void>;
  editReply: (id: string, text: string) => Promise<void>;
  removeReply: (id: string) => Promise<void>;
  updateReview: (id: string, body: EditReviewBody) => Promise<void>;
  deleteReview: (id: string) => Promise<void>;
  addReview: (review: Omit<Review, 'id' | 'reply' | 'repliedAt'>) => void;
  report: (id: string, reason: string) => Promise<void>;
}

export const useReviewStore = create<ReviewState>()((set) => ({
  reviews: [],
  avgRating: 0,
  reported: {},

  hydrate: async () => {
    try {
      const res = await api.get<{ reviews: ReviewDto[]; avgRating: number }>('/reviews/me', { retries: 1 });
      set({ reviews: res.reviews, avgRating: res.avgRating });
    } catch {
      /* keep stale */
    }
  },

  reply: async (id, text) => {
    try {
      const res = await api.post<{ review: Review }>(`/reviews/${id}/reply`, { text }, { idempotencyKey: `rv:${id}:${Date.now()}` });
      set((s) => ({ reviews: s.reviews.map((r) => (r.id === id ? res.review : r)) }));
    } catch {
      /* keep stale */
    }
  },

  editReply: async (id, text) => {
    try {
      const res = await api.patch<{ review: Review }>(`/reviews/${id}/reply`, { text }, { idempotencyKey: `rv:${id}:${Date.now()}` });
      set((s) => ({ reviews: s.reviews.map((r) => (r.id === id ? res.review : r)) }));
    } catch {
      /* keep stale */
    }
  },

  removeReply: async (id) => {
    try {
      const res = await api.delete<{ review: Review }>(`/reviews/${id}/reply`);
      set((s) => ({ reviews: s.reviews.map((r) => (r.id === id ? res.review : r)) }));
    } catch {
      /* keep stale */
    }
  },

  /* Contract PATCH /reviews/{reviewId} — visibility toggle (state) + edits. */
  updateReview: async (id, body) => {
    try {
      const res = await api.patch<{ review: Review }>(`/reviews/${id}`, body, { idempotencyKey: `rvp:${id}:${Date.now()}` });
      set((s) => ({ reviews: s.reviews.map((r) => (r.id === id ? res.review : r)) }));
    } catch {
      /* keep stale */
    }
  },

  /* Contract DELETE /reviews/{reviewId} (204). */
  deleteReview: async (id) => {
    try {
      await api.delete(`/reviews/${id}`);
      set((s) => ({ reviews: s.reviews.filter((r) => r.id !== id) }));
    } catch {
      /* keep stale */
    }
  },

  addReview: (review) =>
    set((s) => ({ reviews: [review as Review, ...s.reviews] })),

  /* Contract POST /reviews/{reviewId}/report (reason ≤300) — MESSAGES.md
   * §Reviews: merchants report abusive reviews for moderation. */
  report: async (id, reason) => {
    const res = await api.post<ReviewReport>(`/reviews/${id}/report`, { reason }, { idempotencyKey: `rvr:${id}:${Date.now()}` });
    set((s) => ({ reported: { ...s.reported, [res.reviewId]: true } }));
  },
}));

export function reviewKey(orderNo: string): string {
  return `${orderNo}_${Date.now().toString(36)}`;
}
