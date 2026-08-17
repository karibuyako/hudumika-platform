package api

// Unit tests for the TOTP two-factor extension (twofa.go). No PostgreSQL:
// the DB-backed HTTP surface answers 500 INTERNAL_ERROR without a database
// (like every other DB handler), so the full enroll→verify→session flow
// lives in twofa_integration_test.go (build tag integration). Here we cover
// the pure TOTP math (RFC 6238 vectors + window), the enrollment material
// shape, and the mfa_verified minting path.

import (
	"encoding/base32"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestTOTPRFC6238Vectors pins the manual TOTP implementation to the RFC 6238
// appendix-B SHA-1 vectors (ASCII secret "12345678901234567890", 30s step).
// The published 8-digit values are truncated to the trailing 6 digits; the
// T column of the table IS the counter (time/30), so the time passed to the
// code generator is counter seconds.
func TestTOTPRFC6238Vectors(t *testing.T) {
	secret := base32.StdEncoding.EncodeToString([]byte("12345678901234567890"))
	cases := []struct {
		timeSec int64
		want    string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}
	for _, tc := range cases {
		got, err := totpCode(secret, time.Unix(tc.timeSec, 0))
		if err != nil {
			t.Fatalf("totpCode(%d): %v", tc.timeSec, err)
		}
		if got != tc.want {
			t.Errorf("time %d: code = %s, want %s", tc.timeSec, got, tc.want)
		}
	}
}

// TestVerifyTOTPWindow asserts the verifier accepts the current step and a
// ±1-step drift and rejects a wrong code and a >1-step drift.
func TestVerifyTOTPWindow(t *testing.T) {
	now := time.Now()
	secret := "JBSWY3DPEHPK3PXP"
	current, err := totpCode(secret, now)
	if err != nil {
		t.Fatalf("totpCode: %v", err)
	}
	if !verifyTOTP(secret, current, now) {
		t.Fatal("current-step code rejected")
	}
	plusOne, err := totpCode(secret, now.Add(totpStepSeconds*time.Second))
	if err != nil {
		t.Fatalf("totpCode(+1): %v", err)
	}
	if !verifyTOTP(secret, plusOne, now) {
		t.Fatal("+1-step code rejected (clock drift must be tolerated)")
	}
	minusOne, err := totpCode(secret, now.Add(-totpStepSeconds*time.Second))
	if err != nil {
		t.Fatalf("totpCode(-1): %v", err)
	}
	if !verifyTOTP(secret, minusOne, now) {
		t.Fatal("-1-step code rejected (clock drift must be tolerated)")
	}
	if verifyTOTP(secret, "000000", now) {
		t.Fatal("wrong code accepted")
	}
	farFuture, err := totpCode(secret, now.Add(4*totpStepSeconds*time.Second))
	if err != nil {
		t.Fatalf("totpCode(+4): %v", err)
	}
	if verifyTOTP(secret, farFuture, now) {
		t.Fatal("code outside the ±1-step window accepted")
	}
}

// TestTwoFaEnrollMaterialShape covers the DB-free parts of GET
// /auth/2fa/enroll: the generated secret is valid unpadded base32 and the
// otpauth URL carries the account, secret and the RFC 6238 parameters.
func TestTwoFaEnrollMaterialShape(t *testing.T) {
	secret, err := newTOTPSecret()
	if err != nil {
		t.Fatalf("newTOTPSecret: %v", err)
	}
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(decoded) != 20 {
		t.Fatalf("secret %q is not 20 bytes of base32: %v", secret, err)
	}
	if _, err := totpCode(secret, time.Now()); err != nil {
		t.Fatalf("secret does not produce a code: %v", err)
	}
	u := otpauthURL("u-admin-1", secret)
	for _, want := range []string{"otpauth://totp/HUDumika:u-admin-1", "secret=" + secret, "issuer=HUDumika", "algorithm=SHA1", "digits=6", "period=30"} {
		if !strings.Contains(u, want) {
			t.Errorf("otpauth URL %q missing %q", u, want)
		}
	}
}

// TestTwoFaEnrollWithoutDB is the no-database guard: the handler answers the
// INTERNAL_ERROR envelope exactly like the other DB-backed surfaces.
func TestTwoFaEnrollWithoutDB(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-twofa-1", RoleAdmin, false)
	req := httptest.NewRequest(http.MethodGet, "/auth/2fa/enroll", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q", errBody.Code)
	}
}

// TestTwoFaRoutesRequireAuth: without a bearer token every 2FA route answers
// 401 before the (DB-less) handler can be reached.
func TestTwoFaRoutesRequireAuth(t *testing.T) {
	h := newTestServer().Router()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/auth/2fa/enroll"},
		{http.MethodPost, "/auth/2fa/verify"},
		{http.MethodPost, "/auth/2fa/verify-for-session"},
		{http.MethodPost, "/auth/2fa/disable"},
		{http.MethodPost, "/auth/2fa/recovery"},
	} {
		rec := doJSON(t, h, tc.method, tc.path, `{"code":"000000"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s status = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

// TestMintMFASession mints through the same path TwoFaVerifyForSession uses
// (DB-free: sessions live in the store, not PostgreSQL) and asserts the
// access token's claims carry mfa_verified=true with the right role/subject,
// and that the session record round-trips the flag.
func TestMintMFASession(t *testing.T) {
	s := newTestServer()
	now := time.Now()
	session, err := s.mintMFASession(t.Context(), "u-twofa-mint", RoleAdmin, now)
	if err != nil {
		t.Fatalf("mintMFASession: %v", err)
	}
	claims := &Claims{}
	if _, err := jwt.ParseWithClaims(session.AccessToken, claims, func(tok *jwt.Token) (any, error) {
		return s.cfg.JWTSecret, nil
	}); err != nil {
		t.Fatalf("parse access token: %v", err)
	}
	if !claims.MFAVerified {
		t.Fatal("access token lacks the mfa_verified claim")
	}
	if claims.Role != RoleAdmin || claims.Subject != "u-twofa-mint" {
		t.Fatalf("claims = role %q subject %q", claims.Role, claims.Subject)
	}
	record, err := s.stores.Sessions.Get(t.Context(), sha256Hex(session.RefreshToken))
	if err != nil || record == nil {
		t.Fatalf("session record = %+v, err %v", record, err)
	}
	if !record.MfaVerified {
		t.Fatal("stored session record lacks mfa_verified")
	}
}
