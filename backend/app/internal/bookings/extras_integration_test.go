//go:build integration

// BOOKINGS-EXTRA integration tests against real PostgreSQL (migration
// 00036_booking_extra.sql). Run via `go test -tags integration
// ./internal/bookings/ -count=1` after `go run ./cmd/migrate -up`.
//
// This suite truncates only its own tables (booking_quotes, booking_parts,
// proof_of_service) plus the bookings/booking_events rows the shared
// bookings setup owns; services rows use the shared 'IT Booking %' prefix
// and users rows carry this suite's phone prefix so setup deletes them.
package bookings

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// extrasPhonePrefix identifies every users row this suite inserts.
const extrasPhonePrefix = "+255933"

// newExtraTestPool wraps the shared bookings setup and truncates the
// BOOKINGS-EXTRA tables this suite owns plus its own users rows.
func newExtraTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := newTestPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`TRUNCATE booking_parts, booking_quotes, proof_of_service`); err != nil {
		t.Fatalf("truncate booking extras tables: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM users WHERE phone LIKE '`+extrasPhonePrefix+`%'`); err != nil {
		t.Fatalf("delete extra test users: %v", err)
	}
	return pool
}

// extraCustomer inserts a users row with this suite's phone prefix and
// returns its id.
func extraCustomer(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("%s%09d", extrasPhonePrefix, time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'Bookings Extra IT Customer') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert extra customer: %v", err)
	}
	return id
}

// advance moves a booking through a guarded transition and returns the
// refreshed row.
func advance(t *testing.T, st *Store, row BookingRow, actor uuid.UUID, from []string, to string) BookingRow {
	t.Helper()
	version, err := st.TransitionBooking(context.Background(), row.ID, row.Version, from, to, actor, "")
	if err != nil {
		t.Fatalf("advance booking to %s: %v", to, err)
	}
	row.Status = to
	row.Version = version
	return row
}

// quoteBooking creates a booking and moves it to provider_requested (the
// state quotes start from).
func quoteBooking(t *testing.T, st *Store, customer, provider, service uuid.UUID, key string) BookingRow {
	t.Helper()
	row := createBooking(t, st, customer, provider, service, key)
	return advance(t, st, row, provider, []string{"draft", "pending_payment", "paid"}, "provider_requested")
}

// TestEstimateMath verifies the estimate is the hourly rate times the whole
// hours rounded up: 25000 TZS/hr × ceil(90/60) = 50000, while a partial
// hour still bills one hour. An unknown or inactive service yields
// ErrNotFound (ESTIMATE_UNAVAILABLE at the API).
func TestEstimateMath(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	st := NewStore(pool)

	svc := setupService(t, pool, "IT Booking Extra Estimate", 25000)

	got, err := st.Estimate(ctx, svc, 90)
	if err != nil {
		t.Fatalf("estimate 90min: %v", err)
	}
	if got != 50000 {
		t.Fatalf("estimate 90min = %d, want 50000", got)
	}

	got, err = st.Estimate(ctx, svc, 60)
	if err != nil {
		t.Fatalf("estimate 60min: %v", err)
	}
	if got != 25000 {
		t.Fatalf("estimate 60min = %d, want 25000", got)
	}

	got, err = st.Estimate(ctx, svc, 30)
	if err != nil {
		t.Fatalf("estimate 30min: %v", err)
	}
	if got != 25000 {
		t.Fatalf("estimate 30min = %d, want 25000 (partial hour bills one hour)", got)
	}

	if _, err := st.Estimate(ctx, uuid.New(), 60); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown service error = %v, want ErrNotFound", err)
	}

	offline := setupService(t, pool, "IT Booking Extra Offline", 1000)
	if _, err := pool.Exec(ctx, `UPDATE services SET active = false WHERE id = $1`, offline); err != nil {
		t.Fatalf("deactivate service: %v", err)
	}
	if _, err := st.Estimate(ctx, offline, 60); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inactive service error = %v, want ErrNotFound", err)
	}
}

// TestCreateQuoteComputesTotal verifies the quote persists with the
// server-side total and its parts reconcile with it: labor 10000 + trip
// 2000 + parts (2 × 2500) = amount 17000, and the stored parts rows carry
// the server-computed per-part total.
func TestCreateQuoteComputesTotal(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra Quote", 10000)
	st := NewStore(pool)

	row := quoteBooking(t, st, customer, provider, service, "it-extra-quote-1")
	quoteID, err := st.CreateQuote(ctx, row.ID, provider, 17000, time.Now().Add(48*time.Hour), []QuotePart{
		{Name: "Fuse", Quantity: 2, UnitCostTZS: 2500, TotalTZS: 5000},
	})
	if err != nil {
		t.Fatalf("create quote: %v", err)
	}

	var (
		amount int64
		status string
	)
	if err := pool.QueryRow(ctx,
		`SELECT amount_tzs, status FROM booking_quotes WHERE id = $1`, quoteID).
		Scan(&amount, &status); err != nil {
		t.Fatalf("load quote: %v", err)
	}
	if amount != 17000 || status != "pending" {
		t.Fatalf("quote = %d/%s, want 17000/pending", amount, status)
	}

	var partsSum int64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(total_tzs), 0) FROM booking_parts WHERE quote_id = $1`, quoteID).
		Scan(&partsSum); err != nil {
		t.Fatalf("sum parts: %v", err)
	}
	if partsSum != 5000 {
		t.Fatalf("parts sum = %d, want 5000", partsSum)
	}
	var (
		qty  int
		unit int64
	)
	if err := pool.QueryRow(ctx,
		`SELECT quantity, unit_cost_tzs FROM booking_parts WHERE quote_id = $1`, quoteID).
		Scan(&qty, &unit); err != nil {
		t.Fatalf("load part: %v", err)
	}
	if qty != 2 || unit != 2500 {
		t.Fatalf("part = %d × %d, want 2 × 2500", qty, unit)
	}
}

// TestCreateQuoteTwiceRejected verifies a second quote on a booking that
// already has a pending quote yields ErrQuoteAlreadyIssued
// (QUOTE_ALREADY_ISSUED).
func TestCreateQuoteTwiceRejected(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra Quote2", 10000)
	st := NewStore(pool)

	row := quoteBooking(t, st, customer, provider, service, "it-extra-quote-2")
	if _, err := st.CreateQuote(ctx, row.ID, provider, 15000, time.Time{}, nil); err != nil {
		t.Fatalf("first quote: %v", err)
	}
	if _, err := st.CreateQuote(ctx, row.ID, provider, 16000, time.Time{}, nil); !errors.Is(err, ErrQuoteAlreadyIssued) {
		t.Fatalf("second quote error = %v, want ErrQuoteAlreadyIssued", err)
	}
}

// TestCreateQuoteWrongStatusRejected verifies a quote on a booking outside
// the quoteable states yields ErrQuoteNotAllowed (QUOTE_NOT_ALLOWED).
func TestCreateQuoteWrongStatusRejected(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra Quote3", 10000)
	st := NewStore(pool)

	row := createBooking(t, st, customer, provider, service, "it-extra-quote-3")
	if _, err := st.CreateQuote(ctx, row.ID, provider, 15000, time.Time{}, nil); !errors.Is(err, ErrQuoteNotAllowed) {
		t.Fatalf("quote on draft booking error = %v, want ErrQuoteNotAllowed", err)
	}
}

// TestDecideQuoteAcceptTransitionsBooking verifies accepting a pending
// quote returns the booking id and moves the booking from
// provider_requested to provider_accepted (version bumped).
func TestDecideQuoteAcceptTransitionsBooking(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra DecideA", 10000)
	st := NewStore(pool)

	row := quoteBooking(t, st, customer, provider, service, "it-extra-decide-1")
	quoteID, err := st.CreateQuote(ctx, row.ID, provider, 17000, time.Time{}, nil)
	if err != nil {
		t.Fatalf("create quote: %v", err)
	}

	bookingID, err := st.DecideQuote(ctx, quoteID, true)
	if err != nil {
		t.Fatalf("accept quote: %v", err)
	}
	if bookingID != row.ID {
		t.Fatalf("booking id = %s, want %s", bookingID, row.ID)
	}

	got, err := st.GetBookingRow(ctx, row.ID)
	if err != nil {
		t.Fatalf("reload booking: %v", err)
	}
	if got.Status != "provider_accepted" {
		t.Fatalf("booking status = %s, want provider_accepted", got.Status)
	}
	if got.Version != row.Version+1 {
		t.Fatalf("booking version = %d, want %d", got.Version, row.Version+1)
	}

	var quoteStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM booking_quotes WHERE id = $1`, quoteID).Scan(&quoteStatus); err != nil {
		t.Fatalf("load quote status: %v", err)
	}
	if quoteStatus != "accepted" {
		t.Fatalf("quote status = %s, want accepted", quoteStatus)
	}
}

// TestDecideQuoteDeclineThenReDecide verifies declining leaves the booking
// untouched and a second decision on the declined quote yields
// ErrQuoteDeclined (QUOTE_DECLINED).
func TestDecideQuoteDeclineThenReDecide(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra DecideD", 10000)
	st := NewStore(pool)

	row := quoteBooking(t, st, customer, provider, service, "it-extra-decide-2")
	quoteID, err := st.CreateQuote(ctx, row.ID, provider, 17000, time.Time{}, nil)
	if err != nil {
		t.Fatalf("create quote: %v", err)
	}

	bookingID, err := st.DecideQuote(ctx, quoteID, false)
	if err != nil {
		t.Fatalf("decline quote: %v", err)
	}
	if bookingID != row.ID {
		t.Fatalf("booking id = %s, want %s", bookingID, row.ID)
	}
	got, err := st.GetBookingRow(ctx, row.ID)
	if err != nil {
		t.Fatalf("reload booking: %v", err)
	}
	if got.Status != "provider_requested" {
		t.Fatalf("booking status = %s, want provider_requested (decline does not move the booking)", got.Status)
	}

	if _, err := st.DecideQuote(ctx, quoteID, true); !errors.Is(err, ErrQuoteDeclined) {
		t.Fatalf("re-decide declined quote error = %v, want ErrQuoteDeclined", err)
	}
}

// TestSubmitProofAndDuplicateRejected verifies a proof submission succeeds
// on a mid-job booking and a second submission for the same booking yields
// ErrProofAlreadySubmitted (PROOF_OF_SERVICE_ALREADY_SUBMITTED).
func TestSubmitProofAndDuplicateRejected(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra Proof", 8000)
	st := NewStore(pool)

	row := createBooking(t, st, customer, provider, service, "it-extra-proof-1")
	row = advance(t, st, row, provider, []string{"draft", "pending_payment", "paid"}, "provider_requested")
	row = advance(t, st, row, provider, []string{"provider_requested"}, "provider_accepted")
	row = advance(t, st, row, provider, []string{"provider_accepted"}, "scheduled")
	row = advance(t, st, row, provider, []string{"scheduled"}, "provider_arrived")

	if err := st.SubmitProof(ctx, row.ID, provider, "https://cdn.example.com/proof.jpg", "", ""); err != nil {
		t.Fatalf("submit proof: %v", err)
	}
	if err := st.SubmitProof(ctx, row.ID, provider, "https://cdn.example.com/proof2.jpg", "", ""); !errors.Is(err, ErrProofAlreadySubmitted) {
		t.Fatalf("duplicate proof error = %v, want ErrProofAlreadySubmitted", err)
	}
}

// TestSubmitProofWrongStatusRejected verifies a proof submission on a
// booking that is not mid-job or done yields ErrProofInvalid
// (PROOF_OF_SERVICE_INVALID).
func TestSubmitProofWrongStatusRejected(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra Proof2", 8000)
	st := NewStore(pool)

	row := createBooking(t, st, customer, provider, service, "it-extra-proof-2")
	if err := st.SubmitProof(ctx, row.ID, provider, "https://cdn.example.com/proof.jpg", "", ""); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("proof on draft booking error = %v, want ErrProofInvalid", err)
	}
}

// TestOTPVerifyRoundtrip verifies the OTP hash roundtrip: a proof
// submitted with a server-generated code verifies with the right code
// (status verified), a wrong code marks the proof failed and yields
// ErrProofInvalid, and a booking without a proof row (or without an OTP)
// never verifies.
func TestOTPVerifyRoundtrip(t *testing.T) {
	pool := newExtraTestPool(t)
	ctx := context.Background()
	customer := extraCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Extra OTP", 8000)
	st := NewStore(pool)

	arrived := func(key string) BookingRow {
		row := createBooking(t, st, customer, provider, service, key)
		row = advance(t, st, row, provider, []string{"draft", "pending_payment", "paid"}, "provider_requested")
		row = advance(t, st, row, provider, []string{"provider_requested"}, "provider_accepted")
		row = advance(t, st, row, provider, []string{"provider_accepted"}, "scheduled")
		return advance(t, st, row, provider, []string{"scheduled"}, "provider_arrived")
	}

	// Wrong code marks the proof failed and yields ErrProofInvalid.
	row := arrived("it-extra-otp-1")
	if err := st.SubmitProof(ctx, row.ID, provider, "", "", "123456"); err != nil {
		t.Fatalf("submit otp proof: %v", err)
	}
	if err := st.VerifyProof(ctx, row.ID, "654321"); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("wrong otp error = %v, want ErrProofInvalid", err)
	}
	var failedStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM proof_of_service WHERE booking_id = $1`, row.ID).Scan(&failedStatus); err != nil {
		t.Fatalf("load failed proof status: %v", err)
	}
	if failedStatus != "failed" {
		t.Fatalf("proof status after wrong otp = %s, want failed", failedStatus)
	}

	// The correct code still verifies and marks the proof verified.
	if err := st.VerifyProof(ctx, row.ID, "123456"); err != nil {
		t.Fatalf("verify correct otp: %v", err)
	}
	var verifiedStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM proof_of_service WHERE booking_id = $1`, row.ID).Scan(&verifiedStatus); err != nil {
		t.Fatalf("load verified proof status: %v", err)
	}
	if verifiedStatus != "verified" {
		t.Fatalf("proof status after correct otp = %s, want verified", verifiedStatus)
	}

	// A photo proof has no OTP to verify against.
	photo := arrived("it-extra-otp-2")
	if err := st.SubmitProof(ctx, photo.ID, provider, "https://cdn.example.com/p.jpg", "", ""); err != nil {
		t.Fatalf("submit photo proof: %v", err)
	}
	if err := st.VerifyProof(ctx, photo.ID, "123456"); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("verify photo proof error = %v, want ErrProofInvalid", err)
	}

	// A booking without a proof row never verifies.
	none := arrived("it-extra-otp-3")
	if err := st.VerifyProof(ctx, none.ID, "123456"); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("verify missing proof error = %v, want ErrProofInvalid", err)
	}
}
