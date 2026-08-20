// Package loyalty is the bounded context for merchant-operated membership
// programs: members with a prepaid TZS balance, configurable tiers and
// top-up rewards, and an append-only per-member transaction ledger.
// Balances live on the member row and every ledger entry carries the
// running balance after the entry (backend/PAYOUTS-LEDGER.md ledger
// pattern); top-ups are serialized per member with a transactional
// advisory lock so concurrent top-ups never lose money.
package loyalty

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

// Sentinel errors surfaced to the API layer (ERROR-CODES.md "Loyalty").
var (
	ErrPhoneExists    = errors.New("loyalty member phone already registered")
	ErrMemberNotFound = errors.New("loyalty member not found")
	ErrTierNotFound   = errors.New("membership tier not found")
	ErrTierNameExists = errors.New("membership tier name already exists")
	ErrBelowThreshold = errors.New("top-up below the minimum threshold")
	ErrInvalidCursor  = errors.New("invalid pagination cursor")
)

// minTopUpTZS is the smallest amount a merchant may credit to a member
// balance (ERROR-CODES.md: TOP_UP_BELOW_THRESHOLD).
const minTopUpTZS int64 = 1000

// Store wraps the connection pool for all loyalty persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// MemberRow is one row of the loyalty_members table.
type MemberRow struct {
	ID             uuid.UUID
	MerchantID     uuid.UUID
	CustomerUserID *uuid.UUID
	Name           string
	Phone          string
	BalanceTZS     int64
	TierID         *uuid.UUID
	TotalSpendTZS  int64
	CreatedAt      time.Time
}

// TierRow is one row of the membership_tiers table.
type TierRow struct {
	ID           uuid.UUID
	MerchantID   uuid.UUID
	Name         string
	DiscountBps  int
	ThresholdTZS int64
	Perks        []byte
	CreatedAt    time.Time
}

// TransactionRow is one row of the append-only loyalty_transactions ledger.
type TransactionRow struct {
	ID         uuid.UUID
	MemberID   uuid.UUID
	Type       string
	AmountTZS  int64
	BalanceTZS int64
	CreatedAt  time.Time
}

// CustomerMembershipRow is one row of the platform-wide
// customer_memberships table (backend/DATA-MODEL.md: one row per user,
// user_id PK; there is no per-merchant scope on this table).
type CustomerMembershipRow struct {
	UserID      uuid.UUID
	Points      int
	Level       string
	MemberSince time.Time
}

// TopUpRewardRow is one row of the membership_top_up_rewards table.
type TopUpRewardRow struct {
	ID           uuid.UUID
	MerchantID   uuid.UUID
	ThresholdTZS int64
	BonusTZS     int64
}

// TopUpRewardInput is a threshold/bonus pair from the contract
// PutMembershipTiers body.
type TopUpRewardInput struct {
	ThresholdTZS int64
	BonusTZS     int64
}

const memberColumns = `id, merchant_id, customer_user_id, name, phone, balance_tzs,
	tier_id, total_spend_tzs, created_at`

// CreateMember registers a new member with a zero balance for the
// merchant. A duplicate (merchant_id, phone) yields ErrPhoneExists.
func (s *Store) CreateMember(ctx context.Context, merchantID uuid.UUID, phone, fullName string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`INSERT INTO loyalty_members (merchant_id, name, phone)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		merchantID, fullName, phone).Scan(&id)
	if isUniqueViolation(err, "loyalty_members_merchant_id_phone_key") {
		return uuid.Nil, fmt.Errorf("loyalty: create member for %s: %w", merchantID, ErrPhoneExists)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("loyalty: create member for %s: %w", merchantID, err)
	}
	return id, nil
}

// GetMember loads a single member; ErrMemberNotFound when absent.
func (s *Store) GetMember(ctx context.Context, memberID uuid.UUID) (MemberRow, error) {
	row, err := scanMemberRow(s.pool.QueryRow(ctx,
		`SELECT `+memberColumns+` FROM loyalty_members WHERE id = $1`, memberID))
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberRow{}, fmt.Errorf("loyalty: get member %s: %w", memberID, ErrMemberNotFound)
	}
	if err != nil {
		return MemberRow{}, fmt.Errorf("loyalty: get member %s: %w", memberID, err)
	}
	return row, nil
}

// ListMembers returns a merchant's members, oldest first, cursor-paginated
// on (created_at, id). limit is exclusive of the sentinel row; next is the
// base64 cursor of the last returned row when another page exists, else "".
func (s *Store) ListMembers(ctx context.Context, merchantID uuid.UUID, limit int, cursor string) ([]MemberRow, string, error) {
	query := `SELECT ` + memberColumns + ` FROM loyalty_members WHERE merchant_id = $1`
	args := []any{merchantID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("loyalty: list members: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("loyalty: list members: %w", err)
	}
	defer rows.Close()

	out := make([]MemberRow, 0, limit)
	var (
		last     MemberRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanMemberRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("loyalty: scan member row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("loyalty: iterate member rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// UpdateMember renames a member; ErrMemberNotFound when absent.
func (s *Store) UpdateMember(ctx context.Context, memberID uuid.UUID, fullName string) (MemberRow, error) {
	row, err := scanMemberRow(s.pool.QueryRow(ctx,
		`UPDATE loyalty_members SET name = $2 WHERE id = $1
		 RETURNING `+memberColumns,
		memberID, fullName))
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberRow{}, fmt.Errorf("loyalty: update member %s: %w", memberID, ErrMemberNotFound)
	}
	if err != nil {
		return MemberRow{}, fmt.Errorf("loyalty: update member %s: %w", memberID, err)
	}
	return row, nil
}

// TopUp credits a member balance and appends the top_up ledger entry in ONE
// transaction. A per-member advisory lock serializes concurrent top-ups so
// the running balance is exact. An amount below minTopUpTZS yields
// ErrBelowThreshold; a missing member yields ErrMemberNotFound.
func (s *Store) TopUp(ctx context.Context, memberID uuid.UUID, amountTZS int64) (int64, error) {
	if amountTZS < minTopUpTZS {
		return 0, fmt.Errorf("loyalty: top up %s by %d: %w", memberID, amountTZS, ErrBelowThreshold)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("loyalty: begin top-up tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize every top-up for the member; the lock lives for the
	// transaction and is released on commit or rollback (same pattern as
	// payouts.Store.AppendEntry).
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext('member:'||$1))`, memberID.String()); err != nil {
		return 0, fmt.Errorf("loyalty: lock member %s: %w", memberID, err)
	}

	var balance int64
	err = tx.QueryRow(ctx,
		`SELECT balance_tzs FROM loyalty_members WHERE id = $1 FOR UPDATE`, memberID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("loyalty: top up %s: %w", memberID, ErrMemberNotFound)
	}
	if err != nil {
		return 0, fmt.Errorf("loyalty: read balance for %s: %w", memberID, err)
	}

	newBalance := balance + amountTZS
	if _, err := tx.Exec(ctx,
		`INSERT INTO loyalty_transactions (member_id, type, amount_tzs, balance_tzs)
		 VALUES ($1, 'top_up', $2, $3)`,
		memberID, amountTZS, newBalance); err != nil {
		return 0, fmt.Errorf("loyalty: append top-up for %s: %w", memberID, err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE loyalty_members SET balance_tzs = $2 WHERE id = $1`,
		memberID, newBalance); err != nil {
		return 0, fmt.Errorf("loyalty: update balance for %s: %w", memberID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("loyalty: commit top-up for %s: %w", memberID, err)
	}
	return newBalance, nil
}

// ListTransactions returns one member's ledger, newest first, cursor-
// paginated on (created_at, id). A malformed cursor yields
// ErrInvalidCursor.
func (s *Store) ListTransactions(ctx context.Context, memberID uuid.UUID, limit int, cursor string) ([]TransactionRow, string, error) {
	return s.listTransactionsQuery(ctx,
		`SELECT id, member_id, type, amount_tzs, balance_tzs, created_at
		 FROM loyalty_transactions WHERE member_id = $1`,
		[]any{memberID}, limit, cursor)
}

// ListMerchantTransactions returns the ledger of every member belonging to
// the merchant, newest first, cursor-paginated on (created_at, id). It
// backs the contract GET /loyalty-transactions (merchant surface).
func (s *Store) ListMerchantTransactions(ctx context.Context, merchantID uuid.UUID, limit int, cursor string) ([]TransactionRow, string, error) {
	return s.listTransactionsQuery(ctx,
		`SELECT lt.id, lt.member_id, lt.type, lt.amount_tzs, lt.balance_tzs, lt.created_at
		 FROM loyalty_transactions lt
		 JOIN loyalty_members lm ON lm.id = lt.member_id
		 WHERE lm.merchant_id = $1`,
		[]any{merchantID}, limit, cursor)
}

func (s *Store) listTransactionsQuery(ctx context.Context, baseQuery string, baseArgs []any, limit int, cursor string) ([]TransactionRow, string, error) {
	query := baseQuery
	args := append([]any{}, baseArgs...)
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("loyalty: list transactions: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) < ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("loyalty: list transactions: %w", err)
	}
	defer rows.Close()

	out := make([]TransactionRow, 0, limit)
	var (
		last     TransactionRow
		sentinel bool
	)
	for rows.Next() {
		var row TransactionRow
		if err := rows.Scan(&row.ID, &row.MemberID, &row.Type, &row.AmountTZS, &row.BalanceTZS, &row.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("loyalty: scan transaction row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("loyalty: iterate transaction rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// CreateTier creates a tier for the merchant; thresholdTZS is the minimum
// member balance the tier requires. A duplicate (merchant_id, name) yields
// ErrTierNameExists.
func (s *Store) CreateTier(ctx context.Context, merchantID uuid.UUID, name string, thresholdTZS int64, discountBps int, perks string) (TierRow, error) {
	if perks == "" {
		perks = "[]"
	}
	row, err := scanTierRow(s.pool.QueryRow(ctx,
		`INSERT INTO membership_tiers (merchant_id, name, threshold_tzs, discount_bps, perks)
		 VALUES ($1, $2, $3, $4, $5::jsonb)
		 RETURNING id, merchant_id, name, discount_bps, threshold_tzs, perks, created_at`,
		merchantID, name, thresholdTZS, discountBps, perks))
	if isUniqueViolation(err, "membership_tiers_merchant_id_name_key") {
		return TierRow{}, fmt.Errorf("loyalty: create tier %q for %s: %w", name, merchantID, ErrTierNameExists)
	}
	if err != nil {
		return TierRow{}, fmt.Errorf("loyalty: create tier %q for %s: %w", name, merchantID, err)
	}
	return row, nil
}

// ListTiers returns the merchant's tiers ordered by ascending threshold.
func (s *Store) ListTiers(ctx context.Context, merchantID uuid.UUID) ([]TierRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, merchant_id, name, discount_bps, threshold_tzs, perks, created_at
		 FROM membership_tiers WHERE merchant_id = $1
		 ORDER BY threshold_tzs ASC, name ASC`, merchantID)
	if err != nil {
		return nil, fmt.Errorf("loyalty: list tiers for %s: %w", merchantID, err)
	}
	defer rows.Close()

	out := make([]TierRow, 0, 8)
	for rows.Next() {
		row, err := scanTierRow(rows)
		if err != nil {
			return nil, fmt.Errorf("loyalty: scan tier row: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("loyalty: iterate tier rows: %w", err)
	}
	return out, nil
}

// GetTier loads a single tier; ErrTierNotFound when absent.
func (s *Store) GetTier(ctx context.Context, tierID uuid.UUID) (TierRow, error) {
	row, err := scanTierRow(s.pool.QueryRow(ctx,
		`SELECT id, merchant_id, name, discount_bps, threshold_tzs, perks, created_at
		 FROM membership_tiers WHERE id = $1`, tierID))
	if errors.Is(err, pgx.ErrNoRows) {
		return TierRow{}, fmt.Errorf("loyalty: get tier %s: %w", tierID, ErrTierNotFound)
	}
	if err != nil {
		return TierRow{}, fmt.Errorf("loyalty: get tier %s: %w", tierID, err)
	}
	return row, nil
}

// UpdateTier patches a tier's configuration; ErrTierNotFound when absent.
// A duplicate (merchant_id, name) yields ErrTierNameExists.
func (s *Store) UpdateTier(ctx context.Context, tierID uuid.UUID, name string, discountBps int, thresholdTZS int64, perks string) (TierRow, error) {
	row, err := scanTierRow(s.pool.QueryRow(ctx,
		`UPDATE membership_tiers
		 SET name = $2, discount_bps = $3, threshold_tzs = $4, perks = $5::jsonb
		 WHERE id = $1
		 RETURNING id, merchant_id, name, discount_bps, threshold_tzs, perks, created_at`,
		tierID, name, discountBps, thresholdTZS, perks))
	if isUniqueViolation(err, "membership_tiers_merchant_id_name_key") {
		return TierRow{}, fmt.Errorf("loyalty: update tier %s: %w", tierID, ErrTierNameExists)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return TierRow{}, fmt.Errorf("loyalty: update tier %s: %w", tierID, ErrTierNotFound)
	}
	if err != nil {
		return TierRow{}, fmt.Errorf("loyalty: update tier %s: %w", tierID, err)
	}
	return row, nil
}

// ReplaceTopUpRewards swaps the merchant's threshold/bonus reward table for
// the given pairs (contract PutMembershipTiers.topUpRewards).
func (s *Store) ReplaceTopUpRewards(ctx context.Context, merchantID uuid.UUID, rewards []TopUpRewardInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("loyalty: begin rewards tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`DELETE FROM membership_top_up_rewards WHERE merchant_id = $1`, merchantID); err != nil {
		return fmt.Errorf("loyalty: clear rewards for %s: %w", merchantID, err)
	}
	for _, r := range rewards {
		if _, err := tx.Exec(ctx,
			`INSERT INTO membership_top_up_rewards (merchant_id, threshold_tzs, bonus_tzs)
			 VALUES ($1, $2, $3)`,
			merchantID, r.ThresholdTZS, r.BonusTZS); err != nil {
			return fmt.Errorf("loyalty: insert reward %d for %s: %w", r.ThresholdTZS, merchantID, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("loyalty: commit rewards for %s: %w", merchantID, err)
	}
	return nil
}

// GetMyMemberships returns the platform-wide customer membership rows of a
// user (backend/DATA-MODEL.md: customer_memberships is keyed by user_id, so
// a user has at most one row; merchant names cannot be joined because the
// table has no per-merchant scope). At most one row is ever returned; the
// cursor parameters keep the surface uniform with the other list methods.
func (s *Store) GetMyMemberships(ctx context.Context, customerUserID uuid.UUID, limit int, cursor string) ([]CustomerMembershipRow, string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT user_id, points, level, member_since
		 FROM customer_memberships WHERE user_id = $1
		 ORDER BY member_since DESC, user_id DESC
		 LIMIT $2`,
		customerUserID, limit)
	if err != nil {
		return nil, "", fmt.Errorf("loyalty: get memberships for %s: %w", customerUserID, err)
	}
	defer rows.Close()

	out := make([]CustomerMembershipRow, 0, 1)
	for rows.Next() {
		var row CustomerMembershipRow
		if err := rows.Scan(&row.UserID, &row.Points, &row.Level, &row.MemberSince); err != nil {
			return nil, "", fmt.Errorf("loyalty: scan membership row: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("loyalty: iterate membership rows: %w", err)
	}
	return out, "", nil
}

// UpsertCustomerMembership sets the user's platform-wide points balance
// (customer_memberships is keyed by user_id only). The merchant and tier
// arguments exist for call-site compatibility with the loyalty program
// surface; the documented table carries no per-merchant scope, so they are
// not persisted.
func (s *Store) UpsertCustomerMembership(ctx context.Context, customerUserID, merchantID, tierID uuid.UUID, points int) error {
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO customer_memberships (user_id, points)
		 VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE SET points = EXCLUDED.points`,
		customerUserID, points); err != nil {
		return fmt.Errorf("loyalty: upsert membership for %s: %w", customerUserID, err)
	}
	return nil
}

// isUniqueViolation reports whether err is a unique-violation PgError on
// the named constraint.
func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return constraint == "" || pgErr.ConstraintName == constraint
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanMemberRow(s rowScanner) (MemberRow, error) {
	var row MemberRow
	err := s.Scan(&row.ID, &row.MerchantID, &row.CustomerUserID, &row.Name,
		&row.Phone, &row.BalanceTZS, &row.TierID, &row.TotalSpendTZS, &row.CreatedAt)
	if err != nil {
		return MemberRow{}, err
	}
	return row, nil
}

func scanTierRow(s rowScanner) (TierRow, error) {
	var row TierRow
	err := s.Scan(&row.ID, &row.MerchantID, &row.Name, &row.DiscountBps,
		&row.ThresholdTZS, &row.Perks, &row.CreatedAt)
	if err != nil {
		return TierRow{}, err
	}
	return row, nil
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
