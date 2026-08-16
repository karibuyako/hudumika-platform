package api

// CONSIGNMENT OPS (API-CONTRACT.yaml
// /linehaul/consignments/{consignmentId}/reconcile and .../replan,
// ERROR-CODES.md): the reconcile endpoint compares the scanned order set
// against the consignment manifest while sealed/departed and returns the
// ReconciliationResult (409 CONSIGNMENT_ORDER_MISMATCH / 409
// CONSIGNMENT_MISSING_ORDERS carrying the missing ids); the replan endpoint
// moves an assembling/sealed consignment onto an alternate trip's corridor
// (409 CONSIGNMENT_ALREADY_DEPARTED beyond that, 404 TRIP_NOT_FOUND, 404
// ROUTE_NOT_FOUND, 409 CARRIER_UNAVAILABLE, 404 VEHICLE_NOT_FOUND) and
// returns the updated consignment.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// missingOrdersErrorBody is the CONSIGNMENT_MISSING_ORDERS 409 payload: the
// standard error envelope plus the manifest ids that were not scanned (the
// contract's Conflict response has no missingOrderIds slot, so the ids ride
// on the error body).
type missingOrdersErrorBody struct {
	gen.ErrorResponse
	MissingOrderIds []openapi_types.UUID `json:"missingOrderIds"`
}

// ReconcileConsignment compares the scanned order set against the consignment
// manifest (POST /linehaul/consignments/{consignmentId}/reconcile). A full
// match stamps reconciled_at, appends a consignment_reconciliations row and
// returns the ReconciliationResult (matched); a scan with orders outside the
// manifest is 409 CONSIGNMENT_ORDER_MISMATCH and a short scan is 409
// CONSIGNMENT_MISSING_ORDERS with the missing ids. Consignments that are not
// sealed/departed (assembling, arrived) are 409 CONSIGNMENT_ALREADY_DEPARTED.
func (s *Server) ReconcileConsignment(w http.ResponseWriter, r *http.Request, consignmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.ReconcileConsignmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.ScannedOrderIds == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "scannedOrderIds is required")
		return
	}
	scanned := make([]uuid.UUID, 0, len(body.ScannedOrderIds))
	for _, id := range body.ScannedOrderIds {
		scanned = append(scanned, uuid.UUID(id))
	}
	st := logistics.NewExtraStore(s.db.Pool())
	id := uuid.UUID(consignmentId)
	matched, _, err := st.Reconcile(r.Context(), id, scanned)
	switch {
	case errors.Is(err, logistics.ErrConsignmentNotFound):
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	case errors.Is(err, logistics.ErrConsignmentAlreadyDeparted):
		writeError(w, http.StatusConflict, "CONSIGNMENT_ALREADY_DEPARTED", "Consignment is not sealed or has already arrived")
		return
	case errors.Is(err, logistics.ErrOrderMismatch):
		writeError(w, http.StatusConflict, "CONSIGNMENT_ORDER_MISMATCH", "Scan contains orders not in the manifest")
		return
	case errors.Is(err, logistics.ErrMissingOrders):
		var moe *logistics.MissingOrdersError
		errors.As(err, &moe)
		missingIDs := make([]openapi_types.UUID, 0, len(moe.Missing))
		for _, id := range moe.Missing {
			missingIDs = append(missingIDs, newUUID(id.String()))
		}
		writeJSON(w, http.StatusConflict, missingOrdersErrorBody{
			ErrorResponse: gen.ErrorResponse{
				Code:      "CONSIGNMENT_MISSING_ORDERS",
				Message:   "Scan is missing orders from the manifest",
				RequestId: newUUID(newRequestID()),
			},
			MissingOrderIds: missingIDs,
		})
		return
	case err != nil:
		s.logger.Error("reconcile consignment failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.logger.Info("consignment reconciled", "consignment", consignmentId, "matched", matched)
	writeJSON(w, http.StatusOK, gen.ReconciliationResult{
		ConsignmentId: consignmentId,
		Expected:      matched,
		Scanned:       matched,
		Status:        gen.ReconciliationResultStatusMatched,
	})
}

// ReplanConsignment moves an assembling/sealed consignment onto an alternate
// trip's corridor or validates an alternate vehicle (POST
// /linehaul/consignments/{consignmentId}/replan). The trip must exist (404
// TRIP_NOT_FOUND), its corridor must be a configured active route (404
// ROUTE_NOT_FOUND) served by an active carrier (409 CARRIER_UNAVAILABLE) and
// a bare alternateVehicleId must exist (404 VEHICLE_NOT_FOUND). A consignment
// that already departed is 409 CONSIGNMENT_ALREADY_DEPARTED; the alternate
// vehicle is validated but not persisted (no store column at this milestone).
func (s *Server) ReplanConsignment(w http.ResponseWriter, r *http.Request, consignmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.ReplanConsignmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if len(body.Reason) > 500 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason must be at most 500 characters")
		return
	}
	if body.AlternateTripId == nil && body.AlternateVehicleId == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "alternateTripId or alternateVehicleId is required")
		return
	}
	in := logistics.ReplanInput{Reason: strings.TrimSpace(body.Reason)}
	if body.AlternateTripId != nil {
		id := uuid.UUID(*body.AlternateTripId)
		in.AlternateTripID = &id
	}
	if body.AlternateVehicleId != nil {
		id := uuid.UUID(*body.AlternateVehicleId)
		in.AlternateVehicleID = &id
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).Replan(r.Context(), uuid.UUID(consignmentId), in)
	switch {
	case errors.Is(err, logistics.ErrConsignmentNotFound):
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	case errors.Is(err, logistics.ErrConsignmentAlreadyDeparted):
		writeError(w, http.StatusConflict, "CONSIGNMENT_ALREADY_DEPARTED", "Consignment is not assembling or sealed")
		return
	case errors.Is(err, logistics.ErrTripNotFound):
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Alternate trip not found")
		return
	case errors.Is(err, logistics.ErrRouteNotFound):
		writeError(w, http.StatusNotFound, "ROUTE_NOT_FOUND", "No route is configured for the alternate trip corridor")
		return
	case errors.Is(err, logistics.ErrCarrierUnavailable):
		writeError(w, http.StatusConflict, "CARRIER_UNAVAILABLE", "No active carrier serves the alternate lane")
		return
	case errors.Is(err, logistics.ErrVehicleNotFound):
		writeError(w, http.StatusNotFound, "VEHICLE_NOT_FOUND", "Alternate vehicle not found")
		return
	case err != nil:
		s.logger.Error("replan consignment failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.logger.Info("consignment replanned", "consignment", consignmentId, "reason", in.Reason)
	writeJSON(w, http.StatusOK, toGenConsignment(row))
}
