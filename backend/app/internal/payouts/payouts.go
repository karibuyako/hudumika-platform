// Package payouts is the bounded context for the immutable earnings ledger
// and payout batches (backend/DATA-MODEL.md "Payouts (immutable ledger)",
// backend/PAYOUTS-LEDGER.md). Platform rule: every money movement appends a
// ledger entry; the wallet is a projection of the ledger, never a second
// source of truth; money is int64 TZS minor units only, no floats; ledger
// rows are never updated or deleted — corrections are new adjustment
// entries.
package payouts

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrInvalidCursor is returned by ListPayouts when the keyset cursor does
// not decode to a (created_at, id) pair.
var ErrInvalidCursor = errors.New("invalid pagination cursor")

// LedgerEntryInput is the shape of one append-only ledger entry. AmountTZS
// is signed: negative is a debit (payout, commission, refund).
type LedgerEntryInput struct {
	AccountOwnerID uuid.UUID
	AccountType    string
	Type           string
	AmountTZS      int64
	ReferenceType  string
	ReferenceID    uuid.UUID
	IdempotencyKey string
}

// LedgerEntryRow is one ledger_entries row.
type LedgerEntryRow struct {
	ID            uuid.UUID
	AccountOwner  uuid.UUID
	AccountType   string
	Type          string
	AmountTZS     int64
	BalanceTZS    int64
	ReferenceType *string
	ReferenceID   *uuid.UUID
	CreatedAt     time.Time
}

// PayoutRow is one payout_entries row.
type PayoutRow struct {
	ID         uuid.UUID
	OwnerID    uuid.UUID
	AmountTZS  int64
	Method     string
	Status     string
	GatewayRef *string
	CreatedAt  time.Time
	PaidAt     *time.Time
}

// Store wraps the connection pool for all payouts persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// EarnerType maps an auth role to the ledger account_type. Roles outside
// merchant/provider/rider (customer, admin, finance, ...) have no earner
// account and map to "".
func (s *Store) EarnerType(ctx context.Context, role string) string {
	switch role {
	case "merchant", "provider", "rider":
		return role
	default:
		return ""
	}
}

// AppendEntry appends one immutable ledger entry with the running balance
// computed inside the transaction. Appends for one owner are serialized by a
// per-owner advisory transaction lock, so the balance is exact under
// concurrency. A duplicate idempotency_key is a replay of a previously
// applied entry: nothing is written and applied=false is returned with no
// error.
func (s *Store) AppendEntry(ctx context.Context, e LedgerEntryInput) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("payouts: begin append entry tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize every append for the owner; the lock lives for the
	// transaction and is released on commit or rollback.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, e.AccountOwnerID.String()); err != nil {
		return false, fmt.Errorf("payouts: lock owner %s: %w", e.AccountOwnerID, err)
	}

	var balance int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(balance_tzs), 0) FROM ledger_entries WHERE account_owner_id = $1`,
		e.AccountOwnerID).Scan(&balance); err != nil {
		return false, fmt.Errorf("payouts: read balance for %s: %w", e.AccountOwnerID, err)
	}
	balance += e.AmountTZS

	var refType any
	if e.ReferenceType != "" {
		refType = e.ReferenceType
	}
	var refID any
	if e.ReferenceID != uuid.Nil {
		refID = e.ReferenceID
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO ledger_entries (account_owner_id, account_type, type, amount_tzs, balance_tzs, reference_type, reference_id, idempotency_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		e.AccountOwnerID, e.AccountType, e.Type, e.AmountTZS, balance, refType, refID, e.IdempotencyKey); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return false, nil
		}
		return false, fmt.Errorf("payouts: append entry for %s: %w", e.AccountOwnerID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("payouts: commit append entry for %s: %w", e.AccountOwnerID, err)
	}
	return true, nil
}

// Statement returns the ledger statement for ownerID over [from, to):
// opening is the running balance of the last entry before from (0 when the
// owner has no earlier entries), closing is the balance of the last entry in
// the window (or the opening balance when the window is empty), and entries
// are the window's rows ordered by (created_at, id) ascending.
func (s *Store) Statement(ctx context.Context, ownerID uuid.UUID, from, to time.Time) (opening, closing int64, entries []LedgerEntryRow, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT balance_tzs FROM ledger_entries
		 WHERE account_owner_id = $1 AND created_at < $2
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		ownerID, from).Scan(&opening)
	if errors.Is(err, pgx.ErrNoRows) {
		opening = 0
	} else if err != nil {
		return 0, 0, nil, fmt.Errorf("payouts: opening balance for %s: %w", ownerID, err)
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, account_owner_id, account_type, type, amount_tzs, balance_tzs, reference_type, reference_id, created_at
		 FROM ledger_entries
		 WHERE account_owner_id = $1 AND created_at >= $2 AND created_at < $3
		 ORDER BY created_at, id`,
		ownerID, from, to)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("payouts: statement entries for %s: %w", ownerID, err)
	}
	defer rows.Close()

	entries = make([]LedgerEntryRow, 0)
	for rows.Next() {
		var e LedgerEntryRow
		if err := rows.Scan(&e.ID, &e.AccountOwner, &e.AccountType, &e.Type,
			&e.AmountTZS, &e.BalanceTZS, &e.ReferenceType, &e.ReferenceID, &e.CreatedAt); err != nil {
			return 0, 0, nil, fmt.Errorf("payouts: scan statement entry: %w", err)
		}
		entries = append(entries, e)
		closing = e.BalanceTZS
	}
	if err := rows.Err(); err != nil {
		return 0, 0, nil, fmt.Errorf("payouts: iterate statement entries: %w", err)
	}
	if len(entries) == 0 {
		closing = opening
	}
	return opening, closing, entries, nil
}

// ListPayouts returns the owner's payout entries, newest first, keyset-
// paginated on (created_at, id) with a base64 cursor. limit is exclusive of
// the sentinel row; next is the cursor of the last returned row when another
// page exists, else "". A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListPayouts(ctx context.Context, ownerID uuid.UUID, limit int, cursor string) ([]PayoutRow, string, error) {
	query := `SELECT id, owner_id, amount_tzs, method, status, gateway_reference, created_at, paid_at
	          FROM payout_entries WHERE owner_id = $1`
	args := []any{ownerID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("payouts: list payouts: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) < ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("payouts: list payouts: %w", err)
	}
	defer rows.Close()

	out := make([]PayoutRow, 0, limit)
	var (
		last     PayoutRow
		sentinel bool
	)
	for rows.Next() {
		var p PayoutRow
		if err := rows.Scan(&p.ID, &p.OwnerID, &p.AmountTZS, &p.Method, &p.Status,
			&p.GatewayRef, &p.CreatedAt, &p.PaidAt); err != nil {
			return nil, "", fmt.Errorf("payouts: scan payout row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, p)
		last = p
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("payouts: iterate payout rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// CreateBatch creates a payout batch for the given cycle date (YYYY-MM-DD)
// and returns its id. The cycle is unique: a second batch for the same day
// surfaces as a unique violation.
func (s *Store) CreateBatch(ctx context.Context, cycle string) (uuid.UUID, error) {
	var id uuid.UUID
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO payout_batches (cycle) VALUES ($1) RETURNING id`, cycle).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("payouts: create batch for cycle %q: %w", cycle, err)
	}
	return id, nil
}

// AddToBatch appends one payout entry to a batch and bumps the batch totals
// in the same transaction (used by wallet withdrawals). amountTZS is the
// positive cash-out amount.
func (s *Store) AddToBatch(ctx context.Context, batchID uuid.UUID, ownerID uuid.UUID, amountTZS int64, method string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("payouts: begin add to batch tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`INSERT INTO payout_entries (batch_id, owner_id, amount_tzs, method) VALUES ($1, $2, $3, $4)`,
		batchID, ownerID, amountTZS, method); err != nil {
		return fmt.Errorf("payouts: add entry to batch %s: %w", batchID, err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE payout_batches SET total_tzs = total_tzs + $2, count = count + 1 WHERE id = $1`,
		batchID, amountTZS); err != nil {
		return fmt.Errorf("payouts: bump batch %s totals: %w", batchID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("payouts: commit add to batch %s: %w", batchID, err)
	}
	return nil
}

// encodeCursor packs a row's (created_at, id) keyset into a URL-safe base64
// string; parseCursor is its inverse.
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor id: %w", err)
	}
	return createdAt, id, nil
}
