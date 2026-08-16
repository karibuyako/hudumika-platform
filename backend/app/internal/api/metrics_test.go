package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/notifications"
)

// TestMetricsExposition exercises the full middleware chain against a
// Redis-backed server (miniredis) and asserts the /metrics text exposition
// reflects what was served. Global counters are shared across tests in this
// package, so assertions target label presence and rows only this test
// produces (e.g. /healthz 200, verify-otp 422).
func TestMetricsExposition(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	s := newReadyServer(t, "redis://"+mr.Addr())
	h := s.Router()

	for i := 0; i < 3; i++ {
		rec := doJSON(t, h, http.MethodGet, "/healthz", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("healthz status = %d, want 200", rec.Code)
		}
	}

	// Garbage body: decodeJSON fails, handler answers 422 VALIDATION_FAILED.
	rec := doJSON(t, h, http.MethodPost, "/auth/verify-otp", "not json{")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("verify-otp garbage status = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	body := scrapeMetrics(t, h, "http_requests_total{method=\"GET\",path=\"/healthz\",status=\"200\"}")
	body = scrapeMetrics(t, h, "http_request_duration_seconds_count{method=\"GET\",path=\"/healthz\"}")

	for _, want := range []string{
		`http_requests_total{method="GET",path="/healthz",status="200"} 3`,
		`http_request_duration_seconds_count{method="GET",path="/healthz"} 3`,
		`http_request_duration_seconds_sum{method="GET",path="/healthz"} `,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics body missing %q", want)
		}
	}

	// The garbage verify-otp body must be recorded with status 422. Count is
	// >= 1: other tests in the package (e.g. the contract-path sweep) may
	// also exercise this route before this test runs.
	verified := regexp.MustCompile(`http_requests_total\{method="POST",path="/auth/verify-otp",status="422"\} [0-9]+`)
	if m := verified.FindString(body); m == "" {
		t.Errorf("metrics body missing http_requests_total for verify-otp 422 (got %q)", body)
	}

	// Histogram buckets for the healthz series must exist (p50/p95/p99 base).
	bucket := regexp.MustCompile(`http_request_duration_seconds_bucket\{method="GET",path="/healthz",le="[0-9.e-]+"\} [0-9]+`)
	if !bucket.MatchString(body) {
		t.Errorf("metrics body missing http_request_duration_seconds_bucket lines for /healthz")
	}

	// active_sessions is fed by the background collector (miniredis-backed
	// CountActive); it counts on first request, so it may need a beat to land.
	if !strings.Contains(body, "active_sessions") {
		t.Errorf("metrics body missing active_sessions after scrape")
	}

	// The scrape endpoint itself must not appear in request metrics.
	if strings.Contains(body, `http_requests_total{method="GET",path="/metrics"`) {
		t.Errorf("metrics body counts its own scrape: %q", body)
	}
}

// TestMetricsHelperIncrements verifies the OTP/idempotency helpers (the
// future call sites in server.go / idempotency.go) write the documented
// label sets into the exposition.
func TestMetricsHelperIncrements(t *testing.T) {
	// The collectors are package-level singletons shared with the handlers'
	// call sites, so reset them for an exact-count assertion.
	otpRequestsTotal.Reset()
	idempotencyHitsTotal.Reset()
	s := newTestServer()
	s.RecordOtpOutcome("phone", "issued")
	s.RecordOtpOutcome("phone", "rate_limited")
	s.RecordOtpOutcome("email", "verified")
	s.RecordOtpOutcome("email", "failed")
	s.RecordIdempotencyHit("/payments")

	body := scrapeMetrics(t, s.Router(), "otp_requests_total")
	for _, want := range []string{
		`otp_requests_total{channel="phone",outcome="issued"} 1`,
		`otp_requests_total{channel="phone",outcome="rate_limited"} 1`,
		`otp_requests_total{channel="email",outcome="verified"} 1`,
		`otp_requests_total{channel="email",outcome="failed"} 1`,
		`idempotency_hits_total{operation="/payments"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics body missing %q", want)
		}
	}
}

// TestMetricsQueueDepthExposesNotificationOutbox (skips without
// DATABASE_URL, so the default unit run needs no database) seeds two pending
// notification_outbox rows, runs a notification worker cycle, and asserts
// /metrics exposes queue_depth{queue="notification_outbox"} with the
// remaining pending depth.
func TestMetricsQueueDepthExposesNotificationOutbox(t *testing.T) {
	s, pool := eventingUnitPGServer(t)
	ctx := context.Background()

	ids := make([]uuid.UUID, 0, 2)
	for i := 0; i < 2; i++ {
		id := uuid.New()
		if _, err := pool.Exec(ctx,
			`INSERT INTO notification_outbox (id, channel, recipient, template, payload, status, next_attempt_at)
			 VALUES ($1, 'sms', $2, 'otp', 'encrypted', 'pending', now() + interval '1 hour')`,
			id, fmt.Sprintf("+25570000000%d", i)); err != nil {
			t.Fatalf("seed outbox row: %v", err)
		}
		ids = append(ids, id)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM notification_outbox WHERE id = ANY($1)`, ids)
	})

	// A full worker cycle: the seeded rows are not due yet (next_attempt_at
	// in the future), so nothing is claimed and the reported depth is 2.
	w := notifications.NewWorker(notifications.NewPgOutbox(pool),
		successProvider{}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour)
	if err := w.RunOnce(ctx); err != nil {
		t.Fatalf("worker cycle: %v", err)
	}

	body := scrapeMetrics(t, s.Router(), `queue_depth{queue="notification_outbox"}`)
	if !strings.Contains(body, `queue_depth{queue="notification_outbox"} 2`) {
		t.Errorf("metrics body missing pending outbox depth: %q", body)
	}
}

// successProvider delivers every message; the queue-depth stub provider.
type successProvider struct{}

func (successProvider) Send(ctx context.Context, m notifications.Message) error { return nil }

// scrapeMetrics GETs /metrics and returns the body once it contains probe
// (retrying briefly: the active_sessions collector may still be counting).
func scrapeMetrics(t *testing.T, h http.Handler, probe string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		req := httptest.NewRequest(http.MethodGet, metricsPath, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("/metrics status = %d, want 200", rec.Code)
		}
		body, err := io.ReadAll(rec.Body)
		if err != nil {
			t.Fatalf("read metrics body: %v", err)
		}
		if probe == "" || strings.Contains(string(body), probe) {
			return string(body)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %q in /metrics", probe)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
