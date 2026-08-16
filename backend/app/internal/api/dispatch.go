package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	"github.com/hudumika/api-backend/internal/riders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// dispatchAssignableStatuses are the order statuses a dispatcher may bind a
// rider to via manual override. Drafts and orders already in fulfillment
// (rider_assigned and beyond) are out of scope for a manual assignment.
var dispatchAssignableStatuses = []string{
	"pending_payment", "paid", "merchant_accepted", "preparing",
}

// dispatchRiderListStatuses is the status window shown in the rider's
// assigned-orders view: bound but not yet handed off as delivered.
var dispatchRiderListStatuses = []string{
	"paid", "merchant_accepted", "preparing", "rider_assigned",
	"picked_up", "delivering",
}

// assignedOrderView is one item of the GET /riders/assigned response: the
// rider's own identity plus one order currently bound to them.
type assignedOrderView struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	OrderId string `json:"orderId"`
	Status  string `json:"status"`
}

// AdminAssignOrderToRider is the dispatcher manual override (POST
// /admin/orders/{orderId}/assign-rider). routePolicy has already admitted an
// MFA-verified staff session; this handler verifies the order is in an
// assignable status, that the target rider exists and is online, then binds
// rider, assignment log and event in one transaction.
func (s *Server) AdminAssignOrderToRider(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.AdminAssignOrderToRiderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	riderID := uuid.UUID(body.RiderId)
	if riderID == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "riderId is required")
		return
	}
	if s.db == nil {
		s.logger.Error("assign rider failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}
	orderID := uuid.UUID(orderId)

	st := orders.NewStore(s.db.Pool())
	detail, err := st.GetOrderDetail(r.Context(), orderID)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("assign rider: order lookup failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := detail.Order
	if !containsStatus(dispatchAssignableStatuses, row.Status) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot be assigned to a rider in its current status")
		return
	}

	riderRow, err := riders.NewStore(s.db.Pool()).GetRider(r.Context(), riderID)
	if err != nil {
		s.logger.Error("assign rider: rider lookup failed", "riderId", riderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if riderRow == nil {
		writeError(w, http.StatusNotFound, "DISPATCH_NO_RIDER", "Rider not found")
		return
	}

	// The Redis online set is authoritative for dispatch availability; when
	// Redis is absent (dev) or the check fails, degrade to the durable flag.
	online := riderRow.Online
	if reg := s.riderRegistry(); reg != nil {
		online, err = reg.IsOnline(r.Context(), riderRow.ID)
		if err != nil {
			s.logger.Warn("assign rider: online check failed; using DB flag", "riderId", riderRow.ID, "error", err)
			online = riderRow.Online
		}
	}
	if !online {
		writeError(w, http.StatusConflict, "ASSIGN_RIDER_UNAVAILABLE", "Rider is offline or unavailable")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("assign rider: begin tx failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	tag, err := tx.Exec(r.Context(),
		`UPDATE orders SET rider_id = $1, updated_at = now()
		 WHERE id = $2 AND status = ANY($3)`,
		riderID, orderID, dispatchAssignableStatuses)
	if err != nil {
		s.logger.Error("assign rider: order update failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot be assigned to a rider in its current status")
		return
	}

	reason := body.Reason
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO order_assignments (order_id, rider_id, assigned_by, reason)
		 VALUES ($1, $2, $3, $4)`,
		orderID, riderID, user.ID, reason); err != nil {
		s.logger.Error("assign rider: assignment log failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, $2, $3, $4)`,
		orderID, row.Status, user.ID, "rider assigned"); err != nil {
		s.logger.Error("assign rider: event insert failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("assign rider: commit failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	updated, err := st.GetOrderRow(r.Context(), orderID)
	if err != nil {
		s.logger.Error("assign rider: reload order failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	assignedRider := uuid.Nil
	if updated.RiderID != nil {
		assignedRider = *updated.RiderID
	}
	publishDomainEvent(r.Context(), s, "order.assigned", map[string]any{
		"orderId": updated.ID.String(), "status": updated.Status, "riderId": assignedRider.String(),
	})
	writeJSON(w, http.StatusOK, toGenOrder(*updated))
}

// AdvanceMyOrder moves the caller rider's in-flight order one step along the
// delivery chain (POST /orders/me/advance). The rider does not name the
// order: the newest order bound to them in picked_up/delivering is advanced
// to its single legal next status (picked_up → delivering → delivered), so a
// rider can only ever push their current delivery forward. The requested
// status must be that next step, else 409 ORDER_STATUS_CONFLICT.
func (s *Server) AdvanceMyOrder(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleRider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only riders can advance their delivery")
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
		s.logger.Error("advance my order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	riderRow, err := riders.NewStore(s.db.Pool()).GetByOwner(r.Context(), actor)
	if err != nil {
		s.logger.Error("advance my order: rider lookup failed", "user", actor, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if riderRow == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No rider profile for this account")
		return
	}

	var (
		orderID uuid.UUID
		status  string
		version int
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, status, version FROM orders
		 WHERE rider_id = $1 AND status IN ('picked_up', 'delivering')
		 ORDER BY created_at DESC LIMIT 1`,
		riderRow.ID).Scan(&orderID, &status, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "No in-flight order for this rider")
		return
	}
	if err != nil {
		s.logger.Error("advance my order: in-flight lookup failed", "riderId", riderRow.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	next, ok := riderAdvance[status]
	if !ok || next != target {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot move to the requested status")
		return
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	version, err = orders.NewStore(s.db.Pool()).TransitionOrder(r.Context(), orderID, version, []string{status}, target, actor, note)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_STATUS_CONFLICT", "Order cannot move to the requested status")
		return
	}
	if err != nil {
		s.logger.Error("advance my order failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := orders.NewStore(s.db.Pool()).GetOrderRow(r.Context(), orderID)
	if err != nil {
		s.logger.Error("advance my order: reload failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	publishOrderEvent(r.Context(), s, row.ID.String(), row.CustomerUserID.String(), row.Status, nil)
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// MarkOrderSeen dismisses the new-order badge (POST /orders/{orderId}/seen).
// Either the bound merchant or the bound rider may dismiss it; the update is
// idempotent so a missing order still answers 204.
func (s *Server) MarkOrderSeen(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleRider && claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only riders or merchants can mark an order as seen")
		return
	}
	if s.db == nil {
		s.logger.Error("mark order seen failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE orders SET seen = true WHERE id = $1`, uuid.UUID(orderId)); err != nil {
		s.logger.Error("mark order seen failed", "orderId", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListAssignedRiders returns the caller rider's currently bound orders (GET
// /riders/assigned), newest first, limited to 50. Orders already handed off
// as delivered are not part of the dispatch view.
func (s *Server) ListAssignedRiders(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleRider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only riders can list their assigned orders")
		return
	}
	if s.db == nil {
		// No database (dev, unit tests): honestly no assignments exist.
		writeJSON(w, http.StatusOK, make([]assignedOrderView, 0))
		return
	}
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}
	riderRow, err := riders.NewStore(s.db.Pool()).GetByOwner(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("assigned orders: rider lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if riderRow == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No rider profile for this account")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, status FROM orders
		 WHERE rider_id = $1 AND status = ANY($2)
		 ORDER BY created_at DESC LIMIT 50`,
		riderRow.ID, dispatchRiderListStatuses)
	if err != nil {
		s.logger.Error("assigned orders: query failed", "riderId", riderRow.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]assignedOrderView, 0, 8)
	for rows.Next() {
		var (
			orderID uuid.UUID
			status  string
		)
		if err := rows.Scan(&orderID, &status); err != nil {
			s.logger.Error("assigned orders: scan failed", "riderId", riderRow.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, assignedOrderView{
			Id:      riderRow.ID.String(),
			Name:    riderRow.Name,
			OrderId: orderID.String(),
			Status:  toAssignedStatus(status),
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("assigned orders: iterate failed", "riderId", riderRow.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// toAssignedStatus maps the stored order status onto the contract enum for
// /riders/assigned: pre-fulfillment statuses are "assigned", delivery
// statuses keep their names.
func toAssignedStatus(status string) string {
	switch status {
	case "picked_up", "delivering":
		return status
	default:
		return "assigned"
	}
}

// containsStatus reports whether want is one of the statuses.
func containsStatus(statuses []string, want string) bool {
	for _, s := range statuses {
		if s == want {
			return true
		}
	}
	return false
}
