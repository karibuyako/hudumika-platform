// Package metrics owns the cross-cutting Prometheus collectors that are fed
// from several packages (the notification outbox worker, the webhook
// delivery worker, the sweeper) but registered into the API's custom
// registry (internal/api/metrics.go). Keeping the collectors here lets every
// producer Set them without importing the api package, and keeps the
// registry custom (never the default process registry), so /metrics serves
// exactly what the api package opted in to.
package metrics

import "github.com/prometheus/client_golang/prometheus"

// QueueDepth is the queue_depth gauge: pending items per queue, one series
// per queue label. Producers set it once per worker cycle; last write wins,
// which is the right semantics for a gauge under multiple instances
// (MONITORING.md: each instance reports the DB counts).
var QueueDepth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
	Name: "queue_depth",
	Help: "Pending items per queue.",
}, []string{"queue"})

// Set records the current depth of a queue. It is safe to call before
// RegisterInto: a GaugeVec keeps its values independently of registration, so
// a pre-registration Set is already visible on the first scrape after the
// metric is registered.
func Set(queue string, n int64) {
	QueueDepth.WithLabelValues(queue).Set(float64(n))
}

// RegisterInto registers QueueDepth into r, idempotently: a duplicate
// registration (AlreadyRegisteredError) keeps the collector already present
// in r, so repeated calls are no-ops. Any other error is a genuine conflict
// (e.g. a different collector with the same name) and panics, matching the
// MustRegister behaviour of the api package's init.
func RegisterInto(r *prometheus.Registry) {
	if err := r.Register(QueueDepth); err != nil {
		if _, ok := err.(prometheus.AlreadyRegisteredError); !ok {
			panic(err)
		}
	}
}
