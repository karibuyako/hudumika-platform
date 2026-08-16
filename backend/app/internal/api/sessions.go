package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// ListMySessions returns the caller's live sessions projected from the
// durable sessions table (the Redis store is the hot path; the DB row is the
// durable mirror). device_info is the raw JSON text when present (it is not
// populated by the OTP flow today), and Current is left unset: the caller's
// access token is opaque and cannot be matched to a row.
func (s *Server) ListMySessions(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, device_info, created_at FROM sessions
		 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC`, user.ID)
	if err != nil {
		s.logger.Error("list sessions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	sessions := make([]gen.SessionInfo, 0)
	for rows.Next() {
		var (
			id         uuid.UUID
			deviceInfo *[]byte
			createdAt  time.Time
		)
		if err := rows.Scan(&id, &deviceInfo, &createdAt); err != nil {
			s.logger.Error("scan session failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		info := gen.SessionInfo{
			Id:           newUUID(id.String()),
			DeviceInfo:   "",
			LastActiveAt: createdAt,
		}
		if deviceInfo != nil {
			info.DeviceInfo = string(*deviceInfo)
		}
		sessions = append(sessions, info)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate sessions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

// RevokeSession revokes a session identified either by its durable id or by
// the raw refresh token string. Revocation is idempotent: an unknown or
// already-revoked session still answers 204. A token that is neither a UUID
// nor refresh-token-shaped (64 hex chars) is rejected with 422.
func (s *Server) RevokeSession(w http.ResponseWriter, r *http.Request, token string) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	var hash string
	if id, perr := uuid.Parse(token); perr == nil {
		// Session id: resolve the refresh hash from the durable row, scoped
		// to the caller so foreign sessions can never be revoked.
		if err := s.db.Pool().QueryRow(r.Context(),
			`SELECT refresh_token_hash FROM sessions WHERE id = $1 AND user_id = $2`,
			id, user.ID).Scan(&hash); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				s.logger.Error("session lookup failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			// Unknown session id: idempotent 204.
			w.WriteHeader(http.StatusNoContent)
			return
		}
	} else if isRefreshTokenShape(token) {
		hash = sha256Hex(token)
	} else {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"token must be a session id or a refresh token")
		return
	}

	if err := s.stores.Sessions.Revoke(r.Context(), hash); err != nil {
		s.logger.Error("session revoke failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if s.auth != nil {
		// The durable mirror is updated best-effort, matching Logout.
		if err := s.auth.RevokeSession(r.Context(), hash); err != nil {
			s.logger.Warn("session row revoke failed", "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// isRefreshTokenShape reports whether the value looks like the opaque refresh
// token minted by newRefreshToken (32 random bytes, hex-encoded).
func isRefreshTokenShape(token string) bool {
	if len(token) != 64 {
		return false
	}
	for _, c := range token {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}
