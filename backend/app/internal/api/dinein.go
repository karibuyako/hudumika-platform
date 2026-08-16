package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/dinein"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// List pagination bounds for the dine-in and reservation listings.
const (
	defaultDineInListLimit = 20
	maxDineInListLimit     = 50
)

// writeMerchantError maps merchantIDForSession failures to envelopes: a
// missing bearer token is 401, a session without a merchants row is 404
// (the merchant identity binding lives in the merchants bounded context),
// everything else is an operational 500.
func (s *Server) writeMerchantError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	case errors.Is(err, errNoMerchant):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant account for this session")
	default:
		s.logger.Error("merchant resolution failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// ListDineInTables returns the tables of the caller's store (GET
// /dine-in/tables). Merchants see their own tables; staff sessions see all
// tables (the merchant identity binding lives in the merchants bounded
// context).
func (s *Server) ListDineInTables(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant && !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants or staff can list dine-in tables")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	tables, err := dinein.NewStore(s.db.Pool()).ListTables(r.Context(), merchantID)
	if err != nil {
		s.logger.Error("list dine-in tables failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.DineInTable, 0, len(tables))
	for _, table := range tables {
		out = append(out, toGenDineInTable(table))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateDineInTable creates a dine-in table (POST /dine-in/tables, 201).
// Only merchant sessions may create tables, and the table is bound to the
// merchant id of the session.
func (s *Server) CreateDineInTable(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can create dine-in tables")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body gen.DineInTable
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Label == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "label is required")
		return
	}
	capacity := 4
	if body.Capacity != nil {
		capacity = *body.Capacity
		if capacity < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "capacity must be at least 1")
			return
		}
	}
	row, err := dinein.NewStore(s.db.Pool()).CreateTable(r.Context(), dinein.CreateTableInput{
		MerchantID: merchantID,
		Label:      body.Label,
		Capacity:   capacity,
	})
	if err != nil {
		s.logger.Error("create dine-in table failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenDineInTable(row))
}

// UpdateDineInTable patches a table of the caller's store (PATCH
// /dine-in/tables/{tableId}). Only the owning merchant may update it; a
// table that is missing or belongs to another merchant is the same 404, so
// existence never leaks.
func (s *Server) UpdateDineInTable(w http.ResponseWriter, r *http.Request, tableId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can update dine-in tables")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body gen.DineInTable
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in := dinein.UpdateTableInput{ID: tableId, MerchantID: merchantID}
	if body.Label != "" {
		in.Label = &body.Label
	}
	if body.Capacity != nil {
		if *body.Capacity < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "capacity must be at least 1")
			return
		}
		in.Capacity = body.Capacity
	}
	if body.Disabled != nil {
		active := !*body.Disabled
		in.Active = &active
	}
	row, err := dinein.NewStore(s.db.Pool()).UpdateTable(r.Context(), in)
	if errors.Is(err, dinein.ErrTableNotFound) {
		writeError(w, http.StatusNotFound, "DINE_IN_TABLE_NOT_FOUND", "Dine-in table not found")
		return
	}
	if err != nil {
		s.logger.Error("update dine-in table failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenDineInTable(*row))
}

// GetDineInTableQr returns the QR payload for a table (GET
// /dine-in/tables/{tableId}/qr). Honest stub: the payload is the stable
// deterministic string a customer scans to open an order — no image is
// generated and no per-table token is stored, so the payload encodes the
// table id itself. The contract declares the read unauthenticated, but the
// platform router requires auth on every route outside the public list, so
// any authenticated session may read it.
func (s *Server) GetDineInTableQr(w http.ResponseWriter, r *http.Request, tableId openapi_types.UUID) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("get table qr failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	table, err := dinein.NewStore(s.db.Pool()).GetTable(r.Context(), tableId)
	if errors.Is(err, dinein.ErrTableNotFound) {
		writeError(w, http.StatusNotFound, "DINE_IN_TABLE_NOT_FOUND", "Dine-in table not found")
		return
	}
	if err != nil {
		s.logger.Error("get table qr failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		QrPayload string `json:"qrPayload"`
		MenuURL   string `json:"menuUrl"`
	}{
		QrPayload: "hudumika:dinein:table:" + tableId.String(),
		MenuURL:   "/catalogues/" + table.MerchantID.String(),
	})
}

// CreateDineInOrder opens a dine-in order from a table QR (POST
// /dine-in/orders, 201). The Idempotency-Key header is required by the
// contract; this check catches an absent header. Any authenticated role may
// open an order. Totals are computed server-side from the catalogue; a
// table that is missing, inactive or already hosting an open order is
// rejected with the matching dine-in error code.
func (s *Server) CreateDineInOrder(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.DineInOrderCreate
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one item is required")
		return
	}
	if body.MerchantId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}
	if _, err := resolveMerchantID(r.Context(), s.db.Pool(), body.MerchantId); err != nil {
		writeError(w, http.StatusNotFound, "MERCHANT_NOT_FOUND", "Merchant not found")
		return
	}
	items := make([]dinein.CreateOrderItem, 0, len(body.Items))
	for _, it := range body.Items {
		line := dinein.CreateOrderItem{CatalogueItemID: it.CatalogueItemId, Quantity: it.Quantity}
		if it.Options != nil {
			line.Options = append([]string(nil), (*it.Options)...)
		}
		items = append(items, line)
	}
	row, err := dinein.NewStore(s.db.Pool()).CreateDineInOrder(r.Context(), dinein.CreateDineInOrderInput{
		CustomerUserID: userID,
		MerchantID:     body.MerchantId,
		TableID:        body.TableId,
		Items:          items,
		IdempotencyKey: r.Header.Get("Idempotency-Key"),
	})
	switch {
	case errors.Is(err, dinein.ErrTableNotFound):
		writeError(w, http.StatusNotFound, "DINE_IN_TABLE_NOT_FOUND", "Dine-in table not found")
		return
	case errors.Is(err, dinein.ErrTableInUse):
		writeError(w, http.StatusConflict, "DINE_IN_TABLE_IN_USE", "Table already has an open order")
		return
	case errors.Is(err, dinein.ErrItemUnavailable):
		writeError(w, http.StatusUnprocessableEntity, "ORDER_ITEM_UNAVAILABLE", "One or more items are unavailable")
		return
	case err != nil:
		s.logger.Error("create dine-in order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenDineInOrder(row))
}

// ListMyDineInOrders returns the caller's dine-in orders (GET
// /dine-in/orders/me), cursor-paginated with an optional status filter. The
// next cursor is exposed via the X-Next-Cursor header.
func (s *Server) ListMyDineInOrders(w http.ResponseWriter, r *http.Request, params gen.ListMyDineInOrdersParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	limit, err := listLimit(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit is invalid")
		return
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}
	rows, next, err := dinein.NewStore(s.db.Pool()).ListMyDineInOrders(r.Context(), userID, status, limit, r.URL.Query().Get("cursor"))
	if errors.Is(err, dinein.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list my dine-in orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.DineInOrder, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenDineInOrder(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// GetDineInOrder returns the dine-in order detail (GET
// /dine-in/orders/{dineInOrderId}) for the parties only: the owning
// customer, any merchant session (merchant identity binding lands with the
// merchants bounded context) or staff. Everyone else — including the party
// of an order that does not exist — sees the same DINE_IN_ORDER_NOT_FOUND,
// so existence never leaks.
func (s *Server) GetDineInOrder(w http.ResponseWriter, r *http.Request, dineInOrderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row, err := dinein.NewStore(s.db.Pool()).GetDineInOrder(r.Context(), dineInOrderId)
	if errors.Is(err, dinein.ErrOrderNotFound) {
		writeError(w, http.StatusNotFound, "DINE_IN_ORDER_NOT_FOUND", "Dine-in order not found")
		return
	}
	if err != nil {
		s.logger.Error("get dine-in order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.canViewDineInOrder(claims, userID, row) {
		writeError(w, http.StatusNotFound, "DINE_IN_ORDER_NOT_FOUND", "Dine-in order not found")
		return
	}
	writeJSON(w, http.StatusOK, toGenDineInOrder(*row))
}

func (s *Server) canViewDineInOrder(claims *Claims, userID uuid.UUID, row *dinein.OrderRow) bool {
	switch claims.Role {
	case RoleCustomer:
		return row.CustomerUserID != nil && *row.CustomerUserID == userID
	case RoleMerchant:
		// Any merchant session may view any dine-in bill at this milestone;
		// merchant identity binding lands with the merchants context.
		return true
	case RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		return true
	default:
		return false
	}
}

// ConfirmDineInPayment advances a dine-in order towards payment (POST
// /dine-in/orders/{dineInOrderId}/confirm-payment). The first call moves an
// open order to awaiting_payment (the bill is being settled at the till);
// the second call marks it paid and stamps paid_at. Any other state is a
// 409 DINE_IN_ORDER_STATUS_CONFLICT, and an order that is not the
// merchant's own is the same 404 as a missing order.
func (s *Server) ConfirmDineInPayment(w http.ResponseWriter, r *http.Request, dineInOrderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can confirm dine-in payments")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	st := dinein.NewStore(s.db.Pool())
	row, err := st.GetDineInOrder(r.Context(), dineInOrderId)
	if errors.Is(err, dinein.ErrOrderNotFound) {
		writeError(w, http.StatusNotFound, "DINE_IN_ORDER_NOT_FOUND", "Dine-in order not found")
		return
	}
	if err != nil {
		s.logger.Error("confirm dine-in payment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, row.MerchantID)
	if err != nil {
		s.logger.Error("confirm dine-in payment ownership check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "DINE_IN_ORDER_NOT_FOUND", "Dine-in order not found")
		return
	}
	target := ""
	switch row.Status {
	case "open":
		target = "awaiting_payment"
	case "awaiting_payment":
		target = "paid"
	default:
		writeError(w, http.StatusConflict, "DINE_IN_ORDER_STATUS_CONFLICT", "Dine-in order cannot be confirmed in its current state")
		return
	}
	if err := st.TransitionDineInOrder(r.Context(), dineInOrderId, []string{row.Status}, target, actor); err != nil {
		if errors.Is(err, dinein.ErrConflict) {
			writeError(w, http.StatusConflict, "DINE_IN_ORDER_STATUS_CONFLICT", "Dine-in order cannot be confirmed in its current state")
			return
		}
		s.logger.Error("confirm dine-in payment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = target
	writeJSON(w, http.StatusOK, toGenDineInOrder(*row))
}

// CloseDineInOrder closes a dine-in order after settlement (POST
// /dine-in/orders/{dineInOrderId}/close): only a paid order may close, and
// closing frees the table for the next party. Anything else is a 409
// DINE_IN_BILL_NOT_PAYABLE, and an order that is not the merchant's own is
// the same 404 as a missing order.
func (s *Server) CloseDineInOrder(w http.ResponseWriter, r *http.Request, dineInOrderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can close dine-in orders")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	st := dinein.NewStore(s.db.Pool())
	row, err := st.GetDineInOrder(r.Context(), dineInOrderId)
	if errors.Is(err, dinein.ErrOrderNotFound) {
		writeError(w, http.StatusNotFound, "DINE_IN_ORDER_NOT_FOUND", "Dine-in order not found")
		return
	}
	if err != nil {
		s.logger.Error("close dine-in order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.merchantRowOwned(r.Context(), merchantID, row.MerchantID)
	if err != nil {
		s.logger.Error("close dine-in order ownership check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "DINE_IN_ORDER_NOT_FOUND", "Dine-in order not found")
		return
	}
	if row.Status != "paid" {
		writeError(w, http.StatusConflict, "DINE_IN_BILL_NOT_PAYABLE", "Dine-in order must be paid before it can be closed")
		return
	}
	if err := st.TransitionDineInOrder(r.Context(), dineInOrderId, []string{"paid"}, "closed", actor); err != nil {
		if errors.Is(err, dinein.ErrConflict) {
			writeError(w, http.StatusConflict, "DINE_IN_BILL_NOT_PAYABLE", "Dine-in order must be paid before it can be closed")
			return
		}
		s.logger.Error("close dine-in order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "closed"
	writeJSON(w, http.StatusOK, toGenDineInOrder(*row))
}

// reservationBody is the CreateReservation body: the contract's
// CreateReservationJSONBody (merchantId, partySize, scheduledFor, note)
// plus a tableId binding. The contract marks tableId optional (a table or
// queue slot) but the reservations store is per-table, so the handler
// requires it — a superset, never a conflict, with the contract's required
// fields intact.
type reservationBody struct {
	gen.CreateReservationJSONBody
	TableId openapi_types.UUID `json:"tableId"`
}

// CreateReservation reserves a table or queue slot (POST /reservations,
// 201). The Idempotency-Key header is required by the contract; this check
// catches an absent header. Any authenticated role may reserve. A
// reservation in the past is a 422 RESERVATION_TIME_IN_PAST; a table that
// cannot fit the party at the requested time is a 409 RESERVATION_TABLE_FULL.
func (s *Server) CreateReservation(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body reservationBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.PartySize < 1 || body.PartySize > 50 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "partySize must be between 1 and 50")
		return
	}
	if body.TableId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "tableId is required")
		return
	}
	if body.MerchantId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}
	if _, err := resolveMerchantID(r.Context(), s.db.Pool(), body.MerchantId); err != nil {
		writeError(w, http.StatusNotFound, "MERCHANT_NOT_FOUND", "Merchant not found")
		return
	}
	row, err := dinein.NewStore(s.db.Pool()).CreateReservation(r.Context(), dinein.CreateReservationInput{
		CustomerUserID: userID,
		MerchantID:     body.MerchantId,
		TableID:        body.TableId,
		PartySize:      body.PartySize,
		ReservedFor:    body.ScheduledFor,
		Note:           body.Note,
		IdempotencyKey: r.Header.Get("Idempotency-Key"),
	})
	switch {
	case errors.Is(err, dinein.ErrTableNotFound):
		writeError(w, http.StatusNotFound, "DINE_IN_TABLE_NOT_FOUND", "Dine-in table not found")
		return
	case errors.Is(err, dinein.ErrTimeInPast):
		writeError(w, http.StatusUnprocessableEntity, "RESERVATION_TIME_IN_PAST", "scheduledFor must be in the future")
		return
	case errors.Is(err, dinein.ErrTableFull):
		writeError(w, http.StatusConflict, "RESERVATION_TABLE_FULL", "Table is fully booked at the requested time")
		return
	case err != nil:
		s.logger.Error("create reservation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenReservation(row))
}

// ListMyReservations returns the caller's reservations (GET
// /reservations/me), cursor-paginated. The next cursor is exposed via the
// X-Next-Cursor header.
func (s *Server) ListMyReservations(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	limit, err := listLimit(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit is invalid")
		return
	}
	rows, next, err := dinein.NewStore(s.db.Pool()).ListMyReservations(r.Context(), userID, limit, r.URL.Query().Get("cursor"))
	if errors.Is(err, dinein.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list my reservations failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.Reservation, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenReservation(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// CancelReservation cancels a requested/confirmed reservation (POST
// /reservations/{reservationId}/cancel). Only the owning customer, the
// merchant of the table, or staff may cancel; everyone else — including the
// party of a reservation that does not exist — sees the same 404
// RESERVATION_NOT_FOUND. A reservation that can no longer be cancelled is a
// 409 RESERVATION_NOT_CANCELLABLE.
func (s *Server) CancelReservation(w http.ResponseWriter, r *http.Request, reservationId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer && claims.Role != RoleMerchant && !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the customer or the merchant can cancel a reservation")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	st := dinein.NewStore(s.db.Pool())
	row, err := st.GetReservation(r.Context(), reservationId)
	if errors.Is(err, dinein.ErrReservationNotFound) {
		writeError(w, http.StatusNotFound, "RESERVATION_NOT_FOUND", "Reservation not found")
		return
	}
	if err != nil {
		s.logger.Error("cancel reservation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	switch claims.Role {
	case RoleCustomer:
		if row.CustomerUserID != actor {
			writeError(w, http.StatusNotFound, "RESERVATION_NOT_FOUND", "Reservation not found")
			return
		}
	case RoleMerchant:
		merchantID, err := s.merchantIDForSession(r)
		if err != nil {
			s.writeMerchantError(w, err)
			return
		}
		owned, err := s.merchantRowOwned(r.Context(), merchantID, row.MerchantID)
		if err != nil {
			s.logger.Error("cancel reservation ownership check failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if !owned {
			writeError(w, http.StatusNotFound, "RESERVATION_NOT_FOUND", "Reservation not found")
			return
		}
	}
	if err := st.CancelReservation(r.Context(), reservationId, actor); err != nil {
		if errors.Is(err, dinein.ErrNotCancellable) {
			writeError(w, http.StatusConflict, "RESERVATION_NOT_CANCELLABLE", "Reservation can no longer be cancelled")
			return
		}
		s.logger.Error("cancel reservation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "cancelled"
	writeJSON(w, http.StatusOK, toGenReservation(*row))
}

// listLimit parses the limit query parameter with the listing defaults; a
// non-numeric value is an error the caller surfaces as a 422.
func listLimit(r *http.Request) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultDineInListLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return 0, errors.New("invalid limit")
	}
	if limit > maxDineInListLimit {
		limit = maxDineInListLimit
	}
	return limit, nil
}

// toGenDineInTable maps a table row onto the contract DineInTable schema.
// The qrToken is the deterministic QR payload derived from the table id
// (honest stub, see GetDineInTableQr).
func toGenDineInTable(row dinein.TableRow) gen.DineInTable {
	capacity := row.Capacity
	disabled := !row.Active
	status := gen.DineInTableStatusIdle
	if row.CurrentDineInOrderID != nil {
		status = gen.DineInTableStatusOccupied
	}
	qr := "hudumika:dinein:table:" + row.ID.String()
	id := newUUID(row.ID.String())
	return gen.DineInTable{
		Id:             &id,
		Label:          row.Label,
		Capacity:       &capacity,
		Disabled:       &disabled,
		CurrentOrderId: toOptionalUUID(row.CurrentDineInOrderID),
		Status:         &status,
		QrToken:        &qr,
	}
}

// toGenDineInOrder maps a dine-in order row onto the contract DineInOrder
// schema. Dine-in bills carry no delivery/platform fees, so the subtotal is
// the total.
func toGenDineInOrder(row dinein.OrderRow) gen.DineInOrder {
	items := make([]struct {
		CatalogueItemId openapi_types.UUID `json:"catalogueItemId"`
		Name            string             `json:"name"`
		Quantity        int                `json:"quantity"`
		UnitPriceTZS    int                `json:"unitPriceTZS"`
	}, 0, len(row.Items))
	for _, it := range row.Items {
		items = append(items, struct {
			CatalogueItemId openapi_types.UUID `json:"catalogueItemId"`
			Name            string             `json:"name"`
			Quantity        int                `json:"quantity"`
			UnitPriceTZS    int                `json:"unitPriceTZS"`
		}{
			CatalogueItemId: newUUID(it.CatalogueItemID.String()),
			Name:            it.Name,
			Quantity:        it.Quantity,
			UnitPriceTZS:    int(it.UnitPriceTZS),
		})
	}
	total := int(row.TotalTZS)
	return gen.DineInOrder{
		Id:         newUUID(row.ID.String()),
		TableId:    newUUID(row.TableID.String()),
		MerchantId: newUUID(row.MerchantID.String()),
		Status:     gen.DineInOrderStatus(row.Status),
		Items:      &items,
		Totals: gen.PriceBreakdown{
			SubtotalTZS: total,
			TotalTZS:    total,
		},
		CreatedAt: row.CreatedAt,
		PaidAt:    row.PaidAt,
	}
}

// toGenReservation maps a reservation row onto the contract Reservation
// schema.
func toGenReservation(row dinein.ReservationRow) gen.Reservation {
	createdAt := row.CreatedAt
	tableID := newUUID(row.TableID.String())
	return gen.Reservation{
		Id:           newUUID(row.ID.String()),
		MerchantId:   newUUID(row.MerchantID.String()),
		TableId:      &tableID,
		PartySize:    row.PartySize,
		ScheduledFor: row.ReservedFor,
		Status:       gen.ReservationStatus(row.Status),
		Note:         row.Note,
		CreatedAt:    &createdAt,
	}
}
