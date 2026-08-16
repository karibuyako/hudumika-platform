package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
)

// sweepOrderRow loads an order row for the sweep order handlers, mapping a
// missing row to the 404 envelope. The database must already be verified.
func (s *Server) sweepOrderRow(w http.ResponseWriter, r *http.Request, orderID openapi_types.UUID) *orders.OrderRow {
	row, err := orders.NewStore(s.db.Pool()).GetOrderRow(r.Context(), uuid.UUID(orderID))
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return nil
	}
	if err != nil {
		s.logger.Error("sweep: load order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil
	}
	return row
}

// GetOrderFareBreakdown answers the contract fare breakdown for an order
// (GET /orders/{orderId}/fare). The breakdown is computed server-side from
// the persisted order totals; components the engine does not track yet
// (surge, wait pay, bonuses) stay absent rather than invented.
func (s *Server) GetOrderFareBreakdown(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("fare breakdown failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	writeJSON(w, http.StatusOK, gen.FareBreakdown{
		OrderId:  orderId,
		TotalTZS: int(row.TotalTZS),
		BaseTZS:  intPtr(row.DeliveryFeeTZS),
		Currency: sweepStrPtr("TZS"),
	})
}

// FailDelivery marks a delivery failed with the contract reason catalog
// (POST /orders/{orderId}/failed-delivery). The order must be rider-held
// (picked_up or delivering); the failure is a guarded status transition with
// the reason persisted on the order and an event appended, so retries cannot
// double-apply (409 on the second attempt).
func (s *Server) FailDelivery(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.FailDeliveryJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("fail delivery failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	note := string(body.Reason)
	if body.Note != nil && *body.Note != "" {
		note += ": " + *body.Note
	}
	version, err := orders.NewStore(s.db.Pool()).TransitionOrder(r.Context(), row.ID, row.Version,
		[]string{"picked_up", "delivering"}, "failed", actor, note)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Delivery cannot be failed in its current state")
		return
	}
	if err != nil {
		s.logger.Error("fail delivery transition failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE orders SET reject_reason = $2, reject_reason_code = $3, updated_at = now()
		 WHERE id = $1`,
		row.ID, note, string(body.Reason)); err != nil {
		s.logger.Error("fail delivery reason persist failed", "error", err)
	}
	row.Status = "failed"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// RescheduleOrder moves a rider-held order's acceptance deadline to the
// requested time (POST /orders/{orderId}/reschedule). The reschedule is
// recorded as an order event; the order stays in its current state.
func (s *Server) RescheduleOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.RescheduleOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("reschedule order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE orders SET deadline_at = $2, updated_at = now()
		 WHERE id = $1 AND status IN ('rider_assigned', 'picked_up', 'delivering')`,
		row.ID, body.ScheduledAt)
	if err != nil {
		s.logger.Error("reschedule order update failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot be rescheduled in its current state")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, 'rescheduled', $2, $3)`,
		row.ID, actor, body.Reason); err != nil {
		s.logger.Error("reschedule order event failed", "error", err)
	}
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// HoldOrder puts a rider-held order into the 'held' state
// (POST /orders/{orderId}/hold, 00050_sweep.sql extends the status enum).
// The rider keeps the order; the hold reason and optional resume time are
// recorded on the event.
func (s *Server) HoldOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.HoldOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("hold order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	version, err := orders.NewStore(s.db.Pool()).TransitionOrder(r.Context(), row.ID, row.Version,
		[]string{"rider_assigned", "picked_up", "delivering"}, "held", actor, body.Reason)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot be held in its current state")
		return
	}
	if err != nil {
		s.logger.Error("hold order transition failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "held"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// UnholdOrder resumes a held order back to delivering
// (POST /orders/{orderId}/unhold).
func (s *Server) UnholdOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("unhold order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	version, err := orders.NewStore(s.db.Pool()).TransitionOrder(r.Context(), row.ID, row.Version,
		[]string{"held"}, "delivering", actor, "resumed from hold")
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order is not held")
		return
	}
	if err != nil {
		s.logger.Error("unhold order transition failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "delivering"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// TransferOrder records a rider's request to hand the order to another rider
// (POST /orders/{orderId}/transfer). The request is persisted as an order
// event whose id is the contract's transferId; no dispatch-side reassignment
// engine exists yet, so the recorded state is 'requested'.
func (s *Server) TransferOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.TransferOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("transfer order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	var eventID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note)
		 VALUES ($1, 'transfer_requested', $2, $3) RETURNING id`,
		row.ID, actor, body.Reason).Scan(&eventID); err != nil {
		s.logger.Error("transfer order event failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		TransferId openapi_types.UUID `json:"transferId"`
		Status     string             `json:"status"`
	}{
		TransferId: newUUID(eventID.String()),
		Status:     "requested",
	})
}

// RequestOrderModification records a customer/rider request to change an
// active order (POST /orders/{orderId}/modify-request). There is no approval
// workflow in the contract yet, so the request is persisted as an event and
// answered 'pending_approval' — the honest state of a request awaiting a
// decision surface that does not exist.
func (s *Server) RequestOrderModification(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.RequestOrderModificationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Note == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "note is required")
		return
	}
	if s.db == nil {
		s.logger.Error("request order modification failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	var eventID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note)
		 VALUES ($1, 'modification_requested', $2, $3) RETURNING id`,
		row.ID, actor, string(body.Type)+": "+body.Note).Scan(&eventID); err != nil {
		s.logger.Error("request modification event failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		RequestId openapi_types.UUID `json:"requestId"`
		Status    string             `json:"status"`
	}{
		RequestId: newUUID(eventID.String()),
		Status:    "pending_approval",
	})
}

// AddItemsToOrder records a mid-delivery item addition request
// (POST /orders/{orderId}/add-items). The contract requires merchant
// approval before the items land on the order, so the request is persisted
// as an event and answered 'pending_merchant_approval'; totals are untouched
// until an approval surface exists.
func (s *Server) AddItemsToOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.AddItemsToOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 || body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "items and reason are required")
		return
	}
	if s.db == nil {
		s.logger.Error("add items to order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	summary, err := json.Marshal(struct {
		Items  []gen.AddItemsToOrderJSONRequestBody `json:"items"`
		Reason string                               `json:"reason"`
	}{Items: []gen.AddItemsToOrderJSONRequestBody{body}, Reason: body.Reason})
	if err != nil {
		s.logger.Error("add items marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var eventID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note)
		 VALUES ($1, 'items_add_requested', $2, $3) RETURNING id`,
		row.ID, actor, string(summary)).Scan(&eventID); err != nil {
		s.logger.Error("add items event failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		RequestId openapi_types.UUID `json:"requestId"`
		Status    string             `json:"status"`
	}{
		RequestId: newUUID(eventID.String()),
		Status:    "pending_merchant_approval",
	})
}

// TipRider records a customer tip on a delivered order
// (POST /orders/{orderId}/tip). The tip is persisted immutably in the tips
// table (00050_sweep.sql) with an order event; the order itself is returned
// unchanged because the tip is not part of the order total (it settles with
// the rider separately).
func (s *Server) TipRider(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.TipRiderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.AmountTZS <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS must be positive")
		return
	}
	if s.db == nil {
		s.logger.Error("tip rider failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	var riderID any
	if row.RiderID != nil {
		riderID = *row.RiderID
	}
	method := ""
	if body.Method != nil {
		method = string(*body.Method)
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO tips (order_id, rider_id, amount_tzs, method, note)
		 VALUES ($1, $2, $3, $4, $5)`,
		row.ID, riderID, body.AmountTZS, method, note); err != nil {
		s.logger.Error("tip insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, 'tip', $2, $3)`,
		row.ID, actor, method); err != nil {
		s.logger.Error("tip event failed", "error", err)
	}
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// SubmitProofOfDelivery persists a photo/signature/OTP proof for a delivery
// (POST /orders/{orderId}/proof-of-delivery, table delivery_proofs in
// 00050_sweep.sql). The submitted value is stored as-is (a URL or data URL);
// OTP-style proofs are stored hashed so a plaintext code never lands in the
// database. Verification remains the merchant's job and is not invented
// here.
func (s *Server) SubmitProofOfDelivery(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.ProofOfDelivery
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Type == "" || body.Value == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type and value are required")
		return
	}
	if s.db == nil {
		s.logger.Error("submit proof of delivery failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepOrderRow(w, r, orderId)
	if row == nil {
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var (
		documentURL string
		dropoff     string
		gps         []byte
	)
	if body.DocumentUrl != nil {
		documentURL = *body.DocumentUrl
	}
	if body.DropoffOption != nil {
		dropoff = string(*body.DropoffOption)
	}
	value := body.Value
	if body.Type == gen.ProofOfDeliveryTypeOtp {
		value = sha256Hex(body.Value)
	}
	if body.GpsStamp != nil {
		gps, _ = json.Marshal(body.GpsStamp)
	}
	var proofID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO delivery_proofs (order_id, type, value, document_url, dropoff_option, gps_stamp)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		row.ID, string(body.Type), value, documentURL, dropoff, gps).Scan(&proofID); err != nil {
		s.logger.Error("delivery proof insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, 'proof_submitted', $2, $3)`,
		row.ID, actor, string(body.Type)); err != nil {
		s.logger.Error("delivery proof event failed", "error", err)
	}
	now := time.Now()
	proofIDGen := newUUID(proofID.String())
	orderIDGen := orderId
	verified := false
	writeJSON(w, http.StatusOK, gen.ProofOfDelivery{
		Id:            &proofIDGen,
		OrderId:       &orderIDGen,
		Type:          body.Type,
		Value:         body.Value,
		DocumentUrl:   body.DocumentUrl,
		DropoffOption: body.DropoffOption,
		GpsStamp:      body.GpsStamp,
		ItemIds:       body.ItemIds,
		SubmittedAt:   &now,
		Verified:      &verified,
	})
}

// sweepStrPtr returns a pointer to s for optional contract fields.
func sweepStrPtr(s string) *string { return &s }
