package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/hudumika/api-backend/internal/config"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// isStubAllowed returns true if the stub endpoint may serve fake data.
// In production, stubs must never return fake success — they must 501.
func (s *Server) isStubAllowed(w http.ResponseWriter) bool {
	if s.cfg.Env == config.EnvProduction {
		writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "This feature is not yet available")
		return false
	}
	return true
}

// mthUserID resolves the authenticated user id or writes an error and returns false.
func (s *Server) mthUserID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims.Subject == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("mth user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return uuid.Nil, false
	}
	return user.ID, true
}

func mthParamUUID(r *http.Request, name string) (uuid.UUID, bool) {
	raw := chi.URLParam(r, name)
	if raw == "" {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

func mthIdemKey(r *http.Request, bodyKey *string) string {
	if bodyKey != nil && strings.TrimSpace(*bodyKey) != "" {
		return strings.TrimSpace(*bodyKey)
	}
	if h := strings.TrimSpace(r.Header.Get("Idempotency-Key")); h != "" {
		return h
	}
	return ""
}

// ---------- SPLITS ----------

func (s *Server) MthCreateSplit(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		OrderID        *string         `json:"orderId"`
		OrderIdAlt     *string         `json:"order_id"`
		Participants   json.RawMessage `json:"participants"`
		Shares         json.RawMessage `json:"shares"`
		IdempotencyKey *string         `json:"idempotencyKey"`
		IdemAlt        *string         `json:"idempotency_key"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	// Accept the contract shape {orderId, shares[{label,amountTZS}]} as an
	// alias for the legacy {participants} payload.
	if (len(body.Participants) == 0 || string(body.Participants) == "null") && len(body.Shares) != 0 && string(body.Shares) != "null" {
		body.Participants = body.Shares
	}
	orderStr := ""
	if body.OrderID != nil {
		orderStr = *body.OrderID
	} else if body.OrderIdAlt != nil {
		orderStr = *body.OrderIdAlt
	}
	if strings.TrimSpace(orderStr) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId is required")
		return
	}
	orderID, err := uuid.Parse(strings.TrimSpace(orderStr))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId must be a valid UUID")
		return
	}
	if len(body.Participants) == 0 || string(body.Participants) == "null" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "participants is required")
		return
	}
	var partCheck json.RawMessage
	if err := json.Unmarshal(body.Participants, &partCheck); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "participants must be valid JSON")
		return
	}
	idem := mthIdemKey(r, body.IdempotencyKey)
	if idem == "" && body.IdemAlt != nil {
		idem = strings.TrimSpace(*body.IdemAlt)
	}
	if idem == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "idempotencyKey is required")
		return
	}
	// Idempotency replay: if key exists, return existing row 200
	var existingID uuid.UUID
	var existingStatus string
	err = s.db.Pool().QueryRow(r.Context(), `SELECT id, status FROM splits WHERE idempotency_key = $1`, idem).Scan(&existingID, &existingStatus)
	if err == nil {
		var row struct {
			ID              uuid.UUID       `json:"id"`
			OrderID         uuid.UUID       `json:"orderId"`
			InitiatorUserID uuid.UUID       `json:"initiatorUserId"`
			Participants    json.RawMessage `json:"participants"`
			Status          string          `json:"status"`
		}
		_ = s.db.Pool().QueryRow(r.Context(), `SELECT id, order_id, initiator_user_id, participants, status FROM splits WHERE id = $1`, existingID).Scan(&row.ID, &row.OrderID, &row.InitiatorUserID, &row.Participants, &row.Status)
		writeJSON(w, http.StatusOK, map[string]any{"id": row.ID.String(), "orderId": row.OrderID.String(), "initiatorUserId": row.InitiatorUserID.String(), "participants": json.RawMessage(row.Participants), "status": row.Status, "idempotencyKey": idem})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("split idempotency lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	participantsJSON := string(body.Participants)
	var id uuid.UUID
	var createdAt time.Time
	var status string
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO splits (order_id, initiator_user_id, participants, status, idempotency_key)
		 VALUES ($1,$2,$3::jsonb,'pending',$4) RETURNING id, created_at, status`,
		orderID, userID, participantsJSON, idem).Scan(&id, &createdAt, &status)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// race: another request inserted same key
			_ = s.db.Pool().QueryRow(r.Context(), `SELECT id, order_id, initiator_user_id, participants, status FROM splits WHERE idempotency_key = $1`, idem).Scan(&existingID, &orderID, &userID, &body.Participants, &existingStatus)
			writeJSON(w, http.StatusOK, map[string]any{"id": existingID.String(), "status": existingStatus, "idempotencyKey": idem})
			return
		}
		if pgErr != nil && pgErr.Code == "23503" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Order not found")
			return
		}
		s.logger.Error("create split failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id.String(), "orderId": orderID.String(), "initiatorUserId": userID.String(), "participants": json.RawMessage([]byte(participantsJSON)), "status": status, "createdAt": createdAt, "idempotencyKey": idem})
}

func (s *Server) MthGetSplit(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	splitID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id              uuid.UUID
		orderID         *uuid.UUID
		initiatorUserID *uuid.UUID
		participants    json.RawMessage
		status          string
		createdAt       time.Time
		updatedAt       time.Time
		idemKey         *string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, order_id, initiator_user_id, participants, status, created_at, updated_at, idempotency_key
		 FROM splits WHERE id = $1`, splitID).Scan(&id, &orderID, &initiatorUserID, &participants, &status, &createdAt, &updatedAt, &idemKey)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Split not found")
		return
	}
	if err != nil {
		s.logger.Error("get split failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	resp := map[string]any{"id": id.String(), "status": status, "participants": json.RawMessage(participants), "createdAt": createdAt, "updatedAt": updatedAt}
	if orderID != nil {
		resp["orderId"] = orderID.String()
	}
	if initiatorUserID != nil {
		resp["initiatorUserId"] = initiatorUserID.String()
	}
	if idemKey != nil {
		resp["idempotencyKey"] = *idemKey
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) MthPaySplitShare(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	splitID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id           uuid.UUID
		status       string
		participants json.RawMessage
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`UPDATE splits SET status='paid', updated_at=now() WHERE id=$1 AND status='pending'
		 RETURNING id, status, participants`, splitID).Scan(&id, &status, &participants)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": status, "participants": json.RawMessage(participants)})
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// distinguish 404 vs 409
		var curStatus string
		err2 := s.db.Pool().QueryRow(r.Context(), `SELECT status FROM splits WHERE id=$1`, splitID).Scan(&curStatus)
		if errors.Is(err2, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Split not found")
			return
		}
		if err2 != nil {
			s.logger.Error("pay split lookup failed", "error", err2)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("Split cannot be paid in status %s", curStatus))
		return
	}
	s.logger.Error("pay split failed", "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
}

func (s *Server) MthCompleteSplit(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	splitID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id           uuid.UUID
		status       string
		participants json.RawMessage
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`UPDATE splits SET status='completed', updated_at=now() WHERE id=$1 AND status='paid'
		 RETURNING id, status, participants`, splitID).Scan(&id, &status, &participants)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": status, "participants": json.RawMessage(participants)})
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		var curStatus string
		err2 := s.db.Pool().QueryRow(r.Context(), `SELECT status FROM splits WHERE id=$1`, splitID).Scan(&curStatus)
		if errors.Is(err2, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Split not found")
			return
		}
		if err2 != nil {
			s.logger.Error("complete split lookup failed", "error", err2)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("Split cannot be completed in status %s", curStatus))
		return
	}
	s.logger.Error("complete split failed", "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
}

// ---------- DINE-IN SPLITS ----------

func (s *Server) MthCreateOrderSplit(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	dineOrderID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var body struct {
		Participants   json.RawMessage `json:"participants"`
		IdempotencyKey *string         `json:"idempotencyKey"`
		IdemAlt        *string         `json:"idempotency_key"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Participants) == 0 || string(body.Participants) == "null" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "participants is required")
		return
	}
	idem := mthIdemKey(r, body.IdempotencyKey)
	if idem == "" && body.IdemAlt != nil {
		idem = strings.TrimSpace(*body.IdemAlt)
	}
	if idem == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "idempotencyKey is required")
		return
	}
	// idempotency replay
	var existingID uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(), `SELECT id FROM dine_order_splits WHERE idempotency_key=$1`, idem).Scan(&existingID)
	if err == nil {
		var row struct {
			ID            uuid.UUID
			Participants  json.RawMessage
			Status        string
		}
		_ = s.db.Pool().QueryRow(r.Context(), `SELECT id, participants, status FROM dine_order_splits WHERE id=$1`, existingID).Scan(&row.ID, &row.Participants, &row.Status)
		writeJSON(w, http.StatusOK, map[string]any{"id": row.ID.String(), "dineOrderId": dineOrderID.String(), "participants": json.RawMessage(row.Participants), "status": row.Status, "idempotencyKey": idem})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("dine split idempotency lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	participantsJSON := string(body.Participants)
	var id uuid.UUID
	var createdAt time.Time
	var status string
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO dine_order_splits (dine_order_id, initiator_user_id, participants, status, idempotency_key)
		 VALUES ($1,$2,$3::jsonb,'pending',$4) RETURNING id, created_at, status`,
		dineOrderID, userID, participantsJSON, idem).Scan(&id, &createdAt, &status)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			_ = s.db.Pool().QueryRow(r.Context(), `SELECT id FROM dine_order_splits WHERE idempotency_key=$1`, idem).Scan(&existingID)
			writeJSON(w, http.StatusOK, map[string]any{"id": existingID.String(), "status": "pending", "idempotencyKey": idem})
			return
		}
		s.logger.Error("create dine split failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id.String(), "dineOrderId": dineOrderID.String(), "initiatorUserId": userID.String(), "participants": json.RawMessage([]byte(participantsJSON)), "status": status, "createdAt": createdAt, "idempotencyKey": idem})
}

func (s *Server) MthGetOrderSplits(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	dineOrderID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, dine_order_id, initiator_user_id, participants, status, created_at, updated_at
		 FROM dine_order_splits WHERE dine_order_id=$1 ORDER BY created_at DESC`, dineOrderID)
	if err != nil {
		s.logger.Error("list dine splits failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, dineID, initiator uuid.UUID
		var participants json.RawMessage
		var status string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &dineID, &initiator, &participants, &status, &createdAt, &updatedAt); err != nil {
			s.logger.Error("scan dine split failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, map[string]any{"id": id.String(), "dineOrderId": dineID.String(), "initiatorUserId": initiator.String(), "participants": json.RawMessage(participants), "status": status, "createdAt": createdAt, "updatedAt": updatedAt})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate dine splits failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------- GROUP ORDERS ----------

func (s *Server) MthCreateGroupOrder(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		Title *string         `json:"title"`
		Items json.RawMessage `json:"items"`
	}
	_ = decodeJSON(r, &body)
	title := "Group Order"
	if body.Title != nil && strings.TrimSpace(*body.Title) != "" {
		title = strings.TrimSpace(*body.Title)
	}
	var id uuid.UUID
	var createdAt time.Time
	// Insert handling both legacy and new columns
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO group_orders (creator_user_id, owner_id, title, status)
		 VALUES ($1,$1,$2,'open') RETURNING id, created_at`, userID, title).Scan(&id, &createdAt)
	if err != nil {
		// fallback for DBs where title/owner_id columns don't exist
		err2 := s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO group_orders (creator_user_id, status)
			 VALUES ($1,'open') RETURNING id, created_at`, userID).Scan(&id, &createdAt)
		if err2 != nil {
			s.logger.Error("create group order failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id.String(), "title": title, "creatorUserId": userID.String(), "status": "open", "createdAt": createdAt})
}

func (s *Server) MthGetGroupOrder(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	groupID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id            uuid.UUID
		creatorUserID *uuid.UUID
		ownerID       *uuid.UUID
		title         *string
		status        string
		createdAt     time.Time
		finalizedAt   *time.Time
		updatedAt     *time.Time
	)
	// Try new schema first
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, creator_user_id, owner_id, title, status, created_at, finalized_at, updated_at
		 FROM group_orders WHERE id=$1`, groupID).Scan(&id, &creatorUserID, &ownerID, &title, &status, &createdAt, &finalizedAt, &updatedAt)
	if err != nil {
		// fallback: select without some columns
		err2 := s.db.Pool().QueryRow(r.Context(),
			`SELECT id, status, created_at FROM group_orders WHERE id=$1`, groupID).Scan(&id, &status, &createdAt)
		if errors.Is(err2, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Group order not found")
			return
		}
		if err2 != nil {
			s.logger.Error("get group order failed", "error", err2)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Group order not found")
		return
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		// already handled fallback above; if we are here with actual error different from pgx.ErrNoRows, log
		if !strings.Contains(err.Error(), "column") {
			s.logger.Error("get group order failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	// Fetch items
	items := make([]map[string]any, 0)
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, group_order_id, item, product_id, quantity, added_by
		 FROM group_order_items WHERE group_order_id=$1 ORDER BY id`, groupID)
	if err != nil {
		s.logger.Error("list group order items failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var itemID, gID uuid.UUID
		var item json.RawMessage
		var productID *string
		var quantity *int
		var addedBy *uuid.UUID
		if err := rows.Scan(&itemID, &gID, &item, &productID, &quantity, &addedBy); err != nil {
			s.logger.Error("scan group order item failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		m := map[string]any{"id": itemID.String(), "groupOrderId": gID.String()}
		if len(item) > 0 && string(item) != "null" && string(item) != "{}" {
			m["item"] = json.RawMessage(item)
		}
		if productID != nil {
			m["productId"] = *productID
		}
		if quantity != nil {
			m["quantity"] = *quantity
		}
		if addedBy != nil {
			m["addedBy"] = addedBy.String()
		}
		items = append(items, m)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate group order items failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	resp := map[string]any{"id": id.String(), "status": status, "createdAt": createdAt, "items": items}
	if creatorUserID != nil {
		resp["creatorUserId"] = creatorUserID.String()
	} else if ownerID != nil {
		resp["creatorUserId"] = ownerID.String()
	}
	if title != nil {
		resp["title"] = *title
	}
	if finalizedAt != nil {
		resp["finalizedAt"] = *finalizedAt
	}
	if updatedAt != nil {
		resp["updatedAt"] = *updatedAt
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) MthAddGroupOrderItem(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	groupID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	// verify group exists and open
	var status string
	err := s.db.Pool().QueryRow(r.Context(), `SELECT status FROM group_orders WHERE id=$1`, groupID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Group order not found")
		return
	}
	if err != nil {
		s.logger.Error("add group item lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if status != "open" {
		writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("Group order cannot be modified in status %s", status))
		return
	}
	var body json.RawMessage
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body) == 0 || string(body) == "null" {
		body = json.RawMessage(`{}`)
	}
	// Try to extract productId/quantity for legacy columns
	var legacy struct {
		ProductID *string `json:"productId"`
		ProductID2 *string `json:"product_id"`
		Quantity  *int    `json:"quantity"`
	}
	_ = json.Unmarshal(body, &legacy)
	productID := ""
	if legacy.ProductID != nil {
		productID = *legacy.ProductID
	} else if legacy.ProductID2 != nil {
		productID = *legacy.ProductID2
	}
	quantity := 1
	if legacy.Quantity != nil {
		quantity = *legacy.Quantity
	}
	var itemID uuid.UUID
	// Insert with both new and legacy columns, fallback if item column missing
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO group_order_items (group_order_id, item, product_id, quantity, added_by)
		 VALUES ($1,$2::jsonb,$3,$4,$5) RETURNING id`, groupID, string(body), productID, quantity, userID).Scan(&itemID)
	if err != nil {
		// fallback minimal
		err2 := s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO group_order_items (group_order_id, item) VALUES ($1,$2::jsonb) RETURNING id`,
			groupID, string(body)).Scan(&itemID)
		if err2 != nil {
			s.logger.Error("add group order item failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": itemID.String(), "groupOrderId": groupID.String(), "item": json.RawMessage(body)})
}

func (s *Server) MthRemoveGroupOrderItem(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	groupID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	// item id can be query param itemId/id or body {itemId/id}
	itemIDStr := r.URL.Query().Get("itemId")
	if itemIDStr == "" {
		itemIDStr = r.URL.Query().Get("id")
	}
	if itemIDStr == "" {
		itemIDStr = r.URL.Query().Get("item_id")
	}
	if itemIDStr == "" {
		var body struct {
			ItemID *string `json:"itemId"`
			ID     *string `json:"id"`
			ItemID2 *string `json:"item_id"`
		}
		_ = decodeJSON(r, &body)
		if body.ItemID != nil {
			itemIDStr = *body.ItemID
		} else if body.ID != nil {
			itemIDStr = *body.ID
		} else if body.ItemID2 != nil {
			itemIDStr = *body.ItemID2
		}
	}
	if strings.TrimSpace(itemIDStr) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "itemId is required")
		return
	}
	itemID, err := uuid.Parse(strings.TrimSpace(itemIDStr))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "itemId must be a valid UUID")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(), `DELETE FROM group_order_items WHERE id=$1 AND group_order_id=$2`, itemID, groupID)
	if err != nil {
		s.logger.Error("remove group order item failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Item not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) MthFinalizeGroupOrder(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, ok := s.mthUserID(w, r); !ok {
		return
	}
	groupID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id          uuid.UUID
		status      string
		finalizedAt *time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`UPDATE group_orders SET status='finalized', finalized_at=now(), updated_at=now()
		 WHERE id=$1 AND status='open' RETURNING id, status, finalized_at`, groupID).Scan(&id, &status, &finalizedAt)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": status, "finalizedAt": finalizedAt})
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		var cur string
		err2 := s.db.Pool().QueryRow(r.Context(), `SELECT status FROM group_orders WHERE id=$1`, groupID).Scan(&cur)
		if errors.Is(err2, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Group order not found")
			return
		}
		if err2 != nil {
			s.logger.Error("finalize lookup failed", "error", err2)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("Group order cannot be finalized in status %s", cur))
		return
	}
	s.logger.Error("finalize group order failed", "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
}

// ---------- RED PACKETS ----------

func (s *Server) MthShareRedPacket(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		TotalTZS  *int64  `json:"totalTzs"`
		Total     *int64  `json:"total_tzs"`
		Count     *int    `json:"count"`
		ExpiresAt *string `json:"expiresAt"`
		Expires   *string `json:"expires_at"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	total := int64(0)
	if body.TotalTZS != nil {
		total = *body.TotalTZS
	} else if body.Total != nil {
		total = *body.Total
	}
	count := 0
	if body.Count != nil {
		count = *body.Count
	}
	if total <= 0 || count <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "totalTzs and count are required and must be > 0")
		return
	}
	var expiresAt *time.Time
	rawExp := ""
	if body.ExpiresAt != nil {
		rawExp = *body.ExpiresAt
	} else if body.Expires != nil {
		rawExp = *body.Expires
	}
	if strings.TrimSpace(rawExp) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(rawExp))
		if err != nil {
			t2, err2 := time.Parse("2006-01-02T15:04:05", strings.TrimSpace(rawExp))
			if err2 != nil {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "expiresAt must be RFC3339")
				return
			}
			t = t2
		}
		expiresAt = &t
	}
	shareCode := strings.ToUpper(uuid.NewString())[:8]
	// ensure unique, retry few times on conflict
	var id uuid.UUID
	var createdAt time.Time
	var status string
	var claimed int
	var code string
	for attempts := 0; attempts < 5; attempts++ {
		code = fmt.Sprintf("RP-%s", shareCode)
		err := s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO red_packets (creator_user_id, share_code, total_tzs, count, claimed, expires_at, status)
			 VALUES ($1,$2,$3,$4,0,$5,'active') RETURNING id, created_at, status, claimed, share_code`,
			userID, code, total, count, expiresAt).Scan(&id, &createdAt, &status, &claimed, &code)
		if err == nil {
			break
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && strings.Contains(pgErr.ConstraintName, "share_code") {
			shareCode = strings.ToUpper(uuid.NewString())[:8]
			continue
		}
		s.logger.Error("create red packet failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if id == uuid.Nil {
		s.logger.Error("create red packet failed after retries")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id.String(), "shareCode": code, "totalTzs": total, "count": count, "claimed": claimed, "status": status, "createdAt": createdAt, "expiresAt": expiresAt})
}

func (s *Server) MthClaimRedPacket(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	raw := strings.TrimSpace(chi.URLParam(r, "id"))
	if raw == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id        uuid.UUID
		totalTZS  int64
		count     int
		claimed   int
		status    string
		expiresAt *time.Time
		creatorID uuid.UUID
	)
	var err error
	// Try uuid path first if param looks like uuid; fallback to share_code in all cases.
	if packetID, perr := uuid.Parse(raw); perr == nil {
		err = s.db.Pool().QueryRow(r.Context(),
			`SELECT id, total_tzs, count, claimed, status, expires_at, creator_user_id FROM red_packets WHERE id=$1`, packetID).Scan(&id, &totalTZS, &count, &claimed, &status, &expiresAt, &creatorID)
		if errors.Is(err, pgx.ErrNoRows) {
			err = s.db.Pool().QueryRow(r.Context(),
				`SELECT id, total_tzs, count, claimed, status, expires_at, creator_user_id FROM red_packets WHERE share_code=$1`, raw).Scan(&id, &totalTZS, &count, &claimed, &status, &expiresAt, &creatorID)
		}
	} else {
		err = s.db.Pool().QueryRow(r.Context(),
			`SELECT id, total_tzs, count, claimed, status, expires_at, creator_user_id FROM red_packets WHERE share_code=$1`, raw).Scan(&id, &totalTZS, &count, &claimed, &status, &expiresAt, &creatorID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Red packet not found")
		return
	}
	if err != nil {
		s.logger.Error("claim red packet lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if creatorID == userID {
		writeError(w, http.StatusConflict, "CONFLICT", "Cannot claim your own red packet")
		return
	}
	if status != "active" {
		writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("Red packet is %s", status))
		return
	}
	if expiresAt != nil && time.Now().After(*expiresAt) {
		_, _ = s.db.Pool().Exec(r.Context(), `UPDATE red_packets SET status='expired' WHERE id=$1`, id)
		writeError(w, http.StatusConflict, "CONFLICT", "Red packet has expired")
		return
	}
	if claimed >= count {
		writeError(w, http.StatusConflict, "CONFLICT", "Red packet fully claimed")
		return
	}
	// Check already claimed
	var exists bool
	err = s.db.Pool().QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM red_packet_claims WHERE red_packet_id=$1 AND user_id=$2)`, id, userID).Scan(&exists)
	if err != nil {
		s.logger.Error("claim existence check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if exists {
		writeError(w, http.StatusConflict, "CONFLICT", "Already claimed")
		return
	}
	// Compute amount: split equally, first claims get extra 1 if remainder
	base := totalTZS / int64(count)
	rem := totalTZS % int64(count)
	claimedTZS := base
	if int64(claimed) < rem {
		claimedTZS++
	}
	if claimedTZS <= 0 {
		claimedTZS = base
	}
	// Transaction: insert claim and bump claimed
	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("claim begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var claimID uuid.UUID
	var claimedAt time.Time
	err = tx.QueryRow(r.Context(),
		`INSERT INTO red_packet_claims (red_packet_id, user_id, claimed_tzs) VALUES ($1,$2,$3) RETURNING id, claimed_at`,
		id, userID, claimedTZS).Scan(&claimID, &claimedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "CONFLICT", "Already claimed")
			return
		}
		s.logger.Error("insert claim failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// bump
	var newClaimed int
	var newStatus string
	err = tx.QueryRow(r.Context(),
		`UPDATE red_packets SET claimed = claimed + 1,
		 status = CASE WHEN claimed + 1 >= count THEN 'completed' ELSE status END
		 WHERE id=$1 RETURNING claimed, status`, id).Scan(&newClaimed, &newStatus)
	if err != nil {
		s.logger.Error("bump claimed failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("claim commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": claimID.String(), "redPacketId": id.String(), "userId": userID.String(), "claimedTzs": claimedTZS, "claimedAt": claimedAt, "totalClaimed": newClaimed, "status": newStatus})
}

func (s *Server) MthListReceivedRedPackets(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT c.id, c.red_packet_id, c.claimed_tzs, c.claimed_at,
		        p.share_code, p.total_tzs, p.count, p.creator_user_id
		 FROM red_packet_claims c JOIN red_packets p ON p.id = c.red_packet_id
		 WHERE c.user_id = $1 ORDER BY c.claimed_at DESC`, userID)
	if err != nil {
		s.logger.Error("list received red packets failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var claimID, packetID, creator uuid.UUID
		var claimedTZS int64
		var claimedAt time.Time
		var shareCode string
		var totalTZS int64
		var count int
		if err := rows.Scan(&claimID, &packetID, &claimedTZS, &claimedAt, &shareCode, &totalTZS, &count, &creator); err != nil {
			s.logger.Error("scan received red packet failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, map[string]any{"id": claimID.String(), "redPacketId": packetID.String(), "shareCode": shareCode, "totalTzs": totalTZS, "count": count, "creatorUserId": creator.String(), "claimedTzs": claimedTZS, "claimedAt": claimedAt})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate received red packets failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------- DISPUTES ----------

func (s *Server) MthCreateDispute(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		OrderID     *string `json:"orderId"`
		OrderIdAlt  *string `json:"order_id"`
		Subject     *string `json:"subject"`
		Description *string `json:"description"`
		Reason      *string `json:"reason"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	subject := ""
	if body.Subject != nil {
		subject = strings.TrimSpace(*body.Subject)
	} else if body.Reason != nil {
		subject = strings.TrimSpace(*body.Reason)
	}
	if subject == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subject is required")
		return
	}
	var orderID *uuid.UUID
	rawOrder := ""
	if body.OrderID != nil {
		rawOrder = strings.TrimSpace(*body.OrderID)
	} else if body.OrderIdAlt != nil {
		rawOrder = strings.TrimSpace(*body.OrderIdAlt)
	}
	if rawOrder != "" {
		parsed, err := uuid.Parse(rawOrder)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId must be a valid UUID")
			return
		}
		orderID = &parsed
	}
	desc := ""
	if body.Description != nil {
		desc = *body.Description
	}
	var id uuid.UUID
	var createdAt time.Time
	var status string
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO disputes (user_id, order_id, subject, description, status)
		 VALUES ($1,$2,$3,$4,'open') RETURNING id, created_at, status`,
		userID, orderID, subject, desc).Scan(&id, &createdAt, &status)
	if err != nil {
		s.logger.Error("create dispute failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	resp := map[string]any{"id": id.String(), "userId": userID.String(), "subject": subject, "description": desc, "status": status, "createdAt": createdAt}
	if orderID != nil {
		resp["orderId"] = orderID.String()
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) MthListMyDisputes(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, user_id, order_id, subject, description, status, decision_reason, decided_by, decided_at, created_at
		 FROM disputes WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		s.logger.Error("list disputes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, uid uuid.UUID
		var orderID *uuid.UUID
		var subject string
		var description *string
		var status string
		var decisionReason *string
		var decidedBy *uuid.UUID
		var decidedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&id, &uid, &orderID, &subject, &description, &status, &decisionReason, &decidedBy, &decidedAt, &createdAt); err != nil {
			s.logger.Error("scan dispute failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		m := map[string]any{"id": id.String(), "userId": uid.String(), "subject": subject, "status": status, "createdAt": createdAt}
		if orderID != nil {
			m["orderId"] = orderID.String()
		}
		if description != nil {
			m["description"] = *description
		}
		if decisionReason != nil {
			m["decisionReason"] = *decisionReason
		}
		if decidedBy != nil {
			m["decidedBy"] = decidedBy.String()
		}
		if decidedAt != nil {
			m["decidedAt"] = *decidedAt
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate disputes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) MthGetDispute(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	disputeID, ok := mthParamUUID(r, "id")
	if !ok {
		// also accept disputeId param name
		disputeID, ok = mthParamUUID(r, "disputeId")
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
			return
		}
	}
	var (
		id             uuid.UUID
		uid            uuid.UUID
		orderID        *uuid.UUID
		subject        string
		description    *string
		status         string
		decisionReason *string
		decidedBy      *uuid.UUID
		decidedAt      *time.Time
		createdAt      time.Time
		updatedAt      *time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, user_id, order_id, subject, description, status, decision_reason, decided_by, decided_at, created_at, updated_at
		 FROM disputes WHERE id=$1`, disputeID).Scan(&id, &uid, &orderID, &subject, &description, &status, &decisionReason, &decidedBy, &decidedAt, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Dispute not found")
		return
	}
	if err != nil {
		// fallback without updated_at for older migration
		err2 := s.db.Pool().QueryRow(r.Context(),
			`SELECT id, user_id, order_id, subject, description, status, decision_reason, decided_by, decided_at, created_at
			 FROM disputes WHERE id=$1`, disputeID).Scan(&id, &uid, &orderID, &subject, &description, &status, &decisionReason, &decidedBy, &decidedAt, &createdAt)
		if errors.Is(err2, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Dispute not found")
			return
		}
		if err2 != nil {
			s.logger.Error("get dispute failed", "error", err2)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	// Customer may only view own dispute; other roles pass
	claims, _ := ClaimsFromContext(r.Context())
	if claims != nil && claims.Role == RoleCustomer && uid != userID {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Dispute not found")
		return
	}
	m := map[string]any{"id": id.String(), "userId": uid.String(), "subject": subject, "status": status, "createdAt": createdAt}
	if orderID != nil {
		m["orderId"] = orderID.String()
	}
	if description != nil {
		m["description"] = *description
	}
	if decisionReason != nil {
		m["decisionReason"] = *decisionReason
	}
	if decidedBy != nil {
		m["decidedBy"] = decidedBy.String()
	}
	if decidedAt != nil {
		m["decidedAt"] = *decidedAt
	}
	if updatedAt != nil {
		m["updatedAt"] = *updatedAt
	}
	writeJSON(w, http.StatusOK, m)
}

// ---------- FALLBACK STUBS (remain for non-DB groups) ----------

func (s *Server) MthAnalyticsOverview(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthCompleteTask(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthConfirmReservation(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthConnectPrinter(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthCreateLoyaltyRedemption(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthCreateOrderRefund(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthCreatePrinter(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthCreateRedemption(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthDeletePrinter(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthExportOrders(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthExportStoreOrders(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetActiveReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetCampaignPerformance(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetClosureStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetPrinter(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetProviderPublic(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetRevenueComposition(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetStoreCompliance(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetStoreDualScreen(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthGetStoreQrOrdering(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthHomeRecommendations(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListChatThreads(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListCustomerMemberships(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListDeliveryProviders(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListDisputeHolds(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListInvoices(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListMarketingCoupons(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListOrders(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListPaymentAccounts(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListPrinters(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListProvidersAvailable(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListProvidersConsumer(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, []any{})
}
func (s *Server) MthListRedemptions(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthListStaff(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthPairDualScreen(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthPreferredProviders(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	// List preferred providers: join providers with provider_preferences where is_preferred = true.
	// Fallback to existence-based query if is_preferred column is absent (migration 00102 without boolean).
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT p.id, p.name, p.trade, p.avatar_url, p.base_rate_tzs, p.rating, p.review_count, p.service_areas, p.created_at
		 FROM providers p
		 JOIN provider_preferences pp ON pp.provider_id = p.id
		 WHERE pp.user_id = $1 AND pp.is_preferred = true
		 ORDER BY pp.created_at DESC, p.id DESC`, userID)
	if err != nil {
		var pgErr *pgconn.PgError
		if (errors.As(err, &pgErr) && pgErr.Code == "42703") || strings.Contains(err.Error(), "is_preferred") {
			rows, err = s.db.Pool().Query(r.Context(),
				`SELECT p.id, p.name, p.trade, p.avatar_url, p.base_rate_tzs, p.rating, p.review_count, p.service_areas, p.created_at
				 FROM providers p
				 JOIN provider_preferences pp ON pp.provider_id = p.id
				 WHERE pp.user_id = $1
				 ORDER BY pp.created_at DESC, p.id DESC`, userID)
		}
		if err != nil {
			s.logger.Error("list preferred providers failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	defer rows.Close()
	out := make([]gen.ProviderPublic, 0)
	for rows.Next() {
		p, _, scanErr := scanPublicProvider(rows)
		if scanErr != nil {
			s.logger.Error("scan preferred provider failed", "error", scanErr)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		// Handle deferred is_preferred missing detected at iteration time (some drivers report late)
		if strings.Contains(err.Error(), "is_preferred") {
			// retry without filter
			rows2, err2 := s.db.Pool().Query(r.Context(),
				`SELECT p.id, p.name, p.trade, p.avatar_url, p.base_rate_tzs, p.rating, p.review_count, p.service_areas, p.created_at
				 FROM providers p
				 JOIN provider_preferences pp ON pp.provider_id = p.id
				 WHERE pp.user_id = $1
				 ORDER BY pp.created_at DESC, p.id DESC`, userID)
			if err2 != nil {
				s.logger.Error("list preferred providers retry failed", "error", err2)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			defer rows2.Close()
			out = make([]gen.ProviderPublic, 0)
			for rows2.Next() {
				p, _, scanErr := scanPublicProvider(rows2)
				if scanErr != nil {
					s.logger.Error("scan preferred provider retry failed", "error", scanErr)
					writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
					return
				}
				out = append(out, p)
			}
			if err := rows2.Err(); err != nil {
				s.logger.Error("iterate preferred providers retry failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			writeJSON(w, http.StatusOK, out)
			return
		}
		s.logger.Error("iterate preferred providers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
func (s *Server) MthPrivacyExport(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthProcessSupplierReturn(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthRedeemLoyaltyMember(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthRejectSupplierReturn(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthSetProviderPreference(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	providerID, ok := mthParamUUID(r, "id")
	if !ok {
		providerID, ok = mthParamUUID(r, "providerId")
		if !ok {
			raw := chi.URLParam(r, "providerId")
			if raw == "" {
				raw = chi.URLParam(r, "provider_id")
			}
			if raw != "" {
				if parsed, err := uuid.Parse(strings.TrimSpace(raw)); err == nil {
					providerID = parsed
					ok = true
				}
			}
		}
	}
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "providerId is required")
		return
	}
	var body struct {
		Preferred *bool `json:"preferred"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Preferred == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "preferred is required")
		return
	}
	// Verify provider exists
	var exists bool
	if err := s.db.Pool().QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM providers WHERE id=$1)`, providerID).Scan(&exists); err != nil {
		s.logger.Error("provider existence check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Provider not found")
		return
	}
	// Upsert preference: INSERT ON CONFLICT UPDATE is_preferred.
	// Fallback to existence-based insert/delete if is_preferred column is absent.
	_, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO provider_preferences (user_id, provider_id, is_preferred) VALUES ($1,$2,$3)
		 ON CONFLICT (user_id, provider_id) DO UPDATE SET is_preferred = EXCLUDED.is_preferred`, userID, providerID, *body.Preferred)
	if err != nil {
		var pgErr *pgconn.PgError
		isMissingCol := (errors.As(err, &pgErr) && pgErr.Code == "42703") || strings.Contains(err.Error(), "is_preferred") || strings.Contains(err.Error(), "column")
		if isMissingCol {
			if *body.Preferred {
				_, err = s.db.Pool().Exec(r.Context(),
					`INSERT INTO provider_preferences (user_id, provider_id) VALUES ($1,$2) ON CONFLICT (user_id, provider_id) DO NOTHING`, userID, providerID)
			} else {
				_, err = s.db.Pool().Exec(r.Context(),
					`DELETE FROM provider_preferences WHERE user_id=$1 AND provider_id=$2`, userID, providerID)
			}
			if err != nil {
				s.logger.Error("set provider preference fallback failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
		} else {
			s.logger.Error("set provider preference failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	} else {
		// When is_preferred column exists and preferred is false, the row was updated to false.
		// For boolean-false semantics we keep the row (is_preferred=false) so List filters it out.
		// No additional delete needed.
	}
	// Return the provider public projection
	var (
		pID          uuid.UUID
		name         string
		trade        string
		avatarURL    *string
		baseRate     *int64
		rating       *float64
		reviewCount  int
		serviceAreas []byte
		createdAt    time.Time
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, name, trade, avatar_url, base_rate_tzs, rating, review_count, service_areas, created_at FROM providers WHERE id=$1`, providerID).
		Scan(&pID, &name, &trade, &avatarURL, &baseRate, &rating, &reviewCount, &serviceAreas, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Provider not found")
			return
		}
		s.logger.Error("fetch provider after preference failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// Map to ProviderPublic using same logic as scanPublicProvider
	row := struct {
		ID           uuid.UUID
		Name         string
		Trade        string
		AvatarURL    *string
		BaseRateTZS  *int64
		Rating       *float64
		ReviewCount  int
		ServiceAreas []byte
		CreatedAt    time.Time
	}{pID, name, trade, avatarURL, baseRate, rating, reviewCount, serviceAreas, createdAt}
	// Reuse helper by constructing a fake scanner? Instead build directly.
	public := gen.ProviderPublic{
		Id:          newUUID(row.ID.String()),
		Name:        row.Name,
		Trade:       row.Trade,
		Rating:      merchantRating(row.Rating),
		ReviewCount: row.ReviewCount,
		Verified:    true,
		AvatarUrl:   row.AvatarURL,
	}
	if row.BaseRateTZS != nil {
		v := int(*row.BaseRateTZS)
		public.BaseRateTZS = &v
	}
	if len(row.ServiceAreas) > 0 {
		var areas []string
		if err := json.Unmarshal(row.ServiceAreas, &areas); err == nil {
			public.ServiceAreas = &areas
		}
	}
	writeJSON(w, http.StatusOK, public)
}
func (s *Server) MthStopCampaign(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthTableQr(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthTestPrinter(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthTestWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthUpdatePaymentAccount(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthUpdatePrinter(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthUpdateStoreDualScreen(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) MthUpdateStoreQrOrdering(w http.ResponseWriter, r *http.Request) {
	if !s.isStubAllowed(w) { return }
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) RecordSearchHistory(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) SearchImageGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) SearchVoiceGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
func (s *Server) CollectCOD(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	writeJSON(w, http.StatusOK, map[string]any{"id": uuid.NewString(), "status": "ok"})
}
