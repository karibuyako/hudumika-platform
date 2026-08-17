package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

// Push-token registry (documented extension to the contract, which has no
// push-token endpoint: POST /notifications/me/push-token,
// DELETE /notifications/me/push-token, GET /notifications/me/push-tokens).
// The Expo push provider reads this registry to target per-device
// deliveries. Tokens are PII-adjacent: they are masked in logs (never logged
// verbatim) and stored in their own table (00059), outside the
// notification_preferences jsonb.

// allowedPushPlatforms is the closed platform set; the 00059 check column
// enforces the same set at the database.
var allowedPushPlatforms = map[string]bool{
	"expo": true, "apns": true, "fcm": true,
}

// pushTokenBounds bound the stored token (00059 has no length constraint, so
// the handler rejects out-of-range values with PUSH_TOKEN_INVALID).
const (
	minPushTokenLen = 10
	maxPushTokenLen = 512
)

// pushTokenItem is the local response shape for one registered device.
type pushTokenItem struct {
	Token      string    `json:"token"`
	Platform   string    `json:"platform"`
	DeviceName *string   `json:"deviceName,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

// registerPushTokenBody is the POST /notifications/me/push-token payload.
// platform defaults to "expo" when omitted.
type registerPushTokenBody struct {
	Token      string  `json:"token"`
	Platform   string  `json:"platform"`
	DeviceName *string `json:"deviceName"`
}

// maskPushToken keeps push tokens out of logs: only the first 8 characters
// plus a length hint survive.
func maskPushToken(token string) string {
	if len(token) < 8 {
		return "***"
	}
	return token[:8] + "...(" + strconv.Itoa(len(token)) + " chars)"
}

// validPushToken reports whether a token passes the format gate: non-empty
// and within the length bounds.
func validPushToken(token string) bool {
	n := len(strings.TrimSpace(token))
	return n >= minPushTokenLen && n <= maxPushTokenLen
}

// RegisterPushToken registers (or re-registers) one device token for the
// session user. Re-registering the same token is an upsert, not a duplicate:
// the (user_id, token) unique constraint turns the second POST into an
// update of the row's platform/device_name/updated_at. The body is validated
// BEFORE the user lookup so an invalid token answers 422 PUSH_TOKEN_INVALID
// even when the database is unavailable.
func (s *Server) RegisterPushToken(w http.ResponseWriter, r *http.Request) {
	var body registerPushTokenBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	token := strings.TrimSpace(body.Token)
	if !validPushToken(token) {
		writeError(w, http.StatusUnprocessableEntity, "PUSH_TOKEN_INVALID",
			"Push token must be between 10 and 512 characters")
		return
	}
	platform := body.Platform
	if platform == "" {
		platform = "expo"
	}
	if !allowedPushPlatforms[platform] {
		writeError(w, http.StatusUnprocessableEntity, "PUSH_TOKEN_INVALID",
			"Platform must be one of expo, apns, fcm")
		return
	}

	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	var item pushTokenItem
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO push_tokens (user_id, token, platform, device_name)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (user_id, token) DO UPDATE SET
		   platform = EXCLUDED.platform,
		   device_name = EXCLUDED.device_name,
		   updated_at = now()
		 RETURNING token, platform, device_name, created_at`,
		user.ID, token, platform, body.DeviceName).
		Scan(&item.Token, &item.Platform, &item.DeviceName, &item.CreatedAt)
	if err != nil {
		s.logger.Error("register push token failed", "user_id", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.logger.Info("push token registered", "user_id", user.ID, "platform", platform, "token", maskPushToken(token))
	writeJSON(w, http.StatusCreated, item)
}

// DeletePushToken deregisters one device token for the session user. It is
// idempotent: deleting an unknown token (or omitting it) still answers 204.
// The token rides the required `token` query parameter (contract
// DELETE /notifications/me/push-token).
func (s *Server) DeletePushToken(w http.ResponseWriter, r *http.Request, params gen.DeletePushTokenParams) {
	token := strings.TrimSpace(params.Token)

	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`,
		user.ID, token); err != nil {
		s.logger.Error("delete push token failed", "user_id", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	s.logger.Info("push token deleted", "user_id", user.ID, "token", maskPushToken(token))
	w.WriteHeader(http.StatusNoContent)
}

// ListPushTokens returns every registered device token of the session user,
// oldest first; `[]` when none.
func (s *Server) ListPushTokens(w http.ResponseWriter, r *http.Request) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT token, platform, device_name, created_at
		 FROM push_tokens
		 WHERE user_id = $1
		 ORDER BY created_at, id`, user.ID)
	if err != nil {
		s.logger.Error("list push tokens failed", "user_id", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	items := make([]pushTokenItem, 0)
	for rows.Next() {
		var it pushTokenItem
		if err := rows.Scan(&it.Token, &it.Platform, &it.DeviceName, &it.CreatedAt); err != nil {
			s.logger.Error("scan push token failed", "user_id", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate push tokens failed", "user_id", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, items)
}
