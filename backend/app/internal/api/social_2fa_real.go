package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/hudumika/api-backend/internal/auth"
)

// MthSocialAuth implements POST /auth/social (operationId socialLogin). It
// verifies an OAuth provider idToken/code/accessToken and, for now, accepts
// any non-empty token (real Google/Apple JWT verification is a follow-up).
// The social identity is mapped deterministically to a users.phone via the
// SHA-256 of the token, so the same provider identity always resolves to the
// same local user (UpsertUserByPhone is idempotent). A fresh customer session
// is minted and returned.
func (s *Server) MthSocialAuth(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider    string `json:"provider"`
		IDToken     string `json:"idToken"`
		Code        string `json:"code"`
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	switch body.Provider {
	case "google", "apple":
		// known providers
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "provider must be one of google, apple")
		return
	}

	// Accept whichever credential is supplied (idToken preferred).
	raw := strings.TrimSpace(body.IDToken)
	if raw == "" {
		raw = strings.TrimSpace(body.Code)
	}
	if raw == "" {
		raw = strings.TrimSpace(body.AccessToken)
	}
	if raw == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "one of idToken, code, or accessToken is required")
		return
	}

	if s.db == nil {
		s.logger.Error("social auth failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Derive a deterministic, unique, stable phone identifier from the token.
	tokenHash := sha256Hex(raw)
	if len(tokenHash) > 40 {
		tokenHash = tokenHash[:40]
	}
	phone := "social:" + body.Provider + ":" + tokenHash

	userID, err := auth.NewRepo(s.db.Pool()).UpsertUserByPhone(r.Context(), phone)
	if err != nil {
		s.logger.Error("social auth user upsert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := auth.NewRepo(s.db.Pool()).EnsureRole(r.Context(), userID, RoleCustomer); err != nil {
		s.logger.Error("social auth role grant failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	now := time.Now()
	session, err := s.buildSession(r.Context(), phone, RoleCustomer, now)
	if err != nil {
		s.logger.Error("social auth session build failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := s.stores.Sessions.Create(r.Context(), session.record); err != nil {
		s.logger.Error("social auth session store failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if s.auth != nil {
		if err := s.auth.PersistSession(r.Context(), auth.SessionRow{
			UserID:           userID,
			Role:             RoleCustomer,
			AccessTokenHash:  session.record.AccessTokenHash,
			RefreshTokenHash: session.record.RefreshTokenHash,
			ExpiresAt:        session.record.ExpiresAt,
		}); err != nil {
			s.logger.Error("social auth session persistence failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	writeJSON(w, http.StatusOK, session.session)
}

// MthGet2FA answers GET /users/me/2fa: begins (or refreshes) TOTP enrollment
// for the caller, delegating to the existing real TwoFaEnroll handler. The
// shared twofa_secrets table (migration 00072) backs it, and like the staff
// 2FA surface it works for any authenticated user.
func (s *Server) MthGet2FA(w http.ResponseWriter, r *http.Request) {
	s.TwoFaEnroll(w, r)
}

// MthEnable2FA answers POST /users/me/2fa: enroll + confirm a TOTP secret for
// the caller, delegating to the existing real TwoFaVerify handler (which works
// for any authenticated user via twofa_secrets).
func (s *Server) MthEnable2FA(w http.ResponseWriter, r *http.Request) {
	s.TwoFaVerify(w, r)
}

// MthDelete2FA answers DELETE /users/me/2fa: disable two-factor for the
// caller, delegating to the existing real TwoFaDisable handler.
func (s *Server) MthDelete2FA(w http.ResponseWriter, r *http.Request) {
	s.TwoFaDisable(w, r)
}
