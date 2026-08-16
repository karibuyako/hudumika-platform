package api

// ORDER-ROUTE / SCHEDULED-ADVANCE / SHIPMENT-REASSIGN surface (migration
// 00053_order_route.sql):
//   GET  /orders/{orderId}/route               getOrderRoute
//   POST /orders/me/advance                    AdvanceScheduledOrder (see
//                                              the deviating signature note
//                                              below)
//   POST /admin/shipments/{shipmentId}/reassign adminReassignShipment
//
// AdvanceScheduledOrder is NOT part of the generated interface: the contract
// defines only GET /orders/me/advance (listAdvanceOrders) for that path, so
// there is no generated handler to implement (deviation, documented). The
// customer-facing "advance my scheduled order" mutation is therefore exposed
// as a plain *Server method that any future route wiring (or a contract
// regeneration that adds the POST) can attach as-is.

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// customerAdvanceFrom is the from-set the CUSTOMER may advance a scheduled
// (advance/pre-order) order out of. Pre-orders are paid up front and the
// merchant accepts them like any other order; once the merchant starts
// preparing the order the customer's confirmation window is closed, so the
// customer can only confirm the scheduled delivery while it is still in
// (paid, merchant_accepted). The single legal target is 'preparing'
// (customerScheduledTarget).
var customerAdvanceFrom = []string{"paid", "merchant_accepted"}

const customerScheduledTarget = "preparing"

// orderRouteLegRow is one order_route_legs row joined onto its trip leg
// (one batched query, no N+1) with the hub names resolved for
// traceability.
type orderRouteLegRow struct {
	LegID       uuid.UUID
	Sequence    int
	Mode        string
	Status      string
	CompletedAt *time.Time
	FromHubID   *uuid.UUID
	ToHubID     *uuid.UUID
	FromHubName string
	ToHubName   string
}

// asTripLeg adapts the row onto logistics.TripLegRow so the shared
// toGenRouteSegment mapper (logistics_ops.go) can render the contract
// RouteSegment (type/mode/status/hub-id vocabulary).
func (l orderRouteLegRow) asTripLeg() logistics.TripLegRow {
	var fromHub, toHub uuid.UUID
	if l.FromHubID != nil {
		fromHub = *l.FromHubID
	}
	if l.ToHubID != nil {
		toHub = *l.ToHubID
	}
	return logistics.TripLegRow{
		ID:          l.LegID,
		Sequence:    l.Sequence,
		Mode:        l.Mode,
		Status:      l.Status,
		FromHubID:   fromHub,
		ToHubID:     toHub,
		CompletedAt: l.CompletedAt,
	}
}

// GetOrderRoute returns the multi-leg journey of an order (GET
// /orders/{orderId}/route, contract RouteSegment[], 200). Parties only, like
// GetOrder: the owning customer, any merchant or staff session; everyone else
// — including a non-party hitting a missing order — sees the same 404
// ORDER_NOT_FOUND. The segments mirror order_route_legs (the per-order leg
// status) joined onto trip_legs for the hub ids, in sequence order. An order
// without route legs answers the contract's empty shape: []. Deviation note:
// the contract RouteSegment carries only hub ids, so the joined hub names are
// resolved but not emitted.
func (s *Server) GetOrderRoute(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
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
		s.logger.Error("get order route failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := orders.NewStore(s.db.Pool()).GetOrderRow(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("get order route failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.orderPartyOrStaff(claims, userID, row) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	legs, err := s.orderRouteLegs(r, uuid.UUID(orderId))
	if err != nil {
		s.logger.Error("get order route failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	segments := make([]gen.RouteSegment, 0, len(legs))
	for _, l := range legs {
		segments = append(segments, toGenRouteSegment(l.asTripLeg()))
	}
	writeJSON(w, http.StatusOK, segments)
}

// orderRouteLegs loads the order's route legs ordered by sequence in one
// batched query: order_route_legs joined onto trip_legs (for the hub ids)
// and the hubs themselves (for the names).
func (s *Server) orderRouteLegs(r *http.Request, orderID uuid.UUID) ([]orderRouteLegRow, error) {
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT orl.leg_id, orl.sequence, orl.mode, orl.status, orl.completed_at,
		        tl.from_hub_id, tl.to_hub_id, COALESCE(fh.name, ''), COALESCE(th.name, '')
		 FROM order_route_legs orl
		 LEFT JOIN trip_legs tl ON tl.id = orl.leg_id
		 LEFT JOIN hubs fh ON fh.id = tl.from_hub_id
		 LEFT JOIN hubs th ON th.id = tl.to_hub_id
		 WHERE orl.order_id = $1
		 ORDER BY orl.sequence, orl.id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]orderRouteLegRow, 0, 8)
	for rows.Next() {
		var l orderRouteLegRow
		if err := rows.Scan(&l.LegID, &l.Sequence, &l.Mode, &l.Status, &l.CompletedAt,
			&l.FromHubID, &l.ToHubID, &l.FromHubName, &l.ToHubName); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// advanceScheduledOrderBody is the mutation body of AdvanceScheduledOrder
// (orderId + status). The contract defines no POST body for /orders/me/advance
// at this milestone (deviation, documented with the handler).
type advanceScheduledOrderBody struct {
	OrderId openapi_types.UUID `json:"orderId"`
	Status  gen.OrderStatus    `json:"status"`
}

// AdvanceScheduledOrder lets the owning CUSTOMER confirm/advance a scheduled
// (advance/pre-order) delivery: an order booked with scheduledAt moves from
// paid or merchant_accepted into preparing once the customer activates it
// (POST /orders/me/advance, contract Order, 200). Guards:
//   - the order must belong to the session user — non-owners see the same
//     404 ORDER_NOT_FOUND as a missing order (existence never leaks);
//   - an order without scheduled_at is not a pre-order: 409 PREORDERS_DISABLED;
//   - a scheduled order past the confirmation window (already preparing or
//     beyond) is 409 ORDER_MODIFICATION_NOT_ALLOWED;
//   - a racing version/status change between the read and the guarded
//     transition is 409 ORDER_STATUS_CONFLICT.
func (s *Server) AdvanceScheduledOrder(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only customers can advance a scheduled order")
		return
	}
	var body advanceScheduledOrderBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if uuid.UUID(body.OrderId) == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId is required")
		return
	}
	if body.Status != gen.OrderStatus(customerScheduledTarget) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"status must be "+customerScheduledTarget+" for a scheduled order")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("advance scheduled order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	id := uuid.UUID(body.OrderId)
	var (
		status      string
		version     int
		scheduledAt *time.Time
		owner       uuid.UUID
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT status, version, scheduled_at, customer_user_id FROM orders WHERE id = $1`, id).
		Scan(&status, &version, &scheduledAt, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("advance scheduled order lookup failed", "order", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if owner != actor {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if scheduledAt == nil {
		writeError(w, http.StatusConflict, "PREORDERS_DISABLED", "This order is not a scheduled order")
		return
	}
	if !isScheduledAdvanceable(status) {
		writeError(w, http.StatusConflict, "ORDER_MODIFICATION_NOT_ALLOWED",
			"A scheduled order can only be advanced before preparation begins")
		return
	}
	st := orders.NewStore(s.db.Pool())
	newVersion, err := st.TransitionOrder(r.Context(), id, version, []string{status}, customerScheduledTarget, actor,
		"customer advanced scheduled order")
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order status changed; refetch and retry")
		return
	}
	if err != nil {
		s.logger.Error("advance scheduled order failed", "order", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := st.GetOrderRow(r.Context(), id)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("reload advanced order failed", "order", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = customerScheduledTarget
	row.Version = newVersion
	out := toGenOrder(*row)
	out.ScheduledAt = scheduledAt
	writeJSON(w, http.StatusOK, out)
}

// isScheduledAdvanceable reports whether the order is still inside the
// customer's scheduled-order confirmation window (paid, merchant_accepted).
func isScheduledAdvanceable(status string) bool {
	for _, from := range customerAdvanceFrom {
		if status == from {
			return true
		}
	}
	return false
}

// AdminReassignShipment lets a dispatcher move a shipment onto another trip
// (POST /admin/shipments/{shipmentId}/reassign, contract Shipment, 200). The
// generated body carries tripId (and riderId) — there is no vehicleId field,
// so the shipment's vehicle follows from the target trip (deviation from the
// task brief, which anticipated a vehicle id; documented). Guards:
//   - staff session only (the /admin/ route policy already gates this, and
//     the handler re-checks like the other admin shipment endpoints);
//   - reason is required and tripId is the supported target (rider-only
//     reassignment is not supported at this milestone: the shipments table
//     has no rider column);
//   - missing shipment 404 SHIPMENT_NOT_FOUND;
//   - only pending/at_hub shipments are reassignable (a shipment on the
//     road, delivered, frozen or in exception is 409 SHIPMENT_NOT_REASSIGNABLE);
//   - missing trip 404 TRIP_NOT_FOUND; a closed trip (completed/cancelled)
//     cannot take a reassignment 409 TRIP_ALREADY_ACTIVE;
//   - the target trip's vehicle must exist (404 VEHICLE_NOT_FOUND) and must
//     not already be riding another active trip (409 TRIP_ALREADY_ACTIVE).
//
// The guarded UPDATE and the 'reassigned' ledger event land in one
// transaction.
func (s *Server) AdminReassignShipment(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only staff sessions may reassign shipments")
		return
	}
	var body gen.AdminReassignShipmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if body.TripId == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"tripId is required — rider-only reassignment is not supported at this milestone")
		return
	}
	if s.db == nil {
		s.logger.Error("admin reassign shipment failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	reason := strings.TrimSpace(body.Reason)
	actor := s.resolvedActorID(r)
	tripID := uuid.UUID(*body.TripId)
	shipmentID := uuid.UUID(shipmentId)

	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("admin reassign begin failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM shipments WHERE id = $1 FOR UPDATE`, shipmentID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
		return
	}
	if err != nil {
		s.logger.Error("admin reassign shipment lookup failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if status != logistics.StatusPending && status != logistics.StatusAtHub {
		writeError(w, http.StatusConflict, "SHIPMENT_NOT_REASSIGNABLE",
			"Only pending or at-hub shipments can be reassigned")
		return
	}

	var (
		tripStatus string
		vehicleID  uuid.UUID
	)
	err = tx.QueryRow(ctx,
		`SELECT status, vehicle_id FROM trips WHERE id = $1`, tripID).Scan(&tripStatus, &vehicleID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Trip not found")
		return
	}
	if err != nil {
		s.logger.Error("admin reassign trip lookup failed", "trip", tripID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tripStatus != logistics.TripStatusPlanned && tripStatus != logistics.TripStatusInProgress {
		writeError(w, http.StatusConflict, "TRIP_ALREADY_ACTIVE", "Target trip is closed and cannot take a reassignment")
		return
	}

	var vehicleExists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM vehicles WHERE id = $1)`, vehicleID).Scan(&vehicleExists); err != nil {
		s.logger.Error("admin reassign vehicle lookup failed", "vehicle", vehicleID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !vehicleExists {
		writeError(w, http.StatusNotFound, "VEHICLE_NOT_FOUND", "Vehicle not found")
		return
	}
	var busy bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM trips
		 WHERE vehicle_id = $1 AND id <> $2 AND status IN ($3, $4))`,
		vehicleID, tripID, logistics.TripStatusPlanned, logistics.TripStatusInProgress).Scan(&busy); err != nil {
		s.logger.Error("admin reassign vehicle busy check failed", "vehicle", vehicleID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if busy {
		writeError(w, http.StatusConflict, "TRIP_ALREADY_ACTIVE", "The target vehicle is already on another active trip")
		return
	}

	tag, err := tx.Exec(ctx,
		`UPDATE shipments SET trip_id = $1, vehicle_id = $2, updated_at = now()
		 WHERE id = $3 AND status IN ($4, $5)`,
		tripID, vehicleID, shipmentID, logistics.StatusPending, logistics.StatusAtHub)
	if err != nil {
		s.logger.Error("admin reassign update failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "SHIPMENT_NOT_REASSIGNABLE",
			"Shipment moved while reassigning — refetch and retry")
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note, vehicle_id)
		 VALUES ($1, 'reassigned', $2, $3, $4)`,
		shipmentID, actor, reason, vehicleID); err != nil {
		s.logger.Error("admin reassign event failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("admin reassign commit failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	detail, err := logistics.NewStore(s.db.Pool()).GetShipmentDetail(ctx, shipmentID)
	if err != nil {
		s.logger.Error("admin reassign reload failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenShipment(detail.Shipment, detail.Packages))
}
