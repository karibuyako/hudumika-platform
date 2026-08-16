package api

// PostgreSQL-backed implementations of the server event stream, used as the
// fallback path when Redis is absent (s.stores.Redis == nil) but PostgreSQL
// is wired (s.db != nil). Rows live in the event_log table; the bigserial id
// doubles as the event sequence, mirroring the milliseconds part of the Redis
// stream ID so the /events response schema is identical on both paths.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// pgPublishEvent appends one event to the event_log table. The returned id is
// the bigserial sequence reported to clients as the event id and the `after`
// watermark. Publishing is best-effort at the call sites: failures are
// logged and returned, never propagated into the caller's flow.
func pgPublishEvent(ctx context.Context, pool *pgxpool.Pool, eventType string, payload any) error {
	const insert = `
INSERT INTO event_log (type, payload)
VALUES ($1, $2)`
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("publish event payload: %w", err)
	}
	if _, err := pool.Exec(ctx, insert, eventType, raw); err != nil {
		return fmt.Errorf("publish event insert: %w", err)
	}
	return nil
}

// pgReadEvents returns up to limit events with an id strictly greater than
// after (exclusive lower bound, ascending sequence), plus the newest sequence
// in the log (0 when the log is empty). A quiet poll still reports latestSeq
// from the newest row so clients can advance past a poll that found nothing.
func pgReadEvents(ctx context.Context, pool *pgxpool.Pool, after int64, limit int) (events []serverEvent, latest int64, err error) {
	const selectEvents = `
SELECT id, type, payload, created_at
FROM event_log
WHERE id > $1
ORDER BY id
LIMIT $2`
	rows, err := pool.Query(ctx, selectEvents, after, limit)
	if err != nil {
		return nil, 0, fmt.Errorf("pg event log query: %w", err)
	}
	defer rows.Close()

	events = make([]serverEvent, 0, limit)
	for rows.Next() {
		var (
			ev        serverEvent
			raw       []byte
			createdAt time.Time
		)
		if err := rows.Scan(&ev.ID, &ev.Type, &raw, &createdAt); err != nil {
			return nil, 0, fmt.Errorf("pg event log scan: %w", err)
		}
		ev.At = createdAt.UTC().Format(time.RFC3339)
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &ev.Payload); err != nil {
				return nil, 0, fmt.Errorf("pg event payload unmarshal: %w", err)
			}
		}
		events = append(events, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("pg event log rows: %w", err)
	}

	const selectLatest = `SELECT COALESCE(MAX(id), 0) FROM event_log`
	if err := pool.QueryRow(ctx, selectLatest).Scan(&latest); err != nil {
		return nil, 0, fmt.Errorf("pg event log latest: %w", err)
	}
	return events, latest, nil
}
