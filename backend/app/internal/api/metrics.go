package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel/attribute"

	"github.com/hudumika/api-backend/internal/metrics"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// metricsPath is the scrape endpoint, excluded from the request metrics so
// the scraper does not count itself.
const metricsPath = "/metrics"

// The registry and its collectors are package-level singletons: the Server
// struct is owned by server.go (another agent) and cannot carry a registry
// field. Production runs exactly one Server per process; tests share the
// registry and assert on label presence rather than global counts.
var (
	httpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "Total HTTP requests served, split by method, route and status class.",
	}, []string{"method", "path", "status"})

	httpRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request latency in seconds.",
		Buckets: prometheus.DefBuckets, // 0.005s..10s, p50/p95/p99 derivable
	}, []string{"method", "path"})

	otpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "otp_requests_total",
		Help: "OTP requests by channel and outcome (issued|verified|failed|rate_limited).",
	}, []string{"channel", "outcome"})

	idempotencyHitsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "idempotency_hits_total",
		Help: "Idempotency-key cache hits (replayed responses), by operation.",
	}, []string{"operation"})

	activeSessions = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "active_sessions",
		Help: "Current authenticated sessions (refresh token store).",
	})

	promRegistry = prometheus.NewRegistry()
)

func init() {
	// queue_depth is owned by the internal/metrics package (its producers
	// are the notification/webhook/sweeper workers, which cannot import
	// this package); registering it here keeps every exported collector on
	// the one custom registry.
	metrics.RegisterInto(promRegistry)
	promRegistry.MustRegister(
		httpRequestsTotal,
		httpRequestDuration,
		otpRequestsTotal,
		idempotencyHitsTotal,
		activeSessions,
	)
	// Seed CounterVec families so /metrics exposes them even on a cold
	// instance (no OTP/idempotency traffic yet). Prometheus client omits
	// CounterVec families with zero series, which would fail the selfcheck
	// base-metric gate and dashboard alerts until first traffic.
	otpRequestsTotal.WithLabelValues("phone", "issued").Add(0)
	idempotencyHitsTotal.WithLabelValues("payments").Add(0)
}

// metrics serves the Prometheus exposition format on /metrics.
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	promhttp.HandlerFor(promRegistry, promhttp.HandlerOpts{}).ServeHTTP(w, r)
}

// metricsMiddleware records duration, method, path and status for every
// request except the scrape endpoint itself. The path label prefers the
// matched chi route pattern (stable across URL params); the raw URL path is
// the fallback for unmatched routes (404).
func (s *Server) metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == metricsPath {
			next.ServeHTTP(w, r)
			return
		}
		s.ensureActiveSessionsCollector()
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		defer func() {
			status := ww.Status()
			// A panic in the handler is answered 500 by the Recoverer
			// middleware further out; re-panic so it can finish the job.
			if p := recover(); p != nil {
				status = http.StatusInternalServerError
				panic(p)
			}
			httpRequestsTotal.WithLabelValues(r.Method, routePath(r), strconv.Itoa(status)).Inc()
			httpRequestDuration.WithLabelValues(r.Method, routePath(r)).Observe(time.Since(start).Seconds())
		}()
		next.ServeHTTP(ww, r)
	})
}

// routePath returns the matched chi route pattern (e.g. "/auth/verify-otp")
// once routing has happened, falling back to the literal URL path.
func routePath(r *http.Request) string {
	if rctx := chi.RouteContext(r.Context()); rctx != nil && rctx.RoutePattern() != "" {
		return rctx.RoutePattern()
	}
	return r.URL.Path
}

// RecordOtpOutcome increments otp_requests_total{channel,outcome}. Outcomes
// are one of issued|verified|failed|rate_limited. The OTP handlers in
// server.go call this (wiring lands with the server.go agent); the helper
// exists here so the metric is shippable independently.
func (s *Server) RecordOtpOutcome(channel, outcome string) {
	otpRequestsTotal.WithLabelValues(channel, outcome).Inc()
}

// RecordIdempotencyHit increments idempotency_hits_total{operation} on a
// replayed idempotency-key response. idempotency.go calls this once its
// replay path is patched (next agent); the helper lives here so the metric is
// shippable independently.
func (s *Server) RecordIdempotencyHit(operation string) {
	idempotencyHitsTotal.WithLabelValues(operation).Inc()
}

// activeSessionsInterval is the refresh period for the active_sessions gauge.
const activeSessionsInterval = 15 * time.Second

// The Server struct cannot carry a collector field (server.go is owned
// elsewhere), so launched collectors are tracked package-level by pointer.
var (
	activeSessionsMu       sync.Mutex
	activeSessionsLaunched = make(map[*Server]struct{})
)

// ensureActiveSessionsCollector starts the gauge collector on the first
// request through the middleware. A dedicated start (e.g. from main with a
// cancellable context) can call startActiveSessionsCollector directly.
func (s *Server) ensureActiveSessionsCollector() {
	activeSessionsMu.Lock()
	defer activeSessionsMu.Unlock()
	if _, ok := activeSessionsLaunched[s]; ok {
		return
	}
	activeSessionsLaunched[s] = struct{}{}
	go s.startActiveSessionsCollector(context.Background(), activeSessionsInterval)
}

// startActiveSessionsCollector polls the session store and keeps
// active_sessions current. It counts once immediately, then on each tick,
// and stops when ctx is cancelled.
func (s *Server) startActiveSessionsCollector(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if n, err := s.stores.Sessions.CountActive(ctx); err != nil {
			s.logger.Warn("active_sessions collect failed", "error", err)
		} else {
			activeSessions.Set(float64(n))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ---- OpenTelemetry tracing ----

const (
	// traceRatioSample is the sampling ratio for healthy traffic (10%);
	// error traffic is exported at 100% via errorAwareExporter.
	traceRatioSample = 0.1
	// tracerName is the instrumentation scope name used for HTTP spans.
	tracerName = "hudumika/api-backend"
)

var (
	tracingOnce    sync.Once
	tracingErr     error
	tracerProvider *sdktrace.TracerProvider
)

// InitTracing builds the process TracerProvider. When
// OTEL_EXPORTER_OTLP_ENDPOINT is set (env guard — config is owned by the
// config package and is deliberately not touched here) spans are exported
// over OTLP/HTTP through errorAwareExporter; otherwise the provider has no
// span processors and tracing is effectively a no-op, which keeps dev and
// test runs free of export machinery.
func InitTracing(ctx context.Context, logger *slog.Logger) (*sdktrace.TracerProvider, error) {
	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithSampler(sdktrace.ParentBased(&errorAwareSampler{
			ratio: sdktrace.TraceIDRatioBased(traceRatioSample),
		})),
	}
	if endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"); endpoint != "" {
		exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint))
		if err != nil {
			return nil, fmt.Errorf("otlp exporter: %w", err)
		}
		opts = append(opts, sdktrace.WithBatcher(&errorAwareExporter{next: exp}))
		logger.Info("tracing enabled", "otlp_endpoint", endpoint, "sample_ratio", traceRatioSample)
	} else {
		logger.Info("tracing no-op: OTEL_EXPORTER_OTLP_ENDPOINT not set")
	}
	return sdktrace.NewTracerProvider(opts...), nil
}

// tracingProvider returns the process TracerProvider, initializing it once
// on first use. Main's explicit InitTracing wiring lands later; the lazy
// init keeps tracing working from the middleware chain alone.
func (s *Server) tracingProvider() *sdktrace.TracerProvider {
	tracingOnce.Do(func() {
		tracerProvider, tracingErr = InitTracing(context.Background(), s.logger)
	})
	if tracingErr != nil {
		s.logger.Error("tracing init failed", "error", tracingErr)
		return nil
	}
	return tracerProvider
}

// otelMiddleware wraps each request in an OTLP span named "<METHOD> <route>"
// carrying request_id, method, route and status. 5xx responses are marked as
// errors so errorAwareExporter exports them at 100% (MONITORING.md sampling
// rule). The scrape endpoint is skipped to keep metrics noise-free.
func (s *Server) otelMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == metricsPath {
			next.ServeHTTP(w, r)
			return
		}
		tp := s.tracingProvider()
		if tp == nil {
			next.ServeHTTP(w, r)
			return
		}
		path := routePath(r)
		ctx, span := tp.Tracer(tracerName).Start(r.Context(), r.Method+" "+path,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("request_id", middleware.GetReqID(r.Context())),
				attribute.String("http.method", r.Method),
				attribute.String("http.route", path),
			),
		)
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		defer func() {
			status := ww.Status()
			if p := recover(); p != nil {
				status = http.StatusInternalServerError
				span.SetStatus(codes.Error, "panic")
				panic(p)
			}
			span.SetAttributes(attribute.Int("http.status_code", status))
			if status >= 500 {
				span.SetStatus(codes.Error, "HTTP "+strconv.Itoa(status))
			}
			span.End()
		}()
		next.ServeHTTP(ww, r.WithContext(ctx))
	})
}

// errorAwareSampler implements the 10%-of-healthy half of the sampling rule.
// OTel decides sampling when a span starts — before the HTTP status is
// known — so the sampler cannot judge errors itself. Approximation: spans
// the ratio sampler would drop are kept recorded but flagged unsampled
// (RecordOnly), and errorAwareExporter promotes 5xx spans to full export.
type errorAwareSampler struct {
	ratio sdktrace.Sampler
}

func (s *errorAwareSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	res := s.ratio.ShouldSample(p)
	if res.Decision == sdktrace.RecordAndSample {
		return res
	}
	return sdktrace.SamplingResult{
		Decision:   sdktrace.RecordOnly,
		Tracestate: res.Tracestate,
		Attributes: res.Attributes,
	}
}

func (s *errorAwareSampler) Description() string {
	return "errorAwareSampler(" + s.ratio.Description() + ")"
}

// errorAwareExporter implements the 100%-of-errors half of the sampling
// rule: it exports spans flagged sampled (the 10% healthy slice) plus every
// span whose status is Error (5xx), and drops the rest. Wrapping the real
// (OTLP) exporter keeps the export pipeline unchanged.
type errorAwareExporter struct {
	next sdktrace.SpanExporter
}

func (e *errorAwareExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	out := make([]sdktrace.ReadOnlySpan, 0, len(spans))
	for _, sp := range spans {
		if sp.SpanContext().TraceFlags().IsSampled() || sp.Status().Code == codes.Error {
			out = append(out, sp)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return e.next.ExportSpans(ctx, out)
}

func (e *errorAwareExporter) Shutdown(ctx context.Context) error {
	return e.next.Shutdown(ctx)
}
