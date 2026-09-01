package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

// StructuredLogger wraps slog with request context helpers.
type StructuredLogger struct {
	logger *slog.Logger
}

// NewStructuredLogger creates a StructuredLogger from the given slog.Logger.
func NewStructuredLogger(l *slog.Logger) *StructuredLogger {
	return &StructuredLogger{logger: l}
}

// WithRequest returns a logger enriched with request fields.
func (l *StructuredLogger) WithRequest(r *http.Request) *slog.Logger {
	return l.logger.With(
		"method", r.Method,
		"path", r.URL.Path,
		"remoteAddr", r.RemoteAddr,
		"requestId", middleware.GetReqID(r.Context()),
	)
}

// HandlerMiddleware returns a middleware that logs each request with
// structured fields using slog.
//
// Example output:
//
//	{"level":"info","method":"POST","path":"/admin/bookings/refund",
//	 "status":200,"latencyMs":45,"requestId":"abc-123","adminId":"uuid",
//	 "ip":"1.2.3.4","msg":"request"}
func (l *StructuredLogger) HandlerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		latency := time.Since(start)

		attrs := []slog.Attr{
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", ww.Status()),
			slog.Int64("latencyMs", latency.Milliseconds()),
			slog.String("requestId", middleware.GetReqID(r.Context())),
			slog.String("ip", extractIP(r)),
		}

		// Enrich with admin identity if present in the request context.
		if c, ok := ClaimsFromContext(r.Context()); ok {
			attrs = append(attrs, slog.String("adminId", c.Subject))
		}

		level := slog.LevelInfo
		if ww.Status() >= 500 {
			level = slog.LevelError
		} else if ww.Status() >= 400 {
			level = slog.LevelWarn
		}

		l.logger.LogAttrs(r.Context(), level, "request", attrs...)
	})
}

// ---------------------------------------------------------------------------
// Convenience structured logging helpers for admin handlers
// ---------------------------------------------------------------------------

// LogAuditEvent logs a structured audit event via slog.
func LogAuditEvent(action, entityType, entityID, actor string, attrs ...slog.Attr) {
	base := []slog.Attr{
		slog.String("category", "audit"),
		slog.String("action", action),
		slog.String("entityType", entityType),
		slog.String("entityId", entityID),
		slog.String("actor", actor),
	}
	base = append(base, attrs...)
	slog.LogAttrs(nil, slog.LevelInfo, "audit event", base...)
}

// LogSecurityEvent logs a structured security event via slog.
func LogSecurityEvent(event, detail string, attrs ...slog.Attr) {
	base := []slog.Attr{
		slog.String("category", "security"),
		slog.String("event", event),
		slog.String("detail", detail),
	}
	base = append(base, attrs...)
	slog.LogAttrs(nil, slog.LevelWarn, "security event", base...)
}

// LogPerformanceWarn logs a structured performance warning via slog.
func LogPerformanceWarn(operation string, latencyMs int64, attrs ...slog.Attr) {
	base := []slog.Attr{
		slog.String("category", "performance"),
		slog.String("operation", operation),
		slog.Int64("latencyMs", latencyMs),
	}
	base = append(base, attrs...)
	slog.LogAttrs(nil, slog.LevelWarn, "slow operation", base...)
}
