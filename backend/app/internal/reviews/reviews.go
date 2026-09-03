// Package reviews is the bounded context for post-completion ratings,
// replies and moderation reporting (backend/REVIEWS-MODERATION.md). It talks
// directly to PostgreSQL via a pgxpool.Pool. Reviews are created pending and
// become published through moderation; rating averages elsewhere are computed
// over published rows only.
package reviews

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors returned by Store methods and mapped to HTTP envelopes by
// the reviews API handlers.
var (
	// ErrAlreadyExists is returned by Create when the author already reviewed
	// the same target for the same completion link.
	ErrAlreadyExists = errors.New("review already exists")
	// ErrNotEligible is returned when a mutation cannot run on the review in
	// its current state (e.g. a helpful vote on a non-published review).
	ErrNotEligible = errors.New("review not eligible")
	// ErrNotRepliable is returned when the review is missing or is not in a
	// state that accepts a reply (hidden/deleted).
	ErrNotRepliable = errors.New("review not repliable")
	// ErrReplyExists is returned when the review already has a reply; a
	// review carries at most one reply.
	ErrReplyExists = errors.New("review already has a reply")
	// ErrNotFound is returned when a moderation transition cannot run
	// because the review is missing or already in a terminal state.
	ErrNotFound = errors.New("review not found")
	// ErrAlreadyVoted is returned by VoteHelpful when the user already voted
	// helpful on the review.
	ErrAlreadyVoted = errors.New("already voted helpful")
)

// Review is the persisted projection of one review row.
type Review struct {
	ID                uuid.UUID
	TargetType        string
	TargetID          uuid.UUID
	AuthorUserID      uuid.UUID
	OrderID           *uuid.UUID
	BookingID         *uuid.UUID
	Rating            int
	Body              string
	State             string
	HelpfulCount      int
	ReplyBody         *string
	ReplyAuthorUserID *uuid.UUID
	ReplyCreatedAt    *time.Time
	CreatedAt         time.Time
}

// Report is the persisted projection of one moderation report row.
type Report struct {
	ID             uuid.UUID
	ReviewID       uuid.UUID
	ReporterUserID uuid.UUID
	Reason         string
	State          string
	CreatedAt      time.Time
}

// Store wraps the connection pool for all reviews persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

const reviewColumns = `id, target_type, target_id, author_user_id, order_id, booking_id,
	rating, body, state, helpful_count, reply_body, reply_author_user_id,
	reply_created_at, created_at`

// Create inserts a review in the pending state (moderation gate) and returns
// its id. A duplicate review for the same author, target and completion link
// yields ErrAlreadyExists.
func (s *Store) Create(ctx context.Context, r Review) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`INSERT INTO reviews (target_type, target_id, author_user_id, order_id, booking_id, rating, body)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		r.TargetType, r.TargetID, r.AuthorUserID, r.OrderID, r.BookingID, r.Rating, r.Body).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return uuid.Nil, fmt.Errorf("reviews: create: %w", ErrAlreadyExists)
		}
		return uuid.Nil, fmt.Errorf("reviews: create: %w", err)
	}
	return id, nil
}

// Get returns the review for the id, or (nil, nil) when no row matches.
// State gating is the caller's responsibility.
func (s *Store) Get(ctx context.Context, reviewID uuid.UUID) (*Review, error) {
	var r Review
	err := s.pool.QueryRow(ctx,
		`SELECT `+reviewColumns+` FROM reviews WHERE id = $1`, reviewID).
		Scan(&r.ID, &r.TargetType, &r.TargetID, &r.AuthorUserID, &r.OrderID, &r.BookingID,
			&r.Rating, &r.Body, &r.State, &r.HelpfulCount, &r.ReplyBody, &r.ReplyAuthorUserID,
			&r.ReplyCreatedAt, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reviews: get %s: %w", reviewID, err)
	}
	return &r, nil
}

// ListMine returns the reviews authored by the user, newest first, with
// keyset pagination over a base64 (created_at, id) cursor. The returned
// cursor is empty when no further page exists.
func (s *Store) ListMine(ctx context.Context, authorUserID uuid.UUID, limit int, cursor string) ([]Review, string, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	query := `SELECT ` + reviewColumns + ` FROM reviews WHERE author_user_id = $1`
	args := []any{authorUserID}
	if cursor != "" {
		c, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("reviews: list mine: invalid cursor: %w", err)
		}
		query += ` AND (created_at, id) < ($2, $3)`
		args = append(args, c.createdAt, c.id)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("reviews: list mine for user %s: %w", authorUserID, err)
	}
	defer rows.Close()

	reviews := make([]Review, 0, limit+1)
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.TargetType, &r.TargetID, &r.AuthorUserID, &r.OrderID, &r.BookingID,
			&r.Rating, &r.Body, &r.State, &r.HelpfulCount, &r.ReplyBody, &r.ReplyAuthorUserID,
			&r.ReplyCreatedAt, &r.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("reviews: list mine for user %s: %w", authorUserID, err)
		}
		reviews = append(reviews, r)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("reviews: list mine for user %s: %w", authorUserID, err)
	}

	if len(reviews) <= limit {
		return reviews, "", nil
	}
	next := encodeCursor(reviews[limit-1].CreatedAt, reviews[limit-1].ID)
	return reviews[:limit], next, nil
}

// ListReceived returns the reviews received by one target entity (e.g. the
// caller's own provider row), newest first, with keyset pagination over a
// base64 (created_at, id) cursor. The returned cursor is empty when no
// further page exists.
func (s *Store) ListReceived(ctx context.Context, targetType string, targetID uuid.UUID, limit int, cursor string) ([]Review, string, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	query := `SELECT ` + reviewColumns + ` FROM reviews WHERE target_type = $1 AND target_id = $2`
	args := []any{targetType, targetID}
	if cursor != "" {
		c, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("reviews: list received: invalid cursor: %w", err)
		}
		query += ` AND (created_at, id) < ($3, $4)`
		args = append(args, c.createdAt, c.id)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("reviews: list received for %s %s: %w", targetType, targetID, err)
	}
	defer rows.Close()

	reviews := make([]Review, 0, limit+1)
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.TargetType, &r.TargetID, &r.AuthorUserID, &r.OrderID, &r.BookingID,
			&r.Rating, &r.Body, &r.State, &r.HelpfulCount, &r.ReplyBody, &r.ReplyAuthorUserID,
			&r.ReplyCreatedAt, &r.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("reviews: list received for %s %s: %w", targetType, targetID, err)
		}
		reviews = append(reviews, r)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("reviews: list received for %s %s: %w", targetType, targetID, err)
	}

	if len(reviews) <= limit {
		return reviews, "", nil
	}
	next := encodeCursor(reviews[limit-1].CreatedAt, reviews[limit-1].ID)
	return reviews[:limit], next, nil
}

// AddReply attaches the single allowed reply to a review. It only succeeds on
// reviews in the published or pending state without an existing reply; a
// hidden/deleted or missing review yields ErrNotRepliable, and a review that
// already carries a reply yields ErrReplyExists.
func (s *Store) AddReply(ctx context.Context, reviewID, authorUserID uuid.UUID, body string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE reviews SET reply_body = $2, reply_author_user_id = $3, reply_created_at = now()
		 WHERE id = $1 AND state IN ('published', 'pending') AND reply_body IS NULL`,
		reviewID, body, authorUserID)
	if err != nil {
		return fmt.Errorf("reviews: add reply to %s: %w", reviewID, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}

	// Distinguish the failure: missing or non-repliable state vs existing reply.
	var replyBody *string
	err = s.pool.QueryRow(ctx, `SELECT reply_body FROM reviews WHERE id = $1`, reviewID).Scan(&replyBody)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("reviews: add reply to %s: %w", reviewID, ErrNotRepliable)
	}
	if err != nil {
		return fmt.Errorf("reviews: add reply to %s: %w", reviewID, err)
	}
	if replyBody != nil {
		return fmt.Errorf("reviews: add reply to %s: %w", reviewID, ErrReplyExists)
	}
	return fmt.Errorf("reviews: add reply to %s: %w", reviewID, ErrNotRepliable)
}

// BumpHelpful increments the helpful vote count of a published review.
// Non-published or missing reviews yield ErrNotEligible.
func (s *Store) BumpHelpful(ctx context.Context, reviewID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE reviews SET helpful_count = helpful_count + 1
		 WHERE id = $1 AND state = 'published'`, reviewID)
	if err != nil {
		return fmt.Errorf("reviews: bump helpful on %s: %w", reviewID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("reviews: bump helpful on %s: %w", reviewID, ErrNotEligible)
	}
	return nil
}

// VoteHelpful records a helpful vote by a user on a published review. It
// inserts into review_helpful_votes with ON CONFLICT DO NOTHING; a duplicate
// yields ErrAlreadyVoted without incrementing, and a non-published or missing
// review yields ErrNotEligible.
func (s *Store) VoteHelpful(ctx context.Context, reviewID, userID uuid.UUID) error {
	// Pre-validate the review exists and is published so we return a clean
	// ErrNotEligible instead of a foreign-key violation on the vote insert
	// when the review is missing or unpublished.
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT true FROM reviews WHERE id = $1 AND state = 'published'`, reviewID,
	).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("reviews: vote helpful on %s: %w", reviewID, ErrNotEligible)
		}
		return fmt.Errorf("reviews: vote helpful lookup %s: %w", reviewID, err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("reviews: begin vote helpful tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Insert dedup row first; ON CONFLICT DO NOTHING detects duplicate.
	tag, err := tx.Exec(ctx,
		`INSERT INTO review_helpful_votes (review_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		reviewID, userID)
	if err != nil {
		return fmt.Errorf("reviews: vote helpful insert %s: %w", reviewID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("reviews: vote helpful on %s: %w", reviewID, ErrAlreadyVoted)
	}

	tag, err = tx.Exec(ctx,
		`UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = $1 AND state = 'published'`,
		reviewID)
	if err != nil {
		return fmt.Errorf("reviews: vote helpful bump %s: %w", reviewID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("reviews: vote helpful on %s: %w", reviewID, ErrNotEligible)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("reviews: commit vote helpful %s: %w", reviewID, err)
	}
	return nil
}

// RecomputeRating updates merchants/providers/riders rating and review_count
// from the average of published reviews for the target. Target types other
// than merchant/provider/rider are no-ops.
func (s *Store) RecomputeRating(ctx context.Context, targetType string, targetID uuid.UUID) error {
	var avg *float64
	var cnt int
	if err := s.pool.QueryRow(ctx,
		`SELECT AVG(rating)::float8, COUNT(*) FROM reviews WHERE target_type = $1 AND target_id = $2 AND state = 'published'`,
		targetType, targetID).Scan(&avg, &cnt); err != nil {
		return fmt.Errorf("reviews: recompute rating avg for %s %s: %w", targetType, targetID, err)
	}
	switch targetType {
	case "merchant":
		if _, err := s.pool.Exec(ctx, `UPDATE merchants SET rating = $1, review_count = $2, updated_at = now() WHERE id = $3`, avg, cnt, targetID); err != nil {
			return fmt.Errorf("reviews: recompute merchant %s: %w", targetID, err)
		}
	case "provider":
		if _, err := s.pool.Exec(ctx, `UPDATE providers SET rating = $1, review_count = $2, updated_at = now() WHERE id = $3`, avg, cnt, targetID); err != nil {
			return fmt.Errorf("reviews: recompute provider %s: %w", targetID, err)
		}
	case "rider":
		if _, err := s.pool.Exec(ctx, `UPDATE riders SET rating = $1, review_count = $2, updated_at = now() WHERE id = $3`, avg, cnt, targetID); err != nil {
			return fmt.Errorf("reviews: recompute rider %s: %w", targetID, err)
		}
	default:
		return nil
	}
	return nil
}

// SetState transitions a review between moderation states (pending,
// published, hidden, deleted). Only rows still in a mutable state move;
// a missing or already-deleted review yields ErrNotFound. The caller is
// responsible for enforcing the moderation state machine: the guard only
// prevents writes racing a concurrent moderation from clobbering a
// terminal state.
func (s *Store) SetState(ctx context.Context, reviewID uuid.UUID, state string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE reviews SET state = $2 WHERE id = $1 AND state IN ('pending', 'published', 'hidden')`,
		reviewID, state)
	if err != nil {
		return fmt.Errorf("reviews: set state on %s: %w", reviewID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("reviews: set state on %s: %w", reviewID, ErrNotFound)
	}
	return nil
}

// Report inserts a moderation report for the review. Duplicate reports by the
// same reporter are ignored (ON CONFLICT DO NOTHING).
func (s *Store) Report(ctx context.Context, reviewID, reporterID uuid.UUID, reason string) error {
	// Pre-validate the review exists so we return a clean ErrNotFound instead
	// of a foreign-key violation on the report insert for a missing review.
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT true FROM reviews WHERE id = $1`, reviewID,
	).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("reviews: report %s: %w", reviewID, ErrNotFound)
		}
		return fmt.Errorf("reviews: report lookup %s: %w", reviewID, err)
	}

	if _, err := s.pool.Exec(ctx,
		`INSERT INTO review_reports (review_id, reporter_user_id, reason)
		 VALUES ($1, $2, $3)
		 ON CONFLICT DO NOTHING`, reviewID, reporterID, reason); err != nil {
		return fmt.Errorf("reviews: report %s: %w", reviewID, err)
	}
	return nil
}

// UpdateBody applies the author's edits (rating and/or body) to their own
// review. Only pending or published reviews are editable; a missing review,
// one owned by a different author or one in a moderated (hidden/deleted)
// state yields ErrNotFound. The handler distinguishes those cases via Get.
func (s *Store) UpdateBody(ctx context.Context, reviewID, authorUserID uuid.UUID, rating *int, body *string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE reviews SET rating = COALESCE($2, rating), body = COALESCE($3, body)
		 WHERE id = $1 AND author_user_id = $4 AND state IN ('pending', 'published')`,
		reviewID, rating, body, authorUserID)
	if err != nil {
		return fmt.Errorf("reviews: update body on %s: %w", reviewID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("reviews: update body on %s: %w", reviewID, ErrNotFound)
	}
	return nil
}

// Delete soft-deletes the author's own review: the row stays for moderation
// history with state 'deleted' and the body replaced by a deletion marker.
// Only pending or published reviews are deletable; a missing review, one
// owned by a different author or one in a moderated (hidden/deleted) state
// yields ErrNotFound. The handler distinguishes those cases via Get. The
// reason argument is informational (the contract DELETE carries no body,
// so callers pass the deletion marker) and is not persisted.
func (s *Store) Delete(ctx context.Context, reviewID, authorUserID uuid.UUID, reason string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE reviews SET state = 'deleted', body = 'deleted by author'
		 WHERE id = $1 AND author_user_id = $2 AND state IN ('pending', 'published')`,
		reviewID, authorUserID)
	if err != nil {
		return fmt.Errorf("reviews: delete %s: %w", reviewID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("reviews: delete %s: %w", reviewID, ErrNotFound)
	}
	return nil
}

// GetReport returns the report filed by the reporter on the review, or
// (nil, nil) when the reporter never reported that review.
func (s *Store) GetReport(ctx context.Context, reviewID, reporterID uuid.UUID) (*Report, error) {
	var r Report
	err := s.pool.QueryRow(ctx,
		`SELECT id, review_id, reporter_user_id, reason, state, created_at
		 FROM review_reports WHERE review_id = $1 AND reporter_user_id = $2
		 ORDER BY created_at DESC LIMIT 1`, reviewID, reporterID).
		Scan(&r.ID, &r.ReviewID, &r.ReporterUserID, &r.Reason, &r.State, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reviews: get report on %s: %w", reviewID, err)
	}
	return &r, nil
}

// cursor is a keyset pagination position: (created_at, id).
type cursor struct {
	createdAt time.Time
	id        uuid.UUID
}

// encodeCursor serializes a pagination position as base64 "createdAt|id".
func encodeCursor(t time.Time, id uuid.UUID) string {
	raw := t.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.StdEncoding.EncodeToString([]byte(raw))
}

// parseCursor decodes a cursor produced by encodeCursor.
func parseCursor(s string) (cursor, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return cursor{}, fmt.Errorf("decode: %w", err)
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return cursor{}, errors.New("malformed cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return cursor{}, fmt.Errorf("parse time: %w", err)
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return cursor{}, fmt.Errorf("parse id: %w", err)
	}
	return cursor{createdAt: t, id: id}, nil
}
