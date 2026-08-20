package api

import (
	"errors"
	"net/http"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/reviews"
)

// AdminModerateReview transitions a review through the moderation state
// machine (POST /admin/reviews/moderate, REVIEWS-MODERATION.md). RequireAuth
// gates the route to MFA-verified staff before this handler runs; the audit
// middleware records every /admin/* mutation, so no explicit audit write is
// needed here. publish only promotes pending reviews (publishing an already
// published review is an idempotent 200); hide demotes pending or published
// reviews; delete moves any non-deleted review to deleted (already-deleted is
// an idempotent 200). A wrong-state transition answers 409
// REVIEW_MODERATION_REQUIRED and a missing review 404 REVIEW_NOT_FOUND.
func (s *Server) AdminModerateReview(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminModerateReviewJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Action.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action must be one of publish, hide, delete")
		return
	}
	if body.Reason != nil && len(*body.Reason) > 500 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason must be at most 500 characters")
		return
	}

	if s.db == nil {
		s.logger.Error("moderate review failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	review, err := s.reviewStore().Get(r.Context(), body.ReviewId)
	if err != nil {
		s.logger.Error("moderate review lookup failed", "review", body.ReviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if review == nil {
		writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Review not found")
		return
	}

	// Resolve the target state for the requested action against the review's
	// current state; nil means the transition is invalid for this state.
	var target string
	switch body.Action {
	case gen.AdminModerateReviewJSONBodyActionPublish:
		switch review.State {
		case "published":
			// Idempotent: publishing an already published review is a no-op.
			writeJSON(w, http.StatusOK, toGenReview(review))
			return
		case "pending":
			target = "published"
		}
	case gen.AdminModerateReviewJSONBodyActionHide:
		if review.State == "pending" || review.State == "published" {
			target = "hidden"
		}
	case gen.AdminModerateReviewJSONBodyActionDelete:
		switch review.State {
		case "deleted":
			// Idempotent: deleting an already deleted review is a no-op.
			writeJSON(w, http.StatusOK, toGenReview(review))
			return
		default:
			target = "deleted"
		}
	}
	if target == "" {
		writeError(w, http.StatusConflict, "REVIEW_MODERATION_REQUIRED", "Review is not in a state that allows this moderation action")
		return
	}

	if err := s.reviewStore().SetState(r.Context(), review.ID, target); err != nil {
		if errors.Is(err, reviews.ErrNotFound) {
			// The row vanished or moved between Get and SetState: re-check.
			writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Review not found")
			return
		}
		s.logger.Error("moderate review failed", "review", body.ReviewId, "action", body.Action, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	if err := s.reviewStore().RecomputeRating(r.Context(), review.TargetType, review.TargetID); err != nil {
		s.logger.Error("recompute rating failed after moderation", "targetType", review.TargetType, "target", review.TargetID, "error", err)
	}

	updated, err := s.reviewStore().Get(r.Context(), review.ID)
	if err != nil || updated == nil {
		s.logger.Error("review reload failed after moderation", "review", review.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenReview(updated))
}
