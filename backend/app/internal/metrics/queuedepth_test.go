package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// scrape renders the registry in Prometheus text exposition format.
func scrape(t *testing.T, reg *prometheus.Registry) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	promhttp.HandlerFor(reg, promhttp.HandlerOpts{}).ServeHTTP(rec, req)
	return rec.Body.String()
}

// TestQueueDepthSetBeforeRegisterInto: Set() is callable before any
// registration — the GaugeVec keeps the value, so the first scrape after
// RegisterInto must already expose it. RegisterInto must also be idempotent.
func TestQueueDepthSetBeforeRegisterInto(t *testing.T) {
	QueueDepth.Reset()
	Set("notification_outbox", 7)

	reg := prometheus.NewRegistry()
	RegisterInto(reg)
	RegisterInto(reg) // duplicate registration must not panic

	body := scrape(t, reg)
	if !strings.Contains(body, `queue_depth{queue="notification_outbox"} 7`) {
		t.Fatalf("exposition missing queue_depth series: %q", body)
	}
}

// TestQueueDepthSetAfterRegisterInto: once registered, Set feeds the gauge;
// the last write wins for a label, and multiple queues coexist.
func TestQueueDepthSetAfterRegisterInto(t *testing.T) {
	QueueDepth.Reset()
	reg := prometheus.NewRegistry()
	RegisterInto(reg)

	Set("webhook_deliveries", 3)
	Set("orders_stale", 1)
	Set("webhook_deliveries", 4) // last write wins for a gauge

	body := scrape(t, reg)
	for _, want := range []string{
		`queue_depth{queue="webhook_deliveries"} 4`,
		`queue_depth{queue="orders_stale"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("exposition missing %q (body: %q)", want, body)
		}
	}
}
