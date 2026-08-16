// Package groupbuy is the bounded context for merchant group-buy deals and
// the vouchers they mint. Deals carry a capped quantity; a purchase is a
// guarded increment inside a transaction that also issues the voucher.
// Vouchers settle on redemption, never on purchase (backend/PAYMENTS.md).
package groupbuy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced to the API layer.
var (
	ErrNotFound         = errors.New("group buy deal not found")
	ErrStatusConflict   = errors.New("group buy status conflict")
	ErrInvalidExtend    = errors.New("group buy extension invalid")
	ErrEnded            = errors.New("group buy ended")
	ErrQuantityExceeded = errors.New("group buy quantity exceeded")
	ErrInvalidCode      = errors.New("voucher code not found")
	ErrAlreadyUsed      = errors.New("voucher already used")
	ErrExpired          = errors.New("voucher expired")
	ErrNotRedeemable    = errors.New("voucher not redeemable at this merchant")
	ErrInvalidCursor    = errors.New("invalid pagination cursor")
)

// maxExtend caps how far a single extension may push a live deal's end time
// (ERROR-CODES.md: GROUP_BUY_EXTEND_INVALID).
const maxExtend = 72 * time.Hour

// Store wraps the connection pool for all group buy persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// DealRow is one row of the group_buy_deals table.
type DealRow struct {
	ID               uuid.UUID
	MerchantID       uuid.UUID
	Title            string
	Description      *string
	OriginalPriceTZS int64
	DealPriceTZS     int64
	QuantityTotal    int
	QuantitySold     int
	StartAt          time.Time
	EndAt            time.Time
	Status           string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// VoucherRow is a vouchers row joined with its deal projection (title,
// price, merchant) so API responses need no second query.
type VoucherRow struct {
	ID           uuid.UUID
	DealID       uuid.UUID
	UserID       uuid.UUID
	Code         string
	Status       string
	ExpiresAt    time.Time
	RedeemedAt   *time.Time
	CreatedAt    time.Time
	DealTitle    string
	DealPriceTZS int64
	MerchantID   uuid.UUID
}

// VerificationRow is one row of the voucher_verifications log.
type VerificationRow struct {
	ID          uuid.UUID
	VoucherCode string
	MerchantID  uuid.UUID
	Action      string
	CreatedAt   time.Time
}

// CreateDealInput is the input shape for creating a group buy deal. The
// deal is created live (status 'active'); moderation lands with the admin
// milestone.
type CreateDealInput struct {
	MerchantID       uuid.UUID
	Title            string
	Description      *string
	OriginalPriceTZS int64
	DealPriceTZS     int64
	QuantityTotal    int
	StartAt          time.Time
	EndAt            time.Time
}

const dealColumns = `id, merchant_id, title, description, original_price_tzs, deal_price_tzs,
	quantity_total, quantity_sold, start_at, end_at, status, created_at, updated_at`

// CreateDeal inserts a live group buy deal for the merchant.
func (s *Store) CreateDeal(ctx context.Context, in CreateDealInput) (DealRow, error) {
	row, err := scanDealRow(s.pool.QueryRow(ctx,
		`INSERT INTO group_buy_deals (merchant_id, title, description, original_price_tzs,
			deal_price_tzs, quantity_total, start_at, end_at, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
		 RETURNING `+dealColumns,
		in.MerchantID, in.Title, in.Description, in.OriginalPriceTZS, in.DealPriceTZS,
		in.QuantityTotal, in.StartAt, in.EndAt))
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: create deal: %w", err)
	}
	return row, nil
}

// GetDeal loads a single deal; ErrNotFound when absent.
func (s *Store) GetDeal(ctx context.Context, dealID uuid.UUID) (DealRow, error) {
	row, err := scanDealRow(s.pool.QueryRow(ctx,
		`SELECT `+dealColumns+` FROM group_buy_deals WHERE id = $1`, dealID))
	if errors.Is(err, pgx.ErrNoRows) {
		return DealRow{}, fmt.Errorf("groupbuy: get deal %s: %w", dealID, ErrNotFound)
	}
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: get deal %s: %w", dealID, err)
	}
	return row, nil
}

// ListDeals returns deals in a given status, oldest first, cursor-paginated
// on (created_at, id). limit is exclusive of the sentinel row; next is the
// base64 cursor of the last returned row when another page exists, else "".
// A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListDeals(ctx context.Context, status string, limit int, cursor string) ([]DealRow, string, error) {
	query := `SELECT ` + dealColumns + ` FROM group_buy_deals WHERE status = $1`
	args := []any{status}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("groupbuy: list deals: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("groupbuy: list deals: %w", err)
	}
	defer rows.Close()

	out := make([]DealRow, 0, limit)
	var (
		last     DealRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanDealRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("groupbuy: scan deal row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("groupbuy: iterate deal rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// ExtendDeal pushes a live deal's end time forward. The deal must be active
// (ErrStatusConflict otherwise); the new end must be strictly later than the
// current end and no more than maxExtend beyond it (ErrInvalidExtend).
func (s *Store) ExtendDeal(ctx context.Context, dealID uuid.UUID, newEndAt time.Time) (DealRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: begin extend deal tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		status string
		endAt  time.Time
	)
	err = tx.QueryRow(ctx,
		`SELECT status, end_at FROM group_buy_deals WHERE id = $1 FOR UPDATE`, dealID).
		Scan(&status, &endAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DealRow{}, fmt.Errorf("groupbuy: extend deal %s: %w", dealID, ErrNotFound)
	}
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: lock deal %s: %w", dealID, err)
	}
	if status != "active" {
		return DealRow{}, fmt.Errorf("groupbuy: extend deal %s: %w", dealID, ErrStatusConflict)
	}
	if !newEndAt.After(endAt) || newEndAt.Sub(endAt) > maxExtend {
		return DealRow{}, fmt.Errorf("groupbuy: extend deal %s: %w", dealID, ErrInvalidExtend)
	}

	row, err := scanDealRow(tx.QueryRow(ctx,
		`UPDATE group_buy_deals SET end_at = $2, updated_at = now() WHERE id = $1 RETURNING `+dealColumns,
		dealID, newEndAt))
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: update deal %s: %w", dealID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: commit extend deal: %w", err)
	}
	return row, nil
}

// DelistDeal moves an active deal to delisted; a 0-row update (missing or
// non-active deal) yields ErrStatusConflict.
func (s *Store) DelistDeal(ctx context.Context, dealID uuid.UUID) (DealRow, error) {
	row, err := scanDealRow(s.pool.QueryRow(ctx,
		`UPDATE group_buy_deals SET status = 'delisted', updated_at = now()
		 WHERE id = $1 AND status = 'active' RETURNING `+dealColumns, dealID))
	if errors.Is(err, pgx.ErrNoRows) {
		return DealRow{}, fmt.Errorf("groupbuy: delist deal %s: %w", dealID, ErrStatusConflict)
	}
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: delist deal %s: %w", dealID, err)
	}
	return row, nil
}

// RelistDeal moves a delisted deal back to active, only while its sale
// window is still open; a 0-row update (missing, not delisted, or past
// end_at) yields ErrStatusConflict.
func (s *Store) RelistDeal(ctx context.Context, dealID uuid.UUID) (DealRow, error) {
	row, err := scanDealRow(s.pool.QueryRow(ctx,
		`UPDATE group_buy_deals SET status = 'active', updated_at = now()
		 WHERE id = $1 AND status = 'delisted' AND end_at > now() RETURNING `+dealColumns, dealID))
	if errors.Is(err, pgx.ErrNoRows) {
		return DealRow{}, fmt.Errorf("groupbuy: relist deal %s: %w", dealID, ErrStatusConflict)
	}
	if err != nil {
		return DealRow{}, fmt.Errorf("groupbuy: relist deal %s: %w", dealID, err)
	}
	return row, nil
}

// Purchase sells one unit of an active deal and mints the customer's voucher
// in a single transaction. The deal row is locked FOR UPDATE so concurrent
// purchases serialize on the quantity guard. A dead/expired deal yields
// ErrEnded, a sold-out deal ErrQuantityExceeded. The voucher expires with the
// deal's sale window (the schema has no independent validity window).
func (s *Store) Purchase(ctx context.Context, dealID, userID uuid.UUID) (VoucherRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: begin purchase tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		status     string
		endAt      time.Time
		sold, qty  int
		title      string
		priceTZS   int64
		merchantID uuid.UUID
	)
	err = tx.QueryRow(ctx,
		`SELECT status, end_at, quantity_sold, quantity_total, title, deal_price_tzs, merchant_id
		 FROM group_buy_deals WHERE id = $1 FOR UPDATE`, dealID).
		Scan(&status, &endAt, &sold, &qty, &title, &priceTZS, &merchantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return VoucherRow{}, fmt.Errorf("groupbuy: purchase deal %s: %w", dealID, ErrNotFound)
	}
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: lock deal %s: %w", dealID, err)
	}
	if status != "active" || !endAt.After(time.Now()) {
		return VoucherRow{}, fmt.Errorf("groupbuy: purchase deal %s: %w", dealID, ErrEnded)
	}
	if sold >= qty {
		return VoucherRow{}, fmt.Errorf("groupbuy: purchase deal %s: %w", dealID, ErrQuantityExceeded)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE group_buy_deals SET quantity_sold = quantity_sold + 1, updated_at = now()
		 WHERE id = $1`, dealID); err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: sell deal %s: %w", dealID, err)
	}

	code, err := newVoucherCode()
	if err != nil {
		return VoucherRow{}, err
	}
	var voucher VoucherRow
	err = tx.QueryRow(ctx,
		`INSERT INTO vouchers (deal_id, user_id, code, status, expires_at)
		 VALUES ($1, $2, $3, 'active', $4)
		 RETURNING id, deal_id, user_id, code, status, expires_at, redeemed_at, created_at`,
		dealID, userID, code, endAt).
		Scan(&voucher.ID, &voucher.DealID, &voucher.UserID, &voucher.Code, &voucher.Status,
			&voucher.ExpiresAt, &voucher.RedeemedAt, &voucher.CreatedAt)
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: insert voucher: %w", err)
	}
	voucher.DealTitle = title
	voucher.DealPriceTZS = priceTZS
	voucher.MerchantID = merchantID

	if err := tx.Commit(ctx); err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: commit purchase: %w", err)
	}
	return voucher, nil
}

// GetVoucherByCode loads a voucher with its deal projection; ErrInvalidCode
// when no voucher carries the code.
func (s *Store) GetVoucherByCode(ctx context.Context, code string) (VoucherRow, error) {
	row, err := scanVoucherRow(s.pool.QueryRow(ctx,
		`SELECT v.id, v.deal_id, v.user_id, v.code, v.status, v.expires_at, v.redeemed_at, v.created_at,
		        d.title, d.deal_price_tzs, d.merchant_id
		 FROM vouchers v JOIN group_buy_deals d ON d.id = v.deal_id
		 WHERE v.code = $1`, code))
	if errors.Is(err, pgx.ErrNoRows) {
		return VoucherRow{}, fmt.Errorf("groupbuy: get voucher %s: %w", code, ErrInvalidCode)
	}
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: get voucher %s: %w", code, err)
	}
	return row, nil
}

// ListMyVouchers returns a customer's vouchers, oldest first, cursor-
// paginated on (created_at, id).
func (s *Store) ListMyVouchers(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]VoucherRow, string, error) {
	query := `SELECT v.id, v.deal_id, v.user_id, v.code, v.status, v.expires_at, v.redeemed_at, v.created_at,
	                 d.title, d.deal_price_tzs, d.merchant_id
	          FROM vouchers v JOIN group_buy_deals d ON d.id = v.deal_id
	          WHERE v.user_id = $1`
	args := []any{userID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("groupbuy: list vouchers: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (v.created_at, v.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY v.created_at, v.id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("groupbuy: list vouchers: %w", err)
	}
	defer rows.Close()

	out := make([]VoucherRow, 0, limit)
	var (
		last     VoucherRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanVoucherRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("groupbuy: scan voucher row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("groupbuy: iterate voucher rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// VerifyVoucher checks a voucher for redemption without consuming it: it
// must exist (ErrInvalidCode), be unused (ErrAlreadyUsed), unexpired
// (ErrExpired) and belong to a deal run by the merchant (ErrNotRedeemable).
// Every successful check appends a voucher_verifications row.
func (s *Store) VerifyVoucher(ctx context.Context, code string, merchantID uuid.UUID) (VoucherRow, error) {
	row, err := s.GetVoucherByCode(ctx, code)
	if err != nil {
		return VoucherRow{}, err
	}
	switch row.Status {
	case "used":
		return VoucherRow{}, fmt.Errorf("groupbuy: verify voucher %s: %w", code, ErrAlreadyUsed)
	case "expired", "refunded":
		return VoucherRow{}, fmt.Errorf("groupbuy: verify voucher %s: %w", code, ErrExpired)
	}
	if !row.ExpiresAt.After(time.Now()) {
		return VoucherRow{}, fmt.Errorf("groupbuy: verify voucher %s: %w", code, ErrExpired)
	}
	if row.MerchantID != merchantID {
		return VoucherRow{}, fmt.Errorf("groupbuy: verify voucher %s at %s: %w", code, merchantID, ErrNotRedeemable)
	}
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO voucher_verifications (voucher_id, merchant_id, action) VALUES ($1, $2, 'verify')`,
		row.ID, merchantID); err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: log voucher verification %s: %w", code, err)
	}
	return row, nil
}

// RedeemVoucher consumes an active voucher (active -> used) and logs the
// redemption. A missing code yields ErrInvalidCode; anything that prevents
// the guarded update (already used, expired) yields ErrAlreadyUsed.
func (s *Store) RedeemVoucher(ctx context.Context, code string, merchantID uuid.UUID) (VoucherRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: begin redeem tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var voucherID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM vouchers WHERE code = $1 FOR UPDATE`, code).Scan(&voucherID)
	if errors.Is(err, pgx.ErrNoRows) {
		return VoucherRow{}, fmt.Errorf("groupbuy: redeem voucher %s: %w", code, ErrInvalidCode)
	}
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: lock voucher %s: %w", code, err)
	}
	tag, err := tx.Exec(ctx,
		`UPDATE vouchers SET status = 'used', redeemed_at = now() WHERE id = $1 AND status = 'active'`,
		voucherID)
	if err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: redeem voucher %s: %w", code, err)
	}
	if tag.RowsAffected() == 0 {
		return VoucherRow{}, fmt.Errorf("groupbuy: redeem voucher %s: %w", code, ErrAlreadyUsed)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO voucher_verifications (voucher_id, merchant_id, action) VALUES ($1, $2, 'redeem')`,
		voucherID, merchantID); err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: log voucher redemption %s: %w", code, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return VoucherRow{}, fmt.Errorf("groupbuy: commit redeem: %w", err)
	}
	return s.GetVoucherByCode(ctx, code)
}

// VerifyHistory returns a merchant's verification log, oldest first,
// cursor-paginated on (created_at, id).
func (s *Store) VerifyHistory(ctx context.Context, merchantID uuid.UUID, limit int, cursor string) ([]VerificationRow, string, error) {
	query := `SELECT vv.id, v.code, vv.merchant_id, vv.action, vv.created_at
	          FROM voucher_verifications vv JOIN vouchers v ON v.id = vv.voucher_id
	          WHERE vv.merchant_id = $1`
	args := []any{merchantID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("groupbuy: verify history: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (vv.created_at, vv.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY vv.created_at, vv.id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("groupbuy: verify history: %w", err)
	}
	defer rows.Close()

	out := make([]VerificationRow, 0, limit)
	var (
		last     VerificationRow
		sentinel bool
	)
	for rows.Next() {
		var row VerificationRow
		if err := rows.Scan(&row.ID, &row.VoucherCode, &row.MerchantID, &row.Action, &row.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("groupbuy: scan verification row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("groupbuy: iterate verification rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// newVoucherCode returns a voucher code of the form GB-<8 random hex>.
func newVoucherCode() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("groupbuy: voucher code randomness: %w", err)
	}
	return "GB-" + strings.ToUpper(hex.EncodeToString(b)), nil
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanDealRow(s rowScanner) (DealRow, error) {
	var row DealRow
	err := s.Scan(&row.ID, &row.MerchantID, &row.Title, &row.Description,
		&row.OriginalPriceTZS, &row.DealPriceTZS, &row.QuantityTotal, &row.QuantitySold,
		&row.StartAt, &row.EndAt, &row.Status, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return DealRow{}, err
	}
	return row, nil
}

func scanVoucherRow(s rowScanner) (VoucherRow, error) {
	var row VoucherRow
	err := s.Scan(&row.ID, &row.DealID, &row.UserID, &row.Code, &row.Status,
		&row.ExpiresAt, &row.RedeemedAt, &row.CreatedAt,
		&row.DealTitle, &row.DealPriceTZS, &row.MerchantID)
	if err != nil {
		return VoucherRow{}, err
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
