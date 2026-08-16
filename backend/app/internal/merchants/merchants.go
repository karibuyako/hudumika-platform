// Package merchants is the bounded context for merchant and provider
// applications, profiles and the admin approval workflow
// (backend/DATA-MODEL.md §marketplaces). It talks directly to PostgreSQL
// via a pgxpool.Pool. A user owns at most one merchants row and at most one
// providers row; verification drives the public/private visibility split.
package merchants

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced by the store.
var (
	// ErrAlreadyApplied is returned by ApplyMerchant/ApplyProvider when the
	// user already owns a row (unique owner_user_id).
	ErrAlreadyApplied = errors.New("merchants: user already applied")
	// ErrNotFound is returned when the entity id does not exist at all.
	ErrNotFound = errors.New("merchants: entity not found")
	// ErrStatusConflict is returned when the entity exists but is not in a
	// decidable state (not pending; changes_requested rows must be
	// resubmitted by the owner — UpdateMerchantProfile — first).
	ErrStatusConflict = errors.New("merchants: entity not in a decidable state")
	// ErrInvalidDecision guards the CHECK constraint: only the three
	// contract transitions may be written.
	ErrInvalidDecision = errors.New("merchants: invalid decision")
)

// merchantColumns is the shared SELECT list for merchants rows including the
// owner phone (users join) used by the staff list; the public/owner queries
// scan the same projection and leave Phone unused.
const merchantColumns = `m.id, m.owner_user_id, m.business_name, m.description, m.logo_url,
	m.city_id, c.name, m.business_type, m.verification, m.verification_reason,
	m.commission_rate_bps, m.payout_cycle_days, m.payout_account, m.is_open,
	m.rating, m.review_count, m.created_at, m.updated_at, u.phone`

// Merchant is the projection of one merchants row used by the API layer.
type Merchant struct {
	ID                 uuid.UUID
	OwnerUserID        uuid.UUID
	BusinessName       string
	Description        *string
	LogoURL            *string
	CityID             *uuid.UUID
	CityName           string
	BusinessType       *string
	Verification       string
	VerificationReason *string
	CommissionRateBps  *int
	PayoutCycleDays    int
	PayoutAccount      *string
	IsOpen             bool
	Rating             *float64
	ReviewCount        int
	CreatedAt          time.Time
	UpdatedAt          time.Time
	OwnerPhone         string
}

// Provider is the projection of one providers row used by the API layer.
type Provider struct {
	ID                 uuid.UUID
	OwnerUserID        uuid.UUID
	Name               string
	Trade              string
	Bio                *string
	AvatarURL          *string
	CityID             *uuid.UUID
	BaseRateTZS        *int64
	Verification       string
	VerificationReason *string
	ReliabilityScore   *int
	Rating             *float64
	ReviewCount        int
	PayoutCycleDays    int
	ServiceAreas       []byte
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// MerchantInput carries the application fields of a new merchant.
type MerchantInput struct {
	BusinessName string
	BusinessType *string
	CityID       *string
	Description  *string
	LogoURL      *string
}

// ProviderInput carries the application fields of a new provider.
type ProviderInput struct {
	Name        string
	Trade       string
	CityID      *string
	Bio         *string
	ServiceArea *string
}

// MerchantProfileUpdate carries the mutable profile fields of a merchant.
// Pointers select the fields to apply (PATCH semantics).
type MerchantProfileUpdate struct {
	BusinessName *string
	LogoURL      *string
	Description  *string
	IsOpen       *bool
}

// ProviderProfileUpdate carries the mutable profile fields of a provider.
type ProviderProfileUpdate struct {
	Bio          *string
	AvatarURL    *string
	BaseRateTZS  *int64
	ServiceAreas []byte
}

// Store wraps the connection pool for all merchant/provider persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// ApplyMerchant inserts a merchant application in the 'pending' state. A
// user may apply exactly once: a second application for the same
// owner_user_id yields ErrAlreadyApplied. The returned id is the new
// merchants row.
func (s *Store) ApplyMerchant(ctx context.Context, ownerUserID uuid.UUID, in MerchantInput) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`INSERT INTO merchants (owner_user_id, business_name, business_type, city_id, description, logo_url)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (owner_user_id) DO NOTHING
		 RETURNING id`,
		ownerUserID, in.BusinessName, in.BusinessType, in.CityID, in.Description, in.LogoURL).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrAlreadyApplied
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("merchants: apply for user %s: %w", ownerUserID, err)
	}
	return id, nil
}

// ApplyProvider inserts a provider application in the 'pending' state; a
// second application for the same owner_user_id yields ErrAlreadyApplied.
func (s *Store) ApplyProvider(ctx context.Context, ownerUserID uuid.UUID, in ProviderInput) (uuid.UUID, error) {
	var areas json.RawMessage
	if in.ServiceArea != nil && *in.ServiceArea != "" {
		b, err := json.Marshal([]string{*in.ServiceArea})
		if err != nil {
			return uuid.Nil, fmt.Errorf("merchants: provider apply for user %s: %w", ownerUserID, err)
		}
		areas = b
	}
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`INSERT INTO providers (owner_user_id, name, trade, city_id, bio, service_areas)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (owner_user_id) DO NOTHING
		 RETURNING id`,
		ownerUserID, in.Name, in.Trade, in.CityID, in.Bio, areas).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrAlreadyApplied
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("merchants: provider apply for user %s: %w", ownerUserID, err)
	}
	return id, nil
}

// scanMerchant maps one merchants row (merchantColumns order) onto Merchant.
func scanMerchant(row pgx.Row) (*Merchant, error) {
	var m Merchant
	var cityName *string
	err := row.Scan(&m.ID, &m.OwnerUserID, &m.BusinessName, &m.Description, &m.LogoURL,
		&m.CityID, &cityName, &m.BusinessType, &m.Verification, &m.VerificationReason,
		&m.CommissionRateBps, &m.PayoutCycleDays, &m.PayoutAccount, &m.IsOpen,
		&m.Rating, &m.ReviewCount, &m.CreatedAt, &m.UpdatedAt, &m.OwnerPhone)
	if err != nil {
		return nil, err
	}
	if cityName != nil {
		m.CityName = *cityName
	}
	return &m, nil
}

// merchantFromClause is the shared FROM for merchants reads: the cities
// join resolves the public city name and the users join supplies the owner
// phone for the staff list.
const merchantFromClause = `merchants m
	LEFT JOIN cities c ON c.id = m.city_id
	JOIN users u ON u.id = m.owner_user_id`

// GetMerchantByOwner returns the merchant owned by the user, or (nil, nil)
// when the user has no merchants row.
func (s *Store) GetMerchantByOwner(ctx context.Context, userID uuid.UUID) (*Merchant, error) {
	m, err := scanMerchant(s.pool.QueryRow(ctx,
		`SELECT `+merchantColumns+` FROM `+merchantFromClause+`
		 WHERE m.owner_user_id = $1`, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("merchants: get by owner %s: %w", userID, err)
	}
	return m, nil
}

// GetMerchant returns the merchant row by id, or (nil, nil) when it does
// not exist.
func (s *Store) GetMerchant(ctx context.Context, merchantID uuid.UUID) (*Merchant, error) {
	m, err := scanMerchant(s.pool.QueryRow(ctx,
		`SELECT `+merchantColumns+` FROM `+merchantFromClause+`
		 WHERE m.id = $1`, merchantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("merchants: get %s: %w", merchantID, err)
	}
	return m, nil
}

// UpdateMerchantProfile applies the present fields of a merchant row and
// stamps updated_at. Updating a missing row yields ErrNotFound. A profile
// update on a changes_requested row IS the owner's resubmission: the row
// returns to 'pending' (reason cleared) so staff can decide it again — a
// decision can only ever land on a pending row, which keeps concurrent
// decisions single-winner (see DecideMerchant). Other verification states
// are untouched.
func (s *Store) UpdateMerchantProfile(ctx context.Context, merchantID uuid.UUID, in MerchantProfileUpdate) error {
	sets := []string{"updated_at = now()"}
	args := make([]any, 0, 5)
	if in.BusinessName != nil {
		args = append(args, *in.BusinessName)
		sets = append(sets, fmt.Sprintf("business_name = $%d", len(args)))
	}
	if in.LogoURL != nil {
		args = append(args, *in.LogoURL)
		sets = append(sets, fmt.Sprintf("logo_url = $%d", len(args)))
	}
	if in.Description != nil {
		args = append(args, *in.Description)
		sets = append(sets, fmt.Sprintf("description = $%d", len(args)))
	}
	if in.IsOpen != nil {
		args = append(args, *in.IsOpen)
		sets = append(sets, fmt.Sprintf("is_open = $%d", len(args)))
	}
	// Resubmission: a changes_requested row the owner edits returns to
	// pending for a fresh decision; every other state keeps its
	// verification (and its reason).
	sets = append(sets,
		"verification = CASE WHEN verification = 'changes_requested' THEN 'pending' ELSE verification END",
		"verification_reason = CASE WHEN verification = 'changes_requested' THEN NULL ELSE verification_reason END")
	args = append(args, merchantID)
	tag, err := s.pool.Exec(ctx,
		fmt.Sprintf(`UPDATE merchants SET %s WHERE id = $%d`, strings.Join(sets, ", "), len(args)), args...)
	if err != nil {
		return fmt.Errorf("merchants: update profile %s: %w", merchantID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("merchants: update profile %s: %w", merchantID, ErrNotFound)
	}
	return nil
}

// providerColumns is the shared SELECT list for providers rows.
const providerColumns = `id, owner_user_id, name, trade, bio, avatar_url, city_id,
	base_rate_tzs, verification, verification_reason, reliability_score, rating,
	review_count, payout_cycle_days, service_areas, created_at, updated_at`

// scanProvider maps one providers row (providerColumns order) onto Provider.
func scanProvider(row pgx.Row) (*Provider, error) {
	var p Provider
	err := row.Scan(&p.ID, &p.OwnerUserID, &p.Name, &p.Trade, &p.Bio, &p.AvatarURL, &p.CityID,
		&p.BaseRateTZS, &p.Verification, &p.VerificationReason, &p.ReliabilityScore, &p.Rating,
		&p.ReviewCount, &p.PayoutCycleDays, &p.ServiceAreas, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// GetProviderByOwner returns the provider owned by the user, or (nil, nil)
// when the user has no providers row.
func (s *Store) GetProviderByOwner(ctx context.Context, userID uuid.UUID) (*Provider, error) {
	p, err := scanProvider(s.pool.QueryRow(ctx,
		`SELECT `+providerColumns+` FROM providers WHERE owner_user_id = $1`, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("merchants: get provider by owner %s: %w", userID, err)
	}
	return p, nil
}

// GetProvider returns the provider row by id, or (nil, nil) when it does
// not exist.
func (s *Store) GetProvider(ctx context.Context, providerID uuid.UUID) (*Provider, error) {
	p, err := scanProvider(s.pool.QueryRow(ctx,
		`SELECT `+providerColumns+` FROM providers WHERE id = $1`, providerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("merchants: get provider %s: %w", providerID, err)
	}
	return p, nil
}

// UpdateProviderProfile applies the present fields of a provider row and
// stamps updated_at. Updating a missing row yields ErrNotFound.
func (s *Store) UpdateProviderProfile(ctx context.Context, providerID uuid.UUID, in ProviderProfileUpdate) error {
	sets := []string{"updated_at = now()"}
	args := make([]any, 0, 5)
	if in.Bio != nil {
		args = append(args, *in.Bio)
		sets = append(sets, fmt.Sprintf("bio = $%d", len(args)))
	}
	if in.AvatarURL != nil {
		args = append(args, *in.AvatarURL)
		sets = append(sets, fmt.Sprintf("avatar_url = $%d", len(args)))
	}
	if in.BaseRateTZS != nil {
		args = append(args, *in.BaseRateTZS)
		sets = append(sets, fmt.Sprintf("base_rate_tzs = $%d", len(args)))
	}
	if in.ServiceAreas != nil {
		args = append(args, in.ServiceAreas)
		sets = append(sets, fmt.Sprintf("service_areas = $%d", len(args)))
	}
	args = append(args, providerID)
	tag, err := s.pool.Exec(ctx,
		fmt.Sprintf(`UPDATE providers SET %s WHERE id = $%d`, strings.Join(sets, ", "), len(args)), args...)
	if err != nil {
		return fmt.Errorf("merchants: update provider profile %s: %w", providerID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("merchants: update provider profile %s: %w", providerID, ErrNotFound)
	}
	return nil
}

// ListApprovedMerchants returns approved merchants newest first, optionally
// scoped to one city, keyset-paginated with the (created_at, id) cursor.
// nextCursor is "" when the page is the last one.
func (s *Store) ListApprovedMerchants(ctx context.Context, cityID *string, limit int, cursor string) ([]Merchant, string, error) {
	query := `SELECT ` + merchantColumns + ` FROM ` + merchantFromClause + `
		WHERE m.verification = 'approved'`
	args := []any{}
	if cityID != nil && *cityID != "" {
		args = append(args, *cityID)
		query += ` AND m.city_id = $` + fmt.Sprintf("%d", len(args))
	}
	afterCreated, afterID, err := ParseCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	if afterCreated != nil && afterID != nil {
		args = append(args, *afterCreated, *afterID)
		query += fmt.Sprintf(` AND (m.created_at, m.id) < ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += ` ORDER BY m.created_at DESC, m.id DESC LIMIT $` + fmt.Sprintf("%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("merchants: list approved: %w", err)
	}
	defer rows.Close()

	merchants := make([]Merchant, 0, limit)
	for rows.Next() {
		m, err := scanMerchant(rows)
		if err != nil {
			return nil, "", fmt.Errorf("merchants: scan approved: %w", err)
		}
		merchants = append(merchants, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("merchants: iterate approved: %w", err)
	}

	next := ""
	if len(merchants) > limit {
		merchants = merchants[:limit]
		last := merchants[len(merchants)-1]
		next = EncodeCursor(last.CreatedAt, last.ID)
	}
	return merchants, next, nil
}

// ListMerchantsForAdmin returns merchants with the given verification state
// (any state when status is nil) newest first, keyset-paginated. The owner
// phone is resolved via the users join.
func (s *Store) ListMerchantsForAdmin(ctx context.Context, status *string, limit int, cursor string) ([]Merchant, string, error) {
	query := `SELECT ` + merchantColumns + ` FROM ` + merchantFromClause + ` WHERE true`
	args := []any{}
	if status != nil && *status != "" {
		args = append(args, *status)
		query += ` AND m.verification = $` + fmt.Sprintf("%d", len(args))
	}
	afterCreated, afterID, err := ParseCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	if afterCreated != nil && afterID != nil {
		args = append(args, *afterCreated, *afterID)
		query += fmt.Sprintf(` AND (m.created_at, m.id) < ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += ` ORDER BY m.created_at DESC, m.id DESC LIMIT $` + fmt.Sprintf("%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("merchants: list for admin: %w", err)
	}
	defer rows.Close()

	merchants := make([]Merchant, 0, limit)
	for rows.Next() {
		m, err := scanMerchant(rows)
		if err != nil {
			return nil, "", fmt.Errorf("merchants: scan admin: %w", err)
		}
		merchants = append(merchants, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("merchants: iterate admin: %w", err)
	}

	next := ""
	if len(merchants) > limit {
		merchants = merchants[:limit]
		last := merchants[len(merchants)-1]
		next = EncodeCursor(last.CreatedAt, last.ID)
	}
	return merchants, next, nil
}

// DecideMerchant applies an admin approval decision. The merchant must be
// in the decidable state 'pending'; any other state yields
// ErrStatusConflict and a missing row yields ErrNotFound. Only the three
// contract transitions are accepted (ErrInvalidDecision otherwise). A
// changes_requested row is NOT decidable: the owner resubmits by editing
// the profile (UpdateMerchantProfile returns the row to 'pending'), after
// which staff may decide again.
//
// Concurrency: a decision is a compare-and-swap on the row version. The
// state is read first, then the guarded UPDATE requires the row to still
// carry exactly that state and that updated_at. Because every decision
// leaves the row in a terminal state (approved / rejected /
// changes_requested — none decidable), a queued or later decider always
// finds the guard false: exactly one decider in a simultaneous burst wins
// and the rest get ErrStatusConflict. (A plain `verification IN
// ('pending','changes_requested')` guard could not promise this: under
// READ COMMITTED a queued UPDATE re-evaluates its WHERE against the
// freshly committed row, and a concurrent 'changes_requested' commit
// leaves the row decidable, so several deciders would all report success
// and silently overwrite each other — TestConcurrentDecideSingleWinner
// caught 10/10 winners in that interleaving.) The updated_at clause also
// rejects a decision that raced an owner profile edit, which would
// otherwise be decided against a stale application.
func (s *Store) DecideMerchant(ctx context.Context, merchantID uuid.UUID, decision, reason string) error {
	switch decision {
	case "approved", "rejected", "changes_requested":
	default:
		return fmt.Errorf("merchants: decide %s: %w", merchantID, ErrInvalidDecision)
	}

	var state string
	var version time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT verification, updated_at FROM merchants WHERE id = $1`, merchantID).Scan(&state, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("merchants: decide %s: %w", merchantID, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("merchants: decide %s: %w", merchantID, err)
	}
	if state != "pending" {
		return fmt.Errorf("merchants: decide %s: %w", merchantID, ErrStatusConflict)
	}

	tag, err := s.pool.Exec(ctx,
		`UPDATE merchants
		 SET verification = $2, verification_reason = $3, updated_at = now()
		 WHERE id = $1 AND verification = $4 AND updated_at = $5`,
		merchantID, decision, reason, state, version)
	if err != nil {
		return fmt.Errorf("merchants: decide %s: %w", merchantID, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM merchants WHERE id = $1)`, merchantID).Scan(&exists); err != nil {
		return fmt.Errorf("merchants: decide existence %s: %w", merchantID, err)
	}
	if !exists {
		return fmt.Errorf("merchants: decide %s: %w", merchantID, ErrNotFound)
	}
	return fmt.Errorf("merchants: decide %s: %w", merchantID, ErrStatusConflict)
}

// EncodeCursor packs a (created_at, id) keyset into the URL-safe base64
// cursor used by the list endpoints.
func EncodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// ParseCursor decodes a list cursor; a blank cursor yields (nil, nil, nil).
// A malformed cursor is an error so callers can reject it with 422.
func ParseCursor(cursor string) (*time.Time, *uuid.UUID, error) {
	if cursor == "" {
		return nil, nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, nil, fmt.Errorf("merchants: decode cursor: %w", err)
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return nil, nil, fmt.Errorf("merchants: malformed cursor")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, nil, fmt.Errorf("merchants: parse cursor time: %w", err)
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return nil, nil, fmt.Errorf("merchants: parse cursor id: %w", err)
	}
	return &createdAt, &id, nil
}
