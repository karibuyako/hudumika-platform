// Service orchestrates the auth domain across the Redis stores and the
// durable repository. A nil repo means the process runs without persistence
// (development mode only; production config requires DATABASE_URL).
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/store"
)

// Service orchestrates the auth domain across the Redis stores and the
// durable repository. A nil repo means the process runs without persistence
// (development mode only; production config requires DATABASE_URL).
type Service struct {
	otp      store.OtpStore
	sessions store.SessionStore
	repo     *Repo
	logger   *slog.Logger
}

func NewService(otp store.OtpStore, sessions store.SessionStore, repo *Repo, logger *slog.Logger) *Service {
	return &Service{otp: otp, sessions: sessions, repo: repo, logger: logger}
}

// PersistenceEnabled reports whether durable rows are written.
func (s *Service) PersistenceEnabled() bool { return s.repo != nil }

// CreateOtp mints an OTP (Redis) and persists the audit row (PostgreSQL) with
// only the SHA-256 hash of the code. Ordering: the durable row lands before
// the hot-path record so a crash cannot leave an un-logged code; the code
// itself is never logged or persisted.
func (s *Service) CreateOtp(ctx context.Context, in store.OtpCreateInput) (store.OtpCreated, error) {
	created, err := s.otp.Create(ctx, in)
	if err != nil {
		return store.OtpCreated{}, err
	}
	if s.repo == nil {
		return created, nil
	}
	id, err := s.repo.CreateOtpRequest(ctx, OtpRequestRow{
		Channel:     in.Channel,
		Destination: in.Destination,
		Purpose:     in.Purpose,
		CodeHash:    sha256Hex(created.Code),
		ExpiresAt:   created.ExpiresAt,
	})
	if err != nil {
		return store.OtpCreated{}, fmt.Errorf("auth: persist otp request: %w", err)
	}
	if err := s.otp.AttachDBID(ctx, created.RequestID, id.String()); err != nil {
		s.logger.Warn("otp audit link failed", "requestId", created.RequestID, "error", err)
	}
	return created, nil
}

// VerifyOtp checks the code against Redis and, on success, links the user:
// durable otp row marked verified, user upserted by destination, customer
// role ensured. Failed attempts mirror the attempt counter to the audit row.
// The returned userID is meaningful only when persistence is enabled.
func (s *Service) VerifyOtp(ctx context.Context, requestID, code string, now time.Time) (store.OtpVerifyResult, uuid.UUID, error) {
	result, err := s.otp.Verify(ctx, requestID, code, now)
	if err != nil || !result.Verified {
		if s.repo != nil && result.DBID != "" {
			dbID, perr := uuid.Parse(result.DBID)
			if perr == nil {
				if ierr := s.repo.IncrementOtpAttempts(ctx, dbID); ierr != nil {
					s.logger.Warn("otp attempt mirror failed", "error", ierr)
				}
			}
		}
		return result, uuid.Nil, err
	}
	if s.repo == nil {
		return result, uuid.Nil, nil
	}

	if result.DBID != "" {
		if dbID, perr := uuid.Parse(result.DBID); perr == nil {
			if merr := s.repo.MarkOtpVerified(ctx, dbID); merr != nil {
				s.logger.Warn("otp verified mirror failed", "error", merr)
			}
		}
	}

	userID, err := s.repo.UpsertUserByPhone(ctx, result.Destination)
	if err != nil {
		return store.OtpVerifyResult{}, uuid.Nil, fmt.Errorf("auth: upsert user: %w", err)
	}
	if err := s.repo.EnsureRole(ctx, userID, "customer"); err != nil {
		return store.OtpVerifyResult{}, uuid.Nil, fmt.Errorf("auth: ensure role: %w", err)
	}
	return result, userID, nil
}

// PersistSession writes the durable session row (after the Redis store has
// accepted the hot-path record).
func (s *Service) PersistSession(ctx context.Context, row SessionRow) error {
	if s.repo == nil {
		return nil
	}
	if _, err := s.repo.CreateSession(ctx, row); err != nil {
		return fmt.Errorf("auth: persist session: %w", err)
	}
	return nil
}

// RotateSession mirrors a refresh-token rotation to the durable row. The
// guarded UPDATE is idempotent against Redis rotation: a row that is missing
// (dev-created sessions, wiped audit data) fails with ErrSessionNotFound and
// the caller decides.
func (s *Service) RotateSession(ctx context.Context, oldRefreshHash string, row SessionRow) error {
	if s.repo == nil {
		return nil
	}
	if err := s.repo.RotateSession(ctx, oldRefreshHash, row); err != nil {
		return fmt.Errorf("auth: rotate session row: %w", err)
	}
	return nil
}

// RevokeSession mirrors logout to the durable row.
func (s *Service) RevokeSession(ctx context.Context, refreshHash string) error {
	if s.repo == nil {
		return nil
	}
	if err := s.repo.RevokeSession(ctx, refreshHash); err != nil {
		return fmt.Errorf("auth: revoke session row: %w", err)
	}
	return nil
}

func sha256Hex(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}
