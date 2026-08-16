package tracing

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// testTracerProvider installs an in-memory span recorder as the global
// provider for the remainder of this test process. The otel global delegate
// is fixed on first SetTracerProvider, but each go test binary runs in its
// own process, so production wiring (main) is unaffected.
func testTracerProvider(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	return rec
}

func TestProviderSpanRecordsAttribute(t *testing.T) {
	rec := testTracerProvider(t)

	ctx, span := ProviderSpan(context.Background(), "sms.provider.send",
		attribute.String("provider", "sms"),
		attribute.String("channel", "sms"),
	)
	if !span.SpanContext().IsValid() {
		t.Fatal("ProviderSpan returned an invalid span context")
	}
	if _, ok := ctx.Deadline(); ok {
		t.Error("ProviderSpan unexpectedly set a deadline on the context")
	}
	span.End()

	ended := rec.Ended()
	if len(ended) != 1 {
		t.Fatalf("expected 1 recorded span, got %d", len(ended))
	}
	got := ended[0]
	if got.Name() != "sms.provider.send" {
		t.Errorf("span name = %q, want %q", got.Name(), "sms.provider.send")
	}
	if got.SpanKind() != trace.SpanKindClient {
		t.Errorf("span kind = %q, want client", got.SpanKind())
	}
	attrs := got.Attributes()
	if v, ok := attrValue(attrs, "provider"); !ok || v != "sms" {
		t.Errorf("attribute provider = %q (present=%v), want %q", v, ok, "sms")
	}
	if v, ok := attrValue(attrs, "channel"); !ok || v != "sms" {
		t.Errorf("attribute channel = %q (present=%v), want %q", v, ok, "sms")
	}
}

func TestHTTPClientRoundtrip(t *testing.T) {
	rec := testTracerProvider(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()

	client := HTTPClient(&http.Client{Timeout: 5 * time.Second})
	if client.Timeout != 5*time.Second {
		t.Errorf("client timeout = %v, want 5s", client.Timeout)
	}

	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET via instrumented client: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "ok" {
		t.Errorf("body = %q, want %q", string(body), "ok")
	}

	// The otelhttp transport must have emitted a client span named after the
	// method with an HTTP status attribute.
	ended := rec.Ended()
	if len(ended) != 1 {
		t.Fatalf("expected 1 recorded span, got %d", len(ended))
	}
	if ended[0].Name() != "HTTP GET" {
		t.Errorf("span name = %q, want %q", ended[0].Name(), "HTTP GET")
	}
	if v, ok := attrValue(ended[0].Attributes(), "http.response.status_code"); !ok || v != "200" {
		t.Errorf("http.response.status_code = %q (present=%v), want %q", v, ok, "200")
	}
}

func TestHTTPClientNil(t *testing.T) {
	client := HTTPClient(nil)
	if client == nil {
		t.Fatal("HTTPClient(nil) returned nil")
	}
	if client.Timeout != 0 {
		t.Errorf("timeout = %v, want zero value", client.Timeout)
	}
	if _, ok := client.Transport.(*otelhttp.Transport); !ok {
		t.Errorf("transport = %T, want *otelhttp.Transport", client.Transport)
	}
}

func attrValue(attrs []attribute.KeyValue, key string) (string, bool) {
	for _, a := range attrs {
		if string(a.Key) == key {
			return a.Value.Emit(), true
		}
	}
	return "", false
}
