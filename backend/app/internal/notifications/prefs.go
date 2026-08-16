package notifications

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// pgPool is the subset of *pgxpool.Pool used by PrefStore, so unit tests can
// substitute a fake without a live database.
type pgPool interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ErrNotificationNotFound is returned by MarkRead when the row does not exist
// or belongs to another user.
var ErrNotificationNotFound = errors.New("notification not found")

// maxPrefPage caps the page size accepted by List.
const maxPrefPage = 100

// Notification is one row of the in-app feed (notifications).
type Notification struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	Type      string
	Title     string
	Body      string
	DeepLink  *string
	Read      bool
	CreatedAt time.Time
}

// Prefs is the per-event toggle map of one user per channel (nil maps mean
// "no preference stored").
type Prefs struct {
	Push  map[string]bool
	SMS   map[string]bool
	Email map[string]bool
	InApp map[string]bool
}

// PrefStore is the persistence layer for notifications and
// notification_preferences.
type PrefStore struct {
	pool pgPool
}

// NewPrefStore returns a PrefStore bound to the given pool.
func NewPrefStore(pool pgPool) *PrefStore {
	return &PrefStore{pool: pool}
}

// Upsert writes the full per-channel preference maps of a user. Each raw
// argument must be a JSON object (json.RawMessage); the caller decides what
// an absent channel means.
func (s *PrefStore) Upsert(ctx context.Context, userID uuid.UUID, push, sms, email, inApp []byte) error {
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO notification_preferences (user_id, push, sms, email, in_app, updated_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (user_id) DO UPDATE SET
		     push = EXCLUDED.push,
		     sms = EXCLUDED.sms,
		     email = EXCLUDED.email,
		     in_app = EXCLUDED.in_app,
		     updated_at = now()`,
		userID, json.RawMessage(push), json.RawMessage(sms), json.RawMessage(email), json.RawMessage(inApp)); err != nil {
		return fmt.Errorf("notifications: upsert preferences: %w", err)
	}
	return nil
}

// Get returns the preferences of a user, or (nil, nil) when no row exists.
func (s *PrefStore) Get(ctx context.Context, userID uuid.UUID) (*Prefs, error) {
	var push, sms, email, inApp []byte
	err := s.pool.QueryRow(ctx,
		`SELECT push, sms, email, in_app
		 FROM notification_preferences WHERE user_id = $1`,
		userID).Scan(&push, &sms, &email, &inApp)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("notifications: get preferences: %w", err)
	}
	p := &Prefs{}
	if err := json.Unmarshal(push, &p.Push); err != nil {
		return nil, fmt.Errorf("notifications: get preferences: decode push: %w", err)
	}
	if err := json.Unmarshal(sms, &p.SMS); err != nil {
		return nil, fmt.Errorf("notifications: get preferences: decode sms: %w", err)
	}
	if err := json.Unmarshal(email, &p.Email); err != nil {
		return nil, fmt.Errorf("notifications: get preferences: decode email: %w", err)
	}
	if err := json.Unmarshal(inApp, &p.InApp); err != nil {
		return nil, fmt.Errorf("notifications: get preferences: decode in_app: %w", err)
	}
	return p, nil
}

// channelEnabledQuery selects the per-event toggle column of one channel.
// The channel identifiers are compile-time constants in the map — never user
// input — and the value lookup itself is parameterized.
var channelEnabledQuery = map[string]string{
	"push":   `SELECT push FROM notification_preferences WHERE user_id = $1`,
	"sms":    `SELECT sms FROM notification_preferences WHERE user_id = $1`,
	"email":  `SELECT email FROM notification_preferences WHERE user_id = $1`,
	"in_app": `SELECT in_app FROM notification_preferences WHERE user_id = $1`,
}

// ChannelEnabled reports whether userID has enabled eventType on channel
// ("push", "sms", "email" or "in_app"). The rules are defaults-on
// (backend/NOTIFICATIONS.md §preferences):
//
//   - no preferences row → true (every channel/event defaults to on);
//   - an empty or missing toggle object → true;
//   - an explicit boolean for the exact eventType wins over everything;
//   - a "*" key acts as the channel-wide default when the exact eventType
//     is absent;
//   - anything else (unknown event, non-boolean value, malformed jsonb) →
//     true with a warning: a preference row must never silence a channel by
//     accident.
//
// Policy decisions — e.g. whether OTP SMS is exempt from toggles — are the
// caller's: this store special-cases no event, the caller opts in by calling
// (or not calling) ChannelEnabled.
func (s *PrefStore) ChannelEnabled(ctx context.Context, userID uuid.UUID, channel, eventType string) (bool, error) {
	q, ok := channelEnabledQuery[channel]
	if !ok {
		return false, fmt.Errorf("notifications: channel enabled: unknown channel %q", channel)
	}
	var raw []byte
	err := s.pool.QueryRow(ctx, q, userID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("notifications: channel enabled: %w", err)
	}
	return resolveChannelEnabled(channel, raw, eventType), nil
}

// resolveChannelEnabled applies one channel's toggle object to eventType.
// It never returns false for a malformed or unknown payload: defaults are on
// and the failure mode is a warning, not silence.
func resolveChannelEnabled(channel string, raw []byte, eventType string) bool {
	if len(raw) == 0 {
		return true
	}
	var toggles map[string]any
	if err := json.Unmarshal(raw, &toggles); err != nil {
		slog.Default().Warn("notifications: channel enabled: malformed toggle jsonb, defaulting to enabled",
			"channel", channel, "error", err)
		return true
	}
	if v, ok := toggles[eventType]; ok {
		if b, isBool := v.(bool); isBool {
			return b
		}
		slog.Default().Warn("notifications: channel enabled: non-boolean toggle, defaulting to enabled",
			"channel", channel, "eventType", eventType)
	}
	if v, ok := toggles["*"]; ok {
		if b, isBool := v.(bool); isBool {
			return b
		}
		slog.Default().Warn("notifications: channel enabled: non-boolean wildcard toggle, defaulting to enabled",
			"channel", channel)
	}
	return true
}

// List returns the user's feed ordered by created_at DESC (id DESC breaks
// ties), starting after the given opaque cursor ("" = first page). The
// returned cursor feeds the next page and is "" when the end is reached.
func (s *PrefStore) List(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]Notification, string, error) {
	if limit <= 0 || limit > maxPrefPage {
		limit = maxPrefPage
	}
	// Fetch one extra row to detect whether another page exists.
	q := `SELECT id, type, title, body, deep_link, read, created_at
	      FROM notifications WHERE user_id = $1`
	args := []any{userID}
	if cursor != "" {
		ts, id, err := decodeCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("notifications: list: %w", err)
		}
		q += ` AND (created_at, id) < ($2, $3)`
		args = append(args, ts, id)
	}
	q += ` ORDER BY created_at DESC, id DESC
	      LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, "", fmt.Errorf("notifications: list: %w", err)
	}
	defer rows.Close()

	items := make([]Notification, 0, limit+1)
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Type, &n.Title, &n.Body, &n.DeepLink, &n.Read, &n.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("notifications: list scan: %w", err)
		}
		items = append(items, n)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("notifications: list rows: %w", err)
	}

	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return items, next, nil
}

// MarkRead flags one notification as read. Rows of other users are never
// touched: a zero-row update yields ErrNotificationNotFound.
func (s *PrefStore) MarkRead(ctx context.Context, notificationID, userID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2`,
		notificationID, userID)
	if err != nil {
		return fmt.Errorf("notifications: mark read: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotificationNotFound
	}
	return nil
}

// MarkAllRead flags every unread notification of the user as read.
func (s *PrefStore) MarkAllRead(ctx context.Context, userID uuid.UUID) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE notifications SET read = true WHERE user_id = $1 AND read = false`,
		userID); err != nil {
		return fmt.Errorf("notifications: mark all read: %w", err)
	}
	return nil
}

// Create inserts an in-app notification (used by the push worker's
// InAppWriter; the id and timestamps come from the database).
func (s *PrefStore) Create(ctx context.Context, n Notification) error {
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO notifications (user_id, type, title, body, deep_link)
		 VALUES ($1, $2, $3, $4, $5)`,
		n.UserID, n.Type, n.Title, n.Body, n.DeepLink); err != nil {
		return fmt.Errorf("notifications: create: %w", err)
	}
	return nil
}

// encodeCursor renders a page boundary into an opaque base64 cursor. The
// (created_at, id) pair is the full ordering key, so pages never overlap.
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.URLEncoding.EncodeToString([]byte(raw))
}

// decodeCursor parses a cursor produced by encodeCursor.
func decodeCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor: %w", err)
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, errors.New("invalid cursor")
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor id: %w", err)
	}
	return ts, id, nil
}
