package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// pushTokenPlatforms enumerates the valid push provider platforms, matching
// the push_tokens.platform CHECK constraint added in migrations 00059/00104.
var pushTokenPlatforms = map[string]bool{
	"expo": true,
	"apns": true,
	"fcm":  true,
}

// pushTokenRegisterInput is the JSON body for POST /push/tokens (consumer
// alias). It mirrors PushTokenRegister but is parsed inline to avoid depending
// on the generated request-body type used by the /notifications/me surface.
type pushTokenRegisterInput struct {
	Token      string  `json:"token"`
	Platform   string  `json:"platform"`
	DeviceName *string `json:"deviceName"`
}

// MthRegisterPushTokenConsumer registers (or re-registers) a device push token
// for the authenticated user. It is the real implementation behind the stub
// (POST /push/tokens) and is idempotent: a repeated registration for the same
// (user_id, token) updates the platform/device metadata instead of failing.
func (s *Server) MthRegisterPushTokenConsumer(w http.ResponseWriter, r *http.Request) {
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	var body pushTokenRegisterInput
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid request body")
		return
	}

	token := strings.TrimSpace(body.Token)
	if len(token) < 10 || len(token) > 512 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "token must be between 10 and 512 characters")
		return
	}
	platform := strings.TrimSpace(body.Platform)
	if platform == "" {
		platform = "expo"
	}
	if !pushTokenPlatforms[platform] {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "platform must be one of expo, apns, fcm")
		return
	}

	if s.db == nil {
		s.logger.Error("register push token failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	const q = `
		INSERT INTO push_tokens (user_id, token, platform, device_name, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id, token)
		DO UPDATE SET platform = EXCLUDED.platform,
		              device_name = EXCLUDED.device_name,
		              updated_at = now()
		RETURNING token, platform, device_name, created_at, (xmax = 0) AS inserted`

	var (
		gotToken      string
		gotPlatform   string
		gotDeviceName *string
		gotCreatedAt  time.Time
		inserted      bool
	)
	if err := s.db.Pool().QueryRow(r.Context(), q, user.ID, token, platform, body.DeviceName).
		Scan(&gotToken, &gotPlatform, &gotDeviceName, &gotCreatedAt, &inserted); err != nil {
		s.logger.Error("register push token failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out := gen.PushToken{
		Token:      gotToken,
		Platform:   gen.PushTokenPlatform(gotPlatform),
		DeviceName: gotDeviceName,
		CreatedAt:  gotCreatedAt,
	}
	if inserted {
		writeJSON(w, http.StatusCreated, out)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthListPushTokens returns every registered device push token for the
// authenticated user, oldest first (GET /push/tokens, consumer alias).
func (s *Server) MthListPushTokens(w http.ResponseWriter, r *http.Request) {
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	if s.db == nil {
		s.logger.Error("list push tokens failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	const q = `
		SELECT token, platform, device_name, created_at
		FROM push_tokens
		WHERE user_id = $1
		ORDER BY created_at ASC`

	rows, err := s.db.Pool().Query(r.Context(), q, user.ID)
	if err != nil {
		s.logger.Error("list push tokens failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.PushToken, 0)
	for rows.Next() {
		var (
			gotToken      string
			gotPlatform   string
			gotDeviceName *string
			gotCreatedAt  time.Time
		)
		if err := rows.Scan(&gotToken, &gotPlatform, &gotDeviceName, &gotCreatedAt); err != nil {
			s.logger.Error("list push tokens scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.PushToken{
			Token:      gotToken,
			Platform:   gen.PushTokenPlatform(gotPlatform),
			DeviceName: gotDeviceName,
			CreatedAt:  gotCreatedAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("list push tokens iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

// MthDeletePushToken deregisters a device push token for the authenticated
// user (DELETE /push/tokens/{id}, consumer alias). The {id} path segment is the
// token string itself. It is scoped to the caller so a user can only remove
// their own tokens. A missing token returns 404; success returns 204.
func (s *Server) MthDeletePushToken(w http.ResponseWriter, r *http.Request) {
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	token := strings.TrimSpace(chi.URLParam(r, "id"))
	if token == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "token id is required")
		return
	}

	if s.db == nil {
		s.logger.Error("delete push token failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	const q = `DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`
	tag, err := s.db.Pool().Exec(r.Context(), q, user.ID, token)
	if err != nil {
		s.logger.Error("delete push token failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "push token not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
