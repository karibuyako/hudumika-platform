package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/gen"
)

// Redis stream keys for the server event stream and the client error report
// sink. The events stream is the single source of truth behind /events: every
// entry is a {type, payload} pair whose stream ID doubles as the event
// sequence. The sequence reported to clients (and compared against by the
// `after` query parameter) is the milliseconds part of the stream ID
// ("<ms>-<seq>"), which keeps `after` a plain integer and timestamps free.
const (
	eventStreamKey       = "events"
	clientErrorStreamKey = "client_errors"

	// eventReadCount caps the entries pulled per XRANGE poll.
	eventReadCount = int64(200)
)

// Long-poll budget for /events: the handler polls the stream every
// eventPollInterval and answers an empty page (plus latestSeq) once
// eventPollTimeout elapses or the request context is cancelled. Package-level
// vars so integration tests can shrink them; tests must restore them.
var (
	eventPollInterval = 2 * time.Second
	eventPollTimeout  = 25 * time.Second
)

// serverEvent is one entry of the /events 200 response. The contract schema
// is {events: [{id, type, payload, at}], latestSeq}; id is the event sequence
// (stream ID milliseconds) and at is the same instant in RFC3339.
type serverEvent struct {
	ID      int64          `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
	At      string         `json:"at"`
}

// serverEventsResponse is the /events 200 response schema.
type serverEventsResponse struct {
	Events    []serverEvent `json:"events"`
	LatestSeq int64         `json:"latestSeq"`
}

// GetServerEvents answers the contract /events long-poll. `after` is the last
// sequence the client has seen; the response lists the events published after
// it (exclusive lower bound, so after+1 is the XRANGE start on the Redis
// path) plus latestSeq so the client can advance. When the stream is quiet
// the handler polls for up to ~25s, then answers an empty events array —
// unless the client disconnects first, in which case it answers the same
// empty page. The primary backend is the Redis stream "events"; when Redis
// is absent but PostgreSQL is wired, the event_log table (events_pg.go)
// serves the identical schema. When neither is available the endpoint
// answers the NOT_IMPLEMENTED envelope. The generated wrapper guarantees
// `after` is present; negative sequences are invalid by definition.
func (s *Server) GetServerEvents(w http.ResponseWriter, r *http.Request, params gen.GetServerEventsParams) {
	if params.After < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "after must be a non-negative sequence")
		return
	}

	read := func(ctx context.Context, after int64) ([]serverEvent, int64, error) {
		return nil, 0, fmt.Errorf("no event backend configured")
	}
	if s.stores != nil && s.stores.Redis != nil {
		read = func(ctx context.Context, after int64) ([]serverEvent, int64, error) {
			return s.readEvents(ctx, strconv.FormatInt(after+1, 10))
		}
	} else if s.db != nil {
		read = func(ctx context.Context, after int64) ([]serverEvent, int64, error) {
			return pgReadEvents(ctx, s.db.Pool(), after, int(eventReadCount))
		}
	} else {
		writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "The event stream requires Redis or PostgreSQL")
		return
	}

	deadline := time.Now().Add(eventPollTimeout)
	ctx := r.Context()
	for {
		events, latest, err := read(ctx, int64(params.After))
		if err != nil {
			if ctx.Err() != nil {
				// Client is gone: answer the empty page so the connection
				// closes cleanly.
				writeJSON(w, http.StatusOK, serverEventsResponse{Events: []serverEvent{}, LatestSeq: 0})
				return
			}
			s.logger.Error("event stream read failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not read the event stream")
			return
		}
		if len(events) > 0 || time.Now().After(deadline) {
			if events == nil {
				events = []serverEvent{}
			}
			writeJSON(w, http.StatusOK, serverEventsResponse{Events: events, LatestSeq: latest})
			return
		}
		select {
		case <-ctx.Done():
			writeJSON(w, http.StatusOK, serverEventsResponse{Events: []serverEvent{}, LatestSeq: latest})
			return
		case <-time.After(eventPollInterval):
		}
	}
}

// readEvents returns up to eventReadCount events with a stream ID strictly
// greater than start, plus the newest sequence in the stream (0 when the
// stream has no entries). A quiet poll still reports latestSeq from the
// newest entry so clients can advance past a poll that found nothing.
func (s *Server) readEvents(ctx context.Context, start string) ([]serverEvent, int64, error) {
	client := s.stores.Redis.Client()
	msgs, err := client.XRangeN(ctx, eventStreamKey, start, "+", eventReadCount).Result()
	if err != nil {
		return nil, 0, fmt.Errorf("xrange %s: %w", eventStreamKey, err)
	}

	events := make([]serverEvent, 0, len(msgs))
	for _, m := range msgs {
		ms, ok := streamIDMilliseconds(m.ID)
		if !ok {
			continue
		}
		ev := serverEvent{
			ID:   ms,
			Type: streamString(m.Values, "type"),
			At:   time.UnixMilli(ms).UTC().Format(time.RFC3339),
		}
		if raw, ok := m.Values["payload"].(string); ok && raw != "" {
			if err := json.Unmarshal([]byte(raw), &ev.Payload); err != nil {
				s.logger.Warn("event payload unmarshal failed", "stream_id", m.ID, "error", err)
			}
		}
		events = append(events, ev)
	}
	if len(msgs) > 0 {
		return events, events[len(events)-1].ID, nil
	}

	newest, err := client.XRevRangeN(ctx, eventStreamKey, "+", "-", 1).Result()
	if err != nil {
		return events, 0, fmt.Errorf("xrevrange %s: %w", eventStreamKey, err)
	}
	latest := int64(0)
	if len(newest) > 0 {
		if ms, ok := streamIDMilliseconds(newest[0].ID); ok {
			latest = ms
		}
	}
	return events, latest, nil
}

// streamIDMilliseconds extracts the milliseconds part of a Redis stream ID
// ("<ms>-<seq>"), which is the event sequence reported to clients.
func streamIDMilliseconds(id string) (int64, bool) {
	ms, _, _ := strings.Cut(id, "-")
	if ms == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(ms, 10, 64)
	return n, err == nil
}

// streamString reads a string field from a stream entry, returning "" when
// the field is absent or not a string.
func streamString(values map[string]interface{}, key string) string {
	if v, ok := values[key].(string); ok {
		return v
	}
	return ""
}

// ReportClientError accepts the contract /monitoring/errors report. The
// contract marks the route unauthenticated, but the router gates everything
// behind RequireAuth unless isPublicPath names it — /monitoring/errors is not
// named, so the request is already authenticated when it lands here and this
// handler performs no auth of its own. The report is logged with structured
// fields and, when Redis is present, best-effort XADDed to the client_errors
// stream for offline triage. The contract answers 204.
func (s *Server) ReportClientError(w http.ResponseWriter, r *http.Request) {
	var body gen.ReportClientErrorJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Message == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "message is required")
		return
	}

	s.logger.Error("client error report",
		"message", body.Message,
		"stack", body.Stack,
		"context", body.Context,
	)

	if s.stores != nil && s.stores.Redis != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		values := []any{"message", body.Message, "stack", body.Stack}
		if body.Context != nil {
			if raw, err := json.Marshal(body.Context); err == nil {
				values = append(values, "context", string(raw))
			}
		}
		if err := s.stores.Redis.Client().XAdd(ctx, &redis.XAddArgs{
			Stream: clientErrorStreamKey,
			ID:     "*",
			Values: values,
		}).Err(); err != nil {
			s.logger.Warn("client error report not streamed", "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// PublishEvent appends an event to the event stream. The stream ID doubles
// as the sequence: /events reports the milliseconds part as the event id on
// the Redis path and the bigserial id on the PostgreSQL fallback, and clients
// pass either back as `after`. Publishing is best-effort: failures (including
// a missing Redis and PostgreSQL, e.g. in-memory dev mode) are logged and
// returned, never propagated into the caller's flow — callers that treat
// publishing as best-effort may ignore the returned error.
func (s *Server) PublishEvent(ctx context.Context, eventType string, payload any) error {
	if s.stores != nil && s.stores.Redis != nil {
		payloadJSON, err := json.Marshal(payload)
		if err != nil {
			err = fmt.Errorf("publish event payload: %w", err)
			s.logger.Error("event not published", "type", eventType, "error", err)
			return err
		}
		id, err := s.stores.Redis.Client().XAdd(ctx, &redis.XAddArgs{
			Stream: eventStreamKey,
			ID:     "*",
			Values: []any{"type", eventType, "payload", string(payloadJSON)},
		}).Result()
		if err != nil {
			err = fmt.Errorf("publish event xadd: %w", err)
			s.logger.Error("event not published", "type", eventType, "error", err)
			return err
		}
		s.logger.Debug("event published", "type", eventType, "stream_id", id)
		return nil
	}
	if s.db != nil {
		err := pgPublishEvent(ctx, s.db.Pool(), eventType, payload)
		if err != nil {
			err = fmt.Errorf("publish event pg: %w", err)
			s.logger.Error("event not published", "type", eventType, "error", err)
			return err
		}
		s.logger.Debug("event published", "type", eventType)
		return nil
	}
	err := fmt.Errorf("publish event: no event backend configured (redis or postgres)")
	s.logger.Warn("event not published", "type", eventType, "error", err)
	return err
}
