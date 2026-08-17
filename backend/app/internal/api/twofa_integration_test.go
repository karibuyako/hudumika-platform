//go:build integration

// Full TOTP two-factor flows against real PostgreSQL + Redis (docker
// compose; `make test-integration` after `make migrate`). Every test seeds
// only its own user and cleans up exactly its own rows.
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestTwoFaFullFlow drives enroll → verify (enable) → verify-for-session →
// recovery (consume + reuse rejection) → disable against PostgreSQL.
func TestTwoFaFullFlow(t *testing.T) {
	s, pool := newPersistentServer(t)
	h := s.Router()

	// Seed a staff user and mint its access token (no MFA claim yet).
	var userID uuid.UUID
	if err := pool.QueryRow(t.Context(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`,
		"+2559twofa"+time.Now().Format("150405")+t.Name()).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(t.Context(), `DELETE FROM twofa_recovery_codes WHERE user_id = $1`, userID)
		_, _ = pool.Exec(t.Context(), `DELETE FROM twofa_secrets WHERE user_id = $1`, userID)
		_, _ = pool.Exec(t.Context(), `DELETE FROM users WHERE id = $1`, userID)
	})
	subject := userID.String()
	token := tokenFor(t, s, subject, RoleAdmin, false)
	authed := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// Enroll: base32 secret + otpauth URL + 10 recovery codes.
	rec := authed(http.MethodGet, "/auth/2fa/enroll", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll status = %d (%s)", rec.Code, rec.Body)
	}
	var enroll struct {
		Secret        string   `json:"secret"`
		OtpauthURL    string   `json:"otpauthUrl"`
		QrDataURL     *string  `json:"qrDataUrl"`
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&enroll); err != nil {
		t.Fatalf("decode enroll: %v", err)
	}
	if enroll.Secret == "" || enroll.OtpauthURL == "" || len(enroll.RecoveryCodes) != recoveryCodeN {
		t.Fatalf("enroll result incomplete: %+v", enroll)
	}

	// First verify enables 2FA and returns a fresh code set.
	code, err := totpCode(enroll.Secret, time.Now())
	if err != nil {
		t.Fatalf("totpCode: %v", err)
	}
	rec = authed(http.MethodPost, "/auth/2fa/verify", `{"code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify status = %d (%s)", rec.Code, rec.Body)
	}
	var enabled struct {
		Enabled       bool     `json:"enabled"`
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&enabled); err != nil {
		t.Fatalf("decode verify: %v", err)
	}
	if !enabled.Enabled || len(enabled.RecoveryCodes) != recoveryCodeN {
		t.Fatalf("verify result incomplete: %+v", enabled)
	}
	// Re-verify is refused: already enabled.
	rec = authed(http.MethodPost, "/auth/2fa/verify", `{"code":"`+code+`"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-verify status = %d, want 409", rec.Code)
	}

	// verify-for-session mints an mfa_verified access token.
	rec = authed(http.MethodPost, "/auth/2fa/verify-for-session", `{"code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify-for-session status = %d (%s)", rec.Code, rec.Body)
	}
	var session twoFaSessionResult
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatalf("decode verify-for-session: %v", err)
	}
	claims, err := s.parseToken(session.AccessToken)
	if err != nil {
		t.Fatalf("parse mfa token: %v", err)
	}
	if !claims.MFAVerified || claims.Role != RoleAdmin || claims.Subject != subject {
		t.Fatalf("claims = %+v", claims)
	}

	// Recovery: consume one code, then reuse must fail.
	recoveryCode := enabled.RecoveryCodes[0]
	rec = authed(http.MethodPost, "/auth/2fa/recovery", `{"code":"`+recoveryCode+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("recovery status = %d (%s)", rec.Code, rec.Body)
	}
	var recovered twoFaSessionResult
	if err := json.NewDecoder(rec.Body).Decode(&recovered); err != nil {
		t.Fatalf("decode recovery: %v", err)
	}
	if recovered.AccessToken == "" || recovered.RefreshToken == "" {
		t.Fatal("recovery minted empty tokens")
	}
	rec = authed(http.MethodPost, "/auth/2fa/recovery", `{"code":"`+recoveryCode+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("recovery reuse status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode reuse error: %v", err)
	}
	if errBody.Code != "TWO_FA_RECOVERY_CODE_USED" {
		t.Fatalf("reuse error code = %q", errBody.Code)
	}
	// Unknown recovery code is a plain invalid code.
	rec = authed(http.MethodPost, "/auth/2fa/recovery", `{"code":"AAAA-BBBB-CCCC-DDDD"}`)
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode unknown-code error: %v", err)
	}
	if rec.Code != http.StatusUnauthorized || errBody.Code != "TWO_FA_CODE_INVALID" {
		t.Fatalf("unknown recovery code: status %d code %q", rec.Code, errBody.Code)
	}

	// Disable: wrong code rejected, right code removes everything.
	rec = authed(http.MethodPost, "/auth/2fa/disable", `{"code":"000000"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("disable wrong code status = %d, want 401", rec.Code)
	}
	rec = authed(http.MethodPost, "/auth/2fa/disable", `{"code":"`+code+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("disable status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authed(http.MethodPost, "/auth/2fa/verify-for-session", `{"code":"`+code+`"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("verify-for-session after disable status = %d, want 409", rec.Code)
	}
	var notEnabled gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&notEnabled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if notEnabled.Code != "TWO_FA_NOT_ENABLED" {
		t.Fatalf("error code = %q, want TWO_FA_NOT_ENABLED", notEnabled.Code)
	}
}
