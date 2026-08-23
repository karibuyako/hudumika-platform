package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
	"strconv"
)

// ---------- PRODUCTS ----------

// MthListProductsReal lists the merchant's products (GET /products, 200 []).
func (s *Server) MthListProductsReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, name, description, price_cents, currency, sku, active, created_at, updated_at
		 FROM products WHERE merchant_id = $1 ORDER BY created_at DESC`, merchantID)
	if err != nil {
		s.logger.Error("list products failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id          uuid.UUID
			mid         uuid.UUID
			name        string
			description *string
			priceCents  int64
			currency    string
			sku         *string
			active      bool
			createdAt   *time.Time
			updatedAt   *time.Time
		)
		if err := rows.Scan(&id, &mid, &name, &description, &priceCents, &currency, &sku, &active, &createdAt, &updatedAt); err != nil {
			s.logger.Error("scan product failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		m := map[string]any{"id": id.String(), "merchantId": mid.String(), "name": name, "priceCents": priceCents, "currency": currency, "active": active}
		if description != nil {
			m["description"] = *description
		}
		if sku != nil {
			m["sku"] = *sku
		}
		if createdAt != nil {
			m["createdAt"] = *createdAt
		}
		if updatedAt != nil {
			m["updatedAt"] = *updatedAt
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate products failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthCreateProductReal creates a product (POST /products, 201). Idempotent via
// the Idempotency-Key header or body idempotencyKey.
func (s *Server) MthCreateProductReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		PriceCents  *int64  `json:"priceCents"`
		Currency    *string `json:"currency"`
		Sku         *string `json:"sku"`
		Active      *bool   `json:"active"`
		IdempotencyKey *string `json:"idempotencyKey"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := ""
	if body.Name != nil {
		name = strings.TrimSpace(*body.Name)
	}
	if name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	priceCents := int64(0)
	if body.PriceCents != nil {
		priceCents = *body.PriceCents
	}
	if priceCents < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceCents must be >= 0")
		return
	}
	currency := "TZS"
	if body.Currency != nil && strings.TrimSpace(*body.Currency) != "" {
		currency = strings.TrimSpace(*body.Currency)
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	idem := mthIdemKey(r, body.IdempotencyKey)
	idemKey := ""
	if idem != "" {
		var existingID uuid.UUID
		var eName string
		var eDesc *string
		var ePrice int64
		var eCur string
		var eSku *string
		var eActive bool
		var eCreated interface{}
		var eUpdated interface{}
		err := s.db.Pool().QueryRow(r.Context(),
			`SELECT id, name, description, price_cents, currency, sku, active, created_at, updated_at
			 FROM products WHERE idempotency_key = $1`, idem).Scan(&existingID, &eName, &eDesc, &ePrice, &eCur, &eSku, &eActive, &eCreated, &eUpdated)
		if err == nil {
			replay := map[string]any{
				"id": existingID.String(), "merchantId": merchantID.String(), "name": eName,
				"priceCents": ePrice, "currency": eCur, "active": eActive,
				"createdAt": eCreated, "updatedAt": eUpdated, "idempotencyKey": idem,
			}
			if eDesc != nil {
				replay["description"] = *eDesc
			}
			if eSku != nil {
				replay["sku"] = *eSku
			}
			writeJSON(w, http.StatusOK, replay)
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			s.logger.Error("product idempotency lookup failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		idemKey = idem
	}
	var id uuid.UUID
	var createdAt interface{}
	var updatedAt interface{}
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO products (merchant_id, name, description, price_cents, currency, sku, active, idempotency_key)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 RETURNING id, created_at, updated_at`,
		merchantID, name, body.Description, priceCents, currency, body.Sku, active, idemKey).Scan(&id, &createdAt, &updatedAt)
	if err != nil {
		s.logger.Error("create product failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	resp := map[string]any{"id": id.String(), "merchantId": merchantID.String(), "name": name, "priceCents": priceCents, "currency": currency, "active": active, "createdAt": createdAt, "updatedAt": updatedAt}
	if body.Description != nil {
		resp["description"] = *body.Description
	}
	if body.Sku != nil {
		resp["sku"] = *body.Sku
	}
	if idem != "" {
		resp["idempotencyKey"] = idem
	}
	writeJSON(w, http.StatusCreated, resp)
}

// ---------- STORES ----------

// MthListStoresReal lists the merchant's stores (GET /stores, 200 []).
func (s *Server) MthListStoresReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, name, address, city_id, is_active, created_at, updated_at
		 FROM stores WHERE merchant_id = $1 ORDER BY created_at DESC`, merchantID)
	if err != nil {
		s.logger.Error("list stores failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id        uuid.UUID
			mid       uuid.UUID
			name      string
			address   *string
			cityID    *uuid.UUID
			isActive  bool
			createdAt *time.Time
			updatedAt *time.Time
		)
		if err := rows.Scan(&id, &mid, &name, &address, &cityID, &isActive, &createdAt, &updatedAt); err != nil {
			s.logger.Error("scan store failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		m := map[string]any{"id": id.String(), "merchantId": mid.String(), "name": name, "isActive": isActive}
		if address != nil {
			m["address"] = *address
		}
		if cityID != nil {
			m["cityId"] = cityID.String()
		}
		if createdAt != nil {
			m["createdAt"] = *createdAt
		}
		if updatedAt != nil {
			m["updatedAt"] = *updatedAt
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate stores failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthGetStoreReal returns a single store by id (GET /stores/{id}, 200 or 404).
func (s *Server) MthGetStoreReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	storeID, ok := mthParamUUID(r, "storeId")
	if !ok {
		storeID, ok = mthParamUUID(r, "id")
	}
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id        uuid.UUID
		mid       uuid.UUID
		name      string
		address   *string
		cityID    *uuid.UUID
		isActive  bool
		createdAt *time.Time
		updatedAt *time.Time
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, merchant_id, name, address, city_id, is_active, created_at, updated_at
		 FROM stores WHERE id = $1 AND merchant_id = $2`, storeID, merchantID).Scan(&id, &mid, &name, &address, &cityID, &isActive, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Store not found")
		return
	}
	if err != nil {
		s.logger.Error("get store failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	m := map[string]any{"id": id.String(), "merchantId": mid.String(), "name": name, "isActive": isActive}
	if address != nil {
		m["address"] = *address
	}
	if cityID != nil {
		m["cityId"] = cityID.String()
	}
	if createdAt != nil {
		m["createdAt"] = *createdAt
	}
	if updatedAt != nil {
		m["updatedAt"] = *updatedAt
	}
	writeJSON(w, http.StatusOK, m)
}

// ---------- JOURNEYS ----------

// MthUpdateJourneyReal updates a journey (PATCH /journeys/{id}, 200 or 404).
// The live journeys table exposes name, trigger_event, steps (jsonb) and
// active (bool); the documented status/notes/metadata fields are mapped onto
// these real columns (active for status, steps for notes/metadata payload).
func (s *Server) MthUpdateJourneyReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.merchantIDForSession(r); err != nil {
		s.writeMerchantError(w, err)
		return
	}
	journeyID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var body struct {
		Name        *string          `json:"name"`
		TriggerEvent *string         `json:"triggerEvent"`
		Active      *bool            `json:"active"`
		Status      *string          `json:"status"`
		Steps       json.RawMessage  `json:"steps"`
		Metadata    json.RawMessage  `json:"metadata"`
		Notes       json.RawMessage  `json:"notes"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	setParts := make([]string, 0)
	args := make([]any, 0)
	idx := 1
	if body.Name != nil {
		setParts = append(setParts, "name = $"+strconv.Itoa(idx))
		args = append(args, strings.TrimSpace(*body.Name))
		idx++
	}
	if body.TriggerEvent != nil {
		setParts = append(setParts, "trigger_event = $"+strconv.Itoa(idx))
		args = append(args, strings.TrimSpace(*body.TriggerEvent))
		idx++
	}
	if body.Active != nil {
		setParts = append(setParts, "active = $"+strconv.Itoa(idx))
		args = append(args, *body.Active)
		idx++
	} else if body.Status != nil {
		st := strings.TrimSpace(*body.Status)
		setParts = append(setParts, "active = $"+strconv.Itoa(idx))
		args = append(args, strings.EqualFold(st, "active") || strings.EqualFold(st, "enabled"))
		idx++
	}
	// Merge notes/metadata into steps (the only jsonb column on journeys).
	var merged json.RawMessage
	if len(body.Steps) > 0 && string(body.Steps) != "null" {
		merged = body.Steps
	} else if len(body.Metadata) > 0 && string(body.Metadata) != "null" {
		merged = body.Metadata
	} else if len(body.Notes) > 0 && string(body.Notes) != "null" {
		merged = body.Notes
	}
	if len(merged) > 0 {
		setParts = append(setParts, "steps = $"+strconv.Itoa(idx)+"::jsonb")
		args = append(args, string(merged))
		idx++
	}
	if len(setParts) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "No updatable fields provided")
		return
	}
	setParts = append(setParts, "updated_at = now()")
	query := `UPDATE journeys SET ` + strings.Join(setParts, ", ") + ` WHERE id = $` + strconv.Itoa(idx) + ` RETURNING id, name, trigger_event, steps, active, created_at, updated_at`
	args = append(args, journeyID)

	var (
		id          uuid.UUID
		name        string
		trigger     string
		steps       json.RawMessage
		active      bool
		createdAt   *time.Time
		updatedAt   *time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(), query, args...).Scan(&id, &name, &trigger, &steps, &active, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Journey not found")
		return
	}
	if err != nil {
		s.logger.Error("update journey failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status := "inactive"
	if active {
		status = "active"
	}
	m := map[string]any{"id": id.String(), "name": name, "triggerEvent": trigger, "active": active, "status": status}
	if len(steps) > 0 {
		m["steps"] = json.RawMessage(steps)
	}
	if createdAt != nil {
		m["createdAt"] = *createdAt
	}
	if updatedAt != nil {
		m["updatedAt"] = *updatedAt
	}
	writeJSON(w, http.StatusOK, m)
}

// ---------- DINE-IN BILL REQUEST ----------

// MthRequestBillReal requests the bill for a dine-in order
// (POST /dine-in/orders/{id}/request-bill, 200 with order or 404). The live
// dine_in_orders table has no bill_requested column; the request is recorded
// by moving the order to the 'awaiting_payment' status.
func (s *Server) MthRequestBillReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	orderID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var (
		id          uuid.UUID
		mid         uuid.UUID
		tableID     uuid.UUID
		customerID  *uuid.UUID
		status      string
		items       json.RawMessage
		totalTZS    int64
		paidAt      *time.Time
		createdAt   *time.Time
		updatedAt   *time.Time
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE dine_in_orders SET status = 'awaiting_payment', updated_at = now()
		 WHERE id = $1 AND merchant_id = $2
		 RETURNING id, merchant_id, table_id, customer_user_id, status, items, total_tzs, paid_at, created_at, updated_at`,
		orderID, merchantID).Scan(&id, &mid, &tableID, &customerID, &status, &items, &totalTZS, &paidAt, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Dine-in order not found")
		return
	}
	if err != nil {
		s.logger.Error("request bill failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	m := map[string]any{"id": id.String(), "merchantId": mid.String(), "tableId": tableID.String(), "status": status, "totalTzs": totalTZS, "billRequested": true}
	if customerID != nil {
		m["customerUserId"] = customerID.String()
	}
	if len(items) > 0 {
		m["items"] = json.RawMessage(items)
	}
	if createdAt != nil {
		m["createdAt"] = *createdAt
	}
	if updatedAt != nil {
		m["updatedAt"] = *updatedAt
	}
	writeJSON(w, http.StatusOK, m)
}

// ---------- REFUND DECISION ----------

// MthDecideRefundReal decides a refund request
// (POST /refunds/{refundId}/decide, 200 or 404). Body
// {decision:'approved'|'rejected', reason?}. Updates status and records the
// decision.
func (s *Server) MthDecideRefundReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.merchantIDForSession(r); err != nil {
		s.writeMerchantError(w, err)
		return
	}
	refundID, ok := mthParamUUID(r, "refundId")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "refundId is required")
		return
	}
	var body struct {
		Decision *string `json:"decision"`
		Reason   *string `json:"reason"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	decision := ""
	if body.Decision != nil {
		decision = strings.TrimSpace(*body.Decision)
	}
	if decision != "approved" && decision != "rejected" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be 'approved' or 'rejected'")
		return
	}
	var (
		id          uuid.UUID
		orderID     uuid.UUID
		customerID  uuid.UUID
		amountTZS   int64
		reason      string
		status      string
		decisionRsn *string
		decidedAt   *time.Time
		createdAt   *time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`UPDATE refunds SET status = $1, decision_reason = $2, decided_at = now()
		 WHERE id = $3 AND status = 'pending'
		 RETURNING id, order_id, customer_user_id, amount_tzs, reason, status, decision_reason, decided_at, created_at`,
		decision, body.Reason, refundID).Scan(&id, &orderID, &customerID, &amountTZS, &reason, &status, &decisionRsn, &decidedAt, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var cur string
		err2 := s.db.Pool().QueryRow(r.Context(), `SELECT status FROM refunds WHERE id = $1`, refundID).Scan(&cur)
		if errors.Is(err2, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Refund not found")
			return
		}
		if err2 != nil {
			s.logger.Error("refund decision lookup failed", "error", err2)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeError(w, http.StatusConflict, "CONFLICT", "Refund is already "+cur)
		return
	}
	if err != nil {
		s.logger.Error("decide refund failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	m := map[string]any{"id": id.String(), "orderId": orderID.String(), "customerUserId": customerID.String(), "amountTzs": amountTZS, "reason": reason, "status": status}
	if decisionRsn != nil {
		m["decisionReason"] = *decisionRsn
	}
	if decidedAt != nil {
		m["decidedAt"] = *decidedAt
	}
	if createdAt != nil {
		m["createdAt"] = *createdAt
	}
	writeJSON(w, http.StatusOK, m)
}
