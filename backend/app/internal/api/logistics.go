package api

// LOGISTICS-CORE bounded context (backend/LOGISTICS-OS.md,
// backend/INTERCITY-LOGISTICS.md): shipments (the physical twin of an order),
// packages, hubs, vehicles and containers, plus the append-only waybill
// event ledger (custody chain) behind /shipments, /containers, /vehicles and
// /hubs.
//
// Security: the contract secures every logistics path with plain bearerAuth,
// so the handlers are role-neutral — any authenticated session may read and
// advance the lane (hub workers, riders, dispatchers and staff all drive the
// same physical lane). The admin freeze/unfreeze endpoints sit under /admin/
// (routePolicy staff+MFA gate) and additionally reject non-staff roles with
// 403 FORBIDDEN here, per the contract.
//
// The contract uses the Shipment status vocabulary (planned/picked_up/...);
// the store keeps the migration's status vocabulary (pending/at_hub/...).
// toGenShipmentStatus maps the two: pending is the stored initial state and
// surfaces as planned; picked_up is not stored and surfaces only via the
// custody ledger.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Logistics pagination bounds shared by the shipment listing.
const (
	defaultLogisticsListLimit = 20
	maxLogisticsListLimit     = 100
)

// logisticsLimit clamps the limit query parameter to the shared bounds.
func logisticsLimit(limit *int) int {
	out := defaultLogisticsListLimit
	if limit != nil && *limit > 0 {
		out = *limit
		if out > maxLogisticsListLimit {
			out = maxLogisticsListLimit
		}
	}
	return out
}

// logisticsReady validates the session and the database for the logistics
// lane: a missing session is 401, a server without a database is the 500
// envelope (no logistics state can be resolved).
func (s *Server) logisticsReady(w http.ResponseWriter, r *http.Request) bool {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return false
	}
	if s.db == nil {
		s.logger.Error("logistics request failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return false
	}
	return true
}

// logisticsActorID resolves the session subject to a user id for the event
// ledger's by column; a non-UUID subject degrades to nil (not recorded).
func logisticsActorID(r *http.Request) *uuid.UUID {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil
	}
	id, err := uuid.Parse(claims.Subject)
	if err != nil {
		return nil
	}
	return &id
}

// ---- shipments ----

// ListShipments returns shipments, cursor-paginated (GET /shipments). The
// contract status filter vocabulary maps onto the stored statuses; the
// contract's picked_up collapses onto pending (the store keeps no separate
// picked_up state at this milestone).
func (s *Server) ListShipments(w http.ResponseWriter, r *http.Request, params gen.ListShipmentsParams) {
	if !s.logisticsReady(w, r) {
		return
	}
	status := ""
	if params.Status != nil {
		status = logisticsStatusToDB(string(*params.Status))
		if status == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	items, next, err := logistics.NewStore(s.db.Pool()).ListShipments(r.Context(), status, logisticsLimit(params.Limit), cursor)
	if errors.Is(err, logistics.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list shipments failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.Shipment, 0, len(items))
	for _, it := range items {
		out = append(out, toGenShipment(it, nil))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateShipment links an order to its physical shipment (POST /shipments,
// 201): one order yields exactly one shipment (SHIPMENT_ALREADY_EXISTS 409 on
// a duplicate). The waybill number and the first 'created' event are
// server-assigned; packageCount physical units are created with the shipment.
func (s *Server) CreateShipment(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateShipmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if uuid.UUID(body.OrderId) == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId is required")
		return
	}
	count := 1
	if body.PackageCount != nil {
		if *body.PackageCount < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "packageCount must be >= 1")
			return
		}
		count = *body.PackageCount
	}
	st := logistics.NewStore(s.db.Pool())
	row, err := st.CreateShipment(r.Context(), logistics.CreateShipmentInput{
		OrderID:      uuid.UUID(body.OrderId),
		PackageCount: count,
		ActorID:      logisticsActorID(r),
	})
	if errors.Is(err, logistics.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "SHIPMENT_ALREADY_EXISTS", "An order can have only one shipment")
		return
	}
	if err != nil {
		s.logger.Error("create shipment failed", "order", body.OrderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	detail, err := st.GetShipmentDetail(r.Context(), row.ID)
	if err != nil {
		s.logger.Error("reload shipment failed", "shipment", row.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenShipment(detail.Shipment, detail.Packages))
}

// GetShipment returns the shipment with its packages and current logistics
// state (GET /shipments/{shipmentId}); a missing shipment is 404
// SHIPMENT_NOT_FOUND.
func (s *Server) GetShipment(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	detail, err := logistics.NewStore(s.db.Pool()).GetShipmentDetail(r.Context(), uuid.UUID(shipmentId))
	if errors.Is(err, logistics.ErrNotFound) {
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
		return
	}
	if err != nil {
		s.logger.Error("get shipment failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenShipment(detail.Shipment, detail.Packages))
}

// GetShipmentCustody returns the full custody ledger — every handoff and scan
// for the shipment's packages, oldest first (GET
// /shipments/{shipmentId}/custody).
func (s *Server) GetShipmentCustody(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	events, err := logistics.NewStore(s.db.Pool()).ListEvents(r.Context(), uuid.UUID(shipmentId))
	if errors.Is(err, logistics.ErrNotFound) {
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
		return
	}
	if err != nil {
		s.logger.Error("get shipment custody failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.CustodyEntry, 0, len(events))
	for _, e := range events {
		out = append(out, toGenCustodyEntry(e))
	}
	writeJSON(w, http.StatusOK, out)
}

// ScanShipment records a waybill scan at a hub or vehicle and advances the
// shipment (POST /shipments/{shipmentId}/scan, 201 with the new custody
// entry). A frozen shipment is 409 SHIPMENT_FROZEN; a scan the current status
// does not permit is 409 SHIPMENT_STATUS_CONFLICT; an unknown hub or vehicle
// in the scan is 404 HUB_NOT_FOUND / VEHICLE_NOT_FOUND. The GPS fix is
// sanity-checked here (plausible ranges only — strict geofence verification
// is a later milestone).
func (s *Server) ScanShipment(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.ScanShipmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.ScanType.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "scanType is invalid")
		return
	}
	if strings.TrimSpace(body.Location) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "location is required")
		return
	}
	var lat, lon *float64
	if body.Lat != nil {
		v := float64(*body.Lat)
		if v < -90 || v > 90 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "lat is out of range")
			return
		}
		lat = &v
	}
	if body.Lon != nil {
		v := float64(*body.Lon)
		if v < -180 || v > 180 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "lon is out of range")
			return
		}
		lon = &v
	}
	var hubID, vehicleID *uuid.UUID
	if body.HubId != nil {
		id := uuid.UUID(*body.HubId)
		hubID = &id
	}
	if body.VehicleId != nil {
		id := uuid.UUID(*body.VehicleId)
		vehicleID = &id
	}
	_, event, err := logistics.NewStore(s.db.Pool()).ScanShipment(r.Context(), logistics.ScanInput{
		ShipmentID: uuid.UUID(shipmentId),
		HubID:      hubID,
		VehicleID:  vehicleID,
		ScanType:   string(body.ScanType),
		Location:   strings.TrimSpace(body.Location),
		Lat:        lat,
		Lon:        lon,
		ActorID:    logisticsActorID(r),
	})
	switch {
	case errors.Is(err, logistics.ErrNotFound):
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
	case errors.Is(err, logistics.ErrFrozen):
		writeError(w, http.StatusConflict, "SHIPMENT_FROZEN", "Shipment is frozen — all movement is blocked")
	case errors.Is(err, logistics.ErrStatusGate):
		writeError(w, http.StatusConflict, "SHIPMENT_STATUS_CONFLICT", "Shipment cannot be scanned in its current state")
	case errors.Is(err, logistics.ErrHubNotFound):
		writeError(w, http.StatusNotFound, "HUB_NOT_FOUND", "Hub not found")
	case errors.Is(err, logistics.ErrVehicleNotFound):
		writeError(w, http.StatusNotFound, "VEHICLE_NOT_FOUND", "Vehicle not found")
	case err != nil:
		s.logger.Error("scan shipment failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenCustodyEntry(event))
}

// ---- hubs ----

// ListHubs returns the consolidation hubs (GET /hubs).
func (s *Server) ListHubs(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	hubs, err := logistics.NewStore(s.db.Pool()).ListHubs(r.Context())
	if err != nil {
		s.logger.Error("list hubs failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Hub, 0, len(hubs))
	for _, h := range hubs {
		out = append(out, toGenHub(h))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateHub adds a consolidation hub (POST /hubs, 201). name is required; a
// cityId is resolved to the city name best-effort (00004 cities).
func (s *Server) CreateHub(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateHubJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	in := logistics.HubInput{Name: body.Name}
	if uuid.UUID(body.CityId) != uuid.Nil {
		cityID := uuid.UUID(body.CityId)
		in.CityID = &cityID
		in.City = s.cityName(r, cityID)
	}
	if body.Capacity != nil {
		in.Capacity = body.Capacity
	}
	if body.Active != nil {
		in.Active = body.Active
	}
	hub, err := logistics.NewStore(s.db.Pool()).CreateHub(r.Context(), in)
	if errors.Is(err, logistics.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "CONFLICT", "Hub code is already in use")
		return
	}
	if err != nil {
		s.logger.Error("create hub failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenHub(hub))
}

// ---- vehicles ----

// ListVehicles returns the vehicle registry (GET /vehicles).
func (s *Server) ListVehicles(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	vehicles, err := logistics.NewStore(s.db.Pool()).ListVehicles(r.Context())
	if err != nil {
		s.logger.Error("list vehicles failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Vehicle, 0, len(vehicles))
	for _, v := range vehicles {
		out = append(out, toGenVehicle(v))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateVehicle registers a vehicle (POST /vehicles, 201). The contract's
// rich vehicleType enum collapses onto the store's bike/van/truck lanes; a
// duplicate registration is 409 CONFLICT.
func (s *Server) CreateVehicle(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateVehicleJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in, ok := vehicleInput(body.Registration, body.VehicleType, body.Status, body.Capacity, nil)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "registration, vehicleType and status are invalid")
		return
	}
	if body.OperatorId != nil {
		// The contract allows an operator binding; vehicles are hub-parked in
		// this milestone, so the binding is not persisted (documented).
		_ = body.OperatorId
	}
	vehicle, err := logistics.NewStore(s.db.Pool()).CreateVehicle(r.Context(), in)
	if errors.Is(err, logistics.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "CONFLICT", "Vehicle registration is already in use")
		return
	}
	if err != nil {
		s.logger.Error("create vehicle failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenVehicle(vehicle))
}

// UpdateVehicle patches a vehicle (PATCH /vehicles/{vehicleId}); a missing
// vehicle is 404 VEHICLE_NOT_FOUND.
func (s *Server) UpdateVehicle(w http.ResponseWriter, r *http.Request, vehicleId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.UpdateVehicleJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	in, ok := vehicleInput(body.Registration, body.VehicleType, body.Status, body.Capacity, &vehicleId)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "registration, vehicleType and status are invalid")
		return
	}
	vehicle, err := logistics.NewStore(s.db.Pool()).UpdateVehicle(r.Context(), uuid.UUID(vehicleId), in)
	switch {
	case errors.Is(err, logistics.ErrVehicleNotFound):
		writeError(w, http.StatusNotFound, "VEHICLE_NOT_FOUND", "Vehicle not found")
	case errors.Is(err, logistics.ErrAlreadyExists):
		writeError(w, http.StatusConflict, "CONFLICT", "Vehicle registration is already in use")
	case err != nil:
		s.logger.Error("update vehicle failed", "vehicle", vehicleId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenVehicle(vehicle))
}

// ---- containers ----

// ListContainers returns the logistics containers (GET /containers).
func (s *Server) ListContainers(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	containers, err := logistics.NewStore(s.db.Pool()).ListContainers(r.Context())
	if err != nil {
		s.logger.Error("list containers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Container, 0, len(containers))
	for _, c := range containers {
		out = append(out, toGenContainer(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateContainer adds a grouping container (POST /containers, 201).
// containerId (the barcode) and kind are required; a duplicate containerId is
// 409 CONFLICT.
func (s *Server) CreateContainer(w http.ResponseWriter, r *http.Request) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.CreateContainerJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.ContainerId = strings.TrimSpace(body.ContainerId)
	if body.ContainerId == "" || !body.Kind.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "containerId and kind are required")
		return
	}
	if body.Section != nil && !body.Section.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "section is invalid")
		return
	}
	in := logistics.ContainerInput{Code: body.ContainerId, Kind: string(body.Kind)}
	if body.Section != nil {
		section := string(*body.Section)
		in.Section = &section
	}
	container, err := logistics.NewStore(s.db.Pool()).CreateContainer(r.Context(), in)
	if errors.Is(err, logistics.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "CONFLICT", "Container code is already in use")
		return
	}
	if err != nil {
		s.logger.Error("create container failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenContainer(container))
}

// ---- admin ops ----

// The freeze/unfreeze endpoints are the ops-manager surface (LOGISTICS-OS.md
// §27); routePolicy already gates /admin/ to staff+MFA and the handler
// re-checks the role against the shared staff set (support.go isStaffRole).

// AdminFreezeShipment halts all movement on a shipment (POST
// /admin/shipments/{shipmentId}/freeze): status becomes frozen and every
// movement endpoint returns SHIPMENT_FROZEN. A delivered shipment cannot be
// frozen (409 SHIPMENT_NOT_FREEZABLE).
func (s *Server) AdminFreezeShipment(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	s.adminShipmentHold(w, r, shipmentId, false)
}

// AdminUnfreezeShipment lifts the ops hold and resumes the shipment (POST
// /admin/shipments/{shipmentId}/unfreeze). A shipment that is not frozen is
// 409 SHIPMENT_NOT_UNFREEZABLE.
func (s *Server) AdminUnfreezeShipment(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	s.adminShipmentHold(w, r, shipmentId, true)
}

func (s *Server) adminShipmentHold(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID, unfreeze bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !isStaffRole(claims.Role) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only staff sessions may manage shipment holds")
		return
	}
	if s.db == nil {
		s.logger.Error("admin shipment hold failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	reason, ok := shipmentHoldReason(w, r, unfreeze)
	if !ok {
		return
	}
	st := logistics.NewStore(s.db.Pool())
	var (
		row logistics.ShipmentRow
		err error
	)
	if unfreeze {
		row, err = st.UnfreezeShipment(r.Context(), uuid.UUID(shipmentId), reason, logisticsActorID(r))
	} else {
		row, err = st.FreezeShipment(r.Context(), uuid.UUID(shipmentId), reason, logisticsActorID(r))
	}
	switch {
	case errors.Is(err, logistics.ErrNotFound):
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
		return
	case errors.Is(err, logistics.ErrNotFreezable):
		writeError(w, http.StatusConflict, "SHIPMENT_NOT_FREEZABLE", "A delivered shipment cannot be frozen")
		return
	case errors.Is(err, logistics.ErrNotUnfreezable):
		writeError(w, http.StatusConflict, "SHIPMENT_NOT_UNFREEZABLE", "Shipment is not frozen")
		return
	case err != nil:
		s.logger.Error("admin shipment hold failed", "shipment", shipmentId, "unfreeze", unfreeze, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	detail, err := st.GetShipmentDetail(r.Context(), row.ID)
	if err != nil {
		s.logger.Error("reload shipment failed", "shipment", row.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenShipment(detail.Shipment, detail.Packages))
}

// shipmentHoldReason decodes the freeze/unfreeze body (both carry the same
// required reason) and returns the trimmed reason.
func shipmentHoldReason(w http.ResponseWriter, r *http.Request, unfreeze bool) (string, bool) {
	if unfreeze {
		var b gen.AdminUnfreezeShipmentJSONRequestBody
		if err := decodeJSON(r, &b); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
			return "", false
		}
		if strings.TrimSpace(b.Reason) == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
			return "", false
		}
		return strings.TrimSpace(b.Reason), true
	}
	var b gen.AdminFreezeShipmentJSONRequestBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return "", false
	}
	if strings.TrimSpace(b.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return "", false
	}
	return strings.TrimSpace(b.Reason), true
}

// ---- mapping helpers ----

// toGenShipment maps a shipment row (and optionally its packages) onto the
// contract Shipment. The stored statuses are translated to the contract
// vocabulary (pending -> planned; the store has no picked_up state).
func toGenShipment(row logistics.ShipmentRow, packages []logistics.PackageRow) gen.Shipment {
	out := gen.Shipment{
		Id:             newUUID(row.ID.String()),
		ShipmentNumber: row.WaybillNumber,
		Status:         toGenShipmentStatus(row.Status),
		CreatedAt:      &row.CreatedAt,
	}
	if row.OrderID != nil {
		out.OrderId = newUUID(row.OrderID.String())
	}
	if row.Frozen {
		out.FrozenAt = row.FrozenAt
		out.FrozenReason = row.FrozenReason
	}
	if packages != nil {
		out.Packages = &[]gen.Package{}
		for _, p := range packages {
			*out.Packages = append(*out.Packages, toGenPackage(p))
		}
	}
	return out
}

// toGenShipmentStatus maps a stored shipment status onto the contract enum.
func toGenShipmentStatus(db string) gen.ShipmentStatus {
	switch db {
	case logistics.StatusPending:
		return gen.ShipmentStatusPlanned
	case logistics.StatusAtHub:
		return gen.ShipmentStatusAtHub
	case logistics.StatusInTransit:
		return gen.ShipmentStatusInTransit
	case logistics.StatusOutForDelivery:
		return gen.ShipmentStatusOutForDelivery
	case logistics.StatusDelivered:
		return gen.ShipmentStatusDelivered
	case logistics.StatusException:
		return gen.ShipmentStatusException
	case logistics.StatusFrozen:
		return gen.ShipmentStatusFrozen
	}
	return gen.ShipmentStatusException
}

// logisticsStatusToDB maps a contract list-filter status onto the stored
// vocabulary; "" marks an unknown value.
func logisticsStatusToDB(contract string) string {
	switch contract {
	case "planned", "picked_up":
		return logistics.StatusPending
	case "at_hub":
		return logistics.StatusAtHub
	case "in_transit":
		return logistics.StatusInTransit
	case "out_for_delivery":
		return logistics.StatusOutForDelivery
	case "delivered":
		return logistics.StatusDelivered
	case "exception":
		return logistics.StatusException
	}
	return ""
}

// toGenPackage maps a packages row onto the contract Package. The contract
// packageId (GS1-style, LOGISTICS-OS.md §3) is derived deterministically from
// the row id.
func toGenPackage(p logistics.PackageRow) gen.Package {
	out := gen.Package{
		Id:         newUUID(p.ID.String()),
		ShipmentId: newUUID(p.ShipmentID.String()),
		PackageId:  "PKG-" + strings.ToUpper(p.ID.String()[:6]),
		Attributes: struct {
			AllowedModes    *[]gen.PackageAttributesAllowedModes `json:"allowedModes,omitempty"`
			Compatible      bool                                 `json:"compatible"`
			Fragile         *bool                                `json:"fragile,omitempty"`
			Hazardous       *bool                                `json:"hazardous,omitempty"`
			HighValue       *bool                                `json:"highValue,omitempty"`
			MaxTransitHours *int                                 `json:"maxTransitHours,omitempty"`
			Temperature     *gen.PackageAttributesTemperature    `json:"temperature,omitempty"`
			VolumeL         *float32                             `json:"volumeL,omitempty"`
			WeightKg        *float32                             `json:"weightKg,omitempty"`
		}{Compatible: true},
	}
	if p.WeightKg != nil {
		v := float32(*p.WeightKg)
		out.Attributes.WeightKg = &v
	}
	if p.VolumeL != nil {
		v := float32(*p.VolumeL)
		out.Attributes.VolumeL = &v
	}
	if v, ok := p.Attributes["compatible"].(bool); ok {
		out.Attributes.Compatible = v
	}
	if v, ok := p.Attributes["temperature"].(string); ok && v != "" {
		t := gen.PackageAttributesTemperature(v)
		out.Attributes.Temperature = &t
	}
	if v, ok := p.Attributes["fragile"].(bool); ok {
		out.Attributes.Fragile = &v
	}
	if v, ok := p.Attributes["hazardous"].(bool); ok {
		out.Attributes.Hazardous = &v
	}
	if v, ok := p.Attributes["highValue"].(bool); ok {
		out.Attributes.HighValue = &v
	}
	return out
}

// toGenCustodyEntry maps a ledger row onto the contract CustodyEntry. Event
// statuses outside the contract enum (created/frozen/unfrozen) surface as the
// generic handoff entry with the note carrying the detail.
func toGenCustodyEntry(e logistics.EventRow) gen.CustodyEntry {
	out := gen.CustodyEntry{
		Id:         newUUID(e.ID.String()),
		ShipmentId: newUUID(e.ShipmentID.String()),
		EventType:  custodyEventType(e.Status),
		At:         e.At,
	}
	if e.By != nil {
		id := newUUID(e.By.String())
		out.ActorId = &id
		actor := gen.CustodyEntryActorType("system")
		out.ActorType = &actor
	}
	if e.HubID != nil {
		id := newUUID(e.HubID.String())
		out.HubId = &id
	}
	if e.VehicleID != nil {
		id := newUUID(e.VehicleID.String())
		out.VehicleId = &id
	}
	if e.Lat != nil {
		v := float32(*e.Lat)
		out.Lat = &v
	}
	if e.Lon != nil {
		v := float32(*e.Lon)
		out.Lon = &v
	}
	if e.Note != nil {
		out.Evidence = e.Note
	}
	state := e.Status
	out.NewState = &state
	return out
}

// custodyEventType maps a stored event status onto the contract
// CustodyEntry.eventType enum.
func custodyEventType(status string) gen.CustodyEntryEventType {
	switch status {
	case "picked_up":
		return gen.CustodyEntryEventTypePickedUp
	case "hub_in":
		return gen.CustodyEntryEventTypeHubIn
	case "departed":
		return gen.CustodyEntryEventTypeDeparted
	case "vehicle_loaded":
		return gen.CustodyEntryEventTypeVehicleLoaded
	case "unloaded":
		return gen.CustodyEntryEventTypeUnloaded
	case "handoff":
		return gen.CustodyEntryEventTypeHandoff
	case "out_for_delivery":
		return gen.CustodyEntryEventTypeOutForDelivery
	case "arrived":
		return gen.CustodyEntryEventTypeArrived
	case "container_loaded":
		return gen.CustodyEntryEventTypeContainerLoaded
	case "sorted":
		return gen.CustodyEntryEventTypeSorted
	case "delivered":
		return gen.CustodyEntryEventTypeDelivered
	}
	return gen.CustodyEntryEventTypeHandoff
}

// toGenHub maps a hubs row onto the contract Hub. cityId is the stored city
// reference (zero uuid when the hub has no city); the address field is not
// persisted at this milestone.
func toGenHub(h logistics.HubRow) gen.Hub {
	out := gen.Hub{
		Id:     newUUID(h.ID.String()),
		Name:   h.Name,
		CityId: uuidToGen(h.CityID),
	}
	if h.Capacity != 0 {
		out.Capacity = &h.Capacity
	}
	active := h.Active
	out.Active = &active
	return out
}

// uuidToGen converts a *uuid.UUID to the contract UUID type (zero uuid for
// nil — contract fields marked required cannot stay empty).
func uuidToGen(id *uuid.UUID) openapi_types.UUID {
	if id == nil {
		return newUUID(uuid.Nil.String())
	}
	return newUUID(id.String())
}

// toGenVehicle maps a vehicles row onto the contract Vehicle. The stored
// lane (bike/van/truck) maps to the contract's representative enum value;
// the contract's capacity.compartments and location objects are not stored
// at this milestone.
func toGenVehicle(v logistics.VehicleRow) gen.Vehicle {
	out := gen.Vehicle{
		Id:           newUUID(v.ID.String()),
		Registration: v.Plate,
		VehicleType:  genVehicleType(v.VehicleType),
	}
	if v.CapacityKg > 0 {
		out.Capacity = &struct {
			Compartments *[]struct {
				Capacity     int                                 `json:"capacity"`
				Name         gen.VehicleCapacityCompartmentsName `json:"name"`
				Used         *int                                `json:"used,omitempty"`
				UsedVolumeL  *float32                            `json:"usedVolumeL,omitempty"`
				UsedWeightKg *float32                            `json:"usedWeightKg,omitempty"`
			} `json:"compartments,omitempty"`
			MaxVolumeL  *float32 `json:"maxVolumeL,omitempty"`
			MaxWeightKg *float32 `json:"maxWeightKg,omitempty"`
			TotalUnits  *int     `json:"totalUnits,omitempty"`
		}{MaxWeightKg: float32Ptr(v.CapacityKg)}
	}
	status := gen.VehicleStatus(v.Status)
	out.Status = &status
	return out
}

// toGenContainer maps a containers row onto the contract Container. sealed
// derives from the stored status; containerId is the barcode.
func toGenContainer(c logistics.ContainerRow) gen.Container {
	out := gen.Container{
		Id:          newUUID(c.ID.String()),
		ContainerId: c.Code,
		Kind:        gen.ContainerKind(c.Kind),
		CreatedAt:   &c.CreatedAt,
	}
	if c.Section != nil {
		section := gen.ContainerSection(*c.Section)
		out.Section = &section
	}
	sealed := c.Status == logistics.ContainerStatusSealed
	out.Sealed = &sealed
	out.SealedAt = c.SealedAt
	return out
}

// vehicleInput builds the store input from the contract body. The contract's
// vehicleType enum collapses onto the store lanes: motorcycle/e_bike/bicycle
// -> bike, van -> van, the line-haul/refrigerated/car types -> truck. The
// contract on_trip status is not storable (the store tracks no trip binding)
// and is rejected.
func vehicleInput(registration string, vehicleType gen.VehicleVehicleType, status *gen.VehicleStatus, capacity *struct {
	Compartments *[]struct {
		Capacity     int                                 `json:"capacity"`
		Name         gen.VehicleCapacityCompartmentsName `json:"name"`
		Used         *int                                `json:"used,omitempty"`
		UsedVolumeL  *float32                            `json:"usedVolumeL,omitempty"`
		UsedWeightKg *float32                            `json:"usedWeightKg,omitempty"`
	} `json:"compartments,omitempty"`
	MaxVolumeL  *float32 `json:"maxVolumeL,omitempty"`
	MaxWeightKg *float32 `json:"maxWeightKg,omitempty"`
	TotalUnits  *int     `json:"totalUnits,omitempty"`
}, vehicleID *openapi_types.UUID) (logistics.VehicleInput, bool) {
	in := logistics.VehicleInput{Plate: strings.TrimSpace(registration)}
	storeType, ok := dbVehicleType(vehicleType)
	if !ok {
		return in, false
	}
	in.VehicleType = storeType
	if status != nil {
		switch *status {
		case gen.VehicleStatusActive, gen.VehicleStatusMaintenance, gen.VehicleStatusRetired:
			in.Status = string(*status)
		default:
			// on_trip requires trip binding (trips bounded context); rejected.
			return in, false
		}
	} else {
		in.Status = "active"
	}
	if capacity != nil && capacity.MaxWeightKg != nil {
		v := float64(*capacity.MaxWeightKg)
		in.CapacityKg = &v
	}
	return in, true
}

// dbVehicleType maps a contract vehicleType onto the store lane; the second
// return reports whether the value is known.
func dbVehicleType(v gen.VehicleVehicleType) (string, bool) {
	switch v {
	case gen.VehicleVehicleTypeMotorcycle, gen.VehicleVehicleTypeEBike, gen.VehicleVehicleTypeBicycle:
		return "bike", true
	case gen.VehicleVehicleTypeVan:
		return "van", true
	case gen.VehicleVehicleTypeCar, gen.VehicleVehicleTypeLinehaulBus, gen.VehicleVehicleTypeLinehaulTruck, gen.VehicleVehicleTypeRefrigeratedTruck:
		return "truck", true
	}
	return "", false
}

// genVehicleType maps a store lane back to the contract's representative enum
// value.
func genVehicleType(lane string) gen.VehicleVehicleType {
	switch lane {
	case "bike":
		return gen.VehicleVehicleTypeMotorcycle
	case "van":
		return gen.VehicleVehicleTypeVan
	default:
		return gen.VehicleVehicleTypeLinehaulTruck
	}
}

// cityName resolves a city id to its name (00004 cities), best-effort: a
// missing city yields "".
func (s *Server) cityName(r *http.Request, cityID uuid.UUID) *string {
	var name string
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT name FROM cities WHERE id = $1`, cityID).Scan(&name); err != nil {
		return nil
	}
	return &name
}

func float32Ptr(v float64) *float32 {
	out := float32(v)
	return &out
}
