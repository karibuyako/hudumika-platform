package api

// LOGISTICS-EXTRA bounded context (backend/LOGISTICS-OS.md,
// backend/INTERCITY-LOGISTICS.md): the /routes, /warehouses, /carriers,
// /facilities, /linehaul/consignments and /delivery-exceptions surface
// (API-CONTRACT.yaml). The registry endpoints are plain list/create; the
// consignment flow is create -> depart -> arrive (the contract has no
// add-order or seal path — AddOrderToConsignment and SealConsignment are
// store-only and driven by ops tooling at this milestone) and the
// delivery-exception flow is create -> list -> resolve.
//
// The contract vocabulary is richer than the stored one (migration 00041) in
// three places, and the handlers collapse onto the stored vocabulary:
//
//   - consignment status: manifesting -> assembling/sealed, in_transit ->
//     departed, at_hub -> arrived (delivered/cancelled have no stored rows);
//   - delivery-exception kind: the 18-kind contract catalog collapses onto
//     delay/damage/address/weather/other;
//   - exception status: resolving/escalated collapse onto open.
//
// Contract fields with no store column (route name, carrier regions beyond
// the first mode, facility address/geofence/whitelist, consignment
// transportMode/scheduledDeparture, exception outcome) are accepted and
// documented as not persisted at this milestone.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// ---- routes ----

// ListRoutes returns the configured corridors (GET /routes).
func (s *Server) ListRoutes(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	routes, err := logistics.NewExtraStore(s.db.Pool()).ListRoutes(r.Context())
	if err != nil {
		s.logger.Error("list routes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Route, 0, len(routes))
	for _, rt := range routes {
		out = append(out, toGenRoute(rt))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateRoute adds a corridor route between two hubs (POST /routes, 201). The
// contract requires name and fromHubId/toHubId; the store keeps no name
// column, so the name surfaces derived from the corridor ids (documented).
// The contract estimatedHours is persisted as duration_minutes.
func (s *Server) CreateRoute(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateRouteJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if uuid.UUID(body.FromHubId) == uuid.Nil || uuid.UUID(body.ToHubId) == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "fromHubId and toHubId are required")
		return
	}
	from, to := uuid.UUID(body.FromHubId), uuid.UUID(body.ToHubId)
	in := logistics.RouteInput{OriginHubID: &from, DestinationHubID: &to}
	if body.EstimatedHours != nil {
		minutes := *body.EstimatedHours * 60
		in.DurationMinutes = &minutes
	}
	if body.Active != nil {
		in.Active = body.Active
	}
	route, err := logistics.NewExtraStore(s.db.Pool()).CreateRoute(r.Context(), in)
	if errors.Is(err, logistics.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "CONFLICT", "A route between these hubs already exists")
		return
	}
	if err != nil {
		s.logger.Error("create route failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenRoute(route))
}

// ---- warehouses ----

// ListWarehouses returns the regional warehouse registry (GET /warehouses).
func (s *Server) ListWarehouses(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	warehouses, err := logistics.NewExtraStore(s.db.Pool()).ListWarehouses(r.Context())
	if err != nil {
		s.logger.Error("list warehouses failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Warehouse, 0, len(warehouses))
	for _, wh := range warehouses {
		out = append(out, toGenWarehouse(wh))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateWarehouse registers a warehouse (POST /warehouses, 201). The contract
// cityId is resolved to the stored city name best-effort (00004 cities); the
// contract statuses full/maintenance collapse onto out_of_service.
func (s *Server) CreateWarehouse(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateWarehouseJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	in := logistics.WarehouseInput{Name: body.Name}
	if uuid.UUID(body.CityId) != uuid.Nil {
		in.City = s.cityName(r, uuid.UUID(body.CityId))
	}
	if body.Status != nil {
		status, ok := warehouseStatusToDB(*body.Status)
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
		in.Status = &status
	}
	warehouse, err := logistics.NewExtraStore(s.db.Pool()).CreateWarehouse(r.Context(), in)
	if err != nil {
		s.logger.Error("create warehouse failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenWarehouse(warehouse))
}

// ---- carriers ----

// ListCarriers returns the third-party carrier registry (GET /carriers).
func (s *Server) ListCarriers(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	carriers, err := logistics.NewExtraStore(s.db.Pool()).ListCarriers(r.Context())
	if err != nil {
		s.logger.Error("list carriers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Carrier, 0, len(carriers))
	for _, c := range carriers {
		out = append(out, toGenCarrier(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateCarrier registers a carrier (POST /carriers, 201). The contract
// modes array collapses onto the stored single mode (first entry wins:
// van/linehaul_* /refrigerated_truck -> linehaul, train -> rail, air -> air);
// paused/suspended collapse onto suspended.
func (s *Server) CreateCarrier(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateCarrierJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if len(body.Modes) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "modes is required")
		return
	}
	for _, m := range body.Modes {
		if !m.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "modes is invalid")
			return
		}
	}
	in := logistics.CarrierInput{Name: body.Name, Mode: carrierModeToDB(body.Modes[0])}
	if body.Regions != nil {
		in.Regions = *body.Regions
	}
	if body.Status != nil {
		status, ok := carrierStatusToDB(*body.Status)
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
		in.Status = &status
	}
	carrier, err := logistics.NewExtraStore(s.db.Pool()).CreateCarrier(r.Context(), in)
	if err != nil {
		s.logger.Error("create carrier failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenCarrier(carrier))
}

// ---- facilities ----

// ListFacilities returns the secure facilities (GET /facilities).
func (s *Server) ListFacilities(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	facilities, err := logistics.NewExtraStore(s.db.Pool()).ListFacilities(r.Context())
	if err != nil {
		s.logger.Error("list facilities failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Facility, 0, len(facilities))
	for _, f := range facilities {
		out = append(out, toGenFacility(f))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateFacility registers a facility (POST /facilities, 201). The stored
// kind (hub/depot/rest_stop) is not part of the contract body and defaults to
// hub; address/geofence/whitelist/accessPolicy are accepted but not
// persisted at this milestone (documented).
func (s *Server) CreateFacility(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateFacilityJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	facility, err := logistics.NewExtraStore(s.db.Pool()).CreateFacility(r.Context(), logistics.FacilityInput{
		Name: body.Name,
		Kind: logistics.FacilityKindHub,
	})
	if err != nil {
		s.logger.Error("create facility failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenFacility(facility))
}

// ---- consignments ----

// ListConsignments returns the line-haul consignments (GET
// /linehaul/consignments). The contract status filter maps onto the stored
// statuses (manifesting covers assembling+sealed; delivered/cancelled return
// [] — no stored rows at this milestone).
func (s *Server) ListConsignments(w http.ResponseWriter, r *http.Request, params gen.ListConsignmentsParams) {
	if !s.logisticsReady(w, r) {
		return
	}
	status := ""
	if params.Status != nil {
		if !params.Status.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
		status = string(*params.Status)
	}
	items, _, err := logistics.NewExtraStore(s.db.Pool()).ListConsignments(r.Context(), status, defaultLogisticsListLimit, "")
	if err != nil {
		s.logger.Error("list consignments failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Consignment, 0, len(items))
	for _, c := range items {
		out = append(out, toGenConsignment(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateConsignment opens a consignment on the corridor between the two hubs
// (POST /linehaul/consignments, 201). The route is resolved from the
// (fromHubId, toHubId) corridor (404 ROUTE_NOT_FOUND when not configured);
// the carrier is the newest active carrier for the transport mode (409
// CARRIER_UNAVAILABLE when the mode is not served). The contract
// transportMode and scheduledDeparture are not persisted (the carrier's mode
// captures the lane); the manifest orderIds are stored.
func (s *Server) CreateConsignment(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateConsignmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if uuid.UUID(body.FromHubId) == uuid.Nil || uuid.UUID(body.ToHubId) == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "fromHubId and toHubId are required")
		return
	}
	if len(body.OrderIds) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderIds must contain at least one order")
		return
	}
	if !body.TransportMode.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "TRANSPORT_MODE_INVALID", "transportMode is invalid")
		return
	}
	st := logistics.NewExtraStore(s.db.Pool())
	ctx := r.Context()
	from, to := uuid.UUID(body.FromHubId), uuid.UUID(body.ToHubId)
	route, err := st.FindRoute(ctx, from, to)
	if errors.Is(err, logistics.ErrRouteNotFound) {
		writeError(w, http.StatusNotFound, "ROUTE_NOT_FOUND", "No route is configured between these hubs")
		return
	}
	if err != nil {
		s.logger.Error("resolve consignment route failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	carrier, err := st.FindActiveCarrier(ctx, transportModeToCarrierMode(body.TransportMode))
	if errors.Is(err, logistics.ErrCarrierUnavailable) {
		writeError(w, http.StatusConflict, "CARRIER_UNAVAILABLE", "No active carrier serves this transport mode")
		return
	}
	if err != nil {
		s.logger.Error("resolve consignment carrier failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	orderIDs := make([]uuid.UUID, 0, len(body.OrderIds))
	for _, id := range body.OrderIds {
		orderIDs = append(orderIDs, uuid.UUID(id))
	}
	row, err := st.CreateConsignment(ctx, logistics.CreateConsignmentInput{
		RouteID:          route.ID,
		CarrierID:        carrier.ID,
		OriginHubID:      &from,
		DestinationHubID: &to,
		OrderIDs:         orderIDs,
	})
	switch {
	case errors.Is(err, logistics.ErrRouteNotFound):
		writeError(w, http.StatusNotFound, "ROUTE_NOT_FOUND", "No route is configured between these hubs")
		return
	case errors.Is(err, logistics.ErrCarrierUnavailable):
		writeError(w, http.StatusConflict, "CARRIER_UNAVAILABLE", "No active carrier serves this transport mode")
		return
	case errors.Is(err, logistics.ErrCapacityWeightExceeded):
		writeError(w, http.StatusConflict, "CAPACITY_WEIGHT_EXCEEDED", "Consignment weight exceeds the route capacity")
		return
	case err != nil:
		s.logger.Error("create consignment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenConsignment(row))
}

// DepartConsignment performs the departure scan (POST
// /linehaul/consignments/{consignmentId}/depart): sealed -> departed. A
// consignment that is not sealed is 409 CONSIGNMENT_ALREADY_DEPARTED.
func (s *Server) DepartConsignment(w http.ResponseWriter, r *http.Request, consignmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).DepartConsignment(r.Context(), uuid.UUID(consignmentId))
	switch {
	case errors.Is(err, logistics.ErrConsignmentNotFound):
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	case errors.Is(err, logistics.ErrConsignmentAlreadyDeparted):
		writeError(w, http.StatusConflict, "CONSIGNMENT_ALREADY_DEPARTED", "Consignment is not sealed or has already departed")
		return
	case err != nil:
		s.logger.Error("depart consignment failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenConsignment(row))
}

// ArriveConsignment performs the arrival scan (POST
// /linehaul/consignments/{consignmentId}/arrive): departed -> arrived. The
// scanned-in orders must equal the manifest: a short scan is 409
// CONSIGNMENT_MISSING_ORDERS and a scan with extra orders is 409
// CONSIGNMENT_ORDER_MISMATCH. missingOrderIds is accepted but not consulted
// (the verified set alone is authoritative).
func (s *Server) ArriveConsignment(w http.ResponseWriter, r *http.Request, consignmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.ArriveConsignmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	st := logistics.NewExtraStore(s.db.Pool())
	ctx := r.Context()
	id := uuid.UUID(consignmentId)
	row, err := st.GetConsignment(ctx, id)
	if errors.Is(err, logistics.ErrConsignmentNotFound) {
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	}
	if err != nil {
		s.logger.Error("load consignment failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	verified := make(map[uuid.UUID]bool, len(body.VerifiedOrderIds))
	for _, id := range body.VerifiedOrderIds {
		verified[uuid.UUID(id)] = true
	}
	for _, manifestID := range row.OrderIDs {
		if !verified[manifestID] {
			writeError(w, http.StatusConflict, "CONSIGNMENT_MISSING_ORDERS", "Arrival scan is missing orders from the manifest")
			return
		}
	}
	for _, scannedID := range body.VerifiedOrderIds {
		found := false
		for _, manifestID := range row.OrderIDs {
			if uuid.UUID(scannedID) == manifestID {
				found = true
				break
			}
		}
		if !found {
			writeError(w, http.StatusConflict, "CONSIGNMENT_ORDER_MISMATCH", "Arrival scan contains orders not in the manifest")
			return
		}
	}
	arrived, err := st.ArriveConsignment(ctx, id)
	switch {
	case errors.Is(err, logistics.ErrConsignmentNotFound):
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	case errors.Is(err, logistics.ErrConsignmentAlreadyDeparted):
		writeError(w, http.StatusConflict, "CONSIGNMENT_ALREADY_DEPARTED", "Consignment has not departed or has already arrived")
		return
	case err != nil:
		s.logger.Error("arrive consignment failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenConsignment(arrived))
}

// ---- delivery exceptions ----

// ListDeliveryExceptions returns the exception catalog (GET
// /delivery-exceptions). The contract kind filter is mapped onto the stored
// vocabulary; the status filter collapses resolving/escalated onto open.
func (s *Server) ListDeliveryExceptions(w http.ResponseWriter, r *http.Request, params gen.ListDeliveryExceptionsParams) {
	if !s.logisticsReady(w, r) {
		return
	}
	status := ""
	if params.Status != nil {
		if !params.Status.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
		status = string(*params.Status)
	}
	st := logistics.NewExtraStore(s.db.Pool())
	ctx := r.Context()
	var (
		items []logistics.ExceptionRow
		next  string
		err   error
	)
	if params.Kind != nil {
		kind, ok := exceptionKindToDB(gen.DeliveryExceptionKind(*params.Kind))
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "kind is invalid")
			return
		}
		items, next, err = st.ListExceptionsByKind(ctx, kind, status, defaultLogisticsListLimit, "")
	} else {
		items, next, err = st.ListExceptions(ctx, status, defaultLogisticsListLimit, "")
	}
	if err != nil {
		s.logger.Error("list delivery exceptions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.DeliveryException, 0, len(items))
	for _, e := range items {
		out = append(out, toGenException(e))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateDeliveryException reports a delivery exception (POST
// /delivery-exceptions, 201). The shipment must exist (404 SHIPMENT_NOT_FOUND)
// and the contract kind collapses onto the stored vocabulary. The contract
// orderId/tripId/outcome/autoReplanned fields are accepted but not persisted
// at this milestone (documented).
func (s *Server) CreateDeliveryException(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateDeliveryExceptionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.ShipmentId == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "shipmentId is required")
		return
	}
	if !body.Kind.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "kind is invalid")
		return
	}
	kind, ok := exceptionKindToDB(body.Kind)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "kind is invalid")
		return
	}
	description := ""
	if body.Description != nil {
		description = strings.TrimSpace(*body.Description)
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).CreateException(r.Context(), uuid.UUID(*body.ShipmentId), kind, description)
	if errors.Is(err, logistics.ErrShipmentNotFound) {
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
		return
	}
	if err != nil {
		s.logger.Error("create delivery exception failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenException(row))
}

// UpdateDeliveryException advances an exception (PATCH
// /delivery-exceptions/{exceptionId}): only status=resolved is supported at
// this milestone (open -> resolved; outcome is accepted but not persisted).
// A missing exception is 404 EXCEPTION_NOT_FOUND; a resolved one is 409
// EXCEPTION_ALREADY_RESOLVED.
func (s *Server) UpdateDeliveryException(w http.ResponseWriter, r *http.Request, exceptionId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.UpdateDeliveryExceptionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Status != gen.UpdateDeliveryExceptionJSONBodyStatusResolved {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "only status=resolved is supported at this milestone")
		return
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).ResolveException(r.Context(), uuid.UUID(exceptionId))
	switch {
	case errors.Is(err, logistics.ErrExceptionNotFound):
		writeError(w, http.StatusNotFound, "EXCEPTION_NOT_FOUND", "Delivery exception not found")
		return
	case errors.Is(err, logistics.ErrExceptionAlreadyResolved):
		writeError(w, http.StatusConflict, "EXCEPTION_ALREADY_RESOLVED", "Delivery exception is already resolved")
		return
	case err != nil:
		s.logger.Error("resolve delivery exception failed", "exception", exceptionId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenException(row))
}

// ---- mapping helpers ----

// toGenRoute maps a routes row onto the contract Route. The store keeps no
// name column, so the name is derived deterministically from the corridor
// hub ids (the hub-name registry lives in the logistics-core context).
func toGenRoute(r logistics.RouteRow) gen.Route {
	out := gen.Route{
		Id:        newUUID(r.ID.String()),
		FromHubId: uuidToGen(r.OriginHubID),
		ToHubId:   uuidToGen(r.DestinationHubID),
	}
	from, to := "?", "?"
	if r.OriginHubID != nil {
		from = r.OriginHubID.String()[:8]
	}
	if r.DestinationHubID != nil {
		to = r.DestinationHubID.String()[:8]
	}
	out.Name = "Route " + from + " -> " + to
	if r.DurationMinutes > 0 {
		hours := r.DurationMinutes / 60
		out.EstimatedHours = &hours
	}
	active := r.Active
	out.Active = &active
	return out
}

// toGenWarehouse maps a warehouses row onto the contract Warehouse. The store
// keeps the city name, not the cityId, so the contract cityId surfaces as the
// zero uuid (the name is the authoritative stored value).
func toGenWarehouse(w logistics.WarehouseRow) gen.Warehouse {
	out := gen.Warehouse{
		Id:     newUUID(w.ID.String()),
		Name:   w.Name,
		CityId: newUUID(uuid.Nil.String()),
	}
	status := gen.WarehouseStatus(w.Status)
	if w.Status == logistics.WarehouseStatusOutOfService {
		status = gen.WarehouseStatusMaintenance
	}
	out.Status = &status
	return out
}

// toGenCarrier maps a carriers row onto the contract Carrier: the stored
// single mode surfaces as the representative contract mode and the regions
// jsonb as the contract regions array.
func toGenCarrier(c logistics.CarrierRow) gen.Carrier {
	out := gen.Carrier{
		Id:    newUUID(c.ID.String()),
		Name:  c.Name,
		Modes: []gen.CarrierModes{carrierModeToGen(c.Mode)},
	}
	out.Regions = &c.Regions
	status := gen.CarrierStatus(c.Status)
	out.Status = &status
	return out
}

// toGenFacility maps a facilities row onto the contract Facility. The store
// keeps kind/city/hub_id; the contract address surfaces as the city (or the
// name when no city is stored) since the geofence-style address is not
// persisted at this milestone.
func toGenFacility(f logistics.FacilityRow) gen.Facility {
	out := gen.Facility{
		Id:   newUUID(f.ID.String()),
		Name: f.Name,
	}
	if f.City != nil && *f.City != "" {
		out.Address = *f.City
	} else {
		out.Address = f.Name
	}
	return out
}

// toGenConsignment maps a consignments row onto the contract Consignment.
// The stored status vocabulary maps onto the contract one (assembling/sealed
// -> manifesting, departed -> in_transit, arrived -> at_hub); the waybill
// number of each manifest entry is derived deterministically from the order
// id (the physical waybills live in the logistics-core context).
func toGenConsignment(c logistics.ConsignmentRow) gen.Consignment {
	out := gen.Consignment{
		Id:                newUUID(c.ID.String()),
		ConsignmentNumber: c.Code,
		FromHubId:         uuidToGen(c.OriginHubID),
		ToHubId:           uuidToGen(c.DestinationHubID),
		TransportMode:     consignmentTransportMode(c),
		Status:            toGenConsignmentStatus(c.Status),
		CreatedAt:         &c.CreatedAt,
	}
	if c.CarrierID != nil {
		id := newUUID(c.CarrierID.String())
		out.CarrierId = &id
	}
	count := len(c.OrderIDs)
	out.OrderCount = &count
	if len(c.OrderIDs) > 0 {
		manifest := make([]struct {
			OrderId       openapi_types.UUID             `json:"orderId"`
			ScannedIn     *bool                          `json:"scannedIn,omitempty"`
			ScannedOut    *bool                          `json:"scannedOut,omitempty"`
			Section       gen.ConsignmentManifestSection `json:"section"`
			WaybillNumber string                         `json:"waybillNumber"`
		}, 0, len(c.OrderIDs))
		for _, orderID := range c.OrderIDs {
			manifest = append(manifest, struct {
				OrderId       openapi_types.UUID             `json:"orderId"`
				ScannedIn     *bool                          `json:"scannedIn,omitempty"`
				ScannedOut    *bool                          `json:"scannedOut,omitempty"`
				Section       gen.ConsignmentManifestSection `json:"section"`
				WaybillNumber string                         `json:"waybillNumber"`
			}{
				OrderId:       newUUID(orderID.String()),
				Section:       gen.ConsignmentManifestSectionStandard,
				WaybillNumber: "WB-" + orderID.String()[:8],
			})
		}
		out.Manifest = &manifest
	}
	return out
}

// toGenConsignmentStatus maps a stored consignment status onto the contract
// enum.
func toGenConsignmentStatus(db string) gen.ConsignmentStatus {
	switch db {
	case logistics.ConsignmentStatusAssembling, logistics.ConsignmentStatusSealed:
		return gen.ConsignmentStatusManifesting
	case logistics.ConsignmentStatusDeparted:
		return gen.ConsignmentStatusInTransit
	case logistics.ConsignmentStatusArrived:
		return gen.ConsignmentStatusAtHub
	}
	return gen.ConsignmentStatusCancelled
}

// toGenException maps a delivery_exceptions row onto the contract
// DeliveryException: the reduced stored kind surfaces as a representative
// contract kind and reportedBy surfaces as the empty string (the reporting
// actor is not persisted at this milestone).
func toGenException(e logistics.ExceptionRow) gen.DeliveryException {
	out := gen.DeliveryException{
		Id:         newUUID(e.ID.String()),
		ShipmentId: newUUIDPtr(e.ShipmentID),
		Kind:       exceptionKindToGen(e.Kind),
		Status:     gen.DeliveryExceptionStatus(e.Status),
		CreatedAt:  e.CreatedAt,
		ResolvedAt: e.ResolvedAt,
	}
	if e.Description != nil {
		out.Description = e.Description
	}
	return out
}

// warehouseStatusToDB maps a contract warehouse status onto the stored
// vocabulary; the second return reports whether the value is known.
func warehouseStatusToDB(contract gen.WarehouseStatus) (string, bool) {
	switch contract {
	case gen.WarehouseStatusActive:
		return logistics.WarehouseStatusActive, true
	case gen.WarehouseStatusFull, gen.WarehouseStatusMaintenance:
		return logistics.WarehouseStatusOutOfService, true
	}
	return "", false
}

// carrierStatusToDB maps a contract carrier status onto the stored
// vocabulary; paused collapses onto suspended.
func carrierStatusToDB(contract gen.CarrierStatus) (string, bool) {
	switch contract {
	case gen.CarrierStatusActive:
		return logistics.CarrierStatusActive, true
	case gen.CarrierStatusPaused, gen.CarrierStatusSuspended:
		return logistics.CarrierStatusSuspended, true
	}
	return "", false
}

// carrierModeToDB maps the contract carrier modes onto the stored single
// mode.
func carrierModeToDB(mode gen.CarrierModes) string {
	switch mode {
	case gen.CarrierModesAir:
		return logistics.CarrierModeAir
	case gen.CarrierModesTrain:
		return logistics.CarrierModeRail
	default:
		return logistics.CarrierModeLinehaul
	}
}

// carrierModeToGen maps the stored carrier mode back to the representative
// contract mode.
func carrierModeToGen(mode string) gen.CarrierModes {
	switch mode {
	case logistics.CarrierModeAir:
		return gen.CarrierModesAir
	case logistics.CarrierModeRail:
		return gen.CarrierModesTrain
	default:
		return gen.CarrierModesLinehaulTruck
	}
}

// transportModeToCarrierMode maps the contract consignment transport mode to
// the stored carrier mode (every line-haul lane collapses onto linehaul).
func transportModeToCarrierMode(mode gen.CreateConsignmentJSONBodyTransportMode) string {
	switch mode {
	case gen.CreateConsignmentJSONBodyTransportModeVan,
		gen.CreateConsignmentJSONBodyTransportModeLinehaulBus,
		gen.CreateConsignmentJSONBodyTransportModeLinehaulTruck:
		return logistics.CarrierModeLinehaul
	}
	return logistics.CarrierModeLinehaul
}

// consignmentTransportMode surfaces the stored lane as the contract
// transport mode: the store keeps the carrier's lane, so a carrier-bound
// consignment reports the line-haul representative and an unbound one
// reports van (the default lane).
func consignmentTransportMode(c logistics.ConsignmentRow) gen.ConsignmentTransportMode {
	if c.CarrierID != nil {
		return gen.ConsignmentTransportModeLinehaulTruck
	}
	return gen.ConsignmentTransportModeVan
}

// exceptionKindToDB maps a contract exception kind onto the reduced stored
// vocabulary; the second return reports whether the value is known.
func exceptionKindToDB(kind gen.DeliveryExceptionKind) (string, bool) {
	switch kind {
	case gen.DeliveryExceptionKindLateVehicle, gen.DeliveryExceptionKindVehicleBreakdown,
		gen.DeliveryExceptionKindHubCongestion, gen.DeliveryExceptionKindBusCancellation:
		return logistics.ExceptionKindDelay, true
	case gen.DeliveryExceptionKindDamagedPackage, gen.DeliveryExceptionKindMissingPackage,
		gen.DeliveryExceptionKindWrongPackage, gen.DeliveryExceptionKindScanFailure,
		gen.DeliveryExceptionKindReconciliationFailure, gen.DeliveryExceptionKindSecurityIncident:
		return logistics.ExceptionKindDamage, true
	case gen.DeliveryExceptionKindCustomerUnavailable, gen.DeliveryExceptionKindPackageRefused,
		gen.DeliveryExceptionKindWrongHub, gen.DeliveryExceptionKindWrongVehicle,
		gen.DeliveryExceptionKindRouteDeviation:
		return logistics.ExceptionKindAddress, true
	case gen.DeliveryExceptionKindWeatherDisruption, gen.DeliveryExceptionKindRoadClosure:
		return logistics.ExceptionKindWeather, true
	case gen.DeliveryExceptionKindRiderUnavailable:
		return logistics.ExceptionKindOther, true
	}
	return "", false
}

// exceptionKindToGen maps the reduced stored kind back to a representative
// contract kind.
func exceptionKindToGen(kind string) gen.DeliveryExceptionKind {
	switch kind {
	case logistics.ExceptionKindDelay:
		return gen.DeliveryExceptionKindLateVehicle
	case logistics.ExceptionKindDamage:
		return gen.DeliveryExceptionKindDamagedPackage
	case logistics.ExceptionKindAddress:
		return gen.DeliveryExceptionKindCustomerUnavailable
	case logistics.ExceptionKindWeather:
		return gen.DeliveryExceptionKindWeatherDisruption
	default:
		return gen.DeliveryExceptionKindScanFailure
	}
}
