package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// liveDealChatMessage is the contract LiveDealChatMessage projection
// (id, authorName, body, at). The author's display name is resolved from the
// users.full_name at read time.
type liveDealChatMessage struct {
	ID         string    `json:"id"`
	AuthorName string    `json:"authorName"`
	Body       string    `json:"body"`
	At         time.Time `json:"at"`
}

// liveDealChatMessageMaxLen matches the live_deal_chats.body CHECK constraint
// and the contract's maxLength (2000).
const liveDealChatMessageMaxLen = 2000

// loadLiveDealChat fetches one chat row joined to its author display name.
func (s *Server) loadLiveDealChat(ctx context.Context, id uuid.UUID) (liveDealChatMessage, error) {
	var (
		rowID     uuid.UUID
		body      string
		createdAt time.Time
		fullName  string
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT c.id, c.body, c.created_at, COALESCE(u.full_name, '')
		 FROM live_deal_chats c
		 JOIN users u ON u.id = c.user_id
		 WHERE c.id = $1`, id).Scan(&rowID, &body, &createdAt, &fullName)
	if err != nil {
		return liveDealChatMessage{}, err
	}
	return liveDealChatMessage{
		ID:         rowID.String(),
		AuthorName: fullName,
		Body:       body,
		At:         createdAt,
	}, nil
}

// MthGetLiveDealChat answers GET /marketing/live-deals/{id}/chat: the ordered
// (oldest-first) message thread for a live-deal session. Unknown sessions
// return 404; the route is RequireAuth-wrapped so the caller is always known.
func (s *Server) MthGetLiveDealChat(w http.ResponseWriter, r *http.Request) {
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "live deal session not found")
		return
	}
	if s.db == nil {
		s.logger.Error("get live deal chat failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var exists bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM live_deals WHERE id = $1)`, sessionID).Scan(&exists); err != nil {
		s.logger.Error("get live deal chat session check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "live deal session not found")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT c.id, c.body, c.created_at, COALESCE(u.full_name, '')
		 FROM live_deal_chats c
		 JOIN users u ON u.id = c.user_id
		 WHERE c.session_id = $1
		 ORDER BY c.created_at ASC`, sessionID)
	if err != nil {
		s.logger.Error("get live deal chat query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]liveDealChatMessage, 0)
	for rows.Next() {
		var (
			rowID     uuid.UUID
			body      string
			createdAt time.Time
			fullName  string
		)
		if err := rows.Scan(&rowID, &body, &createdAt, &fullName); err != nil {
			s.logger.Error("get live deal chat scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, liveDealChatMessage{
			ID:         rowID.String(),
			AuthorName: fullName,
			Body:       body,
			At:         createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("get live deal chat iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

// MthPostLiveDealChat answers POST /marketing/live-deals/{id}/chat: appends a
// message to a live-deal session thread. The Idempotency-Key header is
// required and enforced at the database (live_deal_chats.idempotency_key is
// UNIQUE), so a replayed key returns the original message. Unknown sessions
// return 404.
func (s *Server) MthPostLiveDealChat(w http.ResponseWriter, r *http.Request) {
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "live deal session not found")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}

	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Message == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "message is required")
		return
	}
	if len(body.Message) > liveDealChatMessageMaxLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "message must be at most 2000 characters")
		return
	}

	if s.db == nil {
		s.logger.Error("post live deal chat failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var exists bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM live_deals WHERE id = $1)`, sessionID).Scan(&exists); err != nil {
		s.logger.Error("post live deal chat session check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "live deal session not found")
		return
	}

	const ins = `
		INSERT INTO live_deal_chats (session_id, user_id, body, idempotency_key)
		VALUES ($1, $2, $3, $4)
		RETURNING id`
	var rowID uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(), ins, sessionID, user.ID, body.Message, key).Scan(&rowID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// Unique violation on idempotency_key: replay the original row.
			if err := s.db.Pool().QueryRow(r.Context(),
				`SELECT id FROM live_deal_chats WHERE idempotency_key = $1`, key).Scan(&rowID); err != nil {
				s.logger.Error("post live deal chat replay lookup failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
		} else {
			s.logger.Error("post live deal chat insert failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	msg, err := s.loadLiveDealChat(r.Context(), rowID)
	if err != nil {
		s.logger.Error("post live deal chat load failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, msg)
}
