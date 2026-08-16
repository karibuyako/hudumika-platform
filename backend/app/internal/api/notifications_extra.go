package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// NOTIFICATIONS-EXTRA backs the generated order-settings and announcements
// surface (API-CONTRACT.yaml §/notifications/me/order-settings,
// §/announcements; migration 00038_notifications_extra.sql). The contract
// schema is OrderAlertSettings — a merchant order alert / acceptance object,
// not per-order event toggles — and the announcements list item is an inline
// {id, title, body, publishedAt} object (no generated Announcement type).

// orderSettingsKeys is the field set of the OrderAlertSettings contract
// schema. json.Unmarshal into the generated struct would silently drop any
// other key, so the raw body is inspected as a map first and unknown keys are
// rejected with PREFERENCE_INVALID_EVENT (ERROR-CODES.md) before any
// database access.
var orderSettingsKeys = map[string]bool{
	"acceptanceMethod":        true,
	"voiceAlerts":             true,
	"channels":                true,
	"quietHours":              true,
	"autoAcceptWithinSeconds": true,
}

// defaultOrderAlertSettings is the honest no-row shape: every channel on,
// voice alerts on, manual acceptance, quiet hours disabled. GET answers with
// it when the user has no notification_preferences row or an empty
// order_settings blob.
func defaultOrderAlertSettings() gen.OrderAlertSettings {
	method := gen.OrderAlertSettingsAcceptanceMethodManual
	voice := true
	quiet := false
	channels := []gen.OrderAlertSettingsChannels{
		gen.OrderAlertSettingsChannelsPush,
		gen.OrderAlertSettingsChannelsSms,
		gen.OrderAlertSettingsChannelsInApp,
	}
	return gen.OrderAlertSettings{
		AcceptanceMethod: &method,
		VoiceAlerts:      &voice,
		Channels:         &channels,
		QuietHours: &struct {
			Enabled *bool   `json:"enabled,omitempty"`
			From    *string `json:"from,omitempty"`
			To      *string `json:"to,omitempty"`
		}{Enabled: &quiet},
	}
}

// GetOrderAlertSettings returns the caller's order alert and acceptance
// settings (GET /notifications/me/order-settings). A user that never stored
// settings gets the default shape.
func (s *Server) GetOrderAlertSettings(w http.ResponseWriter, r *http.Request) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}
	settings, err := s.loadOrderAlertSettings(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("get order alert settings failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// loadOrderAlertSettings reads the stored OrderAlertSettings blob. No row or
// an empty blob both yield the default shape.
func (s *Server) loadOrderAlertSettings(ctx context.Context, userID uuid.UUID) (gen.OrderAlertSettings, error) {
	var stored []byte
	err := s.db.Pool().QueryRow(ctx,
		`SELECT order_settings FROM notification_preferences WHERE user_id = $1`, userID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultOrderAlertSettings(), nil
	}
	if err != nil {
		return gen.OrderAlertSettings{}, fmt.Errorf("notifications-extra: load order alert settings: %w", err)
	}
	var settings gen.OrderAlertSettings
	if err := json.Unmarshal(stored, &settings); err != nil {
		return gen.OrderAlertSettings{}, fmt.Errorf("notifications-extra: decode order alert settings: %w", err)
	}
	if settings.AcceptanceMethod == nil && settings.VoiceAlerts == nil && settings.Channels == nil &&
		settings.QuietHours == nil && settings.AutoAcceptWithinSeconds == nil {
		return defaultOrderAlertSettings(), nil
	}
	return settings, nil
}

// UpdateOrderAlertSettings replaces the caller's order alert and acceptance
// settings (PUT /notifications/me/order-settings). The body is validated
// before the caller is resolved, so malformed settings are rejected with 422
// regardless of the database state; only the order_settings column of the
// preference row is touched (the 00009 per-channel toggle columns are owned
// by the notifications package).
func (s *Server) UpdateOrderAlertSettings(w http.ResponseWriter, r *http.Request) {
	settings, ok := parseOrderAlertSettings(w, r)
	if !ok {
		return
	}
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}
	stored, err := json.Marshal(settings)
	if err != nil {
		s.logger.Error("marshal order alert settings failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO notification_preferences (user_id, order_settings, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (user_id) DO UPDATE
		 SET order_settings = EXCLUDED.order_settings, updated_at = now()`,
		user.ID, json.RawMessage(stored)); err != nil {
		s.logger.Error("upsert order alert settings failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// parseOrderAlertSettings decodes and validates the PUT body against the
// OrderAlertSettings contract schema: keys outside the schema are rejected
// with PREFERENCE_INVALID_EVENT, out-of-enum channels/acceptanceMethod and
// an out-of-range autoAcceptWithinSeconds (contract minimum 30, maximum 300)
// are rejected with VALIDATION_FAILED.
func parseOrderAlertSettings(w http.ResponseWriter, r *http.Request) (gen.OrderAlertSettings, bool) {
	var raw map[string]json.RawMessage
	if err := decodeJSON(r, &raw); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return gen.OrderAlertSettings{}, false
	}
	for key := range raw {
		if !orderSettingsKeys[key] {
			writeError(w, http.StatusUnprocessableEntity, "PREFERENCE_INVALID_EVENT",
				"Unknown order alert setting: "+key)
			return gen.OrderAlertSettings{}, false
		}
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return gen.OrderAlertSettings{}, false
	}
	var body gen.OrderAlertSettings
	if err := json.Unmarshal(encoded, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return gen.OrderAlertSettings{}, false
	}
	if body.AcceptanceMethod != nil && !body.AcceptanceMethod.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "acceptanceMethod must be manual or auto")
		return gen.OrderAlertSettings{}, false
	}
	if body.Channels != nil {
		for _, c := range *body.Channels {
			if !c.Valid() {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "channels entries must be push, sms or in_app")
				return gen.OrderAlertSettings{}, false
			}
		}
	}
	if body.AutoAcceptWithinSeconds != nil &&
		(*body.AutoAcceptWithinSeconds < 30 || *body.AutoAcceptWithinSeconds > 300) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"autoAcceptWithinSeconds must be between 30 and 300")
		return gen.OrderAlertSettings{}, false
	}
	return body, true
}

// --- announcements ---------------------------------------------------------

// Announcement pagination caps (backend/NOTIFICATIONS.md: page size 20).
// The contract declares no pagination parameters for /announcements, so the
// list is capped server-side and paged via an optional limit query parameter
// plus an opaque cursor with the next page advertised in X-Next-Cursor
// (same convention as /orders/search; documented deviation).
const (
	announcementsDefaultLimit = 20
	announcementsMaxLimit     = 100
)

// announcementItem is one /announcements list item. The contract shape is an
// inline {id, title, body, publishedAt} object; audience/active/window are
// stored but never leak.
type announcementItem struct {
	ID          openapi_types.UUID `json:"id"`
	Title       string             `json:"title"`
	Body        string             `json:"body"`
	PublishedAt time.Time          `json:"publishedAt"`
}

// ListAnnouncements serves the platform broadcast feed (GET /announcements,
// bearerAuth per the contract). Only active announcements inside their
// publish window are returned, newest first, `[]` when none.
func (s *Server) ListAnnouncements(w http.ResponseWriter, r *http.Request) {
	if _, err := s.notificationUser(r); err != nil {
		s.writeNotificationUserError(w, err)
		return
	}
	limit := announcementsDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > announcementsMaxLimit {
		limit = announcementsMaxLimit
	}

	q := `SELECT id, title, body, COALESCE(starts_at, created_at) AS published_at
	      FROM announcements
	      WHERE active = true
	        AND (starts_at IS NULL OR starts_at <= now())
	        AND (ends_at IS NULL OR ends_at >= now())`
	args := []any{}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		ts, id, err := decodeAnnouncementCursor(cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid cursor")
			return
		}
		q += ` AND (COALESCE(starts_at, created_at), id) < ($` + strconv.Itoa(len(args)+1) +
			`, $` + strconv.Itoa(len(args)+2) + `)`
		args = append(args, ts, id)
	}
	// Fetch one extra row to detect whether another page exists.
	q += ` ORDER BY COALESCE(starts_at, created_at) DESC, id DESC
	      LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)

	rows, err := s.db.Pool().Query(r.Context(), q, args...)
	if err != nil {
		s.logger.Error("list announcements failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	items := make([]announcementItem, 0, limit+1)
	for rows.Next() {
		var (
			id          uuid.UUID
			title, body string
			publishedAt time.Time
		)
		if err := rows.Scan(&id, &title, &body, &publishedAt); err != nil {
			s.logger.Error("scan announcement failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		items = append(items, announcementItem{
			ID:          id,
			Title:       title,
			Body:        body,
			PublishedAt: publishedAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate announcements failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		w.Header().Set("X-Next-Cursor", encodeAnnouncementCursor(last.PublishedAt, last.ID))
	}
	writeJSON(w, http.StatusOK, items)
}

// encodeAnnouncementCursor renders a page boundary (published_at, id) into
// an opaque base64 cursor; pages never overlap.
func encodeAnnouncementCursor(publishedAt time.Time, id uuid.UUID) string {
	raw := publishedAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.URLEncoding.EncodeToString([]byte(raw))
}

// decodeAnnouncementCursor parses a cursor produced by
// encodeAnnouncementCursor.
func decodeAnnouncementCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid announcement cursor: %w", err)
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, errors.New("invalid announcement cursor")
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid announcement cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid announcement cursor id: %w", err)
	}
	return ts, id, nil
}
