package api

// CUSTOMER OFFLINE SYNC + API DOCS (ARCHITECTURE.md offline contract extended
// to customers; the API docs surface is the developer-experience twin).
//
// POST /sync/batch is a DOCUMENTED EXTENSION that mirrors the rider offline
// replay (rider_ops2.go SyncRiderBatch): the client sends {events: [{seq,
// type, payload}]} and the server validates the shape, then the strict
// sequence against customer_sync_state.last_seq, acknowledges by advancing
// the high-water mark atomically (the guarded upsert is the race backstop),
// and only then applies the events best-effort. Per-event outcomes land in
// the rejected {seq, code} array; the high-water mark advances regardless
// and rejected is informational — retries follow the high-water mark.
//
// Supported events (all other types are acknowledged but skipped — the
// server has no projection for them):
//   - "order.status" {orderId, status, expectedVersion}: moved through
//     orders.Store.TransitionOrder with the CUSTOMER's actor (the session
//     user's users.id) using the customer transition rules from orders.go
//     CancelOrder and order_route.go: cancelled is reachable from
//     draft|pending_payment, and preparing (the scheduled pre-order
//     confirmation, customerScheduledTarget) from paid|merchant_accepted
//     (customerAdvanceFrom) — the only advance where the customer is a
//     party. Any other target has no customer from-set and is rejected
//     ORDER_STATUS_CONFLICT. TransitionOrder does not scope by owner, so a
//     pre-check rejects orders whose customer_user_id is not the session
//     user with ORDER_NOT_FOUND (existence never leaks, like CancelOrder).
//
// Deviations, documented honestly:
//   - The event type vocabulary differs from the rider batch on purpose:
//     "order.status" is this surface's single supported type (the rider
//     contract types are rider-specific and the customer app sends
//     order.status); unsupported types are SKIPPED per-event, never fatal.
//   - GET /docs/openapi.yaml serves the embedded contract spec (gen
//     GetSpecJSON bytes — JSON, not YAML) with Content-Type application/yaml
//     so tooling that expects a .yaml endpoint keeps working; the bytes are
//     the spec exactly as embedded. GET /docs is a minimal HTML index built
//     from the same spec (top-level resource groups only).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
)

// customerSyncEventOrderStatus is the single supported event type of the
// customer offline batch (a documented extension; the rider contract types
// are rider-specific).
const customerSyncEventOrderStatus = "order.status"

// customerSyncBatchBody is the request body of the documented-extension
// POST /sync/batch: it mirrors the rider batch shape {events: [{seq, type,
// payload}]}.
type customerSyncBatchBody struct {
	Events []customerSyncBatchEvent `json:"events"`
}

// customerSyncBatchEvent is one element of the customer sync batch.
type customerSyncBatchEvent struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
}

// customerSyncBatchResponse is the 200 body: the contract-style inline
// response of the rider batch, re-used verbatim for the customer surface.
type customerSyncBatchResponse struct {
	Accepted      int                      `json:"accepted"`
	Rejected      []syncBatchRejectedEntry `json:"rejected"`
	HighWaterMark int                      `json:"highWaterMark"`
}

// customerSyncStateRow is the customer_sync_state projection.
type customerSyncStateRow struct {
	lastSeq   int64
	updatedAt time.Time
}

// loadCustomerSyncState returns the customer's high-water mark, or a zero
// row when no sync has happened yet (the lazy zero row).
func (s *Server) loadCustomerSyncState(ctx context.Context, userID uuid.UUID) (customerSyncStateRow, error) {
	var row customerSyncStateRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT last_seq, updated_at FROM customer_sync_state WHERE user_id = $1`,
		userID).Scan(&row.lastSeq, &row.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return customerSyncStateRow{}, nil
	}
	if err != nil {
		return customerSyncStateRow{}, fmt.Errorf("load customer sync state: %w", err)
	}
	return row, nil
}

// customerSyncFromSet returns the statuses an order may be in when the
// CUSTOMER's offline order.status event moves it to target. The customer
// transition rules from orders.go CancelOrder (cancelled from
// draft|pending_payment) and order_route.go (preparing — the scheduled
// pre-order confirmation — from customerAdvanceFrom) define the only two
// legal targets; any other target has no from-set and cannot be replayed.
func customerSyncFromSet(target string) []string {
	switch target {
	case "cancelled":
		return []string{"draft", "pending_payment"}
	case customerScheduledTarget:
		return customerAdvanceFrom
	}
	return nil
}

// applyCustomerSyncEvent applies one acknowledged sync event and appends the
// per-event outcome to rejected when it could not be applied. order.status
// events move the caller customer's OWN order through
// orders.TransitionOrder with the customer actor (expectedVersion +
// customerSyncFromSet); every other type is skipped. The batch is already
// acknowledged at this point, so a failure is never fatal — it is recorded
// per-event and logged.
func (s *Server) applyCustomerSyncEvent(ctx context.Context, customerID uuid.UUID, actor uuid.UUID, event syncBatchEvent, rejected *[]syncBatchRejectedEntry) {
	if event.eventType != customerSyncEventOrderStatus {
		s.logger.Info("customer sync batch event skipped", "customer", customerID, "seq", event.seq, "type", event.eventType)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "SKIPPED"})
		return
	}
	target, ok := parseSyncOrderStatusEvent(event.payload)
	if !ok {
		s.logger.Info("customer sync order.status payload malformed", "customer", customerID, "seq", event.seq)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "SKIPPED"})
		return
	}
	from := customerSyncFromSet(target.status)
	if from == nil {
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_STATUS_CONFLICT"})
		return
	}
	st := orders.NewStore(s.db.Pool())
	row, err := st.GetOrderRow(ctx, target.orderID)
	if errors.Is(err, orders.ErrNotFound) {
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_NOT_FOUND"})
		return
	}
	if err != nil {
		s.logger.Error("customer sync order lookup failed", "customer", customerID, "seq", event.seq, "orderId", target.orderID, "error", err)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "INTERNAL_ERROR"})
		return
	}
	// TransitionOrder does not scope by owner — the pre-check does, and a
	// non-owned order looks exactly like a missing one.
	if row.CustomerUserID != customerID {
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_NOT_FOUND"})
		return
	}
	if _, err := st.TransitionOrder(ctx, target.orderID, target.expectedVersion, from, target.status, actor, ""); err != nil {
		if errors.Is(err, orders.ErrConflict) {
			*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_STATUS_CONFLICT"})
			return
		}
		s.logger.Error("customer sync order status apply failed", "customer", customerID, "seq", event.seq, "orderId", target.orderID, "error", err)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "INTERNAL_ERROR"})
	}
}

// SyncCustomerBatch accepts an offline queue batch for the session customer
// (POST /sync/batch — DOCUMENTED EXTENSION mirroring the rider replay).
// Validation order: session user (claims → users.id; a missing database is
// 500 INTERNAL_ERROR first), body shape (events non-empty, ≤ 500, every
// event with a positive seq, a non-empty type and a payload object → 422
// SYNC_BATCH_INVALID), then the strict sequence check (events[0].seq must be
// last_seq+1 and every following seq the previous +1 → 409
// SYNC_SEQUENCE_GAP). Acceptance advances customer_sync_state.last_seq
// atomically (the guarded upsert is the race backstop) and acknowledges the
// batch. After the ack, each event is applied best-effort — order.status
// events via the guarded order transition (see applyCustomerSyncEvent) — and
// the per-event outcomes are reported in rejected; the high-water mark
// advances regardless and rejected is informational.
func (s *Server) SyncCustomerBatch(w http.ResponseWriter, r *http.Request) {
	s.logger.Info("DEBUG SyncCustomerBatch reached", "path", r.URL.Path)
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body customerSyncBatchBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID", "Invalid request body")
		return
	}
	if len(body.Events) == 0 || len(body.Events) > syncBatchMaxEvents {
		writeError(w, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID",
			fmt.Sprintf("events must contain between 1 and %d items", syncBatchMaxEvents))
		return
	}
	events := make([]syncBatchEvent, 0, len(body.Events))
	for i, event := range body.Events {
		if event.Seq < 1 || event.Type == "" || event.Payload == nil {
			writeError(w, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID",
				"each event requires a positive seq, a type and a payload object")
			return
		}
		if i > 0 && event.Seq != body.Events[i-1].Seq+1 {
			writeError(w, http.StatusConflict, "SYNC_SEQUENCE_GAP", "Events must carry consecutive sequence numbers")
			return
		}
		events = append(events, syncBatchEvent{seq: event.Seq, eventType: event.Type, payload: event.Payload})
	}

	state, err := s.loadCustomerSyncState(r.Context(), actor)
	if err != nil {
		s.logger.Error("customer sync state lookup failed", "customer", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	expected := state.lastSeq + 1
	if int64(events[0].seq) != expected {
		writeError(w, http.StatusConflict, "SYNC_SEQUENCE_GAP",
			fmt.Sprintf("First event seq must be %d (the server high-water mark is %d)", expected, state.lastSeq))
		return
	}
	nextSeq := int64(events[len(events)-1].seq)

	var acked int64
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO customer_sync_state (user_id, last_seq, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (user_id) DO UPDATE
		 SET last_seq = EXCLUDED.last_seq, updated_at = now()
		 WHERE customer_sync_state.last_seq = $3
		 RETURNING last_seq`,
		actor, nextSeq, state.lastSeq).Scan(&acked)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "SYNC_SEQUENCE_GAP",
			"Concurrent sync advanced the high-water mark — retry from the current mark")
		return
	}
	if err != nil {
		s.logger.Error("customer sync batch apply failed", "customer", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rejected := make([]syncBatchRejectedEntry, 0, len(events))
	accepted := 0
	for _, event := range events {
		before := len(rejected)
		s.applyCustomerSyncEvent(r.Context(), actor, actor, event, &rejected)
		if len(rejected) == before {
			accepted++
		}
	}
	writeJSON(w, http.StatusOK, customerSyncBatchResponse{
		Accepted:      accepted,
		Rejected:      rejected,
		HighWaterMark: int(acked),
	})
}

// GetOpenAPISpec serves the embedded contract spec (GET /docs/openapi.yaml,
// public). The bytes come straight from gen.GetSpecJSON — the spec is
// embedded as JSON, and the endpoint answers Content-Type application/yaml
// because that is what the .yaml URL implies and what client tooling
// expects; the body is the spec exactly as embedded (see the package
// comment).
func (s *Server) GetOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	spec, err := gen.GetSpecJSON()
	if err != nil {
		s.logger.Error("load embedded openapi spec failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.Header().Set("Content-Type", "application/yaml")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(spec)
}

// GetDocs serves a minimal HTML index of the API surface (GET /docs,
// public): the title, a table of the top-level resource groups derived from
// the embedded spec's paths, and a link to the spec itself.
func (s *Server) GetDocs(w http.ResponseWriter, r *http.Request) {
	spec, err := gen.GetSpecJSON()
	if err != nil {
		s.logger.Error("load embedded openapi spec for docs failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var doc struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(spec, &doc); err != nil {
		s.logger.Error("decode embedded openapi spec for docs failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	groups := make(map[string]struct{}, 32)
	for path := range doc.Paths {
		trimmed := strings.Trim(path, "/")
		first := trimmed
		if i := strings.IndexByte(trimmed, '/'); i >= 0 {
			first = trimmed[:i]
		}
		if first != "" {
			groups[first] = struct{}{}
		}
	}
	names := make([]string, 0, len(groups))
	for group := range groups {
		names = append(names, group)
	}
	sort.Strings(names)

	var rows strings.Builder
	for _, name := range names {
		rows.WriteString("<tr><td><code>/" + name + "</code></td><td>/" + name + "/*</td></tr>")
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hudumika API</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#222}
table{border-collapse:collapse;width:100%%;margin-top:1rem}td,th{border:1px solid #ddd;padding:.5rem;text-align:left}
code{background:#f4f4f4;padding:.1rem .35rem;border-radius:4px}</style>
</head>
<body>
<h1>Hudumika API</h1>
<p>Contract specification: <a href="/docs/openapi.yaml">/docs/openapi.yaml</a></p>
<h2>Resource groups</h2>
<table>
<thead><tr><th>Group</th><th>Path prefix</th></tr></thead>
<tbody>%s</tbody>
</table>
</body>
</html>
`, rows.String())
}
