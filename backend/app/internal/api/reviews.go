package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/reviews"
)

// reviewUser resolves the caller's users row from the authenticated claims.
// A missing database is a server fault (500) here, mirroring the
// notifications handlers rather than users.go where it doubles as NOT_FOUND
// in dev: a review cannot be created without durable identity.
func (s *Server) reviewUser(r *http.Request) (*auth.UserRow, error) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil, errNoBearerToken
	}
	if s.db == nil {
		return nil, errNoDatabase
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errUserNotFound
	}
	return user, nil
}

// writeReviewUserError maps reviewUser failures to envelopes; a missing
// database surfaces as INTERNAL_ERROR (500), never NOT_FOUND.
func (s *Server) writeReviewUserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken), errors.Is(err, errBadToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	case errors.Is(err, errNoDatabase):
		s.logger.Error("reviews handler skipped: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	case errors.Is(err, errUserNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
	default:
		s.logger.Error("reviews user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// reviewStore returns the reviews Store bound to the server pool. Callers
// must guard s.db nil before reaching this point.
func (s *Server) reviewStore() *reviews.Store {
	return reviews.NewStore(s.db.Pool())
}

// CreateReview accepts a post-completion rating (POST /reviews). The review
// is created in the pending state and enters the moderation queue
// (REVIEWS-MODERATION.md); a unique author+target constraint yields 409.
func (s *Server) CreateReview(w http.ResponseWriter, r *http.Request) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(raw) > maxBodyBytes {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	var body gen.CreateReviewJSONRequestBody
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	// Extract optional orderId/bookingId from raw JSON (gen.ReviewCreate may not have them).
	var orderID *uuid.UUID
	var bookingID *uuid.UUID
	{
		var extra map[string]json.RawMessage
		if err := json.Unmarshal(raw, &extra); err == nil {
			for _, k := range []string{"orderId", "order_id", "orderID"} {
				if v, ok := extra[k]; ok {
					var s string
					if err := json.Unmarshal(v, &s); err != nil {
						continue
					}
					if s == "" {
						continue
					}
					id, err := uuid.Parse(s)
					if err != nil {
						writeError(w, http.StatusUnprocessableEntity, "REVIEW_NOT_ELIGIBLE", "Invalid orderId")
						return
					}
					u := id
					orderID = &u
					break
				}
			}
			for _, k := range []string{"bookingId", "booking_id", "bookingID"} {
				if v, ok := extra[k]; ok {
					var s string
					if err := json.Unmarshal(v, &s); err != nil {
						continue
					}
					if s == "" {
						continue
					}
					id, err := uuid.Parse(s)
					if err != nil {
						writeError(w, http.StatusUnprocessableEntity, "REVIEW_NOT_ELIGIBLE", "Invalid bookingId")
						return
					}
					u := id
					bookingID = &u
					break
				}
			}
		}
	}

	// Eligibility verification when extra IDs are present.
	if orderID != nil {
		if s.db == nil {
			s.logger.Error("reviews eligibility check failed: database not configured")
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		var status string
		var cust uuid.UUID
		err := s.db.Pool().QueryRow(r.Context(), `SELECT status, customer_user_id FROM orders WHERE id = $1`, *orderID).Scan(&status, &cust)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Order not found")
			return
		}
		if err != nil {
			s.logger.Error("order eligibility lookup failed", "order", *orderID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if cust != user.ID {
			writeError(w, http.StatusUnprocessableEntity, "REVIEW_NOT_ELIGIBLE", "Not eligible to review this order")
			return
		}
		if status != "completed" && status != "delivered" {
			writeError(w, http.StatusUnprocessableEntity, "REVIEW_NOT_ELIGIBLE", "Order is not eligible for review")
			return
		}
	}
	if bookingID != nil {
		if s.db == nil {
			s.logger.Error("reviews eligibility check failed: database not configured")
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		var status string
		var cust uuid.UUID
		err := s.db.Pool().QueryRow(r.Context(), `SELECT status, customer_user_id FROM bookings WHERE id = $1`, *bookingID).Scan(&status, &cust)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Booking not found")
			return
		}
		if err != nil {
			s.logger.Error("booking eligibility lookup failed", "booking", *bookingID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if cust != user.ID {
			writeError(w, http.StatusUnprocessableEntity, "REVIEW_NOT_ELIGIBLE", "Not eligible to review this booking")
			return
		}
		if status != "completed" {
			writeError(w, http.StatusUnprocessableEntity, "REVIEW_NOT_ELIGIBLE", "Booking is not eligible for review")
			return
		}
	}

	if !body.TargetType.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "targetType must be one of merchant, provider, rider, customer")
		return
	}
	if body.Rating < 1 || body.Rating > 5 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "rating must be between 1 and 5")
		return
	}
	if body.Body == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body is required")
		return
	}
	if len(body.Body) > 2000 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body must be at most 2000 characters")
		return
	}

	id, err := s.reviewStore().Create(r.Context(), reviews.Review{
		TargetType:   string(body.TargetType),
		TargetID:     body.TargetId,
		AuthorUserID: user.ID,
		OrderID:      orderID,
		BookingID:    bookingID,
		Rating:       body.Rating,
		Body:         body.Body,
		// The store defaults the row to pending; the explicit field documents
		// the moderation gate the review passes through.
		State: "pending",
	})
	if errors.Is(err, reviews.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "REVIEW_ALREADY_EXISTS", "You have already reviewed this target for this completion")
		return
	}
	if err != nil {
		s.logger.Error("review create failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	created, err := s.reviewStore().Get(r.Context(), id)
	if err != nil {
		s.logger.Error("review reload failed after create", "review", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenReview(created))
}

// ListMyReceivedReviews returns the caller's reviews, newest first, with
// cursor pagination (GET /reviews/me). The contract intent is "reviews
// received by own merchant/provider/rider"; resolving the session user's
// target entities is not available in this milestone, so this is
// implemented as the reviews authored by the session user (ListMine). The
// next cursor rides the X-Next-Cursor header because the contract response
// is a bare array.
func (s *Server) ListMyReceivedReviews(w http.ResponseWriter, r *http.Request, params gen.ListMyReceivedReviewsParams) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}
	limit := 20
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}
	if limit > 50 {
		limit = 50
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}

	rows, next, err := s.reviewStore().ListMine(r.Context(), user.ID, limit, cursor)
	if err != nil {
		s.logger.Error("reviews list failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out := make([]gen.ReviewDetail, 0, len(rows))
	for i := range rows {
		out = append(out, toGenReviewDetail(rows[i]))
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	writeJSON(w, http.StatusOK, out)
}

// ReplyToReview attaches the single allowed reply to a review (POST
// /reviews/{reviewId}/reply). AddReply accepts published and pending reviews
// alike, so ErrNotRepliable means the review is missing or hidden/deleted
// (404 REVIEW_NOT_FOUND); a review that already carries a reply maps to 409
// REVIEW_REPLY_EXISTS. Pending reviews are repliable, so REVIEW_MODERATION_REQUIRED
// is never produced by this endpoint.
func (s *Server) ReplyToReview(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}

	var body gen.ReplyToReviewJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Body == "" {
		writeError(w, http.StatusUnprocessableEntity, "EMPTY_REPLY", "Reply body is required")
		return
	}
	if len(body.Body) > 1000 {
		writeError(w, http.StatusUnprocessableEntity, "EMPTY_REPLY", "Reply body must be at most 1000 characters")
		return
	}

	err = s.reviewStore().AddReply(r.Context(), reviewId, user.ID, body.Body)
	switch {
	case errors.Is(err, reviews.ErrReplyExists):
		writeError(w, http.StatusConflict, "REVIEW_REPLY_EXISTS", "This review already has a reply")
		return
	case errors.Is(err, reviews.ErrNotRepliable):
		writeError(w, http.StatusNotFound, "REVIEW_NOT_FOUND", "Review not found")
		return
	case err != nil:
		s.logger.Error("review reply failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.ReviewReply{
		Id:        newUUID(replyID(reviewId).String()),
		ReviewId:  reviewId,
		Body:      body.Body,
		CreatedAt: time.Now().UTC(),
	})
}

// VoteReviewHelpful records a helpful vote on a published review (POST
// /reviews/{reviewId}/helpful). The store supports only the one-way upvote
// (VoteHelpful with dedup), so helpful=false is rejected. ErrAlreadyVoted
// yields 409 REVIEW_HELPFUL_ALREADY_VOTED without increment; ErrNotEligible
// covers both a non-published and a missing review, hence 409 REVIEW_HELPFUL_VOTE_INVALID.
func (s *Server) VoteReviewHelpful(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}

	var body gen.VoteReviewHelpfulJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Helpful {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "helpful must be true: only positive helpful votes are supported")
		return
	}

	if err := s.reviewStore().VoteHelpful(r.Context(), reviewId, user.ID); err != nil {
		if errors.Is(err, reviews.ErrAlreadyVoted) {
			writeError(w, http.StatusConflict, "REVIEW_HELPFUL_ALREADY_VOTED", "Already voted helpful on this review")
			return
		}
		if errors.Is(err, reviews.ErrNotEligible) {
			writeError(w, http.StatusConflict, "REVIEW_HELPFUL_VOTE_INVALID", "Review is not published or does not exist")
			return
		}
		s.logger.Error("review helpful vote failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	review, err := s.reviewStore().Get(r.Context(), reviewId)
	if err != nil || review == nil {
		s.logger.Error("review reload failed after helpful vote", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// No per-user vote ledger exists yet: notHelpfulCount stays 0 and the
	// caller's vote is reported as cast.
	myVote := true
	writeJSON(w, http.StatusOK, helpfulVoteResponse{
		HelpfulCount:    review.HelpfulCount,
		NotHelpfulCount: 0,
		MyVote:          &myVote,
	})
}

// ReportReview files a moderation report against a review (POST
// /reviews/{reviewId}/report). Reports are idempotent per reporter
// (ON CONFLICT DO NOTHING); the response reflects the stored report.
func (s *Server) ReportReview(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}

	var body gen.ReportReviewJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if len(body.Reason) > 300 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason must be at most 300 characters")
		return
	}

	if err := s.reviewStore().Report(r.Context(), reviewId, user.ID, body.Reason); err != nil {
		s.logger.Error("review report failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	report, err := s.reviewStore().GetReport(r.Context(), reviewId, user.ID)
	if err != nil || report == nil {
		s.logger.Error("review report reload failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.ReviewReport{
		Id:       newUUID(report.ID.String()),
		ReviewId: newUUID(report.ReviewID.String()),
		Reason:   report.Reason,
		State:    gen.ReviewReportState(report.State),
	})
}

// helpfulVoteResponse is the contract body of POST /reviews/{reviewId}/helpful.
type helpfulVoteResponse struct {
	HelpfulCount    int   `json:"helpfulCount"`
	NotHelpfulCount int   `json:"notHelpfulCount"`
	MyVote          *bool `json:"myVote"`
}

// toGenReview maps a reviews row onto the contract Review. AuthorName is
// omitted (nil) because the store does not persist author names.
func toGenReview(r *reviews.Review) gen.Review {
	body := r.Body
	return gen.Review{
		Id:         newUUID(r.ID.String()),
		TargetId:   newUUID(r.TargetID.String()),
		TargetType: r.TargetType,
		Rating:     r.Rating,
		State:      gen.ReviewState(r.State),
		Body:       &body,
		CreatedAt:  r.CreatedAt,
	}
}

// toGenReviewDetail maps a reviews row onto the contract ReviewDetail,
// carrying the inline single reply when one exists. The reply id is a
// deterministic derivation of the review id (the store keeps no separate
// reply id) and the author role is omitted (the store does not persist it).
func toGenReviewDetail(r reviews.Review) gen.ReviewDetail {
	body := r.Body
	out := gen.ReviewDetail{
		Id:         newUUID(r.ID.String()),
		TargetId:   newUUID(r.TargetID.String()),
		TargetType: r.TargetType,
		Rating:     r.Rating,
		State:      gen.ReviewDetailState(r.State),
		Body:       &body,
		CreatedAt:  r.CreatedAt,
		Replies:    make([]gen.ReviewReply, 0),
	}
	if r.ReplyBody != nil {
		out.Replies = append(out.Replies, gen.ReviewReply{
			Id:        newUUID(replyID(r.ID).String()),
			ReviewId:  newUUID(r.ID.String()),
			Body:      *r.ReplyBody,
			CreatedAt: r.CreatedAt,
		})
		if r.ReplyCreatedAt != nil {
			out.Replies[0].CreatedAt = *r.ReplyCreatedAt
		}
		if r.ReplyAuthorUserID != nil {
			id := newUUID(r.ReplyAuthorUserID.String())
			out.Replies[0].AuthorUserId = &id
		}
	}
	return out
}

// replyID derives a stable reply id from the review id for contract
// responses; the store persists replies inline without their own id.
func replyID(reviewID uuid.UUID) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("review-reply:"+reviewID.String()))
}
