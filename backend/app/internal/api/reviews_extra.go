package api

import (
	"errors"
	"net/http"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/reviews"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// REVIEWS-EXTRA surface: the author-side review mutations (edit own review,
// delete own review) and the rider-side order-decline reason catalog.

// riderRejectReasons is the static reject-reason catalog served by
// /riders/reject-reasons. The contract models the response as a plain array
// of strings and pins no values; the list mirrors the rider order-decline
// vocabulary (not at the location, wrong address, item unavailable, too
// large to carry, traffic, other).
var riderRejectReasons = []string{
	"not_at_location",
	"wrong_address",
	"item_unavailable",
	"too_large",
	"traffic",
	"other",
}

// EditMyReview applies the author's edits to their own review (PATCH
// /reviews/{reviewId}, contract Review, 200). At least one of rating/body
// must be supplied. Another author's review is indistinguishable from a
// missing one (404 REVIEW_NOT_FOUND, no leak); hidden/deleted reviews are
// not editable (409 REVIEW_NOT_EDITABLE). Deviation: the contract also
// accepts dimensions, but the reviews table has no column for it, so the
// field is validated away and not persisted.
func (s *Server) EditMyReview(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}

	var body gen.EditMyReviewJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Rating == nil && body.Body == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "At least one of rating or body must be provided")
		return
	}
	if body.Rating != nil && (*body.Rating < 1 || *body.Rating > 5) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Rating must be between 1 and 5")
		return
	}
	if body.Body != nil && (*body.Body == "" || len(*body.Body) > 2000) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Body must be between 1 and 2000 characters")
		return
	}

	review, err := s.reviewStore().Get(r.Context(), reviewId)
	if err != nil {
		s.logger.Error("review lookup failed for edit", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if review == nil || review.AuthorUserID != user.ID {
		writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Review not found")
		return
	}
	if review.State == "hidden" || review.State == "deleted" {
		writeError(w, http.StatusConflict, "REVIEW_NOT_EDITABLE", "Review is moderated and cannot be edited")
		return
	}

	if err := s.reviewStore().UpdateBody(r.Context(), reviewId, user.ID, body.Rating, body.Body); err != nil {
		if errors.Is(err, reviews.ErrNotFound) {
			// The review was moderated (hidden/deleted) between the Get and
			// the guarded update.
			writeError(w, http.StatusConflict, "REVIEW_NOT_EDITABLE", "Review is moderated and cannot be edited")
			return
		}
		s.logger.Error("review edit failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	updated, err := s.reviewStore().Get(r.Context(), reviewId)
	if err != nil || updated == nil {
		s.logger.Error("review reload failed after edit", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenReview(updated))
}

// DeleteMyReview soft-deletes the author's own review (DELETE
// /reviews/{reviewId}, contract 204). The row is kept for moderation
// history with state 'deleted' and the body replaced by a deletion marker.
// Another author's review is indistinguishable from a missing one (404
// REVIEW_NOT_FOUND, no leak); hidden/deleted reviews are not deletable
// (409 REVIEW_NOT_DELETABLE).
func (s *Server) DeleteMyReview(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}

	review, err := s.reviewStore().Get(r.Context(), reviewId)
	if err != nil {
		s.logger.Error("review lookup failed for delete", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if review == nil || review.AuthorUserID != user.ID {
		writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Review not found")
		return
	}
	if review.State == "hidden" || review.State == "deleted" {
		writeError(w, http.StatusConflict, "REVIEW_NOT_DELETABLE", "Review is moderated and cannot be deleted")
		return
	}

	if err := s.reviewStore().Delete(r.Context(), reviewId, user.ID, "deleted by author"); err != nil {
		if errors.Is(err, reviews.ErrNotFound) {
			// The review was moderated (hidden/deleted) between the Get and
			// the guarded update.
			writeError(w, http.StatusConflict, "REVIEW_NOT_DELETABLE", "Review is moderated and cannot be deleted")
			return
		}
		s.logger.Error("review delete failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListRiderRejectReasons returns the static rider order-decline reason
// catalog (GET /riders/reject-reasons, contract string[], 200). The values
// are the rider-side vocabulary referenced by the dispatch surface; the
// catalog is code-served and needs no database.
func (s *Server) ListRiderRejectReasons(w http.ResponseWriter, r *http.Request) {
	out := make([]string, len(riderRejectReasons))
	copy(out, riderRejectReasons)
	writeJSON(w, http.StatusOK, out)
}
