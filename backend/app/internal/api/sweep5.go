package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	"github.com/hudumika/api-backend/internal/payouts"
	"github.com/hudumika/api-backend/internal/promotions"
	"github.com/hudumika/api-backend/internal/support"
)

// sweepActorID resolves the authenticated subject to their users row id with
// the same error envelopes as the orders surface.
func (s *Server) sweepActorID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return uuid.Nil, false
	}
	return actor, true
}

// GetWarehouse returns one warehouse (GET /warehouses/{warehouseId}).
func (s *Server) GetWarehouse(w http.ResponseWriter, r *http.Request, warehouseId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get warehouse failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).GetWarehouse(r.Context(), uuid.UUID(warehouseId))
	if errors.Is(err, logistics.ErrWarehouseNotFound) {
		writeError(w, http.StatusNotFound, "WAREHOUSE_NOT_FOUND", "Warehouse not found")
		return
	}
	if err != nil {
		s.logger.Error("get warehouse failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenWarehouse(row))
}

// UpdateWarehouse updates a warehouse's editable fields (PATCH
// /warehouses/{warehouseId}).
func (s *Server) UpdateWarehouse(w http.ResponseWriter, r *http.Request, warehouseId openapi_types.UUID) {
	var body gen.UpdateWarehouseJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if s.db == nil {
		s.logger.Error("update warehouse failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// The warehouses table stores name, city text and status only; the
	// contract's geo fields have no column and are intentionally ignored
	// rather than invented.
	status := "active"
	if body.Status != nil {
		status = string(*body.Status)
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE warehouses SET name = $2, status = $3, updated_at = now()
		 WHERE id = $1`,
		uuid.UUID(warehouseId), body.Name, status)
	if err != nil {
		s.logger.Error("update warehouse failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "WAREHOUSE_NOT_FOUND", "Warehouse not found")
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).GetWarehouse(r.Context(), uuid.UUID(warehouseId))
	if err != nil {
		s.logger.Error("reload warehouse failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenWarehouse(row))
}

// UpdateCarrier updates a carrier's name, mode, regions and status (PATCH
// /carriers/{carrierId}).
func (s *Server) UpdateCarrier(w http.ResponseWriter, r *http.Request, carrierId openapi_types.UUID) {
	var body gen.UpdateCarrierJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" || body.Modes == nil || len(body.Modes) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and modes are required")
		return
	}
	if s.db == nil {
		s.logger.Error("update carrier failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	mode := string(body.Modes[0])
	regions := []string{}
	if body.Regions != nil {
		regions = *body.Regions
	}
	status := "active"
	if body.Status != nil {
		status = string(*body.Status)
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE carriers SET name = $2, mode = $3, regions = $4, status = $5
		 WHERE id = $1`,
		uuid.UUID(carrierId), body.Name, mode, regions, status)
	if err != nil {
		s.logger.Error("update carrier failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "CARRIER_NOT_FOUND", "Carrier not found")
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).GetCarrier(r.Context(), uuid.UUID(carrierId))
	if err != nil {
		s.logger.Error("reload carrier failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenCarrier(row))
}

// GetConsignment returns one consignment (GET /linehaul/consignments/{id}).
func (s *Server) GetConsignment(w http.ResponseWriter, r *http.Request, consignmentId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get consignment failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).GetConsignment(r.Context(), uuid.UUID(consignmentId))
	if errors.Is(err, logistics.ErrWarehouseNotFound) {
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	}
	if err != nil {
		s.logger.Error("get consignment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenConsignment(row))
}

// GetDeliveryException returns one delivery exception (GET
// /delivery-exceptions/{exceptionId}).
func (s *Server) GetDeliveryException(w http.ResponseWriter, r *http.Request, exceptionId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get delivery exception failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).GetException(r.Context(), uuid.UUID(exceptionId))
	if errors.Is(err, logistics.ErrWarehouseNotFound) {
		writeError(w, http.StatusNotFound, "EXCEPTION_NOT_FOUND", "Delivery exception not found")
		return
	}
	if err != nil {
		s.logger.Error("get delivery exception failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenException(row))
}

// PutFacilityWhitelist replaces the fixed-rider whitelist of a facility
// (PUT /facilities/{facilityId}/whitelist, table facility_whitelists in
// 00050_sweep.sql). The replacement is transactional: the old list is
// removed and the new one inserted in the same statement.
func (s *Server) PutFacilityWhitelist(w http.ResponseWriter, r *http.Request, facilityId openapi_types.UUID) {
	var body gen.PutFacilityWhitelistJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		s.logger.Error("put facility whitelist failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := logistics.NewExtraStore(s.db.Pool()).GetFacility(r.Context(), uuid.UUID(facilityId)); err != nil {
		if !errors.Is(err, logistics.ErrFacilityNotFound) {
			s.logger.Error("facility lookup failed", "error", err)
		}
		writeError(w, http.StatusNotFound, "FACILITY_NOT_FOUND", "Facility not found")
		return
	}
	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("put facility whitelist begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM facility_whitelists WHERE facility_id = $1`, uuid.UUID(facilityId)); err != nil {
		s.logger.Error("put facility whitelist clear failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for _, riderID := range body.RiderIds {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO facility_whitelists (facility_id, rider_id) VALUES ($1, $2)
			 ON CONFLICT (facility_id, rider_id) DO NOTHING`,
			uuid.UUID(facilityId), uuid.UUID(riderID)); err != nil {
			s.logger.Error("put facility whitelist insert failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("put facility whitelist commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UpdateFleetAccount updates the fleet master account the session owns (or
// any account for staff), PATCH /fleet/accounts/{fleetAccountId}.
func (s *Server) UpdateFleetAccount(w http.ResponseWriter, r *http.Request, fleetAccountId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("update fleet account failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := scanFleetAccount(s.db.Pool().QueryRow(r.Context(),
		`SELECT `+fleetAccountColumns+` FROM fleet_accounts WHERE id = $1`, uuid.UUID(fleetAccountId)))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "FLEET_ACCOUNT_NOT_FOUND", "Fleet account not found")
		return
	}
	if err != nil {
		s.logger.Error("update fleet account lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !isStaffRole(claims.Role) {
		ownerID, ok := s.fleetOwnerID(w, r)
		if !ok {
			return
		}
		if row.ownerUserID != ownerID {
			writeError(w, http.StatusNotFound, "FLEET_ACCOUNT_NOT_FOUND", "Fleet account not found")
			return
		}
	}
	var body gen.UpdateFleetAccountJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" || body.Vehicles == nil || body.Status == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name, vehicles and status are required")
		return
	}
	vehicleCount := len(*body.Vehicles)
	status := string(body.Status)
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE fleet_accounts SET fleet_name = $2, vehicle_count = $3, status = $4, updated_at = now()
		 WHERE id = $1`,
		row.id, body.Name, vehicleCount, status); err != nil {
		s.logger.Error("update fleet account failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.fleetName = body.Name
	row.vehicleCount = vehicleCount
	row.status = status
	writeJSON(w, http.StatusOK, toFleetAccount(row))
}

// UpdateMerchantStaff updates a staff account of the caller's merchant
// (PATCH /merchants/me/staff/{staffId}).
func (s *Server) UpdateMerchantStaff(w http.ResponseWriter, r *http.Request, staffId openapi_types.UUID) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("update merchant staff failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var body gen.UpdateMerchantStaffJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" || body.Phone == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and phone are required")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE merchant_staff SET name = $3, role = $4, phone = $5
		 WHERE id = $1 AND merchant_id = $2`,
		uuid.UUID(staffId), merchantID, body.Name, string(body.Role), body.Phone)
	if err != nil {
		s.logger.Error("update merchant staff failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "STAFF_NOT_FOUND", "Staff account not found")
		return
	}
	status := gen.MerchantStaffStatusActive
	writeJSON(w, http.StatusOK, gen.MerchantStaff{
		Id:        newUUIDPtr(uuid.UUID(staffId)),
		Name:      body.Name,
		Phone:     body.Phone,
		Role:      body.Role,
		Status:    &status,
		CreatedAt: ptrTime(time.Now().UTC()),
	})
}

// DeleteMerchantStaff removes a staff account of the caller's merchant
// (DELETE /merchants/me/staff/{staffId}). Idempotent: an absent or foreign
// row answers 204.
func (s *Server) DeleteMerchantStaff(w http.ResponseWriter, r *http.Request, staffId openapi_types.UUID) {
	merchantID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("delete merchant staff failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM merchant_staff WHERE id = $1 AND merchant_id = $2`,
		uuid.UUID(staffId), merchantID); err != nil {
		s.logger.Error("delete merchant staff failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AdminAssignTicket assigns a support ticket to an agent (POST
// /admin/support/tickets/{ticketId}/assign).
func (s *Server) AdminAssignTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	var body gen.AdminAssignTicketJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		s.logger.Error("admin assign ticket failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := support.NewStore(s.db.Pool()).Assign(r.Context(), uuid.UUID(ticketId), uuid.UUID(body.AgentUserId)); err != nil {
		if errors.Is(err, support.ErrNotFound) {
			writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
			return
		}
		s.logger.Error("admin assign ticket failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ticket, err := support.NewStore(s.db.Pool()).Get(r.Context(), uuid.UUID(ticketId))
	if err != nil {
		s.logger.Error("admin assign ticket reload failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	updated := ticket.UpdatedAt
	writeJSON(w, http.StatusOK, gen.Ticket{
		Id:              newUUID(ticket.ID.String()),
		Subject:         ticket.Subject,
		Status:          gen.TicketStatus(ticket.Status),
		Priority:        gen.TicketPriority(ticket.Priority),
		AssignedAgentId: toOptionalUUID(ticket.AssignedAgentID),
		CreatedAt:       ticket.CreatedAt,
		UpdatedAt:       &updated,
	})
}

// AdminSetUserStatus suspends or reactivates a user account (POST
// /admin/users/{userId}/status, users.status column added in
// 00050_sweep.sql).
func (s *Server) AdminSetUserStatus(w http.ResponseWriter, r *http.Request, userId openapi_types.UUID) {
	var body gen.AdminSetUserStatusJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Status != "active" && body.Status != "suspended" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be active or suspended")
		return
	}
	if s.db == nil {
		s.logger.Error("admin set user status failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`,
		uuid.UUID(userId), string(body.Status))
	if err != nil {
		s.logger.Error("admin set user status failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "USER_NOT_FOUND", "User not found")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Id     openapi_types.UUID `json:"id"`
		Status string             `json:"status"`
	}{
		Id:     userId,
		Status: string(body.Status),
	})
}

// AdminPromotionDecision approves, rejects, or pauses a promotion (POST
// /admin/promotions/{promotionId}/decision). The promotion status is moved
// to the decision state; a reject records the reason for the merchant.
func (s *Server) AdminPromotionDecision(w http.ResponseWriter, r *http.Request, promotionId openapi_types.UUID) {
	var body gen.AdminPromotionDecisionJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		s.logger.Error("admin promotion decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	store := promotions.NewStore(s.db.Pool())
	row, err := store.GetPromotion(r.Context(), uuid.UUID(promotionId))
	if errors.Is(err, promotions.ErrNotFound) {
		writeError(w, http.StatusNotFound, "PROMOTION_NOT_FOUND", "Promotion not found")
		return
	}
	if err != nil {
		s.logger.Error("admin promotion decision lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var toStatus string
	switch body.Decision {
	case "approved":
		toStatus = "active"
	case "rejected":
		toStatus = "rejected"
	case "paused":
		toStatus = "paused"
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be approved, rejected or paused")
		return
	}
	reason := ""
	if body.Reason != nil {
		reason = *body.Reason
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE promotions SET status = $2, reject_reason = $3, updated_at = now() WHERE id = $1`,
		row.ID, toStatus, reason); err != nil {
		s.logger.Error("admin promotion decision failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	updated, err := store.GetPromotion(r.Context(), row.ID)
	if err != nil {
		s.logger.Error("admin promotion decision reload failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPromotion(*updated))
}

// AdminAssignBookingProvider manually assigns a provider to a booking
// (POST /admin/bookings/{bookingId}/assign-provider, a dispatch override).
// The change is recorded with an event; no notification pipeline exists.
func (s *Server) AdminAssignBookingProvider(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.AdminAssignBookingProviderJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.ProviderId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "providerId is required")
		return
	}
	if s.db == nil {
		s.logger.Error("admin assign booking provider failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE bookings SET provider_id = $2, updated_at = now() WHERE id = $1`,
		row.ID, uuid.UUID(body.ProviderId)); err != nil {
		s.logger.Error("admin assign booking provider failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO booking_events (booking_id, status, by, note) VALUES ($1, 'provider_reassigned', $2, $3)`,
		row.ID, actor, body.Reason); err != nil {
		s.logger.Error("admin assign booking provider event failed", "error", err)
	}
	row.ProviderID = uuid.UUID(body.ProviderId)
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// VerifyStorePaymentAccount marks a store payment account verified (POST
// /store/payment-accounts/{accountId}/verify, verified column added in
// 00050_sweep.sql). Verification is a staff/merchant action; the account
// number is masked in the response.
func (s *Server) VerifyStorePaymentAccount(w http.ResponseWriter, r *http.Request, accountId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("verify store payment account failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE payment_accounts SET verified = true WHERE id = $1`, uuid.UUID(accountId))
	if err != nil {
		s.logger.Error("verify store payment account failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "ACCOUNT_NOT_FOUND", "Payment account not found")
		return
	}
	var (
		label    string
		acctType string
		number   string
		isDef    bool
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT label, type, account_number, is_default FROM payment_accounts WHERE id = $1`,
		uuid.UUID(accountId)).Scan(&label, &acctType, &number, &isDef); err != nil {
		s.logger.Error("verify store payment account reload failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	verified := true
	isDefault := isDef
	writeJSON(w, http.StatusOK, gen.StorePaymentAccount{
		Id:            accountId,
		AccountMasked: maskAccountNumber(number),
		Provider:      label,
		Type:          gen.StorePaymentAccountType(acctType),
		IsDefault:     &isDefault,
		Verified:      &verified,
	})
}

// GetHourlyTrends answers the per-hour order/revenue trend for a date (GET
// /analytics/hourly-trends?date=) as one aggregate over the orders table.
func (s *Server) GetHourlyTrends(w http.ResponseWriter, r *http.Request, params gen.GetHourlyTrendsParams) {
	if params.Date.Time.IsZero() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "date is required")
		return
	}
	if s.db == nil {
		s.logger.Error("hourly trends failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	dayStart := params.Date.Time
	dayEnd := dayStart.Add(24 * time.Hour)
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
		        COALESCE(SUM(total_tzs), 0) AS revenue, COUNT(*) AS orders
		 FROM orders
		 WHERE created_at >= $1 AND created_at < $2
		 GROUP BY hour ORDER BY hour`,
		dayStart, dayEnd)
	if err != nil {
		s.logger.Error("hourly trends query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]struct {
		Hour       int `json:"hour"`
		RevenueTZS int `json:"revenueTZS"`
		OrderCount int `json:"orderCount"`
	}, 0, 24)
	for rows.Next() {
		var (
			hour    int
			revenue int64
			orders  int
		)
		if err := rows.Scan(&hour, &revenue, &orders); err != nil {
			s.logger.Error("hourly trends scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, struct {
			Hour       int `json:"hour"`
			RevenueTZS int `json:"revenueTZS"`
			OrderCount int `json:"orderCount"`
		}{Hour: hour, RevenueTZS: int(revenue), OrderCount: orders})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("hourly trends iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetCouponStats answers the claimed/used/conversion stats of a coupon
// campaign (GET /marketing/coupons/{couponId}/stats) as one aggregate over
// the coupons of the campaign.
func (s *Server) GetCouponStats(w http.ResponseWriter, r *http.Request, couponId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("coupon stats failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var claimed, used int
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COUNT(*) FILTER (WHERE claimed_at IS NOT NULL),
		        COUNT(*) FILTER (WHERE used_at IS NOT NULL)
		 FROM coupons WHERE campaign_id = $1`, uuid.UUID(couponId)).Scan(&claimed, &used); err != nil {
		s.logger.Error("coupon stats query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rate := float32(0)
	if claimed > 0 {
		rate = float32(used) / float32(claimed)
	}
	writeJSON(w, http.StatusOK, struct {
		CouponId       openapi_types.UUID `json:"couponId"`
		Claimed        int                `json:"claimed"`
		Used           int                `json:"used"`
		ConversionRate float32            `json:"conversionRate"`
	}{
		CouponId:       couponId,
		Claimed:        claimed,
		Used:           used,
		ConversionRate: rate,
	})
}

// GetRiderLeaderboard answers the rider leaderboard for a metric (GET
// /riders/me/leaderboard?metric=). Rating ranks riders by rating;
// deliveries ranks by delivered order count; the caller's own entry is
// reported when they are a rider.
func (s *Server) GetRiderLeaderboard(w http.ResponseWriter, r *http.Request, params gen.GetRiderLeaderboardParams) {
	if s.db == nil {
		s.logger.Error("rider leaderboard failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		query  string
		metric string
	)
	switch params.Metric {
	case "rating":
		metric = "rating"
		query = `SELECT r.name, COALESCE(r.rating, 0)::float4, r.id
		         FROM riders r ORDER BY r.rating DESC NULLS LAST, r.review_count DESC LIMIT 50`
	case "deliveries":
		metric = "deliveries"
		query = `SELECT r.name, COUNT(o.id)::float4, r.id
		         FROM riders r
		         LEFT JOIN orders o ON o.rider_id = r.id AND o.status IN ('delivered', 'completed')
		         GROUP BY r.id, r.name ORDER BY COUNT(o.id) DESC LIMIT 50`
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "metric must be rating or deliveries")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(), query)
	if err != nil {
		s.logger.Error("rider leaderboard query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	type entry struct {
		rank  int
		name  string
		value float32
		rider uuid.UUID
	}
	var entries []entry
	for rows.Next() {
		var (
			name  string
			value float32
			rider uuid.UUID
		)
		if err := rows.Scan(&name, &value, &rider); err != nil {
			s.logger.Error("rider leaderboard scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		entries = append(entries, entry{rank: len(entries) + 1, name: name, value: value, rider: rider})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("rider leaderboard iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := gen.Leaderboard{Metric: gen.LeaderboardMetric(metric), Period: "weekly"}
	out.Entries = make([]struct {
		Rank      int     `json:"rank"`
		RiderName string  `json:"riderName"`
		Value     float32 `json:"value"`
	}, 0, len(entries))
	for _, e := range entries {
		out.Entries = append(out.Entries, struct {
			Rank      int     `json:"rank"`
			RiderName string  `json:"riderName"`
			Value     float32 `json:"value"`
		}{Rank: e.rank, RiderName: e.name, Value: e.value})
	}
	claims, ok := ClaimsFromContext(r.Context())
	if ok && claims.Subject != "" {
		var riderID uuid.UUID
		if err := s.db.Pool().QueryRow(r.Context(),
			`SELECT id FROM riders WHERE owner_user_id = (SELECT id FROM users WHERE phone = $1)`,
			claims.Subject).Scan(&riderID); err == nil {
			for _, e := range entries {
				if e.rider == riderID {
					out.MyEntry.Rank = e.rank
					out.MyEntry.Value = e.value
					break
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteTrustedContact removes one of the caller's trusted contacts
// (DELETE /riders/me/contacts/{contactId}). Idempotent: an absent or
// foreign row answers 204.
func (s *Server) DeleteTrustedContact(w http.ResponseWriter, r *http.Request, contactId openapi_types.UUID) {
	actor, ok := s.sweepActorID(w, r)
	if !ok {
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM trusted_contacts WHERE id = $1 AND rider_id =
		   (SELECT id FROM riders WHERE owner_user_id = $2)`,
		uuid.UUID(contactId), actor); err != nil {
		s.logger.Error("delete trusted contact failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ApproveRefundRequest approves the caller's pending refund request (POST
// /refunds/{refundId}/approve). The decision is recorded on the row; the
// refund itself is a manual finance step outside this contract surface, so
// no money moves here.
func (s *Server) ApproveRefundRequest(w http.ResponseWriter, r *http.Request, refundId openapi_types.UUID) {
	actor, ok := s.sweepActorID(w, r)
	if !ok {
		return
	}
	var body gen.ApproveRefundRequestJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE refunds SET status = 'approved', decision_reason = $3, decision_by = $4, decided_at = now()
		 WHERE id = $1 AND customer_user_id = $2 AND status = 'pending'`,
		uuid.UUID(refundId), actor, body.Reason, actor)
	if err != nil {
		s.logger.Error("approve refund request failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "REFUND_NOT_APPROVABLE", "Refund request is not pending or not yours")
		return
	}
	s.sweepWriteRefund(w, r, uuid.UUID(refundId))
}

// RejectRefundRequest rejects the caller's pending refund request (POST
// /refunds/{refundId}/reject).
func (s *Server) RejectRefundRequest(w http.ResponseWriter, r *http.Request, refundId openapi_types.UUID) {
	actor, ok := s.sweepActorID(w, r)
	if !ok {
		return
	}
	var body gen.RejectRefundRequestJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE refunds SET status = 'rejected', decision_reason = $3, decision_by = $4, decided_at = now()
		 WHERE id = $1 AND customer_user_id = $2 AND status = 'pending'`,
		uuid.UUID(refundId), actor, body.Reason, actor)
	if err != nil {
		s.logger.Error("reject refund request failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "REFUND_NOT_REJECTABLE", "Refund request is not pending or not yours")
		return
	}
	s.sweepWriteRefund(w, r, uuid.UUID(refundId))
}

// AdminRefundDecision is the finance-side refund decision (POST
// /admin/refunds/{refundId}/decision). A approve decision may carry a
// partial amount; the row's status moves and the decision is recorded.
func (s *Server) AdminRefundDecision(w http.ResponseWriter, r *http.Request, refundId openapi_types.UUID) {
	actor, ok := s.sweepActorID(w, r)
	if !ok {
		return
	}
	var body gen.AdminRefundDecisionJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	toStatus := ""
	switch body.Decision {
	case "approve":
		toStatus = "approved"
	case "reject":
		toStatus = "rejected"
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be approve or reject")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE refunds SET status = $2, decision_reason = $3, decision_by = $4, decided_at = now()
		 WHERE id = $1 AND status = 'pending'`,
		uuid.UUID(refundId), toStatus, body.Reason, actor)
	if err != nil {
		s.logger.Error("admin refund decision failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "REFUND_NOT_DECIDABLE", "Refund request is not pending")
		return
	}
	s.sweepWriteRefund(w, r, uuid.UUID(refundId))
}

// sweepWriteRefund answers the refreshed refund row after a decision.
func (s *Server) sweepWriteRefund(w http.ResponseWriter, r *http.Request, refundID uuid.UUID) {
	var (
		orderID        uuid.UUID
		amountTZS      int64
		reason         string
		status         string
		decisionReason *string
		createdAt      time.Time
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT order_id, amount_tzs, reason, status, decision_reason, created_at
		 FROM refunds WHERE id = $1`, refundID).Scan(&orderID, &amountTZS, &reason, &status, &decisionReason, &createdAt); err != nil {
		s.logger.Error("refund reload failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, gen.RefundRequest{
		Id:             newUUID(refundID.String()),
		OrderId:        newUUID(orderID.String()),
		AmountTZS:      int(amountTZS),
		Reason:         reason,
		Status:         gen.RefundRequestStatus(status),
		DecisionReason: decisionReason,
		CreatedAt:      createdAt,
	})
}

// AdminAdjustWallet adjusts a wallet balance via the append-only ledger
// (POST /admin/wallets/{walletId}/adjust). The delta is a signed integer
// TZS movement appended as a ledger entry (PAYMENTS.md: the wallet is a
// projection of the ledger, never a second source of truth). The
// idempotency key scopes one adjustment per request id.
func (s *Server) AdminAdjustWallet(w http.ResponseWriter, r *http.Request, walletId openapi_types.UUID) {
	var body gen.AdminAdjustWalletJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.DeltaTZS == 0 || body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "deltaTZS must be non-zero and reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("admin adjust wallet failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	_, err = payouts.NewStore(s.db.Pool()).AppendEntry(r.Context(), payouts.LedgerEntryInput{
		AccountOwnerID: uuid.UUID(walletId),
		AccountType:    "wallet",
		Type:           "manual_adjustment",
		AmountTZS:      int64(body.DeltaTZS),
		ReferenceType:  "wallet",
		ReferenceID:    uuid.UUID(walletId),
		IdempotencyKey: "wallet_adjust:" + chiReqID(r) + ":" + uuid.UUID(walletId).String(),
	})
	if err != nil {
		s.logger.Error("admin adjust wallet failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.logger.Info("wallet adjusted", "walletId", walletId, "deltaTZS", body.DeltaTZS, "actor", actor, "reason", body.Reason)
	w.WriteHeader(http.StatusNoContent)
}

// chiReqID returns the request id middleware value or a fresh id.
func chiReqID(r *http.Request) string {
	if id := middleware.GetReqID(r.Context()); id != "" {
		return id
	}
	return newRequestID()
}
