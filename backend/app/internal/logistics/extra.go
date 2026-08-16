// LOGISTICS-EXTRA bounded context (backend/LOGISTICS-OS.md,
// backend/INTERCITY-LOGISTICS.md, API-CONTRACT.yaml /routes /warehouses
// /carriers /facilities /linehaul/consignments /delivery-exceptions): the
// corridor routes between hubs, the regional warehouse registry, the
// third-party carrier registry, secure facilities, line-haul consignments
// (batches of orders on a route/carrier) and the delivery-exception catalog.
//
// The consignment state machine (consignments.status CHECK, migration 00041)
// is assembling -> sealed -> departed -> arrived. Seal is an ops-side action
// with no contract endpoint at this milestone; the HTTP surface drives
// create/depart/arrive and the store exposes the full state machine.
//
// The delivery_exceptions.kind column keeps the reduced stored vocabulary
// (delay/damage/address/weather/other); the 18-kind contract catalog is
// mapped onto it in the API layer.
package logistics

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors for the extra lane, surfaced to the API layer as the
// ERROR-CODES.md envelopes (ROUTE_NOT_FOUND, WAREHOUSE_NOT_FOUND,
// CARRIER_NOT_FOUND, CARRIER_UNAVAILABLE, FACILITY_NOT_FOUND,
// CONSIGNMENT_NOT_FOUND, CONSIGNMENT_FULL, CONSIGNMENT_ALREADY_DEPARTED,
// CAPACITY_WEIGHT_EXCEEDED, EXCEPTION_NOT_FOUND, EXCEPTION_ALREADY_RESOLVED).
// ErrShipmentNotFound is shared with the ops lane (same package).
var (
	ErrRouteNotFound              = errors.New("logistics: route not found")
	ErrWarehouseNotFound          = errors.New("logistics: warehouse not found")
	ErrCarrierNotFound            = errors.New("logistics: carrier not found")
	ErrCarrierUnavailable         = errors.New("logistics: carrier unavailable")
	ErrFacilityNotFound           = errors.New("logistics: facility not found")
	ErrConsignmentNotFound        = errors.New("logistics: consignment not found")
	ErrConsignmentFull            = errors.New("logistics: consignment is full")
	ErrConsignmentAlreadyDeparted = errors.New("logistics: consignment is not in a mutable state")
	ErrCapacityWeightExceeded     = errors.New("logistics: consignment weight exceeds capacity")
	ErrExceptionNotFound          = errors.New("logistics: delivery exception not found")
	ErrExceptionAlreadyResolved   = errors.New("logistics: delivery exception already resolved")
)

// Stored vocabularies (consignments/carriers/warehouses/delivery_exceptions
// CHECK constraints, migration 00041).
const (
	ConsignmentStatusAssembling = "assembling"
	ConsignmentStatusSealed     = "sealed"
	ConsignmentStatusDeparted   = "departed"
	ConsignmentStatusArrived    = "arrived"
	ExceptionStatusOpen         = "open"
	ExceptionStatusResolved     = "resolved"
	CarrierModeLinehaul         = "linehaul"
	CarrierModeAir              = "air"
	CarrierModeRail             = "rail"
	CarrierStatusActive         = "active"
	CarrierStatusSuspended      = "suspended"
	WarehouseStatusActive       = "active"
	WarehouseStatusOutOfService = "out_of_service"
	FacilityKindHub             = "hub"
	ExceptionKindDelay          = "delay"
	ExceptionKindDamage         = "damage"
	ExceptionKindAddress        = "address"
	ExceptionKindWeather        = "weather"
	ExceptionKindOther          = "other"
)

// maxConsignmentOrders is the manifest ceiling per consignment
// (CONSIGNMENT_FULL beyond it; orders carry no weight at this milestone, so
// the manifest length is the only capacity signal).
const maxConsignmentOrders = 50

// ExtraStore wraps the connection pool for the logistics-extra persistence.
// It is a distinct store type from the core Store (separate lane, same pool).
type ExtraStore struct {
	pool *pgxpool.Pool
}

// NewExtraStore returns an ExtraStore bound to the given pool.
func NewExtraStore(pool *pgxpool.Pool) *ExtraStore {
	return &ExtraStore{pool: pool}
}

// RouteRow is one routes row.
type RouteRow struct {
	ID               uuid.UUID
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	DistanceKm       float64
	DurationMinutes  int
	Active           bool
	CreatedAt        time.Time
}

// RouteInput is the input shape for creating a route.
type RouteInput struct {
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	DistanceKm       *float64
	DurationMinutes  *int
	Active           *bool
}

// WarehouseRow is one warehouses row.
type WarehouseRow struct {
	ID         uuid.UUID
	Name       string
	City       *string
	CapacityKg float64
	Status     string
	CreatedAt  time.Time
}

// WarehouseInput is the input shape for creating a warehouse.
type WarehouseInput struct {
	Name       string
	City       *string
	CapacityKg *float64
	Status     *string
}

// CarrierRow is one carriers row. Mode keeps the reduced stored vocabulary
// (linehaul/air/rail); Regions is the jsonb regions column.
type CarrierRow struct {
	ID        uuid.UUID
	Name      string
	Mode      string
	Regions   []string
	Status    string
	CreatedAt time.Time
}

// CarrierInput is the input shape for creating a carrier.
type CarrierInput struct {
	Name    string
	Mode    string
	Regions []string
	Status  *string
}

// FacilityRow is one facilities row.
type FacilityRow struct {
	ID        uuid.UUID
	Name      string
	Kind      string
	HubID     *uuid.UUID
	City      *string
	CreatedAt time.Time
}

// FacilityInput is the input shape for creating a facility.
type FacilityInput struct {
	Name  string
	Kind  string
	HubID *uuid.UUID
	City  *string
}

// ConsignmentRow is one consignments row. OrderIDs is the jsonb order_ids
// manifest column.
type ConsignmentRow struct {
	ID               uuid.UUID
	Code             string
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	RouteID          uuid.UUID
	CarrierID        *uuid.UUID
	Status           string
	CapacityKg       float64
	WeightKg         float64
	OrderIDs         []uuid.UUID
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// CreateConsignmentInput is the input shape for creating a consignment. The
// route must exist (ErrRouteNotFound) and the carrier must be active
// (ErrCarrierUnavailable); the payload weight may not exceed the capacity
// (ErrCapacityWeightExceeded).
type CreateConsignmentInput struct {
	RouteID          uuid.UUID
	CarrierID        uuid.UUID
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	CapacityKg       *float64
	WeightKg         *float64
	OrderIDs         []uuid.UUID
}

// ExceptionRow is one delivery_exceptions row.
type ExceptionRow struct {
	ID          uuid.UUID
	ShipmentID  uuid.UUID
	Kind        string
	Description *string
	Status      string
	CreatedAt   time.Time
	ResolvedAt  *time.Time
}

const routeColumns = `id, origin_hub_id, destination_hub_id, distance_km, duration_minutes, active, created_at`

const warehouseColumns = `id, name, city, capacity_kg, status, created_at`

const carrierColumns = `id, name, mode, regions, status, created_at`

const facilityColumns = `id, name, kind, hub_id, city, created_at`

const consignmentColumns = `id, code, origin_hub_id, destination_hub_id, route_id, carrier_id, status,
	capacity_kg, weight_kg, order_ids, created_at, updated_at`

const exceptionColumns = `id, shipment_id, kind, description, status, created_at, resolved_at`

// ---- routes ----

// CreateRoute inserts a corridor route between two hubs. A duplicate
// (origin_hub_id, destination_hub_id) pair yields ErrAlreadyExists.
func (s *ExtraStore) CreateRoute(ctx context.Context, in RouteInput) (RouteRow, error) {
	row, err := scanRouteRow(s.pool.QueryRow(ctx,
		`INSERT INTO routes (origin_hub_id, destination_hub_id, distance_km, duration_minutes, active)
		 VALUES ($1, $2, COALESCE($3, 0.0), COALESCE($4, 0), COALESCE($5, true))
		 RETURNING `+routeColumns,
		in.OriginHubID, in.DestinationHubID, in.DistanceKm, in.DurationMinutes, in.Active))
	if isUniqueViolation(err) {
		return RouteRow{}, fmt.Errorf("logistics: create route: %w", ErrAlreadyExists)
	}
	if err != nil {
		return RouteRow{}, fmt.Errorf("logistics: create route: %w", err)
	}
	return row, nil
}

// GetRoute loads a single route; ErrRouteNotFound when absent.
func (s *ExtraStore) GetRoute(ctx context.Context, id uuid.UUID) (RouteRow, error) {
	row, err := scanRouteRow(s.pool.QueryRow(ctx,
		`SELECT `+routeColumns+` FROM routes WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return RouteRow{}, fmt.Errorf("logistics: get route %s: %w", id, ErrRouteNotFound)
	}
	if err != nil {
		return RouteRow{}, fmt.Errorf("logistics: get route %s: %w", id, err)
	}
	return row, nil
}

// FindRoute loads the active route between two hubs (the unique corridor);
// ErrRouteNotFound when the corridor is not configured.
func (s *ExtraStore) FindRoute(ctx context.Context, originHubID, destinationHubID uuid.UUID) (RouteRow, error) {
	row, err := scanRouteRow(s.pool.QueryRow(ctx,
		`SELECT `+routeColumns+` FROM routes
		 WHERE origin_hub_id = $1 AND destination_hub_id = $2 AND active = true`,
		originHubID, destinationHubID))
	if errors.Is(err, pgx.ErrNoRows) {
		return RouteRow{}, fmt.Errorf("logistics: find route %s->%s: %w", originHubID, destinationHubID, ErrRouteNotFound)
	}
	if err != nil {
		return RouteRow{}, fmt.Errorf("logistics: find route %s->%s: %w", originHubID, destinationHubID, err)
	}
	return row, nil
}

// ListRoutes returns all routes, newest first.
func (s *ExtraStore) ListRoutes(ctx context.Context) ([]RouteRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+routeColumns+` FROM routes ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list routes: %w", err)
	}
	defer rows.Close()
	out := make([]RouteRow, 0, 8)
	for rows.Next() {
		row, err := scanRouteRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan route: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate routes: %w", err)
	}
	return out, nil
}

// ---- warehouses ----

// CreateWarehouse inserts a warehouse. A blank status defaults to active.
func (s *ExtraStore) CreateWarehouse(ctx context.Context, in WarehouseInput) (WarehouseRow, error) {
	if in.Name == "" {
		return WarehouseRow{}, fmt.Errorf("logistics: create warehouse: name is required")
	}
	row, err := scanWarehouseRow(s.pool.QueryRow(ctx,
		`INSERT INTO warehouses (name, city, capacity_kg, status)
		 VALUES ($1, $2, COALESCE($3, 0.0), COALESCE($4, 'active'))
		 RETURNING `+warehouseColumns,
		in.Name, in.City, in.CapacityKg, in.Status))
	if err != nil {
		return WarehouseRow{}, fmt.Errorf("logistics: create warehouse: %w", err)
	}
	return row, nil
}

// GetWarehouse loads a single warehouse; ErrWarehouseNotFound when absent.
func (s *ExtraStore) GetWarehouse(ctx context.Context, id uuid.UUID) (WarehouseRow, error) {
	row, err := scanWarehouseRow(s.pool.QueryRow(ctx,
		`SELECT `+warehouseColumns+` FROM warehouses WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return WarehouseRow{}, fmt.Errorf("logistics: get warehouse %s: %w", id, ErrWarehouseNotFound)
	}
	if err != nil {
		return WarehouseRow{}, fmt.Errorf("logistics: get warehouse %s: %w", id, err)
	}
	return row, nil
}

// ListWarehouses returns all warehouses, newest first.
func (s *ExtraStore) ListWarehouses(ctx context.Context) ([]WarehouseRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+warehouseColumns+` FROM warehouses ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list warehouses: %w", err)
	}
	defer rows.Close()
	out := make([]WarehouseRow, 0, 8)
	for rows.Next() {
		row, err := scanWarehouseRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan warehouse: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate warehouses: %w", err)
	}
	return out, nil
}

// ---- carriers ----

// CreateCarrier registers a carrier. A blank status defaults to active; an
// empty mode is rejected (every carrier is registered for a lane).
func (s *ExtraStore) CreateCarrier(ctx context.Context, in CarrierInput) (CarrierRow, error) {
	if in.Name == "" {
		return CarrierRow{}, fmt.Errorf("logistics: create carrier: name is required")
	}
	if in.Mode == "" {
		return CarrierRow{}, fmt.Errorf("logistics: create carrier: mode is required")
	}
	regions, err := json.Marshal(in.Regions)
	if err != nil {
		return CarrierRow{}, fmt.Errorf("logistics: create carrier: marshal regions: %w", err)
	}
	row, err := scanCarrierRow(s.pool.QueryRow(ctx,
		`INSERT INTO carriers (name, mode, regions, status)
		 VALUES ($1, $2, $3, COALESCE($4, 'active'))
		 RETURNING `+carrierColumns,
		in.Name, in.Mode, regions, in.Status))
	if err != nil {
		return CarrierRow{}, fmt.Errorf("logistics: create carrier: %w", err)
	}
	return row, nil
}

// GetCarrier loads a single carrier; ErrCarrierNotFound when absent.
func (s *ExtraStore) GetCarrier(ctx context.Context, id uuid.UUID) (CarrierRow, error) {
	row, err := scanCarrierRow(s.pool.QueryRow(ctx,
		`SELECT `+carrierColumns+` FROM carriers WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return CarrierRow{}, fmt.Errorf("logistics: get carrier %s: %w", id, ErrCarrierNotFound)
	}
	if err != nil {
		return CarrierRow{}, fmt.Errorf("logistics: get carrier %s: %w", id, err)
	}
	return row, nil
}

// ListCarriers returns all carriers, newest first.
func (s *ExtraStore) ListCarriers(ctx context.Context) ([]CarrierRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+carrierColumns+` FROM carriers ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list carriers: %w", err)
	}
	defer rows.Close()
	out := make([]CarrierRow, 0, 8)
	for rows.Next() {
		row, err := scanCarrierRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan carrier: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate carriers: %w", err)
	}
	return out, nil
}

// FindActiveCarrier returns the newest active carrier serving a mode;
// ErrCarrierUnavailable when none is available (CARRIER_UNAVAILABLE in the
// API layer — the mode is not served).
func (s *ExtraStore) FindActiveCarrier(ctx context.Context, mode string) (CarrierRow, error) {
	row, err := scanCarrierRow(s.pool.QueryRow(ctx,
		`SELECT `+carrierColumns+` FROM carriers
		 WHERE mode = $1 AND status = 'active' ORDER BY created_at DESC, id LIMIT 1`,
		mode))
	if errors.Is(err, pgx.ErrNoRows) {
		return CarrierRow{}, fmt.Errorf("logistics: find active carrier for %s: %w", mode, ErrCarrierUnavailable)
	}
	if err != nil {
		return CarrierRow{}, fmt.Errorf("logistics: find active carrier for %s: %w", mode, err)
	}
	return row, nil
}

// ---- facilities ----

// CreateFacility registers a secure facility. A blank kind defaults to hub.
func (s *ExtraStore) CreateFacility(ctx context.Context, in FacilityInput) (FacilityRow, error) {
	if in.Name == "" {
		return FacilityRow{}, fmt.Errorf("logistics: create facility: name is required")
	}
	if in.Kind == "" {
		in.Kind = FacilityKindHub
	}
	row, err := scanFacilityRow(s.pool.QueryRow(ctx,
		`INSERT INTO facilities (name, kind, hub_id, city)
		 VALUES ($1, $2, $3, $4) RETURNING `+facilityColumns,
		in.Name, in.Kind, in.HubID, in.City))
	if err != nil {
		return FacilityRow{}, fmt.Errorf("logistics: create facility: %w", err)
	}
	return row, nil
}

// GetFacility loads a single facility; ErrFacilityNotFound when absent.
func (s *ExtraStore) GetFacility(ctx context.Context, id uuid.UUID) (FacilityRow, error) {
	row, err := scanFacilityRow(s.pool.QueryRow(ctx,
		`SELECT `+facilityColumns+` FROM facilities WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return FacilityRow{}, fmt.Errorf("logistics: get facility %s: %w", id, ErrFacilityNotFound)
	}
	if err != nil {
		return FacilityRow{}, fmt.Errorf("logistics: get facility %s: %w", id, err)
	}
	return row, nil
}

// ListFacilities returns all facilities, newest first.
func (s *ExtraStore) ListFacilities(ctx context.Context) ([]FacilityRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+facilityColumns+` FROM facilities ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list facilities: %w", err)
	}
	defer rows.Close()
	out := make([]FacilityRow, 0, 8)
	for rows.Next() {
		row, err := scanFacilityRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan facility: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate facilities: %w", err)
	}
	return out, nil
}

// ---- consignments ----

// CreateConsignment opens a consignment (status assembling) on a route with
// an active carrier. The route must exist (ErrRouteNotFound) and the carrier
// must be active (ErrCarrierUnavailable); a payload heavier than the
// capacity is rejected with ErrCapacityWeightExceeded. The code is
// server-assigned (CN-<8 hex>) and unique; a code collision is a coin flip
// and retried with a fresh number.
func (s *ExtraStore) CreateConsignment(ctx context.Context, in CreateConsignmentInput) (ConsignmentRow, error) {
	for attempt := 0; attempt < 3; attempt++ {
		code, err := newConsignmentCode()
		if err != nil {
			return ConsignmentRow{}, fmt.Errorf("logistics: generate consignment code: %w", err)
		}
		row, err := s.insertConsignment(ctx, in, code)
		if err == nil {
			return row, nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "consignments_code_key" {
			continue
		}
		return ConsignmentRow{}, err
	}
	return ConsignmentRow{}, fmt.Errorf("logistics: create consignment: code generation exhausted: %w", ErrAlreadyExists)
}

func (s *ExtraStore) insertConsignment(ctx context.Context, in CreateConsignmentInput, code string) (ConsignmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: begin create consignment tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var one int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM routes WHERE id = $1`, in.RouteID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return ConsignmentRow{}, fmt.Errorf("logistics: create consignment: %w", ErrRouteNotFound)
	} else if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: create consignment route check: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT 1 FROM carriers WHERE id = $1 AND status = 'active'`, in.CarrierID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return ConsignmentRow{}, fmt.Errorf("logistics: create consignment: %w", ErrCarrierUnavailable)
	} else if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: create consignment carrier check: %w", err)
	}

	capacityKg := 0.0
	if in.CapacityKg != nil {
		capacityKg = *in.CapacityKg
	}
	weightKg := 0.0
	if in.WeightKg != nil {
		weightKg = *in.WeightKg
	}
	if weightKg > capacityKg {
		return ConsignmentRow{}, fmt.Errorf("logistics: create consignment: weight %.2f exceeds capacity %.2f: %w", weightKg, capacityKg, ErrCapacityWeightExceeded)
	}

	orderIDs, err := json.Marshal(in.OrderIDs)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: create consignment: marshal orders: %w", err)
	}
	row, err := scanConsignmentRow(tx.QueryRow(ctx,
		`INSERT INTO consignments (code, origin_hub_id, destination_hub_id, route_id, carrier_id, capacity_kg, weight_kg, order_ids)
		 VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0.0), COALESCE($7, 0.0), $8) RETURNING `+consignmentColumns,
		code, in.OriginHubID, in.DestinationHubID, in.RouteID, in.CarrierID, capacityKg, weightKg, orderIDs))
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: insert consignment: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: commit create consignment: %w", err)
	}
	return row, nil
}

// GetConsignment loads a single consignment; ErrConsignmentNotFound when
// absent.
func (s *ExtraStore) GetConsignment(ctx context.Context, id uuid.UUID) (ConsignmentRow, error) {
	row, err := scanConsignmentRow(s.pool.QueryRow(ctx,
		`SELECT `+consignmentColumns+` FROM consignments WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ConsignmentRow{}, fmt.Errorf("logistics: get consignment %s: %w", id, ErrConsignmentNotFound)
	}
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: get consignment %s: %w", id, err)
	}
	return row, nil
}

// AddOrderToConsignment appends an order to the manifest of an assembling
// consignment (orders carry no weight at this milestone, so the capacity
// re-check is the manifest length ceiling). A consignment that is not
// assembling yields ErrConsignmentAlreadyDeparted; a manifest at the ceiling
// yields ErrConsignmentFull.
func (s *ExtraStore) AddOrderToConsignment(ctx context.Context, consignmentID, orderID uuid.UUID) (ConsignmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: begin add order tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := s.lockConsignment(ctx, tx, consignmentID)
	if err != nil {
		return ConsignmentRow{}, err
	}
	if row.Status != ConsignmentStatusAssembling {
		return ConsignmentRow{}, fmt.Errorf("logistics: add order %s: consignment %s is %s: %w", orderID, consignmentID, row.Status, ErrConsignmentAlreadyDeparted)
	}
	if len(row.OrderIDs) >= maxConsignmentOrders {
		return ConsignmentRow{}, fmt.Errorf("logistics: add order %s: consignment %s: %w", orderID, consignmentID, ErrConsignmentFull)
	}
	orderIDs := append(append([]uuid.UUID{}, row.OrderIDs...), orderID)
	raw, err := json.Marshal(orderIDs)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: add order %s: marshal orders: %w", orderID, err)
	}
	updated, err := scanConsignmentRow(tx.QueryRow(ctx,
		`UPDATE consignments SET order_ids = $2, updated_at = now()
		 WHERE id = $1 RETURNING `+consignmentColumns,
		consignmentID, raw))
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: add order %s: %w", orderID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: commit add order: %w", err)
	}
	return updated, nil
}

// SealConsignment moves an assembling consignment to sealed (tamper-evident
// seal before departure). Any other state yields ErrConsignmentAlreadyDeparted.
func (s *ExtraStore) SealConsignment(ctx context.Context, id uuid.UUID) (ConsignmentRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE consignments SET status = 'sealed', updated_at = now() WHERE id = $1 AND status = 'assembling'`, id)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: seal consignment %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetConsignment(ctx, id); errors.Is(err, ErrConsignmentNotFound) {
			return ConsignmentRow{}, fmt.Errorf("logistics: seal consignment %s: %w", id, ErrConsignmentNotFound)
		}
		return ConsignmentRow{}, fmt.Errorf("logistics: seal consignment %s: %w", id, ErrConsignmentAlreadyDeparted)
	}
	return s.GetConsignment(ctx, id)
}

// DepartConsignment moves a sealed consignment to departed (departure scan at
// the origin hub). A consignment that is not sealed yields
// ErrConsignmentAlreadyDeparted.
func (s *ExtraStore) DepartConsignment(ctx context.Context, id uuid.UUID) (ConsignmentRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE consignments SET status = 'departed', updated_at = now() WHERE id = $1 AND status = 'sealed'`, id)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: depart consignment %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetConsignment(ctx, id); errors.Is(err, ErrConsignmentNotFound) {
			return ConsignmentRow{}, fmt.Errorf("logistics: depart consignment %s: %w", id, ErrConsignmentNotFound)
		}
		return ConsignmentRow{}, fmt.Errorf("logistics: depart consignment %s: %w", id, ErrConsignmentAlreadyDeparted)
	}
	return s.GetConsignment(ctx, id)
}

// ArriveConsignment moves a departed consignment to arrived (arrival scan at
// the destination hub). Any other state yields ErrConsignmentAlreadyDeparted.
func (s *ExtraStore) ArriveConsignment(ctx context.Context, id uuid.UUID) (ConsignmentRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE consignments SET status = 'arrived', updated_at = now() WHERE id = $1 AND status = 'departed'`, id)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: arrive consignment %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetConsignment(ctx, id); errors.Is(err, ErrConsignmentNotFound) {
			return ConsignmentRow{}, fmt.Errorf("logistics: arrive consignment %s: %w", id, ErrConsignmentNotFound)
		}
		return ConsignmentRow{}, fmt.Errorf("logistics: arrive consignment %s: %w", id, ErrConsignmentAlreadyDeparted)
	}
	return s.GetConsignment(ctx, id)
}

// ListConsignments returns consignments, oldest first, cursor-paginated on
// (created_at, id). status filters on the contract vocabulary ("" = all;
// manifesting covers assembling+sealed; delivered/cancelled have no stored
// rows at this milestone); limit is exclusive of the sentinel row; next is
// the base64 cursor of the last returned row when another page exists, else
// "". A malformed cursor yields ErrInvalidCursor; an unknown status yields an
// error.
func (s *ExtraStore) ListConsignments(ctx context.Context, status string, limit int, cursor string) ([]ConsignmentRow, string, error) {
	statuses, ok := consignmentFilterStatuses(status)
	if !ok {
		return nil, "", fmt.Errorf("logistics: list consignments: unknown status %q", status)
	}
	query := `SELECT ` + consignmentColumns + ` FROM consignments`
	args := make([]any, 0, 5)
	conds := make([]string, 0, 2)
	if statuses != nil {
		args = append(args, statuses)
		conds = append(conds, fmt.Sprintf("status = ANY($%d)", len(args)))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: list consignments: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		conds = append(conds, fmt.Sprintf("(created_at, id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("logistics: list consignments: %w", err)
	}
	defer rows.Close()

	out := make([]ConsignmentRow, 0, limit)
	var (
		last     ConsignmentRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanConsignmentRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: scan consignment row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("logistics: iterate consignment rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// ---- delivery exceptions ----

// CreateException opens a delivery exception against a shipment. The
// shipment must exist (ErrShipmentNotFound). kind uses the reduced stored
// vocabulary (delay/damage/address/weather/other).
func (s *ExtraStore) CreateException(ctx context.Context, shipmentID uuid.UUID, kind, description string) (ExceptionRow, error) {
	var one int
	if err := s.pool.QueryRow(ctx, `SELECT 1 FROM shipments WHERE id = $1`, shipmentID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return ExceptionRow{}, fmt.Errorf("logistics: create exception: %w", ErrShipmentNotFound)
	} else if err != nil {
		return ExceptionRow{}, fmt.Errorf("logistics: create exception shipment check: %w", err)
	}
	row, err := scanExceptionRow(s.pool.QueryRow(ctx,
		`INSERT INTO delivery_exceptions (shipment_id, kind, description)
		 VALUES ($1, $2, $3) RETURNING `+exceptionColumns,
		shipmentID, kind, nilString(description)))
	if err != nil {
		return ExceptionRow{}, fmt.Errorf("logistics: create exception: %w", err)
	}
	return row, nil
}

// GetException loads a single delivery exception; ErrExceptionNotFound when
// absent.
func (s *ExtraStore) GetException(ctx context.Context, id uuid.UUID) (ExceptionRow, error) {
	row, err := scanExceptionRow(s.pool.QueryRow(ctx,
		`SELECT `+exceptionColumns+` FROM delivery_exceptions WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ExceptionRow{}, fmt.Errorf("logistics: get exception %s: %w", id, ErrExceptionNotFound)
	}
	if err != nil {
		return ExceptionRow{}, fmt.Errorf("logistics: get exception %s: %w", id, err)
	}
	return row, nil
}

// ListExceptions returns delivery exceptions, oldest first, cursor-paginated
// on (created_at, id). status filters on the contract vocabulary ("" = all;
// resolving/escalated collapse onto open at this milestone). See
// ListExceptionsByKind for the kind filter.
func (s *ExtraStore) ListExceptions(ctx context.Context, status string, limit int, cursor string) ([]ExceptionRow, string, error) {
	return s.listExceptions(ctx, "", status, limit, cursor)
}

// ListExceptionsByKind is ListExceptions with an additional stored-vocabulary
// kind filter ("" = all kinds).
func (s *ExtraStore) ListExceptionsByKind(ctx context.Context, kind, status string, limit int, cursor string) ([]ExceptionRow, string, error) {
	return s.listExceptions(ctx, kind, status, limit, cursor)
}

func (s *ExtraStore) listExceptions(ctx context.Context, kind, status string, limit int, cursor string) ([]ExceptionRow, string, error) {
	statuses, ok := exceptionFilterStatuses(status)
	if !ok {
		return nil, "", fmt.Errorf("logistics: list exceptions: unknown status %q", status)
	}
	query := `SELECT ` + exceptionColumns + ` FROM delivery_exceptions`
	args := make([]any, 0, 5)
	conds := make([]string, 0, 3)
	if kind != "" {
		args = append(args, kind)
		conds = append(conds, fmt.Sprintf("kind = $%d", len(args)))
	}
	if statuses != nil {
		args = append(args, statuses)
		conds = append(conds, fmt.Sprintf("status = ANY($%d)", len(args)))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: list exceptions: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		conds = append(conds, fmt.Sprintf("(created_at, id) > ($%d, $%d)", len(args)-1, len(args)))
	}
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("logistics: list exceptions: %w", err)
	}
	defer rows.Close()

	out := make([]ExceptionRow, 0, limit)
	var (
		last     ExceptionRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanExceptionRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: scan exception row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("logistics: iterate exception rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// ResolveException moves an open exception to resolved (resolved_at set). An
// exception that is not open yields ErrExceptionAlreadyResolved.
func (s *ExtraStore) ResolveException(ctx context.Context, id uuid.UUID) (ExceptionRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE delivery_exceptions SET status = 'resolved', resolved_at = now() WHERE id = $1 AND status = 'open'`, id)
	if err != nil {
		return ExceptionRow{}, fmt.Errorf("logistics: resolve exception %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetException(ctx, id); errors.Is(err, ErrExceptionNotFound) {
			return ExceptionRow{}, fmt.Errorf("logistics: resolve exception %s: %w", id, ErrExceptionNotFound)
		}
		return ExceptionRow{}, fmt.Errorf("logistics: resolve exception %s: %w", id, ErrExceptionAlreadyResolved)
	}
	return s.GetException(ctx, id)
}

// ---- internals ----

// lockConsignment loads a consignment row FOR UPDATE inside a transaction.
func (s *ExtraStore) lockConsignment(ctx context.Context, tx pgx.Tx, id uuid.UUID) (ConsignmentRow, error) {
	row, err := scanConsignmentRow(tx.QueryRow(ctx,
		`SELECT `+consignmentColumns+` FROM consignments WHERE id = $1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ConsignmentRow{}, fmt.Errorf("logistics: lock consignment %s: %w", id, ErrConsignmentNotFound)
	}
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: lock consignment %s: %w", id, err)
	}
	return row, nil
}

// newConsignmentCode generates a CN-<8 hex> code from 4 random bytes.
func newConsignmentCode() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("CN-%08x", b), nil
}

// consignmentFilterStatuses maps a contract list-filter status onto the
// stored statuses; the second return reports whether the value is known.
// delivered/cancelled map to no stored rows (not stored at this milestone).
func consignmentFilterStatuses(contract string) ([]string, bool) {
	switch contract {
	case "":
		return nil, true
	case "manifesting":
		return []string{ConsignmentStatusAssembling, ConsignmentStatusSealed}, true
	case "in_transit":
		return []string{ConsignmentStatusDeparted}, true
	case "at_hub":
		return []string{ConsignmentStatusArrived}, true
	case "delivered", "cancelled":
		return []string{}, true
	}
	return nil, false
}

// exceptionFilterStatuses maps a contract list-filter status onto the stored
// statuses; resolving/escalated collapse onto open at this milestone.
func exceptionFilterStatuses(contract string) ([]string, bool) {
	switch contract {
	case "":
		return nil, true
	case "open", "resolving", "escalated":
		return []string{ExceptionStatusOpen}, true
	case "resolved":
		return []string{ExceptionStatusResolved}, true
	}
	return nil, false
}

func scanRouteRow(s rowScanner) (RouteRow, error) {
	var row RouteRow
	err := s.Scan(&row.ID, &row.OriginHubID, &row.DestinationHubID, &row.DistanceKm,
		&row.DurationMinutes, &row.Active, &row.CreatedAt)
	return row, err
}

func scanWarehouseRow(s rowScanner) (WarehouseRow, error) {
	var row WarehouseRow
	err := s.Scan(&row.ID, &row.Name, &row.City, &row.CapacityKg, &row.Status, &row.CreatedAt)
	return row, err
}

func scanCarrierRow(s rowScanner) (CarrierRow, error) {
	var (
		row     CarrierRow
		regions []byte
	)
	err := s.Scan(&row.ID, &row.Name, &row.Mode, &regions, &row.Status, &row.CreatedAt)
	if err != nil {
		return CarrierRow{}, err
	}
	if len(regions) > 0 {
		_ = json.Unmarshal(regions, &row.Regions)
	}
	return row, nil
}

func scanFacilityRow(s rowScanner) (FacilityRow, error) {
	var row FacilityRow
	err := s.Scan(&row.ID, &row.Name, &row.Kind, &row.HubID, &row.City, &row.CreatedAt)
	return row, err
}

func scanConsignmentRow(s rowScanner) (ConsignmentRow, error) {
	var (
		row      ConsignmentRow
		orderIDs []byte
	)
	err := s.Scan(&row.ID, &row.Code, &row.OriginHubID, &row.DestinationHubID, &row.RouteID,
		&row.CarrierID, &row.Status, &row.CapacityKg, &row.WeightKg, &orderIDs, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return ConsignmentRow{}, err
	}
	if len(orderIDs) > 0 {
		_ = json.Unmarshal(orderIDs, &row.OrderIDs)
	}
	return row, nil
}

func scanExceptionRow(s rowScanner) (ExceptionRow, error) {
	var row ExceptionRow
	err := s.Scan(&row.ID, &row.ShipmentID, &row.Kind, &row.Description, &row.Status,
		&row.CreatedAt, &row.ResolvedAt)
	return row, err
}
