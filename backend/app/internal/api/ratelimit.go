package api

import (
	"net/http"
	"time"
)

// Per-user rate limiting hardening (DEPLOYMENT.md): a fixed-window budget per
// authenticated subject (the JWT subject, the phone) applied to the whole
// generated tree. Requests without a valid bearer token — public discovery
// reads, provider webhooks, /docs — pass through untouched; the limiter only
// bounds authenticated traffic. The budget is RATE_LIMIT_PER_MIN (default
// 300/min, config.Config.RateLimitPerMin); a non-positive budget disables
// the middleware entirely. Redis-backed through the shared store.RateLimiter
// (in-memory in tests), the same backend the OTP and IP limiters use, so a
// limiter failure degrades to pass-through, never a hard failure.

// perUserRateLimit enforces the fixed-window per-subject budget on the
// wrapped tree. The X-RateLimit-* trio rides both the 429 and the success
// response: the window budget, what this window has left, and the unix second
// the window resets (Retry-After on denial, the end of the window on
// success).
func (s *Server) perUserRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := s.cfg.RateLimitPerMin
		if limit <= 0 {
			next.ServeHTTP(w, r)
			return
		}
		token := bearerToken(r)
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		claims, err := s.parseToken(token)
		if err != nil || claims.Subject == "" {
			// Invalid or anonymous: the auth middleware downstream decides;
			// the limiter never rejects unauthenticated traffic.
			next.ServeHTTP(w, r)
			return
		}
		now := time.Now()
		decision, err := s.stores.Rate.Allow(r.Context(), "user:"+claims.Subject, int64(limit), time.Minute, now)
		if err != nil {
			s.logger.Error("per-user rate limit store failed", "subject", claims.Subject, "error", err)
			next.ServeHTTP(w, r)
			return
		}
		if !decision.Allowed {
			s.logger.Warn("per-user rate limited", "subject", claims.Subject)
			writeRateLimitHeaders(w, int64(limit), 0, decision.RetryAfter)
			writeErrorWithRetry(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests", int(decision.RetryAfter.Seconds()))
			return
		}
		writeRateLimitHeaders(w, int64(limit), rateLimitRemaining(decision, int64(limit)), time.Minute)
		next.ServeHTTP(w, r)
	})
}

// RateLimitedRouter returns the full route tree wrapped in the per-user rate
// limit. main.go wires it as the http.Server handler, so the limiter sits
// above the generated tree without touching router.go.
func (s *Server) RateLimitedRouter() http.Handler {
	return s.perUserRateLimit(s.Router())
}