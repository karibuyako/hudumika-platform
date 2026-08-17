package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/gen"
)

// Per-IP verification budgets (AUTH.md: verification is rate-limited per IP
// and per destination).
const (
	verifyRateLimitIP  int64 = 20
	verifyRateWindowIP       = time.Minute
)

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	// otel must sit above metrics so the span covers the recorded request,
	// and both above logRequests so they see the final status. /healthz and
	// /readyz run through the same chain: they are real requests and their
	// status is load-balancer signal worth alerting on (MONITORING.md).
	r.Use(s.otelMiddleware)
	r.Use(s.metricsMiddleware)
	r.Use(s.logRequests)
	r.Use(s.cors)

	r.Get("/metrics", s.metrics)
	r.Get("/healthz", s.health)
	r.Get("/readyz", s.ready)

	// /ws (contract /api/ws after the gateway strips the /api/v1 base path)
	// is deliberately outside the auth-wrapped tree: the handler authenticates
	// itself (Authorization bearer or ?token=) before upgrading, so the 401
	// envelope can be a plain JSON response instead of a failed handshake.
	r.Get("/ws", s.HandleWebSocket)

	// /docs/* is the public developer surface (customer_sync.go): the
	// contract spec (served raw with Content-Type application/yaml — the
	// bytes are the embedded spec JSON) and a minimal HTML index of the
	// top-level resource groups. Both sit outside the auth-wrapped tree and
	// are named in isPublicPath (auth.go) so the generated fallback and any
	// auth audit keep seeing them as public.
	r.Get("/docs", s.GetDocs)
	r.Get("/docs/openapi.yaml", s.GetOpenAPISpec)

	// /internal/* is the staging-only customer simulator (ARCHITECTURE.md).
	// It sits OUTSIDE the auth-wrapped tree: every flow mints its own
	// customer/merchant sessions through the server's mint path. The
	// simulatorGate answers 403 FORBIDDEN unless SIMULATOR_KEY is set
	// (staging/dev only; never production) and the x-internal-key header
	// matches.
	r.Route("/internal", func(r chi.Router) {
		r.Use(s.simulatorGate)
		r.Post("/simulate/order", s.SimulateOrderFlow)
		r.Post("/simulate/chat", s.SimulateChatFlow)
		r.Post("/simulate/rush", s.SimulateRushFlow)
	})

	r.Route("/auth", func(r chi.Router) {
		r.Post("/request-otp", s.RequestOtp)
		r.With(s.rateLimitIP("verify-otp", verifyRateLimitIP, verifyRateWindowIP)).Post("/verify-otp", s.VerifyOtp)
		r.Post("/refresh", s.RefreshToken)
		r.Post("/logout", s.Logout)
		// Contract /auth paths without a manual handler (e.g.
		// /auth/change-password) fall through to the generated interface so
		// they answer the NOT_IMPLEMENTED envelope instead of a blank 404.
		// The route context is reset because the parent subrouter already
		// stripped the /auth prefix from RoutePath.
		fallback := chi.NewRouter()
		gen.HandlerFromMux(s, fallback)
		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), chi.RouteCtxKey, chi.NewRouteContext())
			fallback.ServeHTTP(w, r.WithContext(ctx))
		})
	})

	r.Route("/", func(r chi.Router) {
		r.Use(s.RequireAuth)
		r.Use(s.Idempotency)
		if s.db != nil {
			// Audit every money/status/moderation mutation (M5). Insert
			// failures are logged by the middleware, never fail the request.
			r.Use(audit.NewMiddleware(audit.NewPg(s.db.Pool()), s.logger, func(ctx context.Context) (string, string) {
				if c, ok := ClaimsFromContext(ctx); ok {
					return c.Subject, c.Role
				}
				return "", ""
			}).Handler)
		}
		// Push-token registry (NOTIFICATIONS.md documented extension): the
		// contract now declares the three push-token endpoints
		// (/notifications/me/push-token POST/DELETE,
		// /notifications/me/push-tokens GET), so they mount through the
		// generated tree below (gen.HandlerFromMux) like every other
		// contract route.
		// Admin webhook ops extension (webhook_admin.go): the contract only
		// defines GET /admin/webhooks; the delivery list + manual retry are
		// documented extensions mounted before the generated surface so they
		// win over the generated 404/501 fallbacks.
		r.Get("/admin/webhooks/deliveries", s.AdminListWebhookDeliveries)
		r.Post("/admin/webhooks/deliveries/{deliveryId}/retry", s.AdminRetryWebhookDelivery)
		// Customer offline replay (customer_sync.go, ARCHITECTURE.md offline
		// contract extended to customers): a documented-extension endpoint
		// mirroring the rider sync batch, mounted before the generated
		// fallback so no contract route can shadow it.
		r.Post("/sync/batch", s.SyncCustomerBatch)
		gen.HandlerFromMux(s, r)
	})

	return r
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
}

// rateLimitIP enforces a fixed-window per-IP budget on a route group via the
// shared Redis-backed limiter (in-memory in tests). On store failure the
// request passes through (log + degrade, never break the request). The
// X-RateLimit-* trio rides both the 429 and the success response: the
// window budget, what this window has left, and the unix second the window
// resets (RetryAfter on denial, the end of the window on success).
func (s *Server) rateLimitIP(action string, limit int64, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			now := time.Now()
			decision, err := s.stores.Rate.Allow(r.Context(), "ip:"+clientIP(r), limit, window, now)
			if err != nil {
				s.logger.Error("rate limit store failed", "action", action, "error", err)
				next.ServeHTTP(w, r)
				return
			}
			if !decision.Allowed {
				s.logger.Warn("ip rate limited", "action", action, "ip", clientIP(r))
				writeRateLimitHeaders(w, limit, 0, decision.RetryAfter)
				writeErrorWithRetry(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests", int(decision.RetryAfter.Seconds()))
				return
			}
			writeRateLimitHeaders(w, limit, rateLimitRemaining(decision, limit), window)
			next.ServeHTTP(w, r)
		})
	}
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if ip := strings.TrimSpace(part); ip != "" {
				return ip
			}
		}
	}
	return r.RemoteAddr
}

// ready is the deploy gate: it returns 503 when any configured dependency
// (PostgreSQL, Redis) is down — or when nothing is configured at all. When a
// dependency is not configured it is not part of readiness in development.
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		bad     []string
		checked bool
	)
	check := func(name string, fn func() error) {
		checked = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				bad = append(bad, name)
				mu.Unlock()
			}
		}()
	}

	if s.db != nil {
		check("postgres", func() error { return s.db.Ping(r.Context()) })
	}
	if s.stores != nil && s.stores.Redis != nil {
		check("redis", func() error { return s.stores.Redis.Ping(r.Context()) })
	}
	wg.Wait()

	if !checked {
		// No dependency configured: the process is not ready to serve.
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unavailable",
			"down":   []string{"no dependencies configured"},
		})
		return
	}
	if len(bad) > 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unavailable",
			"down":   bad,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		// The generated Unimplemented handlers answer 501 with an empty body;
		// fill the envelope only then. Handlers that already wrote their own
		// 501 body (e.g. a 501 for a missing dependency) must not be doubled.
		if ww.Status() == http.StatusNotImplemented && ww.BytesWritten() == 0 {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(gen.ErrorResponse{
				Code:      "NOT_IMPLEMENTED",
				Message:   "This endpoint is defined in the contract but not implemented yet",
				RequestId: newUUID(newRequestID()),
			})
		}
		s.logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if s.allowsOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
			w.Header().Set("Access-Control-Max-Age", "86400")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowsOrigin(origin string) bool {
	for _, o := range s.cfg.CORSOrigins {
		if o == "*" || o == origin {
			return true
		}
	}
	return false
}
