// Package audit records append-only audit entries for money, status,
// identity, and moderation mutations (backend/DATA-MODEL.md "Audit").
// Recording is best-effort: a failed insert is logged and never fails the
// request.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Entry is a single audit record. ActorID is the session subject (a user
// UUID once identity linkage lands; phone numbers before that).
type Entry struct {
	ActorID    string
	ActorRole  string
	Action     string
	EntityType string
	EntityID   string
	Details    json.RawMessage
	RequestID  string
	IP         string
	CreatedAt  time.Time
}

// AuditStore persists audit entries. Implementations must never be depended
// on for request correctness: failures are logged and dropped.
type AuditStore interface {
	Insert(ctx context.Context, e Entry) error
}

// PgAudit inserts audit entries into Postgres.
type PgAudit struct {
	pool *pgxpool.Pool
}

// NewPg returns a PgAudit backed by the given connection pool.
func NewPg(pool *pgxpool.Pool) *PgAudit { return &PgAudit{pool: pool} }

// Insert appends one row to audit_logs. Subjects that are not UUIDs (phone
// numbers before user linkage) are resolved via users.phone lookup so the
// row carries the real actor UUID; unresolvable subjects fall back to the
// nil UUID so the row is never dropped.
func (p *PgAudit) Insert(ctx context.Context, e Entry) error {
	const insert = `
INSERT INTO audit_logs
    (actor_id, actor_role, action, entity_type, entity_id, details, request_id, ip, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
	actor := p.resolveActorID(ctx, e.ActorID)
	if _, err := p.pool.Exec(ctx, insert,
		actor, e.ActorRole, e.Action, e.EntityType, e.EntityID,
		e.Details, e.RequestID, e.IP, e.CreatedAt,
	); err != nil {
		return fmt.Errorf("audit insert: %w", err)
	}
	return nil
}

// InsertReturningID appends one row exactly like Insert and additionally
// returns the generated row id, so handlers whose contract response carries
// an auditEntryId can surface the entry (admin-pending results, PENDING
// audit convention). Append-only: never UPDATE/DELETE.
func (p *PgAudit) InsertReturningID(ctx context.Context, e Entry) (uuid.UUID, error) {
	const insert = `
INSERT INTO audit_logs
    (actor_id, actor_role, action, entity_type, entity_id, details, request_id, ip, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id`
	actor := p.resolveActorID(ctx, e.ActorID)
	var id uuid.UUID
	if err := p.pool.QueryRow(ctx, insert,
		actor, e.ActorRole, e.Action, e.EntityType, e.EntityID,
		e.Details, e.RequestID, e.IP, e.CreatedAt,
	).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("audit insert: %w", err)
	}
	return id, nil
}

// actorUUID maps an actor subject to the actor_id column. Subjects that are
// not UUIDs (phone numbers before user linkage) map to the nil UUID so the
// row is never dropped.
func actorUUID(subject string) (uuid.UUID, error) {
	actor, err := uuid.Parse(subject)
	if err != nil {
		return uuid.Nil, nil
	}
	return actor, nil
}

// resolveActorID maps an actor subject to the actor_id column, resolving
// phone subjects via users.phone → users.id lookup when the subject is not a
// UUID (the session subject is the phone, not the user UUID). Unresolvable
// subjects fall back to uuid.Nil so the row is never dropped; callers that
// have a logger (router.go audit middleware) log a warning on lookup failure.
func (p *PgAudit) resolveActorID(ctx context.Context, subject string) uuid.UUID {
	if subject == "" {
		return uuid.Nil
	}
	if id, err := uuid.Parse(subject); err == nil {
		return id
	}
	if p.pool == nil {
		return uuid.Nil
	}
	var id uuid.UUID
	if err := p.pool.QueryRow(ctx, `SELECT id FROM users WHERE phone = $1`, subject).Scan(&id); err != nil {
		return uuid.Nil
	}
	return id
}

// MemoryAudit is an in-memory AuditStore for tests.
type MemoryAudit struct {
	mu      sync.Mutex
	Entries []Entry
}

// Insert appends e to the in-memory log.
func (m *MemoryAudit) Insert(ctx context.Context, e Entry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Entries = append(m.Entries, e)
	return nil
}

// Middleware records audit entries for mutating requests on money, status,
// and moderation routes (DATA-MODEL.md: money, status, identity,
// moderation).
type Middleware struct {
	store   AuditStore
	logger  *slog.Logger
	actorOf func(ctx context.Context) (id, role string)
}

// NewMiddleware returns an audit middleware. actorOf extracts the acting
// session's identity from the request context; it is wired by the API layer
// (via ClaimsFromContext) to avoid an import cycle, and may be nil.
func NewMiddleware(store AuditStore, logger *slog.Logger, actorOf func(ctx context.Context) (id, role string)) *Middleware {
	return &Middleware{store: store, logger: logger, actorOf: actorOf}
}

// auditedPrefixes are the route families whose mutations must be audited.
var auditedPrefixes = []string{
	"/orders/", "/bookings/", "/payments/", "/wallet/", "/reviews/",
	"/admin/", "/merchants/", "/providers/", "/riders/", "/payouts/",
}

// Handler records an audit entry before serving requests that mutate money,
// status, or moderation resources.
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isAudited(r) {
			m.record(r)
		}
		next.ServeHTTP(w, r)
	})
}

func isAudited(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return false
	}
	for _, p := range auditedPrefixes {
		if strings.HasPrefix(r.URL.Path, p) {
			return true
		}
	}
	return false
}

// record inserts an entry for r; failures are logged and never surfaced.
func (m *Middleware) record(r *http.Request) {
	e := Entry{
		Action:     r.Method + " " + r.URL.Path,
		EntityType: firstPathSegment(r.URL.Path),
		RequestID:  middleware.GetReqID(r.Context()),
		IP:         r.RemoteAddr,
		CreatedAt:  time.Now(),
	}
	if m.actorOf != nil {
		e.ActorID, e.ActorRole = m.actorOf(r.Context())
	}
	if err := m.store.Insert(r.Context(), e); err != nil {
		m.logger.Error("audit insert failed", "error", err, "action", e.Action, "path", r.URL.Path)
	}
}

// firstPathSegment returns the leading segment of a URL path, e.g. "orders"
// for "/orders/123/accept".
func firstPathSegment(path string) string {
	seg := strings.TrimPrefix(path, "/")
	if i := strings.IndexByte(seg, '/'); i >= 0 {
		seg = seg[:i]
	}
	return seg
}
