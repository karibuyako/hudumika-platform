// Package promotions is the bounded context for merchant promotion
// campaigns and customer coupon claims (backend/DATA-MODEL.md
// "Promotions and coupons"). It talks directly to PostgreSQL via a
// pgxpool.Pool. All money is TZS bigint; clients never supply money beyond
// the campaign configuration validated here.
package promotions

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced to the API layer (ERROR-CODES.md "Promotions and
// coupons").
var (
	ErrNotFound       = errors.New("promotion or campaign not found")
	ErrStatusConflict = errors.New("promotion status conflict")
	ErrRuleInvalid    = errors.New("promotion rule invalid")
	ErrSoldOut        = errors.New("coupon campaign sold out")
	ErrExpired        = errors.New("coupon campaign expired")
	ErrAlreadyClaimed = errors.New("coupon already claimed")
	ErrInvalidCursor  = errors.New("invalid pagination cursor")
)

// Store wraps the connection pool for all promotion persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// PromotionRow is one row of the promotions table. Rules and performance are
// decoded from their jsonb columns.
type PromotionRow struct {
	ID           uuid.UUID
	MerchantID   uuid.UUID
	Type         string
	Title        string
	Description  *string
	Rules        map[string]any
	BudgetTZS    *int64
	Status       string
	StartsAt     time.Time
	EndsAt       time.Time
	RedeemCount  int
	SpendTZS     int64
	RejectReason *string
	Performance  map[string]any
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// PromotionCreateInput is the input shape for creating a promotion.
type PromotionCreateInput struct {
	MerchantID  uuid.UUID
	Type        string
	Title       string
	Description *string
	Rules       map[string]any
	BudgetTZS   *int64
	Status      string
	StartsAt    time.Time
	EndsAt      time.Time
}

// PromotionUpdateInput is the input shape for updating a promotion.
type PromotionUpdateInput struct {
	Type        string
	Title       string
	Description *string
	Rules       map[string]any
	BudgetTZS   *int64
	Status      string
	StartsAt    time.Time
	EndsAt      time.Time
}

// CampaignRow is one row of the coupon_campaigns table.
type CampaignRow struct {
	ID              uuid.UUID
	MerchantID      uuid.UUID
	Title           string
	DiscountTZS     int64
	MinimumSpendTZS int64
	Quantity        int
	ClaimedCount    int
	ValidUntil      time.Time
	Status          string
	CreatedAt       time.Time
}

// CampaignCreateInput is the input shape for creating a coupon campaign.
type CampaignCreateInput struct {
	MerchantID      uuid.UUID
	Title           string
	DiscountTZS     int64
	MinimumSpendTZS int64
	Quantity        int
	ValidUntil      time.Time
}

// CouponRow is one row of the coupons table.
type CouponRow struct {
	ID             uuid.UUID
	CampaignID     uuid.UUID
	Code           string
	CustomerUserID *uuid.UUID
	Status         string
	ClaimedAt      *time.Time
	UsedAt         *time.Time
	ExpiresAt      *time.Time
	CreatedAt      time.Time
}

const promotionColumns = `id, merchant_id, type, title, description, rules,
	budget_tzs, status, starts_at, ends_at, redeem_count, spend_tzs,
	reject_reason, performance, created_at, updated_at`

const campaignColumns = `id, merchant_id, title, discount_tzs, minimum_spend_tzs,
	quantity, claimed_count, valid_until, status, created_at`

const couponColumns = `id, campaign_id, code, customer_user_id, status,
	claimed_at, used_at, expires_at, created_at`

// CreatePromotion inserts a promotion row for the merchant. The status is
// clamped to a claimable-by-handler set: pending_review/rejected/ended are
// lifecycle outcomes, never creation targets (validated in the API layer
// too, the CHECK here is the backstop).
func (s *Store) CreatePromotion(ctx context.Context, in PromotionCreateInput) (PromotionRow, error) {
	if !in.EndsAt.After(in.StartsAt) {
		return PromotionRow{}, fmt.Errorf("promotions: create promotion: ends_at before starts_at: %w", ErrRuleInvalid)
	}
	rules, err := json.Marshal(in.Rules)
	if err != nil {
		return PromotionRow{}, fmt.Errorf("promotions: encode promotion rules: %w", err)
	}
	row, err := scanPromotionRow(s.pool.QueryRow(ctx,
		`INSERT INTO promotions (merchant_id, type, title, description, rules,
			budget_tzs, status, starts_at, ends_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING `+promotionColumns,
		in.MerchantID, in.Type, in.Title, in.Description, rules,
		in.BudgetTZS, in.Status, in.StartsAt, in.EndsAt))
	if err != nil {
		return PromotionRow{}, fmt.Errorf("promotions: insert promotion: %w", err)
	}
	return row, nil
}

// GetPromotion loads a single promotion row; ErrNotFound when absent.
func (s *Store) GetPromotion(ctx context.Context, id uuid.UUID) (*PromotionRow, error) {
	row, err := scanPromotionRow(s.pool.QueryRow(ctx,
		`SELECT `+promotionColumns+` FROM promotions WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("promotions: get promotion %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("promotions: get promotion %s: %w", id, err)
	}
	return &row, nil
}

// ListPromotions returns a merchant's promotions, oldest first,
// cursor-paginated on (created_at, id). An empty status returns every
// status. limit is exclusive of the sentinel row; next is the base64 cursor
// of the last returned row when another page exists, else "". A malformed
// cursor yields ErrInvalidCursor.
func (s *Store) ListPromotions(ctx context.Context, merchantID uuid.UUID, status string, limit int, cursor string) ([]PromotionRow, string, error) {
	query := `SELECT ` + promotionColumns + ` FROM promotions WHERE merchant_id = $1`
	args := make([]any, 0, 6)
	args = append(args, merchantID)
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("promotions: list promotions: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("promotions: list promotions: %w", err)
	}
	defer rows.Close()

	out := make([]PromotionRow, 0, limit)
	var (
		last     PromotionRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanPromotionRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("promotions: scan promotion row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("promotions: iterate promotion rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// UpdatePromotion applies the provided fields to the merchant's promotion.
// A status outside the hand-editable set, or invalid dates, yield
// ErrRuleInvalid; a missing promotion yields ErrNotFound.
func (s *Store) UpdatePromotion(ctx context.Context, id uuid.UUID, in PromotionUpdateInput) (*PromotionRow, error) {
	if !in.EndsAt.After(in.StartsAt) {
		return nil, fmt.Errorf("promotions: update promotion: ends_at before starts_at: %w", ErrRuleInvalid)
	}
	rules, err := json.Marshal(in.Rules)
	if err != nil {
		return nil, fmt.Errorf("promotions: encode promotion rules: %w", err)
	}
	row, err := scanPromotionRow(s.pool.QueryRow(ctx,
		`UPDATE promotions SET type = $1, title = $2, description = $3, rules = $4,
			budget_tzs = $5, status = $6, starts_at = $7, ends_at = $8,
			updated_at = now()
		 WHERE id = $9
		 RETURNING `+promotionColumns,
		in.Type, in.Title, in.Description, rules, in.BudgetTZS, in.Status,
		in.StartsAt, in.EndsAt, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("promotions: update promotion %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("promotions: update promotion %s: %w", id, err)
	}
	return &row, nil
}

// PausePromotion moves a live promotion to paused. A missing promotion
// yields ErrNotFound; a promotion that is not live (already paused, draft,
// ended, ...) yields ErrStatusConflict.
func (s *Store) PausePromotion(ctx context.Context, promotionID uuid.UUID) error {
	return s.setPromotionStatus(ctx, promotionID, "live", "paused")
}

// ResumePromotion moves a paused promotion back to live. A missing promotion
// yields ErrNotFound; a promotion that is not paused yields ErrStatusConflict.
func (s *Store) ResumePromotion(ctx context.Context, promotionID uuid.UUID) error {
	return s.setPromotionStatus(ctx, promotionID, "paused", "live")
}

func (s *Store) setPromotionStatus(ctx context.Context, promotionID uuid.UUID, from, to string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE promotions SET status = $1, updated_at = now()
		 WHERE id = $2 AND status = $3`,
		to, promotionID, from)
	if err != nil {
		return fmt.Errorf("promotions: set promotion %s status %s: %w", promotionID, to, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	row, err := s.GetPromotion(ctx, promotionID)
	if errors.Is(err, ErrNotFound) {
		return fmt.Errorf("promotions: set promotion %s status %s: %w", promotionID, to, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("promotions: set promotion %s status %s: %w", promotionID, to, err)
	}
	if row.Status != from {
		return fmt.Errorf("promotions: set promotion %s status %s: %w", promotionID, to, ErrStatusConflict)
	}
	return nil
}

// Performance returns the promotion row (with spend_tzs, redeem_count and
// the performance jsonb) for the performance endpoint. ErrNotFound when
// absent.
func (s *Store) Performance(ctx context.Context, promotionID uuid.UUID) (*PromotionRow, error) {
	return s.GetPromotion(ctx, promotionID)
}

// CreateCouponCampaign inserts a live coupon campaign for the merchant. A
// campaign with zero quantity or an already-past valid_until yields
// ErrRuleInvalid.
func (s *Store) CreateCouponCampaign(ctx context.Context, in CampaignCreateInput) (CampaignRow, error) {
	if in.Quantity <= 0 || in.DiscountTZS < 0 || in.MinimumSpendTZS < 0 {
		return CampaignRow{}, fmt.Errorf("promotions: create campaign: %w", ErrRuleInvalid)
	}
	if !in.ValidUntil.After(time.Now()) {
		return CampaignRow{}, fmt.Errorf("promotions: create campaign: valid_until in the past: %w", ErrRuleInvalid)
	}
	row, err := scanCampaignRow(s.pool.QueryRow(ctx,
		`INSERT INTO coupon_campaigns (merchant_id, title, discount_tzs,
			minimum_spend_tzs, quantity, valid_until, status)
		 VALUES ($1, $2, $3, $4, $5, $6, 'live')
		 RETURNING `+campaignColumns,
		in.MerchantID, in.Title, in.DiscountTZS, in.MinimumSpendTZS,
		in.Quantity, in.ValidUntil))
	if err != nil {
		return CampaignRow{}, fmt.Errorf("promotions: insert coupon campaign: %w", err)
	}
	return row, nil
}

// ListCouponCampaigns returns a merchant's coupon campaigns, newest first,
// cursor-paginated on (created_at, id). limit is exclusive of the sentinel
// row; next is the base64 cursor of the last returned row when another page
// exists, else "". A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListCouponCampaigns(ctx context.Context, merchantID uuid.UUID, limit int, cursor string) ([]CampaignRow, string, error) {
	query := `SELECT ` + campaignColumns + ` FROM coupon_campaigns WHERE merchant_id = $1`
	args := make([]any, 0, 4)
	args = append(args, merchantID)
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("promotions: list coupon campaigns: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) < ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("promotions: list coupon campaigns: %w", err)
	}
	defer rows.Close()

	out := make([]CampaignRow, 0, limit)
	var (
		last     CampaignRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanCampaignRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("promotions: scan campaign row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("promotions: iterate campaign rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// ListActivePromotions returns a merchant's live promotions within their
// window, newest first — the public listing projection. limit caps the
// result.
func (s *Store) ListActivePromotions(ctx context.Context, merchantID uuid.UUID, limit int) ([]PromotionRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+promotionColumns+` FROM promotions
		 WHERE merchant_id = $1 AND status = 'live'
		   AND starts_at <= now() AND ends_at > now()
		 ORDER BY created_at DESC LIMIT $2`,
		merchantID, limit)
	if err != nil {
		return nil, fmt.Errorf("promotions: list active promotions: %w", err)
	}
	defer rows.Close()

	out := make([]PromotionRow, 0, limit)
	for rows.Next() {
		row, err := scanPromotionRow(rows)
		if err != nil {
			return nil, fmt.Errorf("promotions: scan active promotion row: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("promotions: iterate active promotion rows: %w", err)
	}
	return out, nil
}

// GetCampaign loads a single coupon campaign; ErrNotFound when absent.
func (s *Store) GetCampaign(ctx context.Context, campaignID uuid.UUID) (*CampaignRow, error) {
	row, err := scanCampaignRow(s.pool.QueryRow(ctx,
		`SELECT `+campaignColumns+` FROM coupon_campaigns WHERE id = $1`, campaignID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("promotions: get campaign %s: %w", campaignID, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("promotions: get campaign %s: %w", campaignID, err)
	}
	return &row, nil
}

// CampaignsByIDs loads the campaigns for the given ids in one query, keyed
// by id; missing campaigns are absent from the map. Used to denormalize
// campaign terms onto coupon responses without an N+1.
func (s *Store) CampaignsByIDs(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]CampaignRow, error) {
	out := make(map[uuid.UUID]CampaignRow, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+campaignColumns+` FROM coupon_campaigns WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("promotions: campaigns by ids: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		row, err := scanCampaignRow(rows)
		if err != nil {
			return nil, fmt.Errorf("promotions: scan campaign by id: %w", err)
		}
		out[row.ID] = row
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("promotions: iterate campaigns by ids: %w", err)
	}
	return out, nil
}

// ClaimCoupon claims one coupon from a campaign for the user: the campaign
// row is locked, guarded against sold-out/expired states, and a uniquely
// coded coupon is inserted — all in one transaction, so concurrent claims on
// a budget of N let exactly N users win. Errors: ErrNotFound (unknown
// campaign), ErrExpired (not live or past valid_until), ErrSoldOut (budget
// exhausted) and ErrAlreadyClaimed (the user already holds a coupon).
func (s *Store) ClaimCoupon(ctx context.Context, campaignID, userID uuid.UUID) (CouponRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CouponRow{}, fmt.Errorf("promotions: begin claim tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pre-check under a row lock: concurrent claims serialize here, so the
	// guarded increment below is the backstop, not the primary gate.
	camp, err := scanCampaignRow(tx.QueryRow(ctx,
		`SELECT `+campaignColumns+` FROM coupon_campaigns WHERE id = $1 FOR UPDATE`, campaignID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: campaign %s: %w", campaignID, ErrNotFound)
	}
	if err != nil {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: lock campaign %s: %w", campaignID, err)
	}
	if camp.Status != "live" || !camp.ValidUntil.After(time.Now()) {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: campaign %s: %w", campaignID, ErrExpired)
	}
	if camp.ClaimedCount >= camp.Quantity {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: campaign %s: %w", campaignID, ErrSoldOut)
	}

	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM coupons WHERE campaign_id = $1 AND customer_user_id = $2)`,
		campaignID, userID).Scan(&exists); err != nil {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: check duplicate %s/%s: %w", campaignID, userID, err)
	}
	if exists {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: campaign %s user %s: %w", campaignID, userID, ErrAlreadyClaimed)
	}

	var claimedCount int
	err = tx.QueryRow(ctx,
		`UPDATE coupon_campaigns SET claimed_count = claimed_count + 1, updated_at = now()
		 WHERE id = $1 AND status = 'live' AND valid_until > now() AND claimed_count < quantity
		 RETURNING claimed_count`,
		campaignID).Scan(&claimedCount)
	if errors.Is(err, pgx.ErrNoRows) {
		// The pre-check won the lock, so this only fires when the campaign
		// flipped between the two statements; report the current condition.
		again, gerr := scanCampaignRow(tx.QueryRow(ctx,
			`SELECT `+campaignColumns+` FROM coupon_campaigns WHERE id = $1 FOR UPDATE`, campaignID))
		if gerr != nil {
			return CouponRow{}, fmt.Errorf("promotions: claim coupon: re-check campaign %s: %w", campaignID, gerr)
		}
		if again.ClaimedCount >= again.Quantity {
			return CouponRow{}, fmt.Errorf("promotions: claim coupon: campaign %s: %w", campaignID, ErrSoldOut)
		}
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: campaign %s: %w", campaignID, ErrExpired)
	}
	if err != nil {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: increment campaign %s: %w", campaignID, err)
	}

	code, err := newCouponCode(ctx, tx, 3)
	if err != nil {
		return CouponRow{}, err
	}
	row, err := scanCouponRow(tx.QueryRow(ctx,
		`INSERT INTO coupons (campaign_id, code, customer_user_id, status, claimed_at, expires_at)
		 VALUES ($1, $2, $3, 'claimed', now(), $4)
		 RETURNING `+couponColumns,
		campaignID, code, userID, camp.ValidUntil))
	if err != nil {
		return CouponRow{}, fmt.Errorf("promotions: claim coupon: insert coupon: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return CouponRow{}, fmt.Errorf("promotions: commit claim coupon: %w", err)
	}
	return row, nil
}

// ListMyCoupons returns the user's claimed coupons, newest first,
// cursor-paginated on (claimed_at, id). An empty status returns every
// status. limit is exclusive of the sentinel row; next is the base64 cursor
// of the last returned row when another page exists, else "". A malformed
// cursor yields ErrInvalidCursor.
func (s *Store) ListMyCoupons(ctx context.Context, userID uuid.UUID, status string, limit int, cursor string) ([]CouponRow, string, error) {
	query := `SELECT ` + couponColumns + ` FROM coupons WHERE customer_user_id = $1`
	args := make([]any, 0, 6)
	args = append(args, userID)
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("promotions: list my coupons: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (claimed_at, id) < ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY claimed_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("promotions: list my coupons: %w", err)
	}
	defer rows.Close()

	out := make([]CouponRow, 0, limit)
	var (
		last     CouponRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanCouponRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("promotions: scan coupon row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("promotions: iterate coupon rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanPromotionRow(s rowScanner) (PromotionRow, error) {
	var (
		row         PromotionRow
		rules       []byte
		performance []byte
	)
	err := s.Scan(&row.ID, &row.MerchantID, &row.Type, &row.Title, &row.Description,
		&rules, &row.BudgetTZS, &row.Status, &row.StartsAt, &row.EndsAt,
		&row.RedeemCount, &row.SpendTZS, &row.RejectReason, &performance,
		&row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return PromotionRow{}, err
	}
	if len(rules) > 0 {
		if err := json.Unmarshal(rules, &row.Rules); err != nil {
			return PromotionRow{}, fmt.Errorf("promotions: decode promotion rules: %w", err)
		}
	}
	if len(performance) > 0 {
		if err := json.Unmarshal(performance, &row.Performance); err != nil {
			return PromotionRow{}, fmt.Errorf("promotions: decode promotion performance: %w", err)
		}
	}
	return row, nil
}

func scanCampaignRow(s rowScanner) (CampaignRow, error) {
	var row CampaignRow
	err := s.Scan(&row.ID, &row.MerchantID, &row.Title, &row.DiscountTZS,
		&row.MinimumSpendTZS, &row.Quantity, &row.ClaimedCount, &row.ValidUntil,
		&row.Status, &row.CreatedAt)
	return row, err
}

func scanCouponRow(s rowScanner) (CouponRow, error) {
	var row CouponRow
	err := s.Scan(&row.ID, &row.CampaignID, &row.Code, &row.CustomerUserID,
		&row.Status, &row.ClaimedAt, &row.UsedAt, &row.ExpiresAt, &row.CreatedAt)
	return row, err
}

// newCouponCode generates a unique claim code of the form CP-<8 hex> and
// retries a handful of times on the coupons.code unique violation.
func newCouponCode(ctx context.Context, tx pgx.Tx, attempts int) (string, error) {
	for i := 0; i < attempts; i++ {
		raw := make([]byte, 4)
		if _, err := rand.Read(raw); err != nil {
			return "", fmt.Errorf("promotions: generate coupon code: %w", err)
		}
		code := "CP-" + strings.ToUpper(hex.EncodeToString(raw))
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM coupons WHERE code = $1)`, code).Scan(&exists); err != nil {
			return "", fmt.Errorf("promotions: check coupon code: %w", err)
		}
		if !exists {
			return code, nil
		}
	}
	return "", fmt.Errorf("promotions: coupon code collision after %d attempts", attempts)
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
