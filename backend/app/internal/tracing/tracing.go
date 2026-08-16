// Package tracing wires OpenTelemetry instrumentation for the out-of-process
// dependencies the API talks to: PostgreSQL, Redis and HTTP provider calls.
//
// Every entry point here resolves the global TracerProvider lazily, so all
// instrumentation is safe to install unconditionally: before InitTracing /
// otel.SetTracerProvider runs, spans are no-ops and nothing is exported
// (MONITORING.md tracing rule).
package tracing

import (
	"context"
	"net/http"

	"github.com/exaring/otelpgx"
	"github.com/redis/go-redis/extra/redisotel/v9"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// tracerName is the instrumentation scope for dependency spans. It matches
// the scope used by internal/api for HTTP spans so all service spans land
// under one scope.
const tracerName = "hudumika/api-backend"

// tracer is created from the global provider: otel-go's global delegate
// switches it to the SDK provider on the first otel.SetTracerProvider call
// (InitTracing), and every span is a no-op until then.
var tracer = otel.Tracer(tracerName)

// PgxTracer returns the tracer to attach to a pgx connection config.
//
// Note: the former official pgx OTel tracer (pgxtrace) never shipped in pgx
// v5 — it was removed upstream before v5.0.0 and no release contains it.
// otelpgx is the tracer listed under "Adapters for 3rd Party Tracers" in the
// pgx README; it implements the pgx QueryTracer/BatchTracer/CopyFromTracer/
// PrepareTracer interfaces plus the pgxpool acquire/release tracers, and
// resolves the global TracerProvider (no-op until tracing is initialized).
func PgxTracer() *otelpgx.Tracer {
	return otelpgx.NewTracer()
}

// RedisInstrumentation installs the redisotel tracing hook on the go-redis
// client. redisotel v9 has no NewTracingHook returning a redis.Hook; the
// hook type is unexported and installed via InstrumentTracing. It reads the
// global TracerProvider at installation time (no-op until initialized).
func RedisInstrumentation(client redis.UniversalClient) error {
	return redisotel.InstrumentTracing(client)
}

// HTTPClient wraps client's transport with the OTel HTTP client
// instrumentation (otelhttp), preserving the timeout and redirect policy.
// A nil client is treated as a zero-value http.Client.
func HTTPClient(client *http.Client) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	out := *client
	out.Transport = otelhttp.NewTransport(client.Transport)
	return &out
}

// ProviderSpan starts a client span for a call to an external provider
// (SMS gateway, payment API, ...) carrying attrs. The span is a no-op until
// tracing is initialized.
func ProviderSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return tracer.Start(ctx, name,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attrs...),
	)
}
