package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// ORDERS-EXTRA surface (migration 00033_orders_extra.sql): merchant order
// search, the rush (hurry-up) flow, batch accept/reject, damage claims, the
// reject-reason catalog, receipt reprint listing and the enterprise listing.

// Batch bounds for /orders/batch/accept and /orders/batch/reject.
const (
	maxBatchOrders = 50
)

// orderRejectReasons is the static reject-reason catalog served by
// /orders/reject-reasons. The contract models the response as a plain array
// of strings; the values double as the reject_reason_code vocabulary the
// batch reject surface stamps on orders.
var orderRejectReasons = []string{
	"customer_unavailable",
	"wrong_address",
	"item_unavailable",
	"merchant_closed",
	"payment_failed",
	"duplicate_order",
	"long_preparation",
	"other",
}

// orderReceiptItem is the contract shape of one /orders/receipts row.
type orderReceiptItem struct {
	OrderId   openapi_types.UUID `json:"orderId"`
	PrintedAt time.Time          `json:"printedAt"`
	JobId     openapi_types.UUID `json:"jobId"`
}

// orderTimeline is the contract shape of GET /orders/{orderId}/timeline.
type orderTimeline struct {
	Events []gen.OrderEvent `json:"events"`
}

// orderStaffRole reports whether the claims belong to a merchant or staff
// session, i.e. the roles the ORDERS-EXTRA search surfaces serve.
func orderStaffRole(claims *Claims) bool {
	switch claims.Role {
	case RoleMerchant, RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		return true
	default:
		return false
	}
}

// SearchOrders is the merchant/staff order search (GET /orders/search,
// contract Order schema, 200). q matches the order number or the customer's
// phone (ILIKE, wildcard-escaped); status, from/to date range and
// customerPhone further narrow the query. Keyset pagination mirrors
// /orders/me (X-Next-Cursor). A request with neither q nor any filter is
// rejected with 422 ORDER_SEARCH_INVALID before the database is touched.
func (s *Server) SearchOrders(w http.ResponseWriter, r *http.Request, params gen.SearchOrdersParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !orderStaffRole(claims) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants and staff can search orders")
		return
	}
	q := ""
	if params.Q != nil {
		q = *params.Q
	}
	customerPhone := ""
	if params.CustomerPhone != nil {
		customerPhone = *params.CustomerPhone
	}
	if q == "" && params.Status == nil && params.From == nil && params.To == nil && customerPhone == "" {
		writeError(w, http.StatusUnprocessableEntity, "ORDER_SEARCH_INVALID", "q or at least one filter is required")
		return
	}
	if s.db == nil {
		s.logger.Error("search orders failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultOrderListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxOrderListLimit {
			limit = maxOrderListLimit
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	in := orders.OrderSearchInput{
		Q:             q,
		Status:        "",
		CustomerPhone: customerPhone,
		Limit:         limit,
		Cursor:        cursor,
	}
	if params.Status != nil {
		in.Status = string(*params.Status)
	}
	if params.From != nil {
		from := (*params.From).Time
		in.From = &from
	}
	if params.To != nil {
		to := (*params.To).Time
		in.To = &to
	}

	rows, next, err := orders.NewStore(s.db.Pool()).SearchOrders(r.Context(), in)
	if errors.Is(err, orders.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("search orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.Order, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenOrder(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// GetOrderTimeline returns the append-only event history of an order (GET
// /orders/{orderId}/timeline, contract {events: OrderEvent[]}). Only the
// parties may read it: the owning customer, any merchant or staff session.
// Like GetOrder, a non-party sees the same 404 as a missing order.
func (s *Server) GetOrderTimeline(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
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
	if s.db == nil {
		s.logger.Error("get order timeline failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	detail, err := orders.NewStore(s.db.Pool()).GetOrderDetail(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("get order timeline failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.canViewOrder(claims, userID, detail) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	writeJSON(w, http.StatusOK, orderTimeline{Events: toGenOrderEvents(detail.Events)})
}

// RushOrder records a customer's hurry-up request on a paid order (POST
// /orders/{orderId}/rush, 204). The store stamps rush_requested_at and the
// acceptance deadline (now + 1 minute) atomically; auto-cancelling orders
// whose deadline lapses is a scheduler concern outside this milestone
// (ERROR-CODES.md ORDER_AUTO_CANCELLED). A rush on a non-paid order, or a
// second rush while one is open, yields 409 ORDER_RUSH_NOT_ALLOWED.
func (s *Server) RushOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("rush order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := orders.NewStore(s.db.Pool())
	row, err := st.GetOrderRow(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("rush order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.orderPartyOrStaff(claims, actor, row) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if _, err := st.RequestRush(r.Context(), orderId, actor); err != nil {
		switch {
		case errors.Is(err, orders.ErrNotFound):
			writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		case errors.Is(err, orders.ErrConflict):
			writeError(w, http.StatusConflict, "ORDER_RUSH_NOT_ALLOWED", "Order cannot be rushed in its current state")
		default:
			s.logger.Error("rush order failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return
	}
	publishDomainEvent(r.Context(), s, "order.rush", map[string]any{"orderId": orderId.String(), "status": row.Status})
	w.WriteHeader(http.StatusNoContent)
}

// ReplyToRush records the merchant's reply to a pending rush request (POST
// /orders/{orderId}/rush-reply, contract RushOrder, 200). The message is
// persisted on the order event log. No pending rush yields 409 RUSH_NOT_OPEN
// and a second reply 409 RUSH_ALREADY_REPLIED.
func (s *Server) ReplyToRush(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can reply to rush requests")
		return
	}
	var body gen.ReplyToRushJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Message == "" || len(body.Message) > 300 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "message is required (max 300 characters)")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("reply to rush failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	detail, err := orders.NewStore(s.db.Pool()).ReplyRush(r.Context(), orderId, actor, body.Message)
	switch {
	case errors.Is(err, orders.ErrNotFound):
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	case errors.Is(err, orders.ErrRushNotOpen):
		writeError(w, http.StatusConflict, "RUSH_NOT_OPEN", "No rush request is open for this order")
		return
	case errors.Is(err, orders.ErrRushReplied):
		writeError(w, http.StatusConflict, "RUSH_ALREADY_REPLIED", "Rush request has already been replied to")
		return
	case err != nil:
		s.logger.Error("reply to rush failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	reply := body.Message
	publishOrderEvent(r.Context(), s, detail.Order.ID.String(), detail.Order.CustomerUserID.String(), detail.Order.Status,
		map[string]any{"rushReply": reply})
	writeJSON(w, http.StatusOK, toGenRushOrder(detail, &reply))
}

// ListRushOrders is the merchant rush queue (GET /orders/rush, contract
// RushOrder[], 200). Every order with a rush request is returned, newest
// first; the optional status filter selects open / replied / resolved.
func (s *Server) ListRushOrders(w http.ResponseWriter, r *http.Request, params gen.ListRushOrdersParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can view the rush queue")
		return
	}
	if s.db == nil {
		s.logger.Error("list rush orders failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}
	rows, err := orders.NewStore(s.db.Pool()).ListRushOrders(r.Context(), status)
	if err != nil {
		s.logger.Error("list rush orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.RushOrder, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenRushQueueRow(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// AcceptOrdersBatch accepts up to 50 orders in one action (POST
// /orders/batch/accept, contract BatchResult, 200). Each order is accepted
// independently and best-effort: the batch never fails as a whole. Orders
// that cannot be accepted are reported per-order in the failures array
// (ORDER_NOT_FOUND, INVALID_TRANSITION for a wrong status or a version that
// moved mid-flight, INTERNAL_ERROR); the others are accepted and counted.
func (s *Server) AcceptOrdersBatch(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can accept orders")
		return
	}
	var body gen.AcceptOrdersBatchJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.OrderIds) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "BATCH_EMPTY", "orderIds must contain at least one order")
		return
	}
	if len(body.OrderIds) > maxBatchOrders {
		writeError(w, http.StatusUnprocessableEntity, "BATCH_EXCEEDS_LIMIT", "A batch may contain at most 50 orders")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("batch accept failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.runAcceptBatch(w, r, body.OrderIds, actor)
}

// RejectOrdersBatch rejects up to 50 orders with one reason (POST
// /orders/batch/reject, contract BatchResult, 200). Semantics match
// AcceptOrdersBatch: per-order best-effort, partial success reported in the
// failures array. The reason is stamped on each order row and event.
func (s *Server) RejectOrdersBatch(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can reject orders")
		return
	}
	var body gen.RejectOrdersBatchJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.OrderIds) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "BATCH_EMPTY", "orderIds must contain at least one order")
		return
	}
	if len(body.OrderIds) > maxBatchOrders {
		writeError(w, http.StatusUnprocessableEntity, "BATCH_EXCEEDS_LIMIT", "A batch may contain at most 50 orders")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("batch reject failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.runRejectBatch(w, r, body.OrderIds, body.Reason, actor)
}

// runAcceptBatch applies the batch accept loop and writes the BatchResult.
// Per-order best-effort: a failing order never aborts the batch. The
// version is read fresh per order (the batch body carries no
// expectedVersion), so a conflict here means the order moved mid-flight
// and is reported as INVALID_TRANSITION.
func (s *Server) runAcceptBatch(w http.ResponseWriter, r *http.Request, orderIDs []openapi_types.UUID, actor uuid.UUID) {
	st := orders.NewStore(s.db.Pool())
	accepted := 0
	var failures []batchFailure
	for _, id := range orderIDs {
		row, err := st.GetOrderRow(r.Context(), id)
		if errors.Is(err, orders.ErrNotFound) {
			failures = append(failures, batchFailure{Code: "ORDER_NOT_FOUND", OrderId: id})
			continue
		}
		if err != nil {
			s.logger.Error("batch accept lookup failed", "orderId", id, "error", err)
			failures = append(failures, batchFailure{Code: "INTERNAL_ERROR", OrderId: id})
			continue
		}
		_, err = st.AcceptOrder(r.Context(), id, row.Version, actor)
		if errors.Is(err, orders.ErrConflict) {
			failures = append(failures, batchFailure{Code: "INVALID_TRANSITION", OrderId: id})
			continue
		}
		if err != nil {
			s.logger.Error("batch accept failed", "orderId", id, "error", err)
			failures = append(failures, batchFailure{Code: "INTERNAL_ERROR", OrderId: id})
			continue
		}
		accepted++
		publishDomainEvent(r.Context(), s, "order.batch", map[string]any{
			"orderId": id.String(), "status": "merchant_accepted", "action": "accepted",
		})
	}
	s.writeBatchResult(w, accepted, failures)
}

// runRejectBatch applies the batch reject loop and writes the BatchResult;
// semantics match runAcceptBatch.
func (s *Server) runRejectBatch(w http.ResponseWriter, r *http.Request, orderIDs []openapi_types.UUID, reason string, actor uuid.UUID) {
	st := orders.NewStore(s.db.Pool())
	rejected := 0
	var failures []batchFailure
	for _, id := range orderIDs {
		row, err := st.GetOrderRow(r.Context(), id)
		if errors.Is(err, orders.ErrNotFound) {
			failures = append(failures, batchFailure{Code: "ORDER_NOT_FOUND", OrderId: id})
			continue
		}
		if err != nil {
			s.logger.Error("batch reject lookup failed", "orderId", id, "error", err)
			failures = append(failures, batchFailure{Code: "INTERNAL_ERROR", OrderId: id})
			continue
		}
		_, err = st.RejectOrderWithReason(r.Context(), id, row.Version, reason, "", actor)
		if errors.Is(err, orders.ErrConflict) {
			failures = append(failures, batchFailure{Code: "INVALID_TRANSITION", OrderId: id})
			continue
		}
		if err != nil {
			s.logger.Error("batch reject failed", "orderId", id, "error", err)
			failures = append(failures, batchFailure{Code: "INTERNAL_ERROR", OrderId: id})
			continue
		}
		rejected++
		publishDomainEvent(r.Context(), s, "order.batch", map[string]any{
			"orderId": id.String(), "status": "cancelled", "action": "rejected", "reason": reason,
		})
	}
	s.writeBatchResult(w, rejected, failures)
}

// writeBatchResult emits the contract BatchResult. Partial success is the
// documented semantic: the response is always 200 and the failures array
// carries the per-order errors.
func (s *Server) writeBatchResult(w http.ResponseWriter, okCount int, failures []batchFailure) {
	res := gen.BatchResult{Accepted: okCount, Failed: len(failures)}
	if len(failures) > 0 {
		f := make([]struct {
			Code    string             `json:"code"`
			OrderId openapi_types.UUID `json:"orderId"`
		}, 0, len(failures))
		for _, bf := range failures {
			f = append(f, struct {
				Code    string             `json:"code"`
				OrderId openapi_types.UUID `json:"orderId"`
			}{Code: bf.Code, OrderId: bf.OrderId})
		}
		res.Failures = &f
	}
	writeJSON(w, http.StatusOK, res)
}

// batchFailure is one per-order failure entry of BatchResult.
type batchFailure struct {
	Code    string             `json:"code"`
	OrderId openapi_types.UUID `json:"orderId"`
}

// ReportOrderDamage files a damage claim for an order (POST
// /orders/{orderId}/damage, contract DamageClaim, 201). Only the parties may
// report: the owning customer, or any merchant/staff session. The claim
// starts pending; deciding claims (approve/reject) is not part of the
// generated surface yet, so claims stay pending until that milestone
// (ERROR-CODES.md DAMAGE_CLAIM_*). The claim type is echoed from the body:
// the damage table carries no type column at this milestone (deviation).
func (s *Server) ReportOrderDamage(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("report damage failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := orders.NewStore(s.db.Pool())
	row, err := st.GetOrderRow(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("report damage failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.orderPartyOrStaff(claims, actor, row) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	var body gen.DamageClaim
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Description == "" || len(body.Description) > 1000 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "description is required (max 1000 characters)")
		return
	}
	if !validDamageClaimType(body.Type) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be one of spilled, missing, wrong_item, damaged_packaging, quality")
		return
	}
	claim, err := st.CreateDamageClaim(r.Context(), orderId, actor, body.Description)
	if err != nil {
		s.logger.Error("report damage failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	publishDomainEvent(r.Context(), s, "order.damage", map[string]any{
		"orderId": orderId.String(), "status": row.Status, "claimId": claim.ID, "type": body.Type,
	})
	id := newUUID(claim.ID.String())
	status := gen.DamageClaimStatusOpen
	writeJSON(w, http.StatusCreated, gen.DamageClaim{
		Id:          &id,
		OrderId:     newUUID(claim.OrderID.String()),
		Type:        body.Type,
		Description: claim.Description,
		Images:      body.Images,
		Status:      &status,
		CreatedAt:   &claim.CreatedAt,
	})
}

// ListRejectReasons returns the static reject-reason catalog (GET
// /orders/reject-reasons, contract string[], 200). The values are the
// reject_reason_code vocabulary referenced by ERROR-CODES.md; the catalog is
// code-served and needs no database.
func (s *Server) ListRejectReasons(w http.ResponseWriter, r *http.Request) {
	out := make([]string, len(orderRejectReasons))
	copy(out, orderRejectReasons)
	writeJSON(w, http.StatusOK, out)
}

// ListOrderReceipts returns recent receipts for reprint (GET
// /orders/receipts, contract {orderId, printedAt, jobId}[], 200). Customers
// see their own orders' receipts; merchants and staff see all. Deviation:
// the order_receipts row has no separate print-job reference, so the receipt
// row id stands in as jobId and created_at as printedAt. There is no create
// path in the generated interface, so receipts are written by the print
// milestone.
func (s *Server) ListOrderReceipts(w http.ResponseWriter, r *http.Request, params gen.ListOrderReceiptsParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list receipts failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultOrderListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxOrderListLimit {
			limit = maxOrderListLimit
		}
	}
	var customerID *uuid.UUID
	if claims.Role == RoleCustomer {
		customerID = &actor
	}
	rows, err := orders.NewStore(s.db.Pool()).ListReceipts(r.Context(), customerID, limit)
	if err != nil {
		s.logger.Error("list receipts failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]orderReceiptItem, 0, len(rows))
	for _, row := range rows {
		out = append(out, orderReceiptItem{
			OrderId:   newUUID(row.OrderID.String()),
			PrintedAt: row.CreatedAt,
			JobId:     newUUID(row.ID.String()),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// ListEnterpriseOrders lists enterprise-sourced orders (GET
// /orders/enterprise, contract EnterpriseOrder[], 200). The contract defines
// only the listing for this surface: enterprise order creation is not part
// of the generated interface, so creation still flows through POST /orders
// with source 'app'; this handler serves source='enterprise' rows once a
// create path exists (deviation, documented). Enterprise orders carry no
// company metadata at this milestone, so companyName is empty.
func (s *Server) ListEnterpriseOrders(w http.ResponseWriter, r *http.Request, params gen.ListEnterpriseOrdersParams) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !orderStaffRole(claims) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants and staff can list enterprise orders")
		return
	}
	if s.db == nil {
		s.logger.Error("list enterprise orders failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultOrderListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxOrderListLimit {
			limit = maxOrderListLimit
		}
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	rows, next, err := orders.NewStore(s.db.Pool()).ListSourceOrders(r.Context(), "enterprise", status, limit, cursor)
	if errors.Is(err, orders.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list enterprise orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.EnterpriseOrder, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenEnterpriseOrder(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// orderPartyOrStaff mirrors canViewOrder for a row (no event history
// needed): the owning customer or any merchant/staff session is a party;
// everyone else is not.
func (s *Server) orderPartyOrStaff(claims *Claims, userID uuid.UUID, row *orders.OrderRow) bool {
	if claims.Role == RoleCustomer {
		return row.CustomerUserID == userID
	}
	return orderStaffRole(claims)
}

// toGenOrderEvents maps the store event history onto the contract OrderEvent
// schema. Rush stamps appear as 'rush_requested' / 'rush_reply' events.
func toGenOrderEvents(events []orders.EventRow) []gen.OrderEvent {
	out := make([]gen.OrderEvent, 0, len(events))
	for _, e := range events {
		by := "system"
		if e.By != nil {
			by = e.By.String()
		}
		out = append(out, gen.OrderEvent{
			At:     e.At,
			By:     by,
			Note:   e.Note,
			Status: gen.OrderStatus(e.Status),
		})
	}
	return out
}

// toGenRushOrder maps a rush mutation result onto the contract RushOrder.
func toGenRushOrder(d *orders.RushOrderDetail, replyMessage *string) gen.RushOrder {
	status := gen.RushOrderStatusOpen
	if d.RepliedAt != nil {
		status = gen.RushOrderStatusReplied
	}
	return gen.RushOrder{
		OrderId:      newUUID(d.Order.ID.String()),
		RequestedAt:  d.RequestedAt,
		RepliedAt:    d.RepliedAt,
		ReplyMessage: replyMessage,
		Status:       status,
	}
}

// toGenRushQueueRow maps a rush queue row onto the contract RushOrder.
func toGenRushQueueRow(row orders.RushOrderRow) gen.RushOrder {
	return gen.RushOrder{
		OrderId:      newUUID(row.OrderID.String()),
		RequestedAt:  row.RequestedAt,
		RepliedAt:    row.RepliedAt,
		ReplyMessage: row.ReplyMessage,
		Status:       gen.RushOrderStatus(row.Status),
	}
}

// toGenEnterpriseOrder maps an order row onto the contract EnterpriseOrder.
// The contract's optional fields (rush stamps, deadline, settlement stamps)
// are omitted: OrderRow does not carry the 00033 columns yet.
func toGenEnterpriseOrder(row orders.OrderRow) gen.EnterpriseOrder {
	no := row.No
	source := gen.EnterpriseOrderSource(row.Source)
	version := row.Version
	updatedAt := row.UpdatedAt
	return gen.EnterpriseOrder{
		Id:          newUUID(row.ID.String()),
		No:          &no,
		Status:      gen.OrderStatus(row.Status),
		MerchantId:  newUUID(row.MerchantID.String()),
		RiderId:     toOptionalUUID(row.RiderID),
		Source:      &source,
		Version:     &version,
		CompanyName: "", // see handler doc: no company metadata yet
		Totals: gen.PriceBreakdown{
			SubtotalTZS:    int(row.SubtotalTZS),
			DeliveryFeeTZS: int(row.DeliveryFeeTZS),
			PlatformFeeTZS: int(row.PlatformFeeTZS),
			TaxTZS:         int(row.TaxTZS),
			DiscountTZS:    int(row.DiscountTZS),
			TotalTZS:       int(row.TotalTZS),
		},
		CreatedAt: row.CreatedAt,
		UpdatedAt: &updatedAt,
	}
}

// validDamageClaimType reports whether the claim type is a known member of
// the contract DamageClaim.type enum.
func validDamageClaimType(t gen.DamageClaimType) bool {
	switch t {
	case gen.DamageClaimTypeSpilled, gen.DamageClaimTypeMissing,
		gen.DamageClaimTypeWrongItem, gen.DamageClaimTypeDamagedPackaging,
		gen.DamageClaimTypeQuality:
		return true
	default:
		return false
	}
}
