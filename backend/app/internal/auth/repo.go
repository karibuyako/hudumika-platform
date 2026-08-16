// Package auth is the bounded context for identities, sessions and OTP
// requests. It talks directly to PostgreSQL via a pgxpool.Pool.
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrSessionNotFound is returned by RotateSession when the old refresh token
// hash does not match an active (non-revoked) session.
var ErrSessionNotFound = errors.New("session not found")

// Repo wraps the connection pool for all auth persistence.
type Repo struct {
	pool *pgxpool.Pool
}

// NewRepo returns a Repo bound to the given pool.
func NewRepo(pool *pgxpool.Pool) *Repo {
	return &Repo{pool: pool}
}

// SessionRow is the input shape for creating or rotating a session.
type SessionRow struct {
	UserID           uuid.UUID
	Role             string
	AccessTokenHash  string
	RefreshTokenHash string
	ExpiresAt        time.Time
}

// OtpRequestRow is the input shape for creating an OTP request.
type OtpRequestRow struct {
	Channel     string
	Destination string
	Purpose     string
	CodeHash    string
	ExpiresAt   time.Time
}

// UserRow is the user projection used by auth flows and the users API.
type UserRow struct {
	ID        uuid.UUID
	Phone     string
	Email     *string
	FullName  string
	AvatarURL *string
	Locale    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// RoleRow is one active role of a user, optionally bound to a merchant,
// provider or rider record.
type RoleRow struct {
	Role       string
	MerchantID *uuid.UUID
	ProviderID *uuid.UUID
	RiderID    *uuid.UUID
}

// UpsertUserByPhone creates a user on first sight of the phone and returns
// its id; subsequent calls return the same id and only bump updated_at.
func (r *Repo) UpsertUserByPhone(ctx context.Context, phone string) (uuid.UUID, error) {
	var id uuid.UUID
	err := r.pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1)
		 ON CONFLICT (phone) DO UPDATE SET updated_at = now()
		 RETURNING id`, phone).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: upsert user by phone: %w", err)
	}
	return id, nil
}

// EnsureRole grants a role to a user; it is a no-op when the role exists.
func (r *Repo) EnsureRole(ctx context.Context, userID uuid.UUID, role string) error {
	if _, err := r.pool.Exec(ctx,
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)
		 ON CONFLICT (user_id, role) DO NOTHING`, userID, role); err != nil {
		return fmt.Errorf("auth: ensure role %q for user %s: %w", role, userID, err)
	}
	return nil
}

// CreateSession inserts a new session and returns its id.
func (r *Repo) CreateSession(ctx context.Context, s SessionRow) (uuid.UUID, error) {
	var id uuid.UUID
	err := r.pool.QueryRow(ctx,
		`INSERT INTO sessions (user_id, role, access_token_hash, refresh_token_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		s.UserID, s.Role, s.AccessTokenHash, s.RefreshTokenHash, s.ExpiresAt).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: create session: %w", err)
	}
	return id, nil
}

// RotateSession atomically replaces the token hashes of the session that
// still holds the old refresh hash. Revoked or unknown sessions yield
// ErrSessionNotFound, so exactly one concurrent rotation can win.
func (r *Repo) RotateSession(ctx context.Context, oldRefreshTokenHash string, s SessionRow) error {
	tag, err := r.pool.Exec(ctx,
		`UPDATE sessions SET access_token_hash = $1, refresh_token_hash = $2, expires_at = $3
		 WHERE refresh_token_hash = $4 AND revoked_at IS NULL`,
		s.AccessTokenHash, s.RefreshTokenHash, s.ExpiresAt, oldRefreshTokenHash)
	if err != nil {
		return fmt.Errorf("auth: rotate session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("auth: rotate session: %w", ErrSessionNotFound)
	}
	return nil
}

// RevokeSession marks the session holding the refresh hash as revoked.
func (r *Repo) RevokeSession(ctx context.Context, refreshTokenHash string) error {
	if _, err := r.pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1`,
		refreshTokenHash); err != nil {
		return fmt.Errorf("auth: revoke session: %w", err)
	}
	return nil
}

// CreateOtpRequest inserts an OTP request and returns its id.
func (r *Repo) CreateOtpRequest(ctx context.Context, o OtpRequestRow) (uuid.UUID, error) {
	var id uuid.UUID
	err := r.pool.QueryRow(ctx,
		`INSERT INTO otp_requests (channel, destination, purpose, code_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		o.Channel, o.Destination, o.Purpose, o.CodeHash, o.ExpiresAt).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: create otp request: %w", err)
	}
	return id, nil
}

// IncrementOtpAttempts counts one failed verification attempt.
func (r *Repo) IncrementOtpAttempts(ctx context.Context, otpID uuid.UUID) error {
	if _, err := r.pool.Exec(ctx,
		`UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1`, otpID); err != nil {
		return fmt.Errorf("auth: increment otp attempts: %w", err)
	}
	return nil
}

// MarkOtpVerified stamps the request as verified.
func (r *Repo) MarkOtpVerified(ctx context.Context, otpID uuid.UUID) error {
	if _, err := r.pool.Exec(ctx,
		`UPDATE otp_requests SET verified_at = now() WHERE id = $1`, otpID); err != nil {
		return fmt.Errorf("auth: mark otp verified: %w", err)
	}
	return nil
}

// GetUserByPhone returns the user for the phone, or (nil, nil) when absent.
// Callers treat a missing row and an error differently: a nil user must not
// leak whether the account exists.
func (r *Repo) GetUserByPhone(ctx context.Context, phone string) (*UserRow, error) {
	var u UserRow
	err := r.pool.QueryRow(ctx,
		`SELECT id, phone, email, full_name, avatar_url, locale, created_at, updated_at
		 FROM users WHERE phone = $1`,
		phone).Scan(&u.ID, &u.Phone, &u.Email, &u.FullName, &u.AvatarURL, &u.Locale, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("auth: get user by phone: %w", err)
	}
	return &u, nil
}

// UpdateUserProfile writes the mutable profile fields of a user. A nil email
// or avatarURL clears the column to NULL; fullName must be non-nil because
// full_name is NOT NULL, and is stored verbatim.
func (r *Repo) UpdateUserProfile(ctx context.Context, userID uuid.UUID, email, fullName, avatarURL *string, locale string) error {
	if _, err := r.pool.Exec(ctx,
		`UPDATE users SET email = $2, full_name = $3, avatar_url = $4, locale = $5, updated_at = now()
		 WHERE id = $1`,
		userID, email, fullName, avatarURL, locale); err != nil {
		return fmt.Errorf("auth: update user profile %s: %w", userID, err)
	}
	return nil
}

// ListRolesByUser returns the active roles of a user in a single query.
func (r *Repo) ListRolesByUser(ctx context.Context, userID uuid.UUID) ([]RoleRow, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT role, merchant_id, provider_id, rider_id FROM roles
		 WHERE user_id = $1 AND active`, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: list roles for user %s: %w", userID, err)
	}
	defer rows.Close()

	roles := make([]RoleRow, 0)
	for rows.Next() {
		var role RoleRow
		if err := rows.Scan(&role.Role, &role.MerchantID, &role.ProviderID, &role.RiderID); err != nil {
			return nil, fmt.Errorf("auth: list roles for user %s: %w", userID, err)
		}
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: list roles for user %s: %w", userID, err)
	}
	return roles, nil
}
