package api

// TWO-FACTOR authentication extension (API-CONTRACT.yaml /auth/2fa/*): TOTP
// enrollment and verification for staff sessions, minting the mfa_verified
// claim that /admin/* RBAC requires (rbac.go).
//
// Manual chi routes outside the generated tree (router.go), mirroring the
// documented-extension pattern of the push-token registry and /sync/batch.
// The /auth group normally lives outside RequireAuth (tokens in body), but
// these routes authenticate with the ACCESS token, so they are wrapped in
// the same RequireAuth middleware the generated tree uses.
//
// TOTP is RFC 6238: SHA-1 HMAC, 30-second step, 6 digits, ±1-step window.
// Implemented manually with crypto/hmac (no TOTP dependency is vendored;
// go.mod has none) — the truncated 31-bit value fits a uint32, so math/big
// is unnecessary.
//
// Secrets live in PostgreSQL (twofa_secrets, twofa_recovery_codes — see
// migrations/00072_twofa.sql); like other DB-backed handlers, every route
// fails hard with 500 INTERNAL_ERROR when no database is wired (dev,
// unit-test server).
//
// mfa_verified sessions are minted here, NOT via buildSession (auth.go
// untouched): mintMFASession mirrors buildSession's token + store writes
// with the MFA claim set and a store.Session.MfaVerified record.

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/store"
)

const (
	totpStepSeconds  = 30
	totpDigits       = 6
	totpWindowSteps  = 1
	recoveryCodeN    = 10
	twoFaIssuer      = "HUDumika"
	recoveryCodeRand = 10
)

// ---- RFC 6238 TOTP ----

// totpCode computes the 6-digit TOTP code for a base32 secret at the given
// time (RFC 6238: HMAC-SHA1 over the 30s step counter, dynamic truncation).
func totpCode(secretBase32 string, now time.Time) (string, error) {
	secret, err := decodeBase32Secret(secretBase32)
	if err != nil {
		return "", fmt.Errorf("totp: %w", err)
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(now.Unix()/totpStepSeconds))
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])
	return fmt.Sprintf("%0*d", totpDigits, bin%1_000_000), nil
}

// verifyTOTP accepts the code within a ±totpWindowSteps step window around
// now. Comparison is constant-time against each candidate.
func verifyTOTP(secretBase32, code string, now time.Time) bool {
	for offset := -totpWindowSteps; offset <= totpWindowSteps; offset++ {
		candidate, err := totpCode(secretBase32, now.Add(time.Duration(offset)*totpStepSeconds*time.Second))
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func decodeBase32Secret(s string) ([]byte, error) {
	enc := base32.StdEncoding
	s = strings.ToUpper(strings.TrimSpace(strings.ReplaceAll(s, " ", "")))
	if rem := len(s) % 8; rem != 0 && !strings.Contains(s, "=") {
		s += strings.Repeat("=", 8-rem)
	}
	return enc.DecodeString(s)
}

// newTOTPSecret returns 20 random bytes as unpadded base32 (160-bit secret,
// the RFC 4226 recommended key length).
func newTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

func otpauthURL(account, secret string) string {
	return fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		twoFaIssuer, url.PathEscape(account), secret, twoFaIssuer, totpDigits, totpStepSeconds)
}

// newRecoveryCodes mints n single-use recovery codes (unpadded base32). Only
// their SHA-256 hashes are ever stored; the plaintext leaves the server once.
func newRecoveryCodes(n int) ([]string, error) {
	codes := make([]string, n)
	for i := range codes {
		b := make([]byte, recoveryCodeRand)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		codes[i] = base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
	}
	return codes, nil
}

// ---- enrollment helpers ----

// twoFaSecretRow is the projected twofa_secrets row.
type twoFaSecretRow struct {
	SecretBase32 string
	Enabled      bool
}

// twoFaUserID resolves the session subject to a users row id: a subject that
// already is a UUID is used as-is; otherwise (phone subjects) it is resolved
// through the users table. Staff subjects are user UUIDs in production; the
// phone fallback keeps OTP-issued sessions enrollable.
func (s *Server) twoFaUserID(ctx context.Context, subject string) (uuid.UUID, bool, error) {
	if id, err := uuid.Parse(subject); err == nil {
		return id, true, nil
	}
	if s.db == nil {
		return uuid.Nil, false, nil
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(ctx, subject)
	if err != nil {
		return uuid.Nil, false, err
	}
	if user == nil {
		return uuid.Nil, false, nil
	}
	return user.ID, true, nil
}

func (s *Server) loadTwoFaSecret(ctx context.Context, userID uuid.UUID) (*twoFaSecretRow, error) {
	var row twoFaSecretRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT secret_base32, enabled FROM twofa_secrets WHERE user_id = $1`, userID).
		Scan(&row.SecretBase32, &row.Enabled)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// replaceRecoveryCodes stores a fresh recovery-code set for the user
// (DELETE + INSERT in one transaction) and returns the plaintext codes.
func (s *Server) replaceRecoveryCodes(ctx context.Context, userID uuid.UUID, n int) ([]string, error) {
	codes, err := newRecoveryCodes(n)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM twofa_recovery_codes WHERE user_id = $1`, userID); err != nil {
		return nil, err
	}
	for _, code := range codes {
		if _, err := tx.Exec(ctx,
			`INSERT INTO twofa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
			userID, sha256Hex(code)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return codes, nil
}

// ---- mfa_verified session minting ----

// mintMFASession mints a token pair whose access token carries
// mfa_verified=true and replicates buildSession's store writes for it
// (auth.go untouched): the same sessions store Create, plus the durable
// session row when the subject resolves to a users id.
func (s *Server) mintMFASession(ctx context.Context, subject, role string, now time.Time) (gen.Session, error) {
	accessExp := now.Add(s.cfg.AccessTTL)
	accessToken, err := s.mintAccessToken(Claims{
		Role:        role,
		MFAVerified: true,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subject,
			ID:        newRequestID(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(accessExp),
		},
	})
	if err != nil {
		return gen.Session{}, err
	}
	refreshToken, err := newRefreshToken()
	if err != nil {
		return gen.Session{}, err
	}
	refreshExp := now.Add(s.cfg.RefreshTTL)
	record := store.Session{
		Subject:          subject,
		Role:             role,
		RefreshTokenHash: sha256Hex(refreshToken),
		AccessTokenHash:  sha256Hex(accessToken),
		ExpiresAt:        refreshExp,
		MfaVerified:      true,
	}
	if err := s.stores.Sessions.Create(ctx, record); err != nil {
		return gen.Session{}, err
	}
	if s.auth != nil {
		// The Redis store is authoritative for the hot path; the durable row
		// is a mirror, so an unresolvable subject degrades to a warning.
		if userID, ok, err := s.twoFaUserID(ctx, subject); err != nil {
			s.logger.Warn("twofa session row lookup failed", "error", err)
		} else if ok {
			if err := s.auth.PersistSession(ctx, auth.SessionRow{
				UserID:           userID,
				Role:             role,
				AccessTokenHash:  record.AccessTokenHash,
				RefreshTokenHash: record.RefreshTokenHash,
				ExpiresAt:        refreshExp,
			}); err != nil {
				s.logger.Warn("twofa session row persistence failed", "error", err)
			}
		}
	}
	return gen.Session{AccessToken: accessToken, RefreshToken: refreshToken}, nil
}

// twoFaSessionResult is the contract TwoFaSessionResult shape (the minted
// pair only; no user projection).
type twoFaSessionResult struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

// ---- handlers ----

// TwoFaEnroll answers GET /auth/2fa/enroll: fresh TOTP secret + otpauth URL
// + one-time recovery codes. Enrollment is not active until the first
// successful POST /auth/2fa/verify.
func (s *Server) TwoFaEnroll(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("twofa enroll failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	userID, ok, err := s.twoFaUserID(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("twofa enroll user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "Account could not be resolved")
		return
	}

	secret, err := newTOTPSecret()
	if err != nil {
		s.logger.Error("twofa enroll secret generation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var enabled bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO twofa_secrets (user_id, secret_base32)
		 VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE SET secret_base32 = EXCLUDED.secret_base32, updated_at = now()
		 RETURNING enabled`, userID, secret).Scan(&enabled); err != nil {
		s.logger.Error("twofa enroll upsert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if enabled {
		writeError(w, http.StatusConflict, "TWO_FA_ALREADY_ENABLED", "Two-factor authentication is already enabled")
		return
	}
	codes, err := s.replaceRecoveryCodes(r.Context(), userID, recoveryCodeN)
	if err != nil {
		s.logger.Error("twofa enroll recovery codes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":        secret,
		"otpauthUrl":    otpauthURL(claims.Subject, secret),
		"qrDataUrl":     nil,
		"recoveryCodes": codes,
	})
}

// TwoFaVerify answers POST /auth/2fa/verify: the first successful TOTP code
// enables two-factor and rotates in a fresh recovery-code set (returned
// once).
func (s *Server) TwoFaVerify(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("twofa verify failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Code == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	userID, ok, err := s.twoFaUserID(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("twofa verify user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "Account could not be resolved")
		return
	}
	secret, err := s.loadTwoFaSecret(r.Context(), userID)
	if err != nil {
		s.logger.Error("twofa verify secret load failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if secret == nil {
		writeError(w, http.StatusConflict, "TWO_FA_NOT_ENABLED", "Two-factor authentication is not enrolled")
		return
	}
	if secret.Enabled {
		writeError(w, http.StatusConflict, "TWO_FA_ALREADY_ENABLED", "Two-factor authentication is already enabled")
		return
	}
	if !verifyTOTP(secret.SecretBase32, body.Code, time.Now()) {
		writeError(w, http.StatusUnauthorized, "TWO_FA_CODE_INVALID", "Invalid or expired authenticator code")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE twofa_secrets SET enabled = true, updated_at = now() WHERE user_id = $1`, userID); err != nil {
		s.logger.Error("twofa verify enable failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	codes, err := s.replaceRecoveryCodes(r.Context(), userID, recoveryCodeN)
	if err != nil {
		s.logger.Error("twofa verify recovery codes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":       true,
		"recoveryCodes": codes,
	})
}

// TwoFaVerifyForSession answers POST /auth/2fa/verify-for-session: confirms
// the enabled TOTP secret and mints an mfa_verified token pair.
func (s *Server) TwoFaVerifyForSession(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("twofa verify-for-session failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Code == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	userID, ok, err := s.twoFaUserID(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("twofa verify-for-session user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "Account could not be resolved")
		return
	}
	secret, err := s.loadTwoFaSecret(r.Context(), userID)
	if err != nil {
		s.logger.Error("twofa verify-for-session secret load failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if secret == nil || !secret.Enabled {
		writeError(w, http.StatusConflict, "TWO_FA_NOT_ENABLED", "Two-factor authentication is not enabled")
		return
	}
	if !verifyTOTP(secret.SecretBase32, body.Code, time.Now()) {
		writeError(w, http.StatusUnauthorized, "TWO_FA_CODE_INVALID", "Invalid or expired authenticator code")
		return
	}
	session, err := s.mintMFASession(r.Context(), claims.Subject, claims.Role, time.Now())
	if err != nil {
		s.logger.Error("twofa verify-for-session mint failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, twoFaSessionResult{
		AccessToken:  session.AccessToken,
		RefreshToken: session.RefreshToken,
	})
}

// TwoFaDisable answers POST /auth/2fa/disable: after a valid TOTP code the
// secret and all recovery codes are removed.
func (s *Server) TwoFaDisable(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("twofa disable failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Code == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	userID, ok, err := s.twoFaUserID(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("twofa disable user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "Account could not be resolved")
		return
	}
	secret, err := s.loadTwoFaSecret(r.Context(), userID)
	if err != nil {
		s.logger.Error("twofa disable secret load failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if secret == nil || !secret.Enabled {
		writeError(w, http.StatusConflict, "TWO_FA_NOT_ENABLED", "Two-factor authentication is not enabled")
		return
	}
	if !verifyTOTP(secret.SecretBase32, body.Code, time.Now()) {
		writeError(w, http.StatusUnauthorized, "TWO_FA_CODE_INVALID", "Invalid or expired authenticator code")
		return
	}
	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("twofa disable tx begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `DELETE FROM twofa_recovery_codes WHERE user_id = $1`, userID); err != nil {
		s.logger.Error("twofa disable recovery delete failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM twofa_secrets WHERE user_id = $1`, userID); err != nil {
		s.logger.Error("twofa disable secret delete failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("twofa disable commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TwoFaRecovery answers POST /auth/2fa/recovery: consumes one single-use
// recovery code (rotating it to used) and mints an mfa_verified token pair.
// The optional newPassword is reserved for a future password-reset extension
// and is not acted on.
func (s *Server) TwoFaRecovery(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("twofa recovery failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body struct {
		Code        string `json:"code"`
		NewPassword string `json:"newPassword"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Code == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.NewPassword != "" {
		s.logger.Warn("twofa recovery newPassword ignored: password-reset extension not implemented")
	}
	userID, ok, err := s.twoFaUserID(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("twofa recovery user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "Account could not be resolved")
		return
	}
	secret, err := s.loadTwoFaSecret(r.Context(), userID)
	if err != nil {
		s.logger.Error("twofa recovery secret load failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if secret == nil || !secret.Enabled {
		writeError(w, http.StatusConflict, "TWO_FA_NOT_ENABLED", "Two-factor authentication is not enabled")
		return
	}
	hash := sha256Hex(body.Code)
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE twofa_recovery_codes SET used_at = now()
		 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`, userID, hash)
	if err != nil {
		s.logger.Error("twofa recovery consume failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		var usedAt *time.Time
		if err := s.db.Pool().QueryRow(r.Context(),
			`SELECT used_at FROM twofa_recovery_codes WHERE user_id = $1 AND code_hash = $2`,
			userID, hash).Scan(&usedAt); err == pgx.ErrNoRows {
			writeError(w, http.StatusUnauthorized, "TWO_FA_CODE_INVALID", "Unknown recovery code")
			return
		} else if err != nil {
			s.logger.Error("twofa recovery lookup failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeError(w, http.StatusUnauthorized, "TWO_FA_RECOVERY_CODE_USED", "Recovery code was already used")
		return
	}
	session, err := s.mintMFASession(r.Context(), claims.Subject, claims.Role, time.Now())
	if err != nil {
		s.logger.Error("twofa recovery mint failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, twoFaSessionResult{
		AccessToken:  session.AccessToken,
		RefreshToken: session.RefreshToken,
	})
}
