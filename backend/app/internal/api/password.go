package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// AUTH CHANGE-PASSWORD (API-CONTRACT.yaml /auth/change-password;
// ERROR-CODES.md §Password change). The platform is OTP-first: users log in
// with one-time codes and users.password_hash is NULL until the password-login
// milestone lands. ChangePassword therefore only works for accounts that
// already carry a hash (seeded during that milestone); accounts without one
// answer 422 PASSWORD_CHANGE_INVALID.
//
// The milestone hash scheme is stored in users.password_hash as
//
//	sha256$<salt-hex>$<hash-hex>
//
// where hash = SHA-256(salt-bytes || password-bytes). It uses stdlib crypto
// only (golang.org/x/crypto/bcrypt is not a dependency): a fresh random salt
// per password, and constant-time comparison via crypto/subtle. It must be
// replaced by bcrypt/argon2 when the password-login milestone lands.
const (
	passwordHashPrefix = "sha256$"
	passwordSaltBytes  = 16
	passwordMinLength  = 8   // contract minLength
	passwordMaxLength  = 128 // contract maxLength
)

// passwordUserRow is the password-change projection of a users row.
type passwordUserRow struct {
	id           string
	passwordHash *string
}

// passwordUser resolves the authenticated session to the users row the
// password change will mutate. The row is missing → (nil, nil); the error is
// wrapped for the caller's 500 path.
func (s *Server) passwordUser(ctx context.Context, phone string) (*passwordUserRow, error) {
	row := &passwordUserRow{}
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id::text, password_hash FROM users WHERE phone = $1`, phone).
		Scan(&row.id, &row.passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("password: resolve user %q: %w", phone, err)
	}
	return row, nil
}

// hashPassword derives the milestone password hash for a plaintext password:
// a fresh random salt and SHA-256(salt || password), stored as
// "sha256$<salt-hex>$<hash-hex>".
func hashPassword(password string) (string, error) {
	salt := make([]byte, passwordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password: salt: %w", err)
	}
	sum := sha256.Sum256(append(salt, []byte(password)...))
	return passwordHashPrefix + hex.EncodeToString(salt) + "$" + hex.EncodeToString(sum[:]), nil
}

// verifyPassword reports whether password matches the stored milestone hash
// ("sha256$<salt-hex>$<hash-hex>") in constant time. Foreign or malformed
// hashes never match.
func verifyPassword(stored, password string) bool {
	if !strings.HasPrefix(stored, passwordHashPrefix) {
		return false
	}
	rest := strings.TrimPrefix(stored, passwordHashPrefix)
	parts := strings.Split(rest, "$")
	if len(parts) != 2 {
		return false
	}
	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}
	sum := sha256.Sum256(append(salt, []byte(password)...))
	want := hex.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(want), []byte(parts[1])) == 1
}

// ChangePassword replaces the session user's password hash (POST
// /auth/change-password). The contract body is {currentPassword,
// newPassword}. Accounts without a password hash (OTP-first platform) are
// rejected with 422 PASSWORD_CHANGE_INVALID; a wrong current password is a
// 401 PASSWORD_CHANGE_INVALID; an invalid new password (too short, too
// long, or identical to the current one) is a 422 PASSWORD_CHANGE_INVALID.
// Success answers 204.
func (s *Server) ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		// The router serves contract /auth/* paths (router.go /auth
		// subrouter) without RequireAuth, so the handler authenticates the
		// bearer token itself — same checks as RequireAuth.
		token := bearerToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
			return
		}
		parsed, err := s.parseToken(token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
			return
		}
		if !enforcePolicy(w, r.URL.Path, parsed) {
			return
		}
		claims = parsed
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var body gen.ChangePasswordJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	user, err := s.passwordUser(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("password change user lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return
	}
	if user.passwordHash == nil || *user.passwordHash == "" {
		writeError(w, http.StatusUnprocessableEntity, "PASSWORD_CHANGE_INVALID",
			"Password login is not set up for this account; OTP remains the only sign-in method")
		return
	}
	newLen := len(body.NewPassword)
	if newLen < passwordMinLength || newLen > passwordMaxLength {
		writeError(w, http.StatusUnprocessableEntity, "PASSWORD_CHANGE_INVALID",
			"newPassword must be between 8 and 128 characters")
		return
	}
	if !verifyPassword(*user.passwordHash, body.CurrentPassword) {
		writeError(w, http.StatusUnauthorized, "PASSWORD_CHANGE_INVALID", "Current password is incorrect")
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.NewPassword), []byte(body.CurrentPassword)) == 1 {
		writeError(w, http.StatusUnprocessableEntity, "PASSWORD_CHANGE_INVALID",
			"newPassword must differ from currentPassword")
		return
	}
	next, err := hashPassword(body.NewPassword)
	if err != nil {
		s.logger.Error("password change hashing failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2::uuid`,
		next, user.id); err != nil {
		s.logger.Error("password change update failed", "user", user.id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
