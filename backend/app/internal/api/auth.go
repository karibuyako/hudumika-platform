package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/hudumika/api-backend/internal/gen"

	"github.com/hudumika/api-backend/internal/store"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

var errNotNil = errors.New("trailing JSON value")

type Claims struct {
	Role        string `json:"role"`
	MFAVerified bool   `json:"mfa_verified"`
	jwt.RegisteredClaims
}

// contextKey is the type for request-context values injected by middleware.
type contextKey string

// claimsContextKey carries the authenticated Claims through the request.
const claimsContextKey contextKey = "hudumika.claims"

// ClaimsFromContext returns the authenticated claims injected by RequireAuth.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsContextKey).(*Claims)
	return c, ok
}

// issuedSession pairs the contract Session with its stored record.
type issuedSession struct {
	session gen.Session
	record  store.Session
}

// issueSession verifies an OTP subject into a brand-new session: a 15-minute
// JWT access token plus a fresh opaque refresh token whose SHA-256 hash is
// stored in the session store.
func (s *Server) issueSession(ctx context.Context, subject string, now time.Time) (gen.Session, error) {
	out, err := s.buildSession(ctx, subject, "customer", now)
	if err != nil {
		return gen.Session{}, err
	}
	if err := s.stores.Sessions.Create(ctx, out.record); err != nil {
		return gen.Session{}, err
	}
	return out.session, nil
}

// buildSession mints the token pair and its store record without persisting.
func (s *Server) buildSession(ctx context.Context, subject, role string, now time.Time) (issuedSession, error) {
	accessExp := now.Add(s.cfg.AccessTTL)
	accessToken, err := s.mintAccessToken(Claims{
		Role: role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subject,
			ID:        newRequestID(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(accessExp),
		},
	})
	if err != nil {
		return issuedSession{}, err
	}

	refreshToken, err := newRefreshToken()
	if err != nil {
		return issuedSession{}, err
	}
	refreshExp := now.Add(s.cfg.RefreshTTL)

	return issuedSession{
		session: gen.Session{
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			User: gen.User{
				Id:        newUUID(subject),
				Phone:     subject,
				Roles:     []gen.RoleSummary{{Role: gen.RoleSummaryRole(role)}},
				CreatedAt: now,
			},
		},
		record: store.Session{
			Subject:          subject,
			Role:             role,
			RefreshTokenHash: sha256Hex(refreshToken),
			AccessTokenHash:  sha256Hex(accessToken),
			ExpiresAt:        refreshExp,
		},
	}, nil
}

// mintAccessToken signs claims into a JWT access token with the server
// secret. buildSession uses it; tests mint role/MFA variants through it.
func (s *Server) mintAccessToken(c Claims) (string, error) {
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(s.cfg.JWTSecret)
	if err != nil {
		return "", fmt.Errorf("sign access token: %w", err)
	}
	return tok, nil
}

// newRefreshToken returns 32 cryptographically random bytes, base64url-encoded.
// It is returned to the client exactly once; only its SHA-256 hash is stored.
func newRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (s *Server) parseToken(token string) (*Claims, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return s.cfg.JWTSecret, nil
	})
	if err != nil || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

// RequireAuth authenticates the bearer token, enforces the route policy
// (rbac.go), and injects the claims into the request context. The downstream
// handler is wrapped in MaskPII so every authenticated response is masked by
// default (AUTH.md: sensitive fields are masked in API responses by default).
// /auth/* and public routes are outside this middleware and unmasked.
func (s *Server) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isPublicPath(r) {
			next.ServeHTTP(w, r)
			return
		}
		token := bearerToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
			return
		}
		claims, err := s.parseToken(token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
			return
		}
		// Admin network isolation (DEPLOYMENT.md): when ADMIN_ALLOWED_IPS is
		// set, /admin/* is reachable only from allow-listed client IPs. The
		// gate runs before the RBAC/MFA policy so a denied request never
		// reaches a handler.
		if strings.HasPrefix(r.URL.Path, "/admin/") && !s.adminIPAllowed(r) {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "Admin surface is restricted by network policy")
			return
		}
		if !enforcePolicy(w, r.URL.Path, claims) {
			return
		}
		ctx := context.WithValue(r.Context(), claimsContextKey, claims)
		s.MaskPII(next).ServeHTTP(w, r.WithContext(ctx))
	})
}

// isPublicPath reports whether the contract marks the route as unauthenticated
// (no bearerAuth in API-CONTRACT.yaml): public discovery reads and payment
// provider webhooks. Public responses are NOT PII-masked.
func isPublicPath(r *http.Request) bool {
	p := r.URL.Path
	switch {
	case p == "/cities", p == "/services":
		return true
	case p == "/promotions":
		// Public deal discovery; merchant-owned promotion surfaces and
		// coupons stay authenticated.
		return r.Method == http.MethodGet
	case p == "/group-buys":
		// Public deal discovery (merchant-owned group-buy surfaces stay
		// authenticated).
		return r.Method == http.MethodGet
	case p == "/monitoring/errors":
		// Client-side error reporting — the contract marks it unauthenticated.
		return true
	case p == "/docs", p == "/docs/openapi.yaml":
		// Public developer surface (customer_sync.go): the contract spec
		// and its minimal HTML index.
		return true
	case p == "/merchants":
		return r.Method == http.MethodGet
	case len(p) > len("/merchants/") && strings.HasPrefix(p, "/merchants/"):
		// Public merchant profile: GET /merchants/{merchantId}. Own-profile
		// and admin surfaces stay authenticated.
		rest := strings.TrimPrefix(p, "/merchants/")
		return r.Method == http.MethodGet && !strings.HasPrefix(rest, "me") && !strings.Contains(rest, "/")
	case strings.HasPrefix(p, "/payments/webhooks/"):
		return true
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/catalogues/"):
		// Public merchant catalogue: GET /catalogues/{merchantId}. The
		// merchant's own surface (/catalogues/me, imports, exports) stays
		// authenticated.
		rest := strings.TrimPrefix(p, "/catalogues/")
		return rest != "" && !strings.HasPrefix(rest, "me") && !strings.Contains(rest, "/")
	}
	return false
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	return ""
}

func newRequestID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

func newUUID(s string) openapi_types.UUID {
	u, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return u
}
