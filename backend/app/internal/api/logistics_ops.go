package api

// LOGISTICS-OPS bounded context (backend/LOGISTICS-OS.md,
// backend/INTERCITY-LOGISTICS.md): trips (one vehicle departure over a route
// origin hub -> destination hub), trip legs, handoffs (custody transfer with
// seal verification) and the waybill/tracking trail.
//
// Contract paths (API-CONTRACT.yaml):
//   GET  /trips                        listTrips
//   POST /trips                        createTrip
//   GET  /trips/{tripId}               getLogisticsTrip
//   PATCH /trips/{tripId}              advanceTrip
//   POST /orders/{orderId}/handoff     recordHandoff
//   POST /orders/{orderId}/legs/{legId}/advance  advanceRouteLeg
//   GET  /orders/{orderId}/waybill     getOrderWaybill
//   GET  /orders/{orderId}/tracking-phases       getOrderTrackingPhases
//
// The contract has no trip-scoped legs/handoff paths: those endpoints are
// order-scoped, so the handlers map the order's shipment onto the trip lane
// (legs are stored per trip; a shipment travels on the trip of its vehicle).
// The contract trip statuses (loading/in_transit/unloading) map onto the
// stored vocabulary (planned/in_progress) via tripStatusToDB.
//
// Security: same role-neutral bearerAuth policy as the core logistics lane
// (logisticsReady) — hub workers, riders, dispatchers and staff all drive
// the physical lane; the audit middleware covers the mutations.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Trip list pagination bounds (the contract exposes no limit parameter).
const defaultTripListLimit = 20

// tripAdvanceActions is the contract action vocabulary for PATCH /trips/{id}.
var tripAdvanceActions = map[gen.AdvanceTripJSONBodyAction]struct{}{
	gen.AdvanceTripJSONBodyActionStartLoading:   {},
	gen.AdvanceTripJSONBodyActionDepart:         {},
	gen.AdvanceTripJSONBodyActionArrive:         {},
	gen.AdvanceTripJSONBodyActionStartUnloading: {},
	gen.AdvanceTripJSONBodyActionComplete:       {},
}

// errRouteUnresolved marks a route that no consignment shipment resolves.
var errRouteUnresolved = errors.New("route not resolved from consignments")

// ---- trips ----

// ListTrips returns the transport trips, newest first (GET /trips). The
// contract status filter maps onto the stored vocabulary; the list is
// cursor-paginated by trip id with the X-Next-Cursor header.
func (s *Server) ListTrips(w http.ResponseWriter, r *http.Request, params gen.ListTripsParams) {
	if !s.logisticsReady(w, r) {
		return
	}
	status := ""
	if params.Status != nil {
		status = tripStatusToDB(string(*params.Status))
		if status == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
	}
	cursor := r.URL.Query().Get("cursor")
	cursorID, err := tripCursor(cursor)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	trips, err := logistics.NewOpsStore(s.db.Pool()).ListTrips(r.Context(), status, defaultTripListLimit, cursorID)
	if err != nil {
		s.logger.Error("list trips failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.LogisticsTrip, 0, len(trips))
	for _, t := range trips {
		out = append(out, toGenTrip(t))
	}
	if len(trips) == defaultTripListLimit {
		w.Header().Set("X-Next-Cursor", trips[len(trips)-1].ID.String())
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateTrip builds a trip from a vehicle + route (POST /trips, 201). The
// contract's routeId identifies the route; the origin/destination hubs are
// resolved from the consignments' shipments (the route is the shipment's
// origin -> destination corridor; no standalone routes table exists at this
// milestone). The vehicle must not already be on an active trip
// (TRIP_ALREADY_ACTIVE 409).
func (s *Server) CreateTrip(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateTripJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if uuid.UUID(body.VehicleId) == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "vehicleId is required")
		return
	}
	if uuid.UUID(body.RouteId) == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "routeId is required")
		return
	}
	if len(body.ConsignmentIds) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "consignmentIds is required")
		return
	}
	originHub, destHub, err := s.routeHubs(r, body.ConsignmentIds)
	if err != nil {
		if errors.Is(err, errRouteUnresolved) {
			writeError(w, http.StatusNotFound, "ROUTE_NOT_FOUND", "Route not configured — no shipment resolves the consignment corridor")
			return
		}
		s.logger.Error("route hub resolution failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	trip, err := logistics.NewOpsStore(s.db.Pool()).CreateTrip(
		r.Context(), uuid.UUID(body.VehicleId), originHub, destHub, body.ScheduledDeparture)
	switch {
	case errors.Is(err, logistics.ErrVehicleNotFound):
		writeError(w, http.StatusNotFound, "VEHICLE_NOT_FOUND", "Vehicle not found")
		return
	case errors.Is(err, logistics.ErrHubNotFound):
		writeError(w, http.StatusNotFound, "HUB_NOT_FOUND", "Hub not found")
		return
	case errors.Is(err, logistics.ErrTripAlreadyActive):
		writeError(w, http.StatusConflict, "TRIP_ALREADY_ACTIVE", "Vehicle is already on an active trip")
		return
	case err != nil:
		s.logger.Error("create trip failed", "vehicle", body.VehicleId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenTrip(trip))
}

// GetLogisticsTrip returns the trip detail (GET /trips/{tripId}); a missing
// trip is 404 TRIP_NOT_FOUND.
func (s *Server) GetLogisticsTrip(w http.ResponseWriter, r *http.Request, tripId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	trip, err := logistics.NewOpsStore(s.db.Pool()).GetTrip(r.Context(), uuid.UUID(tripId))
	if errors.Is(err, logistics.ErrTripNotFound) {
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Trip not found")
		return
	}
	if err != nil {
		s.logger.Error("get trip failed", "trip", tripId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenTrip(trip))
}

// AdvanceTrip advances the trip state machine (PATCH /trips/{tripId}):
// start_loading/depart begin the trip (planned -> in_progress, departed_at
// stamped), arrive stamps arrived_at, start_unloading validates the active
// state, and complete closes the trip — but only once every leg is
// completed (409 TRIP_CANNOT_CLOSE, LOGISTICS-OS.md §7). Departure/arrival
// append waybill events for the shipments riding on the trip's vehicle.
func (s *Server) AdvanceTrip(w http.ResponseWriter, r *http.Request, tripId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.AdvanceTripJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if _, ok := tripAdvanceActions[body.Action]; !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action is invalid")
		return
	}
	id := uuid.UUID(tripId)
	st := logistics.NewOpsStore(s.db.Pool())
	var (
		trip logistics.TripRow
		err  error
	)
	switch body.Action {
	case gen.AdvanceTripJSONBodyActionStartLoading:
		trip, err = st.StartTrip(r.Context(), id)
	case gen.AdvanceTripJSONBodyActionDepart:
		trip, err = s.departTrip(r, st, id)
	case gen.AdvanceTripJSONBodyActionArrive:
		trip, err = st.MarkArrived(r.Context(), id)
	case gen.AdvanceTripJSONBodyActionStartUnloading:
		trip, err = st.GetTrip(r.Context(), id)
		if err == nil && trip.Status != logistics.TripStatusInProgress {
			err = logistics.ErrTripAlreadyActive
		}
	case gen.AdvanceTripJSONBodyActionComplete:
		trip, err = st.CompleteTrip(r.Context(), id)
	}
	switch {
	case errors.Is(err, logistics.ErrTripNotFound):
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Trip not found")
		return
	case errors.Is(err, logistics.ErrTripAlreadyActive):
		writeError(w, http.StatusConflict, "TRIP_ALREADY_ACTIVE", "Trip is already active or past the requested state")
		return
	case errors.Is(err, logistics.ErrCannotClose):
		writeError(w, http.StatusConflict, "TRIP_CANNOT_CLOSE", "Trip cannot close — legs are still pending")
		return
	case err != nil:
		s.logger.Error("advance trip failed", "trip", tripId, "action", body.Action, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if body.Action == gen.AdvanceTripJSONBodyActionDepart {
		s.trackTripBoundary(r, trip, logistics.WaybillEventDeparted, trip.OriginHubID)
	}
	if body.Action == gen.AdvanceTripJSONBodyActionArrive {
		s.trackTripBoundary(r, trip, logistics.WaybillEventArrived, trip.DestinationHubID)
	}
	writeJSON(w, http.StatusOK, toGenTrip(trip))
}

// departTrip applies the contract's "depart" action: a planned trip starts
// (stamping departed_at), an in_progress trip only stamps departed_at.
func (s *Server) departTrip(r *http.Request, st *logistics.OpsStore, id uuid.UUID) (logistics.TripRow, error) {
	trip, err := st.GetTrip(r.Context(), id)
	if err != nil {
		return logistics.TripRow{}, err
	}
	switch trip.Status {
	case logistics.TripStatusPlanned:
		return st.StartTrip(r.Context(), id)
	case logistics.TripStatusInProgress:
		return st.MarkDeparted(r.Context(), id)
	default:
		return logistics.TripRow{}, logistics.ErrTripAlreadyActive
	}
}

// trackTripBoundary appends a departed/arrived waybill event for every
// shipment riding on the trip's vehicle (best-effort: shipments without a
// vehicle binding simply produce no events).
func (s *Server) trackTripBoundary(r *http.Request, trip logistics.TripRow, event string, hubID uuid.UUID) {
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id FROM shipments WHERE vehicle_id = $1`, trip.VehicleID)
	if err != nil {
		s.logger.Warn("trip boundary shipment lookup failed", "trip", trip.ID, "error", err)
		return
	}
	var shipmentIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			shipmentIDs = append(shipmentIDs, id)
		}
	}
	rows.Close()
	if len(shipmentIDs) == 0 {
		return
	}
	location := ""
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT name FROM hubs WHERE id = $1`, hubID).Scan(&location); err != nil {
		location = ""
	}
	st := logistics.NewOpsStore(s.db.Pool())
	tripID := trip.ID
	for _, shipmentID := range shipmentIDs {
		if _, err := st.TrackEvent(r.Context(), shipmentID, &tripID, event, location, nil); err != nil {
			s.logger.Warn("trip waybill event failed", "shipment", shipmentID, "trip", trip.ID, "error", err)
		}
	}
}

// ---- legs ----

// AdvanceRouteLeg starts or completes a leg (POST
// /orders/{orderId}/legs/{legId}/advance). The contract models legs per
// order; at this milestone the leg is a trip leg and the orderId scopes the
// shipment the leg's trip carries. The response is the trip's leg plan as
// route segments, matching the contract's RouteSegment[] payload.
func (s *Server) AdvanceRouteLeg(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID, legId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.AdvanceRouteLegJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Action != gen.AdvanceRouteLegJSONBodyActionStart &&
		body.Action != gen.AdvanceRouteLegJSONBodyActionComplete {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action is invalid")
		return
	}
	st := logistics.NewOpsStore(s.db.Pool())
	legID := uuid.UUID(legId)
	var (
		leg logistics.TripLegRow
		err error
	)
	if body.Action == gen.AdvanceRouteLegJSONBodyActionStart {
		leg, err = st.StartLeg(r.Context(), legID)
	} else {
		leg, err = st.CompleteLeg(r.Context(), legID)
	}
	switch {
	case errors.Is(err, logistics.ErrLegNotFound):
		writeError(w, http.StatusNotFound, "LEG_NOT_FOUND", "Leg not found")
		return
	case errors.Is(err, logistics.ErrLegAlreadyCompleted):
		writeError(w, http.StatusConflict, "LEG_ALREADY_COMPLETED", "Leg is already past the requested state")
		return
	case err != nil:
		s.logger.Error("advance route leg failed", "leg", legId, "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	legs, err := st.ListLegs(r.Context(), leg.TripID)
	if err != nil {
		s.logger.Error("list legs after advance failed", "leg", legId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.RouteSegment, 0, len(legs))
	for _, l := range legs {
		out = append(out, toGenRouteSegment(l))
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- handoffs ----

// RecordHandoff records a custody transfer (POST /orders/{orderId}/handoff,
// 201): the from/to legs resolve to the hubs the transfer happens between
// and the tamper-evident seal check is stored with the handoff. A handoff
// that fails verification is 409 HANDOFF_SEAL_BROKEN.
func (s *Server) RecordHandoff(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.RecordHandoffJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	st := logistics.NewOpsStore(s.db.Pool())
	fromLegID := uuid.UUID(body.FromLegId)
	fromLeg, err := st.GetLeg(r.Context(), fromLegID)
	if err != nil {
		s.writeLegError(w, err)
		return
	}
	toLeg := fromLeg
	if uuid.UUID(body.ToLegId) != uuid.Nil {
		toLeg, err = st.GetLeg(r.Context(), uuid.UUID(body.ToLegId))
		if err != nil {
			s.writeLegError(w, err)
			return
		}
	}
	var note *string
	if code := strings.TrimSpace(body.ScanCode); code != "" {
		note = &code
	}
	row, err := st.CreateHandoff(r.Context(), logistics.CreateHandoffInput{
		TripID:         fromLeg.TripID,
		LegID:          &fromLegID,
		FromEntityType: logistics.HandoffEntityHub,
		FromEntityID:   fromLeg.FromHubID,
		ToEntityType:   logistics.HandoffEntityHub,
		ToEntityID:     toLeg.ToHubID,
		SealVerified:   body.SealIntact,
		Note:           note,
	})
	switch {
	case errors.Is(err, logistics.ErrTripNotFound):
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Trip not found")
		return
	case errors.Is(err, logistics.ErrLegNotFound):
		writeError(w, http.StatusNotFound, "LEG_NOT_FOUND", "Leg not found")
		return
	case errors.Is(err, logistics.ErrSealBroken):
		writeError(w, http.StatusConflict, "HANDOFF_SEAL_BROKEN", "Handoff blocked — tamper-evident seal is broken")
		return
	case errors.Is(err, logistics.ErrHandoffInvalid):
		writeError(w, http.StatusConflict, "HANDOFF_INVALID", "Handoff references unknown hubs or vehicles")
		return
	case err != nil:
		s.logger.Error("record handoff failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	at := row.CreatedAt
	id := newUUID(row.ID.String())
	writeJSON(w, http.StatusCreated, gen.Handoff{
		Id:         &id,
		FromLegId:  body.FromLegId,
		ToLegId:    body.ToLegId,
		ScanCode:   body.ScanCode,
		SealIntact: row.SealVerified,
		From:       body.From,
		To:         body.To,
		At:         &at,
	})
}

// writeLegError maps leg resolution failures to envelopes.
func (s *Server) writeLegError(w http.ResponseWriter, err error) {
	if errors.Is(err, logistics.ErrLegNotFound) {
		writeError(w, http.StatusNotFound, "LEG_NOT_FOUND", "Leg not found")
		return
	}
	s.logger.Error("leg lookup failed", "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
}

// ---- waybill & tracking ----

// GetOrderWaybill returns the waybill for the order's shipment: the full
// scan/event trail across every leg (GET /orders/{orderId}/waybill). An
// order without a shipment or an unknown waybill is 404 WAYBILL_INVALID.
func (s *Server) GetOrderWaybill(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	waybill, err := s.shipmentWaybill(r, uuid.UUID(orderId))
	if errors.Is(err, logistics.ErrShipmentNotFound) {
		writeError(w, http.StatusNotFound, "WAYBILL_INVALID", "Waybill not found for this order")
		return
	}
	if err != nil {
		s.logger.Error("waybill lookup failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	events := make([]gen.WaybillEvent, 0, len(waybill.Events))
	for _, e := range waybill.Events {
		events = append(events, toGenWaybillEvent(e))
	}
	writeJSON(w, http.StatusOK, struct {
		WaybillNumber string             `json:"waybillNumber"`
		Events        []gen.WaybillEvent `json:"events"`
	}{WaybillNumber: waybill.WaybillNumber, Events: events})
}

// GetOrderTrackingPhases derives the customer-facing tracking phases from
// the waybill event trail (GET /orders/{orderId}/tracking-phases,
// LOGISTICS-OS.md §9): the physical leg states are hidden behind the logical
// phases picked up -> traveling -> arrived.
func (s *Server) GetOrderTrackingPhases(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	waybill, err := s.shipmentWaybill(r, uuid.UUID(orderId))
	if errors.Is(err, logistics.ErrShipmentNotFound) {
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found for this order")
		return
	}
	if err != nil {
		s.logger.Error("tracking phases lookup failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	phases := make([]gen.TrackingPhase, 0, len(waybill.Events))
	for _, e := range waybill.Events {
		phases = append(phases, trackingPhase(e))
	}
	writeJSON(w, http.StatusOK, phases)
}

// shipmentWaybill resolves an order's shipment to its waybill (shipment +
// event trail); ErrShipmentNotFound when the order has no shipment.
func (s *Server) shipmentWaybill(r *http.Request, orderID uuid.UUID) (logistics.WaybillRow, error) {
	var number string
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT waybill_number FROM shipments WHERE order_id = $1`, orderID).Scan(&number); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return logistics.WaybillRow{}, logistics.ErrShipmentNotFound
		}
		return logistics.WaybillRow{}, err
	}
	return logistics.NewOpsStore(s.db.Pool()).GetWaybill(r.Context(), number)
}

// routeHubs resolves the route corridor for a trip from the consignments'
// shipments (the shipment carries origin/destination hub bindings).
func (s *Server) routeHubs(r *http.Request, consignmentIDs []openapi_types.UUID) (uuid.UUID, uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(consignmentIDs))
	for _, id := range consignmentIDs {
		ids = append(ids, uuid.UUID(id))
	}
	var origin, dest uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT origin_hub_id, destination_hub_id FROM shipments
		 WHERE id = ANY($1) AND origin_hub_id IS NOT NULL AND destination_hub_id IS NOT NULL
		 ORDER BY created_at LIMIT 1`, ids).Scan(&origin, &dest)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, uuid.Nil, errRouteUnresolved
		}
		return uuid.Nil, uuid.Nil, err
	}
	return origin, dest, nil
}

// ---- mapping helpers ----

// tripStatusToDB maps a contract list-filter status onto the stored trips
// vocabulary; "" marks an unknown value.
func tripStatusToDB(contract string) string {
	switch contract {
	case "planned", "loading":
		return logistics.TripStatusPlanned
	case "in_transit", "unloading":
		return logistics.TripStatusInProgress
	case "completed":
		return logistics.TripStatusCompleted
	case "cancelled":
		return logistics.TripStatusCancelled
	}
	return ""
}

// tripStatusToGen maps a stored trip status onto the contract enum.
func tripStatusToGen(db string) gen.LogisticsTripStatus {
	switch db {
	case logistics.TripStatusPlanned:
		return gen.LogisticsTripStatusPlanned
	case logistics.TripStatusInProgress:
		return gen.LogisticsTripStatusInTransit
	case logistics.TripStatusCompleted:
		return gen.LogisticsTripStatusCompleted
	case logistics.TripStatusCancelled:
		return gen.LogisticsTripStatusCancelled
	}
	return gen.LogisticsTripStatusPlanned
}

// toGenTrip maps a trips row onto the contract LogisticsTrip. The contract
// requires a routeId; the corridor is carried on the trip's hub bindings and
// no routes table exists yet, so the field reports the nil uuid.
func toGenTrip(t logistics.TripRow) gen.LogisticsTrip {
	return gen.LogisticsTrip{
		Id:                 newUUID(t.ID.String()),
		TripNumber:         t.Code,
		Status:             tripStatusToGen(t.Status),
		RouteId:            openapi_types.UUID(uuid.Nil),
		VehicleId:          newUUID(t.VehicleID.String()),
		ScheduledDeparture: t.PlannedDeparture,
		DepartedAt:         t.DepartedAt,
		ArrivedAt:          t.ArrivedAt,
		CreatedAt:          &t.CreatedAt,
	}
}

// toGenRouteSegment maps a trip leg onto the contract RouteSegment.
func toGenRouteSegment(l logistics.TripLegRow) gen.RouteSegment {
	status := gen.RouteSegmentStatusPending
	switch l.Status {
	case logistics.LegStatusInProgress:
		status = gen.RouteSegmentStatusInProgress
	case logistics.LegStatusCompleted:
		status = gen.RouteSegmentStatusCompleted
	}
	segType := gen.Linehaul
	switch l.Mode {
	case logistics.LegModeFirstMile:
		segType = gen.FirstMile
	case logistics.LegModeLastMile:
		segType = gen.LastMile
	}
	fromHub := openapi_types.UUID(l.FromHubID)
	toHub := openapi_types.UUID(l.ToHubID)
	return gen.RouteSegment{
		LegId:       newUUID(l.ID.String()),
		Sequence:    l.Sequence,
		Status:      status,
		Type:        segType,
		FromHubId:   &fromHub,
		ToHubId:     &toHub,
		CompletedAt: l.CompletedAt,
	}
}

// toGenWaybillEvent maps a waybill_tracking row onto the contract
// WaybillEvent.
func toGenWaybillEvent(e logistics.WaybillEventRow) gen.WaybillEvent {
	eventType := gen.WaybillEventTypeScanned
	switch e.Event {
	case logistics.WaybillEventDeparted:
		eventType = gen.WaybillEventTypeDeparted
	case logistics.WaybillEventArrived:
		eventType = gen.WaybillEventTypeArrived
	case logistics.WaybillEventHandoff:
		eventType = gen.WaybillEventTypeHandoff
	}
	location := ""
	if e.Location != nil {
		location = *e.Location
	}
	return gen.WaybillEvent{
		At:       e.At,
		Location: location,
		Note:     e.Note,
		Type:     eventType,
	}
}

// trackingPhase maps a waybill event onto a customer-facing tracking phase.
func trackingPhase(e logistics.WaybillEventRow) gen.TrackingPhase {
	at := e.At
	switch e.Event {
	case logistics.WaybillEventScan:
		return gen.TrackingPhase{At: &at, Label: "Picked up", Phase: gen.TrackingPhasePhasePickedUp, Status: gen.TrackingPhaseStatusCompleted}
	case logistics.WaybillEventDeparted, logistics.WaybillEventHandoff:
		return gen.TrackingPhase{At: &at, Label: "In transit", Phase: gen.TrackingPhasePhaseInTransit, Status: gen.TrackingPhaseStatusCompleted}
	case logistics.WaybillEventArrived:
		return gen.TrackingPhase{At: &at, Label: "Arrived in your city", Phase: gen.TrackingPhasePhaseArrivedCity, Status: gen.TrackingPhaseStatusCompleted}
	}
	return gen.TrackingPhase{At: &at, Label: "Confirmed", Phase: gen.TrackingPhasePhaseConfirmed, Status: gen.TrackingPhaseStatusCompleted}
}

// tripCursor parses the opaque cursor value into a trip id.
func tripCursor(cursor string) (*uuid.UUID, error) {
	if cursor == "" {
		return nil, nil
	}
	id, err := uuid.Parse(cursor)
	if err != nil {
		return nil, err
	}
	return &id, nil
}
