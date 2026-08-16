package bookings

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// BOOKINGS-EXTRA sentinel errors (ERROR-CODES.md: bookings). The quote flow
// surfaces QUOTE_NOT_ALLOWED (booking status gate), QUOTE_ALREADY_ISSUED and
// QUOTE_DECLINED; the proof-of-service flow surfaces
// PROOF_OF_SERVICE_INVALID and PROOF_OF_SERVICE_ALREADY_SUBMITTED. A missing
// row reuses the package ErrNotFound and a lost race ErrConflict.
var (
	ErrQuoteNotAllowed       = errors.New("quote not allowed for this booking state")
	ErrQuoteAlreadyIssued    = errors.New("quote already issued")
	ErrQuoteDeclined         = errors.New("quote was already declined")
	ErrProofInvalid          = errors.New("proof of service invalid")
	ErrProofAlreadySubmitted = errors.New("proof of service already submitted")
)

// QuotePart is one line item of a provider quote. The per-part total is
// always recomputed server-side (quantity × unit cost); clients never supply
// money (backend/README.md).
type QuotePart struct {
	Name        string
	Quantity    int
	UnitCostTZS int64
	TotalTZS    int64
}

// Estimate computes an upfront price estimate for a service: the server-side
// hourly rate (services.price_tzs) times the number of whole hours the job
// takes, rounded up (ceil(durationMinutes/60)). A missing or inactive
// service yields ErrNotFound (ESTIMATE_UNAVAILABLE at the API).
func (s *Store) Estimate(ctx context.Context, serviceID uuid.UUID, durationMinutes int) (int64, error) {
	var price int64
	err := s.pool.QueryRow(ctx,
		`SELECT price_tzs FROM services WHERE id = $1 AND active`, serviceID).Scan(&price)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("bookings: estimate service %s: %w", serviceID, ErrNotFound)
	}
	if err != nil {
		return 0, fmt.Errorf("bookings: estimate service %s: %w", serviceID, err)
	}
	hours := int64(durationMinutes) / 60
	if durationMinutes%60 != 0 {
		hours++
	}
	if hours < 1 {
		hours = 1
	}
	return price * hours, nil
}

// CreateQuote persists a provider's final quote and its parts in one
// transaction. The booking must exist and be in a quoteable state
// (provider_requested, provider_accepted, scheduled) — any other state
// yields ErrQuoteNotAllowed — and must not already carry a pending or
// accepted quote (ErrQuoteAlreadyIssued). The total is server-side: the
// caller has already verified the parts reconcile with the amount.
func (s *Store) CreateQuote(ctx context.Context, bookingID, providerUserID uuid.UUID, amountTZS int64, validUntil time.Time, parts []QuotePart) (uuid.UUID, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("bookings: begin create quote tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM bookings WHERE id = $1 FOR UPDATE`, bookingID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("bookings: create quote: booking %s: %w", bookingID, ErrNotFound)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("bookings: create quote: load booking %s: %w", bookingID, err)
	}
	switch status {
	case "provider_requested", "provider_accepted", "scheduled":
	default:
		return uuid.Nil, fmt.Errorf("bookings: create quote: booking %s in state %q: %w", bookingID, status, ErrQuoteNotAllowed)
	}

	var existing uuid.UUID
	err = tx.QueryRow(ctx,
		`SELECT id FROM booking_quotes WHERE booking_id = $1 AND status IN ('pending', 'accepted') LIMIT 1`,
		bookingID).Scan(&existing)
	if err == nil {
		return uuid.Nil, fmt.Errorf("bookings: create quote: booking %s already has a quote: %w", bookingID, ErrQuoteAlreadyIssued)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("bookings: create quote: check existing quote for %s: %w", bookingID, err)
	}

	var validUntilArg any
	if !validUntil.IsZero() {
		validUntilArg = validUntil
	}
	var quoteID uuid.UUID
	err = tx.QueryRow(ctx,
		`INSERT INTO booking_quotes (booking_id, provider_id, amount_tzs, valid_until)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		bookingID, providerUserID, amountTZS, validUntilArg).Scan(&quoteID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("bookings: insert quote for %s: %w", bookingID, err)
	}

	for _, p := range parts {
		if _, err := tx.Exec(ctx,
			`INSERT INTO booking_parts (quote_id, name, quantity, unit_cost_tzs, total_tzs)
			 VALUES ($1, $2, $3, $4, $5)`,
			quoteID, p.Name, p.Quantity, p.UnitCostTZS, p.TotalTZS); err != nil {
			return uuid.Nil, fmt.Errorf("bookings: insert quote part %q: %w", p.Name, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("bookings: commit create quote for %s: %w", bookingID, err)
	}
	return quoteID, nil
}

// GetQuoteForBooking returns the most recent quote id for a booking;
// ErrNotFound when the booking has none (the decision endpoint answers the
// same 404 as a missing booking).
func (s *Store) GetQuoteForBooking(ctx context.Context, bookingID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM booking_quotes WHERE booking_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
		bookingID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("bookings: quote for booking %s: %w", bookingID, ErrNotFound)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("bookings: quote for booking %s: %w", bookingID, err)
	}
	return id, nil
}

// DecideQuote accepts or declines a pending quote in one transaction and
// returns the booking id so the caller can reload the booking for the
// response. An already-declined quote yields ErrQuoteDeclined; any other
// already-decided state yields ErrConflict. Accepting the quote also moves
// the booking from provider_requested to provider_accepted via the guarded
// versioned update (losing the race yields ErrConflict) and appends the
// event.
func (s *Store) DecideQuote(ctx context.Context, quoteID uuid.UUID, accept bool) (uuid.UUID, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("bookings: begin decide quote tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		bookingID uuid.UUID
		status    string
	)
	err = tx.QueryRow(ctx,
		`SELECT booking_id, status FROM booking_quotes WHERE id = $1 FOR UPDATE`, quoteID).
		Scan(&bookingID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("bookings: decide quote %s: %w", quoteID, ErrNotFound)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("bookings: decide quote %s: load quote: %w", quoteID, err)
	}
	if status == "declined" {
		return uuid.Nil, fmt.Errorf("bookings: decide quote %s: %w", quoteID, ErrQuoteDeclined)
	}
	if status != "pending" {
		return uuid.Nil, fmt.Errorf("bookings: decide quote %s in state %q: %w", quoteID, status, ErrConflict)
	}

	next := "declined"
	if accept {
		next = "accepted"
		tag, err := tx.Exec(ctx,
			`UPDATE bookings SET status = 'provider_accepted', version = version + 1, updated_at = now()
			 WHERE id = $1 AND status = 'provider_requested'`, bookingID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("bookings: decide quote %s: transition booking %s: %w", quoteID, bookingID, err)
		}
		if tag.RowsAffected() == 0 {
			return uuid.Nil, fmt.Errorf("bookings: decide quote %s: transition booking %s: %w", quoteID, bookingID, ErrConflict)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO booking_events (booking_id, status) VALUES ($1, 'provider_accepted')`, bookingID); err != nil {
			return uuid.Nil, fmt.Errorf("bookings: decide quote %s: append event: %w", quoteID, err)
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE booking_quotes SET status = $1, updated_at = now() WHERE id = $2`, next, quoteID); err != nil {
		return uuid.Nil, fmt.Errorf("bookings: decide quote %s: mark %s: %w", quoteID, next, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("bookings: commit decide quote %s: %w", quoteID, err)
	}
	return bookingID, nil
}

// SubmitProof stores the provider's proof-of-service capture for a booking.
// The booking must be mid-job or done (provider_arrived, in_progress,
// awaiting_customer_confirmation, completed) — any other state yields
// ErrProofInvalid — and must not already have a proof row
// (ErrProofAlreadySubmitted). When otpCode is non-empty only its SHA-256
// hash is stored; the plaintext never touches the database.
func (s *Store) SubmitProof(ctx context.Context, bookingID, submitterUserID uuid.UUID, mediaURL, note, otpCode string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("bookings: begin submit proof tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM bookings WHERE id = $1 FOR UPDATE`, bookingID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("bookings: submit proof: booking %s: %w", bookingID, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("bookings: submit proof: load booking %s: %w", bookingID, err)
	}
	switch status {
	case "provider_arrived", "in_progress", "awaiting_customer_confirmation", "completed":
	default:
		return fmt.Errorf("bookings: submit proof: booking %s in state %q: %w", bookingID, status, ErrProofInvalid)
	}

	var existing uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM proof_of_service WHERE booking_id = $1`, bookingID).Scan(&existing)
	if err == nil {
		return fmt.Errorf("bookings: submit proof: booking %s already has proof: %w", bookingID, ErrProofAlreadySubmitted)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("bookings: submit proof: check existing proof for %s: %w", bookingID, err)
	}

	var (
		mediaArg any
		noteArg  any
		otpArg   any
	)
	if mediaURL != "" {
		mediaArg = mediaURL
	}
	if note != "" {
		noteArg = note
	}
	if otpCode != "" {
		otpArg = otpSHA256(otpCode)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO proof_of_service (booking_id, submitted_by, media_url, note, otp_code_hash)
		 VALUES ($1, $2, $3, $4, $5)`,
		bookingID, submitterUserID, mediaArg, noteArg, otpArg); err != nil {
		return fmt.Errorf("bookings: insert proof for %s: %w", bookingID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("bookings: commit submit proof for %s: %w", bookingID, err)
	}
	return nil
}

// VerifyProof checks a customer OTP against the proof row's stored hash in
// constant time. Success marks the proof verified; a mismatch marks it
// failed and yields ErrProofInvalid, as does a booking with no proof row or
// no stored OTP.
func (s *Store) VerifyProof(ctx context.Context, bookingID uuid.UUID, otpCode string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("bookings: begin verify proof tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var stored *string
	err = tx.QueryRow(ctx,
		`SELECT otp_code_hash FROM proof_of_service WHERE booking_id = $1 FOR UPDATE`, bookingID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("bookings: verify proof: booking %s: %w", bookingID, ErrProofInvalid)
	}
	if err != nil {
		return fmt.Errorf("bookings: verify proof: load proof for %s: %w", bookingID, err)
	}
	if stored == nil {
		return fmt.Errorf("bookings: verify proof: booking %s has no otp: %w", bookingID, ErrProofInvalid)
	}

	want, err := hex.DecodeString(*stored)
	if err != nil {
		return fmt.Errorf("bookings: verify proof: decode hash for %s: %w", bookingID, err)
	}
	got := sha256.Sum256([]byte(otpCode))
	if subtle.ConstantTimeCompare(got[:], want) != 1 {
		if _, err := tx.Exec(ctx,
			`UPDATE proof_of_service SET status = 'failed' WHERE booking_id = $1`, bookingID); err != nil {
			return fmt.Errorf("bookings: verify proof: mark failed for %s: %w", bookingID, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("bookings: commit verify proof failure for %s: %w", bookingID, err)
		}
		return fmt.Errorf("bookings: verify proof: booking %s: %w", bookingID, ErrProofInvalid)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE proof_of_service SET status = 'verified' WHERE booking_id = $1`, bookingID); err != nil {
		return fmt.Errorf("bookings: verify proof: mark verified for %s: %w", bookingID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("bookings: commit verify proof for %s: %w", bookingID, err)
	}
	return nil
}

// otpSHA256 hashes a plaintext OTP code to its hex SHA-256 (the pattern
// shared with the auth context). The plaintext is never logged or stored.
func otpSHA256(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}
