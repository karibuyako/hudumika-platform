// Package payments is the bounded context for payment intents and
// transactions (backend/PAYMENTS.md, backend/DATA-MODEL.md "Payments").
// Intent lifecycle: created -> pending -> paid -> refunded /
// partially_refunded (or -> failed). Signed provider webhooks are the ONLY
// trusted state change; client callbacks never move money state.
package payments

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotRefundable is returned by ApplyRefund when the intent is not paid or
// the refund amount exceeds the paid total (0 rows matched by the guard).
var ErrNotRefundable = errors.New("payments: intent not refundable")

// IntentRow is one payment_intents row.
type IntentRow struct {
	ID                uuid.UUID
	OrderID           *uuid.UUID
	BookingID         *uuid.UUID
	Method            string
	AmountTZS         int64
	Status            string
	ProviderReference *string
	IdempotencyKey    string
	PaidAt            *time.Time
	Refunds           json.RawMessage
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// PaymentTransaction is one append-only payment_transactions row: a provider
// call or webhook with the raw payload and verification result. IntentID is
// nil when the payload could not be resolved to an intent.
type PaymentTransaction struct {
	IntentID *uuid.UUID
	Provider string
	Action   string
	Status   string
	Payload  []byte
}

// Store wraps the connection pool for all payments persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// intentColumns is the full payment_intents projection used by every row
// reader.
const intentColumns = `id, order_id, booking_id, method, amount_tzs, status, provider_reference, idempotency_key, paid_at, refunds, created_at, updated_at`

func scanIntent(row pgx.Row) (IntentRow, error) {
	var i IntentRow
	err := row.Scan(&i.ID, &i.OrderID, &i.BookingID, &i.Method, &i.AmountTZS, &i.Status,
		&i.ProviderReference, &i.IdempotencyKey, &i.PaidAt, &i.Refunds, &i.CreatedAt, &i.UpdatedAt)
	if err != nil {
		return IntentRow{}, err
	}
	return i, nil
}

// CreateIntent inserts an intent in status 'created' and returns the row.
// The idempotency middleware replays duplicate Idempotency-Key headers
// before the handler runs, so a unique violation on idempotency_key here is
// a programming error and is surfaced as-is.
func (s *Store) CreateIntent(ctx context.Context, orderID uuid.UUID, method string, amountTZS int64, idemKey string) (IntentRow, error) {
	row, err := scanIntent(s.pool.QueryRow(ctx,
		`INSERT INTO payment_intents (order_id, method, amount_tzs, idempotency_key)
		 VALUES ($1, $2, $3, $4)
		 RETURNING `+intentColumns,
		orderID, method, amountTZS, idemKey))
	if err != nil {
		return IntentRow{}, fmt.Errorf("payments: create intent: %w", err)
	}
	return row, nil
}

// GetIntent returns the intent for id, or (nil, nil) when absent.
func (s *Store) GetIntent(ctx context.Context, id uuid.UUID) (*IntentRow, error) {
	row, err := scanIntent(s.pool.QueryRow(ctx,
		`SELECT `+intentColumns+` FROM payment_intents WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("payments: get intent %s: %w", id, err)
	}
	return &row, nil
}

// FindIntentByProviderReference returns the intent carrying the provider's
// transaction reference, or (nil, nil) when none does.
func (s *Store) FindIntentByProviderReference(ctx context.Context, ref string) (*IntentRow, error) {
	row, err := scanIntent(s.pool.QueryRow(ctx,
		`SELECT `+intentColumns+` FROM payment_intents WHERE provider_reference = $1 ORDER BY created_at DESC LIMIT 1`, ref))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("payments: find intent by reference %q: %w", ref, err)
	}
	return &row, nil
}

// FindIntentByOrderID returns the most recent intent for an order, or
// (nil, nil) when the order has none.
func (s *Store) FindIntentByOrderID(ctx context.Context, orderID uuid.UUID) (*IntentRow, error) {
	row, err := scanIntent(s.pool.QueryRow(ctx,
		`SELECT `+intentColumns+` FROM payment_intents WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, orderID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("payments: find intent by order %s: %w", orderID, err)
	}
	return &row, nil
}

// SetStatus performs the guarded transition from -> to and returns the
// number of rows changed (0 when the intent is not in state `from`).
func (s *Store) SetStatus(ctx context.Context, id uuid.UUID, from, to string) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE payment_intents SET status = $3, updated_at = now()
		 WHERE id = $1 AND status = $2`, id, from, to)
	if err != nil {
		return 0, fmt.Errorf("payments: set status %s -> %s for %s: %w", from, to, id, err)
	}
	return tag.RowsAffected(), nil
}

// MarkPaid marks a created/pending intent paid (guarded: paid/failed/
// refunded intents never change). It returns the number of rows changed, so
// callers can treat a second webhook delivery as an idempotent replay.
func (s *Store) MarkPaid(ctx context.Context, intentID uuid.UUID) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE payment_intents SET status = 'paid', paid_at = now(), updated_at = now()
		 WHERE id = $1 AND status IN ('created', 'pending')`, intentID)
	if err != nil {
		return 0, fmt.Errorf("payments: mark paid %s: %w", intentID, err)
	}
	return tag.RowsAffected(), nil
}

// MarkFailed marks a created/pending intent failed and appends the reason to
// the transaction log. Returns the number of rows changed.
func (s *Store) MarkFailed(ctx context.Context, id uuid.UUID, reason string) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE payment_intents SET status = 'failed', updated_at = now()
		 WHERE id = $1 AND status IN ('created', 'pending')`, id)
	if err != nil {
		return 0, fmt.Errorf("payments: mark failed %s: %w", id, err)
	}
	if tag.RowsAffected() > 0 {
		payload, err := json.Marshal(map[string]string{"reason": reason})
		if err != nil {
			return tag.RowsAffected(), fmt.Errorf("payments: mark failed %s: %w", id, err)
		}
		if err := s.LogTransaction(ctx, PaymentTransaction{
			IntentID: &id, Provider: "webhook", Action: "mark_failed", Status: "failed", Payload: payload,
		}); err != nil {
			return tag.RowsAffected(), err
		}
	}
	return tag.RowsAffected(), nil
}

// ApplyRefund performs the single guarded refund UPDATE: a paid intent whose
// amount_tzs covers the refund becomes 'refunded' (full) or
// 'partially_refunded', and the refund is appended to the refunds jsonb
// array. It returns the new status, or ErrNotRefundable when the guard
// matched nothing (not found, not paid, or refund exceeds the amount).
func (s *Store) ApplyRefund(ctx context.Context, intentID uuid.UUID, amountTZS int64, reason string) (string, error) {
	var status string
	err := s.pool.QueryRow(ctx,
		`UPDATE payment_intents
		 SET status = CASE
		         WHEN amount_tzs = $2 THEN 'refunded'
		         WHEN amount_tzs > $2 THEN 'partially_refunded'
		         ELSE status
		     END,
		     refunds = refunds || jsonb_build_array(jsonb_build_object('amount', $2, 'reason', $3::text, 'at', now())),
		     updated_at = now()
		 WHERE id = $1 AND status = 'paid' AND amount_tzs >= $2
		 RETURNING status`, intentID, amountTZS, reason).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("payments: apply refund %s: %w", intentID, ErrNotRefundable)
	}
	if err != nil {
		return "", fmt.Errorf("payments: apply refund %s: %w", intentID, err)
	}
	return status, nil
}

// LogTransaction appends one row to payment_transactions. Append-only by
// construction: the table has no UPDATE or DELETE path.
func (s *Store) LogTransaction(ctx context.Context, tx PaymentTransaction) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO payment_transactions (intent_id, provider, action, status, payload)
		 VALUES ($1, $2, $3, $4, $5)`,
		tx.IntentID, tx.Provider, tx.Action, tx.Status, tx.Payload)
	if err != nil {
		return fmt.Errorf("payments: log transaction: %w", err)
	}
	return nil
}

// SetProviderReference records the provider's transaction reference on the
// intent so later webhooks can resolve it directly.
func (s *Store) SetProviderReference(ctx context.Context, id uuid.UUID, ref string) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE payment_intents SET provider_reference = $2, updated_at = now() WHERE id = $1`, id, ref); err != nil {
		return fmt.Errorf("payments: set provider reference %s: %w", id, err)
	}
	return nil
}

// RecordCheckoutRequestID persists the Daraja CheckoutRequestID returned by
// the STK invoke as the intent's provider_reference so the callback resolves
// it directly (notifications.CheckoutRecorder seam, bound in main.go).
func (s *Store) RecordCheckoutRequestID(ctx context.Context, intentID, checkoutRequestID string) error {
	id, err := uuid.Parse(intentID)
	if err != nil {
		return fmt.Errorf("payments: record checkout request id: %w", err)
	}
	return s.SetProviderReference(ctx, id, checkoutRequestID)
}

// GetOrderTotal returns the server-computed total of the order owned by
// customerUserID, and false when no such order exists. The amount a payment
// intent charges always comes from here, never from the client.
func (s *Store) GetOrderTotal(ctx context.Context, orderID, customerUserID uuid.UUID) (int64, bool, error) {
	var total int64
	err := s.pool.QueryRow(ctx,
		`SELECT total_tzs FROM orders WHERE id = $1 AND customer_user_id = $2`, orderID, customerUserID).Scan(&total)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("payments: get order total %s: %w", orderID, err)
	}
	return total, true, nil
}

// OrderCustomerUserID returns the owner of the order, or (nil, nil) when the
// order does not exist.
func (s *Store) OrderCustomerUserID(ctx context.Context, orderID uuid.UUID) (*uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT customer_user_id FROM orders WHERE id = $1`, orderID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("payments: order customer %s: %w", orderID, err)
	}
	return &id, nil
}

// UpdateOrderToPaid moves a draft/pending_payment order to 'paid'. The order
// row may not exist yet when a webhook races the order insert; that is
// logged by the caller and is not fatal.
func (s *Store) UpdateOrderToPaid(ctx context.Context, orderID uuid.UUID) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE orders SET status = 'paid', updated_at = now()
		 WHERE id = $1 AND status IN ('draft', 'pending_payment')`, orderID); err != nil {
		return fmt.Errorf("payments: update order %s to paid: %w", orderID, err)
	}
	return nil
}

// CreateWalletIntent inserts an order-less intent (order_id NULL) in status
// 'created' and returns the row. This is the intent path for wallet top-ups
// and quick customer payment requests, which have no order. As with
// CreateIntent, the idempotency middleware replays duplicate
// Idempotency-Key headers before the handler runs, so a unique violation on
// idempotency_key here is a programming error surfaced as-is.
func (s *Store) CreateWalletIntent(ctx context.Context, method string, amountTZS int64, idemKey string) (IntentRow, error) {
	row, err := scanIntent(s.pool.QueryRow(ctx,
		`INSERT INTO payment_intents (order_id, method, amount_tzs, idempotency_key)
		 VALUES (NULL, $1, $2, $3)
		 RETURNING `+intentColumns,
		method, amountTZS, idemKey))
	if err != nil {
		return IntentRow{}, fmt.Errorf("payments: create wallet intent: %w", err)
	}
	return row, nil
}

// ReverseIntent fails a pending intent (guarded: only status 'pending'
// transitions) and returns the number of rows changed. A zero result means
// the intent is absent or no longer pending — the caller maps it to the
// state-conflict error.
func (s *Store) ReverseIntent(ctx context.Context, id uuid.UUID) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE payment_intents SET status = 'failed', updated_at = now()
		 WHERE id = $1 AND status = 'pending'`, id)
	if err != nil {
		return 0, fmt.Errorf("payments: reverse intent %s: %w", id, err)
	}
	return tag.RowsAffected(), nil
}

// ErrInvalidCursor is returned by ListMyIntents when the keyset cursor does
// not decode to a payment_intents id; the handler maps it to 422
// VALIDATION_FAILED.
var ErrInvalidCursor = errors.New("payments: invalid pagination cursor")

// encodePaymentCursor packs an intent id into a URL-safe base64 cursor;
// decodePaymentCursor is its inverse. The wire format matches the wallet
// ledger cursor.
func encodePaymentCursor(id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id.String()))
}

func decodePaymentCursor(cursor string) (uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return uuid.Nil, fmt.Errorf("payments: decode cursor: %w", err)
	}
	id, err := uuid.Parse(string(raw))
	if err != nil {
		return uuid.Nil, fmt.Errorf("payments: parse cursor id: %w", err)
	}
	return id, nil
}

// ListMyIntents returns the order-linked intents owned by customerUserID,
// newest first, keyset-paginated on (created_at, id). next is the cursor of
// the following page, or "" when this is the last page. A malformed cursor
// yields ErrInvalidCursor.
//
// LIMITATION (documented, this milestone): payment_intents has no customer
// column, so intents are scoped through their order only
// (`i.order_id IN (SELECT id FROM orders WHERE customer_user_id = $1)`).
// Order-less wallet top-up intents carry no owner linkage and are NOT listed
// here; the wallet handler responds with the intent directly so clients
// never need history to reconcile a top-up.
func (s *Store) ListMyIntents(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]IntentRow, string, error) {
	query := `SELECT ` + intentColumns + ` FROM payment_intents i
	          WHERE i.order_id IN (SELECT id FROM orders WHERE customer_user_id = $1)`
	args := []any{userID}
	if cursor != "" {
		id, err := decodePaymentCursor(cursor)
		if err != nil {
			return nil, "", err
		}
		args = append(args, id)
		query += ` AND (i.created_at, i.id) < (SELECT created_at, id FROM payment_intents WHERE id = $2)`
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY i.created_at DESC, i.id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("payments: list intents for %s: %w", userID, err)
	}
	defer rows.Close()

	out := make([]IntentRow, 0, limit)
	var (
		last     IntentRow
		sentinel bool
	)
	for rows.Next() {
		i, err := scanIntent(rows)
		if err != nil {
			return nil, "", fmt.Errorf("payments: scan intent: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, i)
		last = i
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("payments: iterate intents: %w", err)
	}
	next := ""
	if sentinel {
		next = encodePaymentCursor(last.ID)
	}
	return out, next, nil
}
