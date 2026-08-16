package audit

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Cursor/default bounds for List (README contract: limit defaults to 20 and
// is capped at 100).
const (
	defaultListLimit = 20
	maxListLimit     = 100
)

// QueueItem is one named queue with the number of items waiting on it.
type QueueItem struct {
	Name  *string
	Count *int
}

// Overview is the admin operations dashboard. It declares one field per
// metric the generated AdminOverview exposes (internal/gen/openapi.gen.go),
// and every declared metric is filled: metrics whose backing pipeline does
// not exist yet are honest zeros, documented per field.
type Overview struct {
	// ActiveOrders is the number of orders created today (orders table,
	// migration 00005). The table may not have landed yet: when it is
	// absent the count is 0 without error.
	ActiveOrders *int
	// ActiveBookings is the number of in-flight bookings. No bookings
	// pipeline exists yet; honest 0.
	ActiveBookings *int
	// PendingApprovals is the number of items awaiting staff approval
	// (review moderation, merchant verification). No approval queue
	// exists yet; honest 0.
	PendingApprovals *int
	// OpenTickets is the number of open support tickets. The support
	// tables do not exist yet; honest 0.
	OpenTickets *int
	// PendingPayoutsTZS is the total value (TZS) of pending payouts. The
	// payouts pipeline does not exist yet; honest 0.
	PendingPayoutsTZS *int
	// Exceptions is the number of operational exceptions (failed jobs,
	// flagged orders). No alerting pipeline exists yet; honest 0.
	Exceptions *int
	// Queue is the list of pending queues and their sizes. No queues are
	// defined yet; it serializes as [] (never null).
	Queue []QueueItem
}

// Query reads the admin read surfaces (overview metrics, audit log) from
// Postgres.
type Query struct {
	pool *pgxpool.Pool
}

// NewQuery returns an admin read Query backed by the given connection pool.
func NewQuery(pool *pgxpool.Pool) *Query { return &Query{pool: pool} }

// Overview computes the admin operations metrics with a few parameterized
// queries (no N+1). Honest zeros are returned for metrics whose backing
// tables do not exist yet instead of failing the request.
func (q *Query) Overview(ctx context.Context) (Overview, error) {
	ov := Overview{
		ActiveOrders:      intPtr(0),
		ActiveBookings:    intPtr(0), // no bookings pipeline yet
		PendingApprovals:  intPtr(0), // no approval queue yet
		OpenTickets:       intPtr(0), // no support tables yet
		PendingPayoutsTZS: intPtr(0), // no payouts pipeline yet
		Exceptions:        intPtr(0), // no alerting pipeline yet
		Queue:             []QueueItem{},
	}

	// The orders table (migration 00005) is owned by another milestone and
	// may not exist at runtime: guard the count so a missing table reads as
	// 0 instead of an error.
	var ordersExist bool
	if err := q.pool.QueryRow(ctx,
		`SELECT to_regclass('public.orders') IS NOT NULL`,
	).Scan(&ordersExist); err != nil {
		return Overview{}, fmt.Errorf("overview orders guard: %w", err)
	}
	if ordersExist {
		var activeOrders int
		if err := q.pool.QueryRow(ctx,
			`SELECT count(*) FROM orders WHERE created_at >= date_trunc('day', now())`,
		).Scan(&activeOrders); err != nil {
			return Overview{}, fmt.Errorf("overview active orders: %w", err)
		}
		ov.ActiveOrders = &activeOrders
	}
	return ov, nil
}

// ListParams filters the audit log read. Empty filters are ignored; Limit
// defaults to 20 and is capped at 100; Cursor resumes a previous page.
type ListParams struct {
	ActorID      *uuid.UUID
	ActionPrefix string
	EntityType   string
	EntityID     string
	From, To     *time.Time
	Limit        int
	Cursor       string
}

// List returns audit entries matching in, newest first. The returned cursor
// ("" on the last page) resumes after the last row of the page; pages never
// overlap. An empty result is an empty slice, never nil.
func (q *Query) List(ctx context.Context, in ListParams) ([]Entry, string, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}

	query := `SELECT id, actor_id, actor_role, action, entity_type, entity_id,
			details, request_id, ip, created_at
		FROM audit_logs`
	args := make([]any, 0, 10)
	where := make([]string, 0, 7)

	if in.ActorID != nil {
		args = append(args, *in.ActorID)
		where = append(where, fmt.Sprintf("actor_id = $%d", len(args)))
	}
	if in.ActionPrefix != "" {
		// LIKE with an exact prefix match: 'order.%' matches actions that
		// start with that exact prefix only.
		args = append(args, in.ActionPrefix+"%")
		where = append(where, fmt.Sprintf("action LIKE $%d", len(args)))
	}
	if in.EntityType != "" {
		args = append(args, in.EntityType)
		where = append(where, fmt.Sprintf("entity_type = $%d", len(args)))
	}
	if in.EntityID != "" {
		args = append(args, in.EntityID)
		where = append(where, fmt.Sprintf("entity_id = $%d", len(args)))
	}
	if in.From != nil {
		args = append(args, *in.From)
		where = append(where, fmt.Sprintf("created_at >= $%d", len(args)))
	}
	if in.To != nil {
		args = append(args, *in.To)
		where = append(where, fmt.Sprintf("created_at <= $%d", len(args)))
	}
	if in.Cursor != "" {
		at, id, err := ParseCursor(in.Cursor)
		if err != nil {
			return nil, "", fmt.Errorf("audit list cursor: %w", err)
		}
		// Keyset pagination descending: strictly before the page's last row.
		args = append(args, at, id)
		where = append(where, fmt.Sprintf("(created_at, id) < ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	// One extra row acts as a sentinel so a full-but-final page does not
	// advertise a next cursor.
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := q.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("audit list query: %w", err)
	}
	defer rows.Close()

	entries := make([]Entry, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id         uuid.UUID
			actorID    uuid.UUID
			actorRole  *string
			action     string
			entityType *string
			entityID   *string
			details    *[]byte
			requestID  *string
			ip         *string
			createdAt  time.Time
		)
		if err := rows.Scan(&id, &actorID, &actorRole, &action, &entityType,
			&entityID, &details, &requestID, &ip, &createdAt); err != nil {
			return nil, "", fmt.Errorf("audit list scan: %w", err)
		}
		if len(entries) == limit {
			// The sentinel row: the page is full and another row exists.
			sentinel = true
			continue
		}
		entries = append(entries, Entry{
			ActorID:    actorID.String(),
			ActorRole:  strDeref(actorRole),
			Action:     action,
			EntityType: strDeref(entityType),
			EntityID:   strDeref(entityID),
			Details:    rawDeref(details),
			RequestID:  strDeref(requestID),
			IP:         strDeref(ip),
			CreatedAt:  createdAt,
		})
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("audit list rows: %w", err)
	}

	next := ""
	if sentinel {
		next = EncodeCursor(lastAt, lastID)
	}
	return entries, next, nil
}

// EncodeCursor packs a row's (created_at, id) keyset into a URL-safe base64
// string; ParseCursor is its inverse. The format mirrors the service cursor
// in internal/api/cities.go.
func EncodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// ParseCursor decodes a cursor produced by EncodeCursor.
func ParseCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor id: %w", err)
	}
	return createdAt, id, nil
}

func intPtr(v int) *int { return &v }

func strDeref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func rawDeref(p *[]byte) json.RawMessage {
	if p == nil {
		return nil
	}
	return json.RawMessage(*p)
}
