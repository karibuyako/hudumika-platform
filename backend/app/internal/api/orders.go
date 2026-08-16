package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	"github.com/hudumika/api-backend/internal/payouts"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// List pagination bounds for /orders/me.
const (
	defaultOrderListLimit = 20
	maxOrderListLimit     = 50
)

// orderStatuses is the status set the orders.status CHECK constraint accepts;
// used to reject unknown advance targets before they hit the database.
var orderStatuses = map[string]struct{}{
	"draft": {}, "pending_payment": {}, "paid": {}, "merchant_accepted": {},
	"preparing": {}, "rider_assigned": {}, "picked_up": {}, "delivering": {},
	"delivered": {}, "completed": {}, "cancelled": {}, "refunded": {},
	"failed": {}, "disputed": {},
}

// merchantAdvance maps the status a merchant may advance FROM to the single
// status they may advance TO; riderAdvance is the rider's shorter chain.
var merchantAdvance = map[string]string{
	"merchant_accepted": "preparing",
	"preparing":         "rider_assigned",
	"rider_assigned":    "picked_up",
	"picked_up":         "delivering",
	"delivering":        "delivered",
	"delivered":         "completed",
}

var riderAdvance = map[string]string{
	"rider_assigned": "picked_up",
	"picked_up":      "delivering",
	"delivering":     "delivered",
	"delivered":      "completed",
}

// orderActor resolves the authenticated subject (phone) to their users.id.
// RequireAuth guarantees claims; the database may still be absent (unit
// tests, dev without DATABASE_URL), which surfaces as errNoDatabase.
func (s *Server) orderActor(r *http.Request) (uuid.UUID, error) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims.Subject == "" {
		return uuid.Nil, errNoBearerToken
	}
	if s.db == nil {
		return uuid.Nil, errNoDatabase
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return uuid.Nil, err
	}
	if user == nil {
		return uuid.Nil, errUserNotFound
	}
	return user.ID, nil
}

// resolveMerchantsBatch resolves a set of raw merchant references (real
// merchants ids or the legacy owner_user_id values) to their canonical
// merchants ids in one query; references without a row are absent from the
// map. It is the batched twin of resolveMerchantID (merchant_linkage.go) so
// per-line order validation never runs a query per item.
func resolveMerchantsBatch(ctx context.Context, pool *pgxpool.Pool, raws []uuid.UUID) (map[uuid.UUID]uuid.UUID, error) {
	resolved := make(map[uuid.UUID]uuid.UUID, len(raws)*2)
	if len(raws) == 0 {
		return resolved, nil
	}
	rows, err := pool.Query(ctx,
		`SELECT id, owner_user_id FROM merchants WHERE id = ANY($1) OR owner_user_id = ANY($1)`, raws)
	if err != nil {
		return nil, fmt.Errorf("merchant linkage: resolve merchants batch: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, owner uuid.UUID
		if err := rows.Scan(&id, &owner); err != nil {
			return nil, fmt.Errorf("merchant linkage: scan resolved merchant: %w", err)
		}
		resolved[id] = id
		resolved[owner] = id
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("merchant linkage: iterate resolved merchants: %w", err)
	}
	return resolved, nil
}

// writeOrderActorError maps orderActor failures to envelopes. Unlike the
// profile endpoints, a missing database here is an operational failure
// (500 INTERNAL_ERROR), never NOT_FOUND.
func (s *Server) writeOrderActorError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	default:
		s.logger.Error("order actor lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// CreateOrder creates an order draft (POST /orders, contract Order schema,
// 201). The Idempotency-Key header is required by the contract; the
// generated wrapper enforces presence at the route layer, and this check
// catches an empty value. Prices are computed server-side from the
// catalogue; unknown or unavailable items are rejected before any write.
func (s *Server) CreateOrder(w http.ResponseWriter, r *http.Request, params gen.CreateOrderParams) {
	if params.IdempotencyKey == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.OrderCreate
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one item is required")
		return
	}
	if s.db == nil {
		s.logger.Error("create order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	ids := make([]uuid.UUID, 0, len(body.Items))
	for _, it := range body.Items {
		ids = append(ids, it.CatalogueItemId)
	}
	catalogue, err := orders.NewStore(s.db.Pool()).GetCatalogueItems(r.Context(), ids)
	if err != nil {
		s.logger.Error("load catalogue items failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if body.MerchantId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}
	// The client merchantId must reference a real merchants row (by id or,
	// for pre-linkage references, by owner_user_id — resolveMerchantsBatch
	// accepts both); the resolved id anchors the item-ownership check so
	// catalogue rows written under either convention match. Every raw
	// reference resolves in one batched query, never one per line.
	raws := make([]uuid.UUID, 0, len(body.Items)+1)
	seen := map[uuid.UUID]struct{}{}
	addRaw := func(id uuid.UUID) {
		if _, dup := seen[id]; dup {
			return
		}
		seen[id] = struct{}{}
		raws = append(raws, id)
	}
	addRaw(body.MerchantId)
	for _, it := range body.Items {
		if item, ok := catalogue[it.CatalogueItemId]; ok {
			addRaw(item.MerchantID)
		}
	}
	resolved, err := resolveMerchantsBatch(r.Context(), s.db.Pool(), raws)
	if err != nil {
		writeError(w, http.StatusNotFound, "MERCHANT_NOT_FOUND", "Merchant not found")
		return
	}
	orderMerchant, ok := resolved[body.MerchantId]
	if !ok {
		writeError(w, http.StatusNotFound, "MERCHANT_NOT_FOUND", "Merchant not found")
		return
	}
	for _, it := range body.Items {
		item, ok := catalogue[it.CatalogueItemId]
		if !ok || !item.Available {
			writeError(w, http.StatusUnprocessableEntity, "ORDER_ITEM_UNAVAILABLE", "One or more items are unavailable")
			return
		}
		itemMerchant, ok := resolved[item.MerchantID]
		if !ok || itemMerchant != orderMerchant {
			writeError(w, http.StatusUnprocessableEntity, "ORDER_ITEM_UNAVAILABLE", "One or more items are unavailable")
			return
		}
	}

	items := make([]orders.CreateOrderItem, 0, len(body.Items))
	for _, it := range body.Items {
		line := orders.CreateOrderItem{CatalogueItemID: it.CatalogueItemId, Quantity: it.Quantity}
		if it.Options != nil {
			line.Options = append([]string(nil), (*it.Options)...)
		}
		items = append(items, line)
	}
	row, err := orders.NewStore(s.db.Pool()).CreateOrder(r.Context(), orders.CreateOrderInput{
		CustomerUserID:  userID,
		MerchantID:      body.MerchantId,
		Items:           items,
		DeliveryAddress: toOrderAddress(body.DeliveryAddress),
		Note:            body.Note,
		IdempotencyKey:  params.IdempotencyKey,
		Source:          "app",
	})
	if err != nil {
		s.logger.Error("create order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenOrder(row))
}

// ListMyOrders returns the caller's orders (GET /orders/me), cursor-
// paginated with an optional status filter. The next cursor is exposed via
// the X-Next-Cursor header, matching the services listing convention.
func (s *Server) ListMyOrders(w http.ResponseWriter, r *http.Request, params gen.ListMyOrdersParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list orders failed: database not configured")
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

	rows, next, err := orders.NewStore(s.db.Pool()).ListOrders(r.Context(), userID, status, limit, cursor)
	if errors.Is(err, orders.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list orders failed", "error", err)
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

// GetOrder returns the order detail with items and events (GET
// /orders/{orderId}) for the parties: the owning customer, any merchant
// session (merchant-scoped ownership lands with the merchants bounded
// context), or staff. Everyone else — including the owner of an order that
// does not exist — sees the same ORDER_NOT_FOUND, so existence never leaks.
func (s *Server) GetOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
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
		s.logger.Error("get order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	detail, err := orders.NewStore(s.db.Pool()).GetOrderDetail(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("get order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.canViewOrder(claims, userID, detail) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	writeJSON(w, http.StatusOK, toGenOrderDetail(detail))
}

func (s *Server) canViewOrder(claims *Claims, userID uuid.UUID, detail *orders.OrderDetail) bool {
	switch claims.Role {
	case RoleCustomer:
		return detail.Order.CustomerUserID == userID
	case RoleMerchant, RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		// Any merchant session may view orders for this milestone; binding
		// orders to the merchant's identity lands with the merchants
		// bounded context.
		return true
	default:
		return false
	}
}

// AcceptOrder moves a draft/pending_payment/paid order to merchant_accepted
// (POST /orders/{orderId}/accept), guarded by the client-observed version.
// A stale version or an already-accepted order yields 409 VERSION_CONFLICT.
func (s *Server) AcceptOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can accept orders")
		return
	}
	var body gen.AcceptOrderJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.ExpectedVersion < 1 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "expectedVersion is required")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("accept order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := orders.NewStore(s.db.Pool())
	version, err := st.TransitionOrder(r.Context(), orderId, body.ExpectedVersion,
		[]string{"draft", "pending_payment", "paid"}, "merchant_accepted", actor, "")
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "VERSION_CONFLICT", "Order version or state changed; refetch and retry")
		return
	}
	if err != nil {
		s.logger.Error("accept order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := st.GetOrderRow(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("reload accepted order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "merchant_accepted"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// RejectOrder lets a merchant cancel an order that has not left the
// pre-acceptance states (draft, pending_payment, paid). The reason is
// recorded on the event; a state conflict yields 409 ORDER_STATUS_CONFLICT.
func (s *Server) RejectOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants can reject orders")
		return
	}
	var body gen.RejectOrderJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
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
		s.logger.Error("reject order failed: database not configured")
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
		s.logger.Error("reject order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row.Status != "draft" && row.Status != "pending_payment" && row.Status != "paid" {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot be rejected in its current state")
		return
	}
	version, err := st.TransitionOrder(r.Context(), orderId, row.Version, []string{row.Status}, "cancelled", actor, body.Reason)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot be rejected in its current state")
		return
	}
	if err != nil {
		s.logger.Error("reject order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "cancelled"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// CancelOrder lets the owning customer cancel before payment and a merchant
// cancel through paid. The reason is recorded on the event; cancellations
// outside those windows yield 409 ORDER_NOT_CANCELLABLE.
func (s *Server) CancelOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer && claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the customer or the merchant can cancel an order")
		return
	}
	var body gen.CancelOrderJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
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
		s.logger.Error("cancel order failed: database not configured")
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
		s.logger.Error("cancel order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if claims.Role == RoleCustomer && row.CustomerUserID != actor {
		// Non-owners see the same NOT_FOUND as a missing order.
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	cancellable := row.Status == "draft" || row.Status == "pending_payment"
	if claims.Role == RoleMerchant {
		cancellable = cancellable || row.Status == "paid"
	}
	if !cancellable {
		writeError(w, http.StatusConflict, "ORDER_NOT_CANCELLABLE", "Order can no longer be cancelled")
		return
	}
	version, err := st.TransitionOrder(r.Context(), orderId, row.Version, []string{row.Status}, "cancelled", actor, body.Reason)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_NOT_CANCELLABLE", "Order can no longer be cancelled")
		return
	}
	if err != nil {
		s.logger.Error("cancel order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "cancelled"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// AdvanceOrder moves an order one step along the fulfillment chain (POST
// /orders/{orderId}/status). Merchants drive merchant_accepted through
// completed; riders drive rider_assigned through completed. The requested
// status must be the single legal next step, else 409 ORDER_STATUS_CONFLICT.
func (s *Server) AdvanceOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleMerchant && claims.Role != RoleRider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchants or riders can advance an order")
		return
	}
	var body gen.AdvanceOrderJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	target := string(body.Status)
	if _, ok := orderStatuses[target]; !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is not a valid order status")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("advance order failed: database not configured")
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
		s.logger.Error("advance order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	chain := merchantAdvance
	if claims.Role == RoleRider {
		chain = riderAdvance
	}
	next, ok := chain[row.Status]
	if !ok || next != target {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot move to the requested status")
		return
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	version, err := st.TransitionOrder(r.Context(), orderId, row.Version, []string{row.Status}, target, actor, note)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot move to the requested status")
		return
	}
	if err != nil {
		s.logger.Error("advance order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Completion hook: a completed order earns the merchant ledger entry
	// (PAYOUTS-LEDGER.md: merchant earning requires order completed). The
	// ledger is the single source of truth and the entry is idempotent by
	// idempotency_key, so a replay after a partial failure never double
	// credits. A missing database (dev) skips the entry with a log.
	if target == "completed" {
		s.appendOrderEarning(r, row)
	}

	row.Status = target
	row.Version = version
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// appendOrderEarning appends the merchant's order_earning ledger entry for a
// completed order. Failures are logged, never fatal: the order transition
// has already committed, and the idempotency_key makes a retry safe.
func (s *Server) appendOrderEarning(r *http.Request, row *orders.OrderRow) {
	if s.db == nil {
		s.logger.Warn("order earning skipped: database not configured", "orderId", row.ID)
		return
	}
	applied, err := payouts.NewStore(s.db.Pool()).AppendEntry(r.Context(), payouts.LedgerEntryInput{
		AccountOwnerID: row.MerchantID,
		AccountType:    "merchant",
		Type:           "order_earning",
		AmountTZS:      row.TotalTZS,
		ReferenceType:  "order",
		ReferenceID:    row.ID,
		IdempotencyKey: "order_earning:" + row.ID.String(),
	})
	if err != nil {
		s.logger.Error("order earning append failed", "orderId", row.ID, "error", err)
		return
	}
	if !applied {
		s.logger.Warn("order earning replay ignored", "orderId", row.ID)
	}
}

// TrackOrder returns the tracking event for a paid order (GET
// /orders/{orderId}/track, contract TrackingEvent schema). Orders outside
// paid yield 409 ORDER_NOT_PAYABLE; live rider location lands with the
// dispatch milestone.
func (s *Server) TrackOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if _, err := s.orderActor(r); err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("track order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := orders.NewStore(s.db.Pool()).GetOrderRow(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("track order failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row.Status != "paid" {
		writeError(w, http.StatusConflict, "ORDER_NOT_PAYABLE", "Tracking is available once the order is paid")
		return
	}
	writeJSON(w, http.StatusOK, gen.TrackingEvent{
		Status:    gen.OrderStatus(row.Status),
		UpdatedAt: row.UpdatedAt,
	})
}

// toGenOrder maps an order row onto the contract Order schema.
func toGenOrder(row orders.OrderRow) gen.Order {
	no := row.No
	source := gen.OrderSource(row.Source)
	version := row.Version
	updatedAt := row.UpdatedAt
	return gen.Order{
		Id:         newUUID(row.ID.String()),
		No:         &no,
		Status:     gen.OrderStatus(row.Status),
		MerchantId: newUUID(row.MerchantID.String()),
		RiderId:    toOptionalUUID(row.RiderID),
		Source:     &source,
		Version:    &version,
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

// toGenOrderDetail maps the full order projection onto the contract
// OrderDetail schema (Order fields + items, deliveryAddress, events).
func toGenOrderDetail(d *orders.OrderDetail) gen.OrderDetail {
	base := toGenOrder(d.Order)

	items := make([]struct {
		CatalogueItemId openapi_types.UUID `json:"catalogueItemId"`
		Name            string             `json:"name"`
		Quantity        int                `json:"quantity"`
		UnitPriceTZS    int                `json:"unitPriceTZS"`
	}, 0, len(d.Items))
	for _, it := range d.Items {
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

	events := make([]gen.OrderEvent, 0, len(d.Events))
	for _, e := range d.Events {
		by := "system"
		if e.By != nil {
			by = e.By.String()
		}
		events = append(events, gen.OrderEvent{
			At:     e.At,
			By:     by,
			Note:   e.Note,
			Status: gen.OrderStatus(e.Status),
		})
	}

	return gen.OrderDetail{
		Id:              base.Id,
		No:              base.No,
		Status:          base.Status,
		MerchantId:      base.MerchantId,
		RiderId:         base.RiderId,
		Source:          (*gen.OrderDetailSource)(base.Source),
		Version:         base.Version,
		Totals:          base.Totals,
		CreatedAt:       base.CreatedAt,
		UpdatedAt:       base.UpdatedAt,
		Items:           &items,
		DeliveryAddress: toGenAddress(d.Order.DeliveryAddress),
		Events:          events,
	}
}

func toGenAddress(a *orders.AddressSnapshot) gen.AddressSnapshot {
	if a == nil {
		return gen.AddressSnapshot{}
	}
	return gen.AddressSnapshot{
		Label:        a.Label,
		Lines:        a.Lines,
		Landmark:     a.Landmark,
		Lat:          float64PtrTo32(a.Lat),
		Lon:          float64PtrTo32(a.Lon),
		ContactPhone: a.ContactPhone,
	}
}

func float64PtrTo32(f *float64) *float32 {
	if f == nil {
		return nil
	}
	v := float32(*f)
	return &v
}

func toOrderAddress(a *gen.AddressSnapshot) *orders.AddressSnapshot {
	if a == nil {
		return nil
	}
	return &orders.AddressSnapshot{
		Label:        a.Label,
		Lines:        a.Lines,
		Landmark:     a.Landmark,
		Lat:          float32PtrTo64(a.Lat),
		Lon:          float32PtrTo64(a.Lon),
		ContactPhone: a.ContactPhone,
	}
}

func float32PtrTo64(f *float32) *float64 {
	if f == nil {
		return nil
	}
	v := float64(*f)
	return &v
}

func toOptionalUUID(id *uuid.UUID) *openapi_types.UUID {
	if id == nil {
		return nil
	}
	v := newUUID(id.String())
	return &v
}
