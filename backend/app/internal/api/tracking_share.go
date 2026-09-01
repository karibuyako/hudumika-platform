package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// MthCreateTrackingShare creates a view-only tracking share link for an order.
// POST /orders/{id}/tracking-share — requires authentication, validates order
// ownership, and is idempotent by Idempotency-Key (replays stored token).
// Token format ts_* with 2h expiry.
func (s *Server) MthCreateTrackingShare(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	orderID, ok := mthParamUUID(r, "id")
	if !ok {
		orderID, ok = mthParamUUID(r, "orderId")
		if !ok {
			// also try contract wrapper param name via chi
			raw := strings.TrimSpace(chi.URLParam(r, "orderId"))
			if raw == "" {
				raw = strings.TrimSpace(chi.URLParam(r, "id"))
			}
			if raw == "" {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId is required")
				return
			}
			parsed, err := uuid.Parse(raw)
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId must be a valid UUID")
				return
			}
			orderID = parsed
			ok = true
		}
	}
	// Idempotency-Key required (contract: header required). The generated
	// wrapper validates it before reaching this handler; manual router paths
	// must validate explicitly.
	idem := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idem == "" {
		idem = strings.TrimSpace(r.Header.Get("idempotency-key"))
	}
	if idem == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}

	// Idempotency replay: if key exists, return stored row 200
	var existingToken string
	var existingOrderID uuid.UUID
	var existingExpiresAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT token, order_id, expires_at FROM tracking_shares WHERE idempotency_key = $1`, idem,
	).Scan(&existingToken, &existingOrderID, &existingExpiresAt)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"token":     existingToken,
			"orderId":   existingOrderID.String(),
			"expiresAt": existingExpiresAt,
		})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("tracking share idempotency lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Verify order exists and belongs to caller
	var customerUserID *uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT customer_user_id FROM orders WHERE id = $1`, orderID,
	).Scan(&customerUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("tracking share order lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if customerUserID == nil || *customerUserID != userID {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Order not found")
		return
	}

	expiresAt := time.Now().Add(time.Duration(GetSettings().TrackingShareExpiryHours) * time.Hour)
	// Generate unguessable token ts_* ; include order for traceability per migration comment
	// Use ts_<uuid> form; ensure uniqueness with retry on PK collision.
	var token string
	var insertedOrderID uuid.UUID
	var insertedExpiresAt time.Time
	for attempts := 0; attempts < 5; attempts++ {
		token = "ts_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		err = s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO tracking_shares (token, order_id, user_id, expires_at, idempotency_key)
			 VALUES ($1,$2,$3,$4,$5) RETURNING token, order_id, expires_at`,
			token, orderID, userID, expiresAt, idem,
		).Scan(&token, &insertedOrderID, &insertedExpiresAt)
		if err == nil {
			break
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if pgErr.Code == "23505" {
				// unique violation on token or idempotency_key
				if strings.Contains(pgErr.ConstraintName, "idempotency") || strings.Contains(pgErr.ConstraintName, "idempotency_key") {
					// race: another request inserted same key
					var raceToken string
					var raceOrderID uuid.UUID
					var raceExpiresAt time.Time
					err2 := s.db.Pool().QueryRow(r.Context(),
						`SELECT token, order_id, expires_at FROM tracking_shares WHERE idempotency_key = $1`, idem,
					).Scan(&raceToken, &raceOrderID, &raceExpiresAt)
					if err2 == nil {
						writeJSON(w, http.StatusOK, map[string]any{
							"token":     raceToken,
							"orderId":   raceOrderID.String(),
							"expiresAt": raceExpiresAt,
						})
						return
					}
					s.logger.Error("tracking share idempotency race lookup failed", "error", err2)
					writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
					return
				}
				// token collision — retry with new token
				if strings.Contains(pgErr.ConstraintName, "pkey") || strings.Contains(pgErr.ConstraintName, "token") {
					continue
				}
				// generic unique violation — retry token collision
				continue
			}
		}
		s.logger.Error("create tracking share failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if insertedOrderID == uuid.Nil {
		s.logger.Error("create tracking share failed after retries")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"token":     token,
		"orderId":   insertedOrderID.String(),
		"expiresAt": insertedExpiresAt,
	})
}

// MthGetTrackingShare resolves a tracking share token to its orderId.
// GET /tracking-share/{token} — public (no ownership check), 404 if unknown,
// 410 TRIP_SHARE_EXPIRED if past expires_at.
func (s *Server) MthGetTrackingShare(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	token := strings.TrimSpace(chi.URLParam(r, "id"))
	if token == "" {
		token = strings.TrimSpace(chi.URLParam(r, "token"))
	}
	if token == "" {
		// fallback: last path segment
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) > 0 {
			token = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	if token == "" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Tracking share not found")
		return
	}
	var orderID uuid.UUID
	var expiresAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT order_id, expires_at FROM tracking_shares WHERE token = $1`, token,
	).Scan(&orderID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Tracking share not found")
		return
	}
	if err != nil {
		s.logger.Error("get tracking share failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if time.Now().After(expiresAt) {
		writeError(w, http.StatusGone, "TRIP_SHARE_EXPIRED", "This tracking share link has expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"orderId":   orderID.String(),
		"expiresAt": expiresAt,
	})
}
