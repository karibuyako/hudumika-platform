// Package logistics is the bounded context for the physical logistics lane
// (backend/LOGISTICS-OS.md, backend/INTERCITY-LOGISTICS.md): consolidation
// hubs, the vehicle registry, grouping containers, shipments (the physical
// twin of an order), packages and the append-only shipment event ledger that
// doubles as the custody chain.
//
// Status vocabulary (shipments.status, migration 00027):
//
//	pending -> at_hub -> in_transit -> out_for_delivery -> delivered
//	            \-> exception (terminal, set by ops tooling)
//	any state -> frozen (ops hold; every movement endpoint is guarded)
//
// The first scan (pickup / hub_in) breaks a pending shipment into at_hub;
// every later movement requires the shipment to be at_hub or in_transit.
package logistics

import (
	"context"
	"crypto/rand"
	"encoding/base64"
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

// Sentinel errors surfaced to the API layer. The required set is
// ErrNotFound, ErrFrozen, ErrAlreadySealed, ErrNotFreezable and
// ErrNotUnfreezable; the extras below exist so the API layer can map the
// distinct ERROR-CODES.md envelopes (SHIPMENT_ALREADY_EXISTS,
// HUB_NOT_FOUND, ...).
var (
	ErrNotFound          = errors.New("logistics: not found")
	ErrFrozen            = errors.New("logistics: shipment is frozen")
	ErrAlreadySealed     = errors.New("logistics: container already sealed")
	ErrNotFreezable      = errors.New("logistics: shipment cannot be frozen")
	ErrNotUnfreezable    = errors.New("logistics: shipment is not frozen")
	ErrAlreadyExists     = errors.New("logistics: already exists")
	ErrStatusGate        = errors.New("logistics: status does not permit the operation")
	ErrHubNotFound       = errors.New("logistics: hub not found")
	ErrVehicleNotFound   = errors.New("logistics: vehicle not found")
	ErrContainerNotFound = errors.New("logistics: container not found")
	ErrInvalidCursor     = errors.New("logistics: invalid pagination cursor")
)

// Shipment statuses stored in the shipments table.
const (
	StatusPending          = "pending"
	StatusAtHub            = "at_hub"
	StatusInTransit        = "in_transit"
	StatusOutForDelivery   = "out_for_delivery"
	StatusDelivered        = "delivered"
	StatusException        = "exception"
	StatusFrozen           = "frozen"
	CustodyKindNone        = "none"
	CustodyKindHub         = "hub"
	CustodyKindVehicle     = "vehicle"
	CustodyKindRider       = "rider"
	ContainerStatusOpen    = "open"
	ContainerStatusSealed  = "sealed"
	ContainerStatusArrived = "arrived"
)

// Store wraps the connection pool for all logistics persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// HubRow is one row of the hubs table.
type HubRow struct {
	ID        uuid.UUID
	Name      string
	City      *string
	CityID    *uuid.UUID
	Code      *string
	Capacity  int
	Active    bool
	CreatedAt time.Time
}

// HubInput is the input shape for creating or updating a hub.
type HubInput struct {
	Name     string
	City     *string
	CityID   *uuid.UUID
	Code     *string
	Capacity *int
	Active   *bool
}

// VehicleRow is one row of the vehicles table.
type VehicleRow struct {
	ID          uuid.UUID
	HubID       *uuid.UUID
	Plate       string
	VehicleType string
	CapacityKg  float64
	Status      string
	CreatedAt   time.Time
}

// VehicleInput is the input shape for creating or updating a vehicle.
type VehicleInput struct {
	HubID       *uuid.UUID
	Plate       string
	VehicleType string
	CapacityKg  *float64
	Status      string
}

// ContainerRow is one row of the containers table.
type ContainerRow struct {
	ID        uuid.UUID
	HubID     *uuid.UUID
	Code      string
	Kind      string
	Section   *string
	Status    string
	SealedAt  *time.Time
	CreatedAt time.Time
}

// ContainerInput is the input shape for creating a container.
type ContainerInput struct {
	HubID   *uuid.UUID
	Code    string
	Kind    string
	Section *string
}

// ShipmentRow is one row of the shipments table.
type ShipmentRow struct {
	ID               uuid.UUID
	OrderID          *uuid.UUID
	WaybillNumber    string
	Status           string
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	CurrentLocation  *string
	CustodyHubID     *uuid.UUID
	CustodyKind      string
	VehicleID        *uuid.UUID
	Frozen           bool
	FrozenReason     *string
	FrozenAt         *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// PackageRow is one row of the packages table.
type PackageRow struct {
	ID         uuid.UUID
	ShipmentID uuid.UUID
	WeightKg   *float64
	VolumeL    *float64
	Attributes map[string]any
	CreatedAt  time.Time
}

// EventRow is one append-only shipment_events row.
type EventRow struct {
	ID         uuid.UUID
	ShipmentID uuid.UUID
	Status     string
	At         time.Time
	By         *uuid.UUID
	Note       *string
	HubID      *uuid.UUID
	VehicleID  *uuid.UUID
	Lat        *float64
	Lon        *float64
}

// ShipmentDetail is the full shipment projection: the row and its packages.
type ShipmentDetail struct {
	Shipment ShipmentRow
	Packages []PackageRow
}

// CreateShipmentInput is the input shape for creating a shipment.
type CreateShipmentInput struct {
	OrderID          uuid.UUID
	PackageCount     int
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	ActorID          *uuid.UUID
}

// UpdateShipmentInput carries the patchable shipment fields; nil fields are
// left unchanged.
type UpdateShipmentInput struct {
	CurrentLocation  *string
	OriginHubID      *uuid.UUID
	DestinationHubID *uuid.UUID
	CustodyKind      *string
}

// ScanInput is the input shape for a waybill scan at a hub or vehicle.
type ScanInput struct {
	ShipmentID uuid.UUID
	HubID      *uuid.UUID
	VehicleID  *uuid.UUID
	ScanType   string
	Location   string
	Lat        *float64
	Lon        *float64
	Note       string
	ActorID    *uuid.UUID
}

const shipmentColumns = `id, order_id, waybill_number, status, origin_hub_id, destination_hub_id,
	current_location, custody_hub_id, custody_kind, vehicle_id, frozen, frozen_reason,
	frozen_at, created_at, updated_at`

const packageColumns = `id, shipment_id, weight_kg, volume_l, attributes, created_at`

const eventColumns = `id, shipment_id, status, at, by, note, hub_id, vehicle_id, lat, lon`

// scanNextStatus maps a scan type to the shipment status it produces.
var scanNextStatus = map[string]string{
	"pickup":         StatusAtHub,
	"hub_in":         StatusAtHub,
	"hub_out":        StatusInTransit,
	"vehicle_load":   StatusInTransit,
	"vehicle_unload": StatusAtHub,
	"handoff":        StatusAtHub,
	"delivery":       StatusOutForDelivery,
}

// scanEventStatus maps a scan type to the custody event vocabulary stored on
// the ledger (values align with the contract CustodyEntry.eventType enum).
var scanEventStatus = map[string]string{
	"pickup":         "picked_up",
	"hub_in":         "hub_in",
	"hub_out":        "departed",
	"vehicle_load":   "vehicle_loaded",
	"vehicle_unload": "unloaded",
	"handoff":        "handoff",
	"delivery":       "out_for_delivery",
}

// scanFromStatuses gates each scan type: the current shipment status must be
// one of the listed states before the scan advances the shipment.
var scanFromStatuses = map[string][]string{
	"pickup":         {StatusPending, StatusAtHub, StatusInTransit},
	"hub_in":         {StatusPending, StatusAtHub, StatusInTransit},
	"hub_out":        {StatusAtHub, StatusInTransit},
	"vehicle_load":   {StatusAtHub, StatusInTransit},
	"vehicle_unload": {StatusAtHub, StatusInTransit},
	"handoff":        {StatusAtHub, StatusInTransit},
	"delivery":       {StatusAtHub, StatusOutForDelivery},
}

// ---- hubs ----

// CreateHub inserts a hub. A duplicate code yields ErrAlreadyExists.
func (s *Store) CreateHub(ctx context.Context, in HubInput) (HubRow, error) {
	row, err := scanHubRow(s.pool.QueryRow(ctx,
		`INSERT INTO hubs (name, city, city_id, code, capacity, active)
		 VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, true))
		 RETURNING id, name, city, city_id, code, capacity, active, created_at`,
		in.Name, in.City, in.CityID, in.Code, in.Capacity, in.Active))
	if isUniqueViolation(err) {
		return HubRow{}, fmt.Errorf("logistics: create hub: %w", ErrAlreadyExists)
	}
	if err != nil {
		return HubRow{}, fmt.Errorf("logistics: create hub: %w", err)
	}
	return row, nil
}

// GetHub loads a single hub; ErrNotFound when absent.
func (s *Store) GetHub(ctx context.Context, id uuid.UUID) (HubRow, error) {
	row, err := scanHubRow(s.pool.QueryRow(ctx,
		`SELECT id, name, city, city_id, code, capacity, active, created_at FROM hubs WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return HubRow{}, fmt.Errorf("logistics: get hub %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return HubRow{}, fmt.Errorf("logistics: get hub %s: %w", id, err)
	}
	return row, nil
}

// ListHubs returns all hubs, newest first.
func (s *Store) ListHubs(ctx context.Context) ([]HubRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, city, city_id, code, capacity, active, created_at FROM hubs ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list hubs: %w", err)
	}
	defer rows.Close()
	out := make([]HubRow, 0, 8)
	for rows.Next() {
		row, err := scanHubRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan hub: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate hubs: %w", err)
	}
	return out, nil
}

// UpdateHub patches the editable hub fields; ErrNotFound when absent and
// ErrAlreadyExists on a code collision.
func (s *Store) UpdateHub(ctx context.Context, id uuid.UUID, in HubInput) (HubRow, error) {
	row, err := scanHubRow(s.pool.QueryRow(ctx,
		`UPDATE hubs SET
			name = COALESCE($2, name),
			city = COALESCE($3, city),
			city_id = COALESCE($4, city_id),
			code = COALESCE($5, code),
			capacity = COALESCE($6, capacity),
			active = COALESCE($7, active)
		 WHERE id = $1 RETURNING id, name, city, city_id, code, capacity, active, created_at`,
		id, nilString(in.Name), in.City, in.CityID, in.Code, in.Capacity, in.Active))
	if errors.Is(err, pgx.ErrNoRows) {
		return HubRow{}, fmt.Errorf("logistics: update hub %s: %w", id, ErrNotFound)
	}
	if isUniqueViolation(err) {
		return HubRow{}, fmt.Errorf("logistics: update hub %s: %w", id, ErrAlreadyExists)
	}
	if err != nil {
		return HubRow{}, fmt.Errorf("logistics: update hub %s: %w", id, err)
	}
	return row, nil
}

// ---- vehicles ----

// CreateVehicle inserts a vehicle. A duplicate plate yields
// ErrAlreadyExists. An empty status defaults to active.
func (s *Store) CreateVehicle(ctx context.Context, in VehicleInput) (VehicleRow, error) {
	if in.Status == "" {
		in.Status = "active"
	}
	row, err := scanVehicleRow(s.pool.QueryRow(ctx,
		`INSERT INTO vehicles (hub_id, plate, vehicle_type, capacity_kg, status)
		 VALUES ($1, $2, $3, COALESCE($4, 0), $5) RETURNING id, hub_id, plate, vehicle_type, capacity_kg, status, created_at`,
		in.HubID, in.Plate, in.VehicleType, in.CapacityKg, in.Status))
	if isUniqueViolation(err) {
		return VehicleRow{}, fmt.Errorf("logistics: create vehicle: %w", ErrAlreadyExists)
	}
	if err != nil {
		return VehicleRow{}, fmt.Errorf("logistics: create vehicle: %w", err)
	}
	return row, nil
}

// GetVehicle loads a single vehicle; ErrVehicleNotFound when absent.
func (s *Store) GetVehicle(ctx context.Context, id uuid.UUID) (VehicleRow, error) {
	row, err := scanVehicleRow(s.pool.QueryRow(ctx,
		`SELECT id, hub_id, plate, vehicle_type, capacity_kg, status, created_at FROM vehicles WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return VehicleRow{}, fmt.Errorf("logistics: get vehicle %s: %w", id, ErrVehicleNotFound)
	}
	if err != nil {
		return VehicleRow{}, fmt.Errorf("logistics: get vehicle %s: %w", id, err)
	}
	return row, nil
}

// ListVehicles returns all vehicles, newest first.
func (s *Store) ListVehicles(ctx context.Context) ([]VehicleRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, hub_id, plate, vehicle_type, capacity_kg, status, created_at FROM vehicles ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list vehicles: %w", err)
	}
	defer rows.Close()
	out := make([]VehicleRow, 0, 8)
	for rows.Next() {
		row, err := scanVehicleRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan vehicle: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate vehicles: %w", err)
	}
	return out, nil
}

// UpdateVehicle patches the editable vehicle fields; ErrVehicleNotFound when
// absent and ErrAlreadyExists on a plate collision.
func (s *Store) UpdateVehicle(ctx context.Context, id uuid.UUID, in VehicleInput) (VehicleRow, error) {
	row, err := scanVehicleRow(s.pool.QueryRow(ctx,
		`UPDATE vehicles SET
			hub_id = COALESCE($2, hub_id),
			plate = COALESCE($3, plate),
			vehicle_type = COALESCE($4, vehicle_type),
			capacity_kg = COALESCE($5, capacity_kg),
			status = COALESCE($6, status)
		 WHERE id = $1 RETURNING id, hub_id, plate, vehicle_type, capacity_kg, status, created_at`,
		id, in.HubID, nilString(in.Plate), nilString(in.VehicleType), in.CapacityKg, nilString(in.Status)))
	if errors.Is(err, pgx.ErrNoRows) {
		return VehicleRow{}, fmt.Errorf("logistics: update vehicle %s: %w", id, ErrVehicleNotFound)
	}
	if isUniqueViolation(err) {
		return VehicleRow{}, fmt.Errorf("logistics: update vehicle %s: %w", id, ErrAlreadyExists)
	}
	if err != nil {
		return VehicleRow{}, fmt.Errorf("logistics: update vehicle %s: %w", id, err)
	}
	return row, nil
}

// ---- containers ----

// CreateContainer inserts a container. A duplicate code yields
// ErrAlreadyExists.
func (s *Store) CreateContainer(ctx context.Context, in ContainerInput) (ContainerRow, error) {
	row, err := scanContainerRow(s.pool.QueryRow(ctx,
		`INSERT INTO containers (hub_id, code, kind, section)
		 VALUES ($1, $2, $3, $4) RETURNING id, hub_id, code, kind, section, status, sealed_at, created_at`,
		in.HubID, in.Code, in.Kind, in.Section))
	if isUniqueViolation(err) {
		return ContainerRow{}, fmt.Errorf("logistics: create container: %w", ErrAlreadyExists)
	}
	if err != nil {
		return ContainerRow{}, fmt.Errorf("logistics: create container: %w", err)
	}
	return row, nil
}

// GetContainer loads a single container; ErrContainerNotFound when absent.
func (s *Store) GetContainer(ctx context.Context, id uuid.UUID) (ContainerRow, error) {
	row, err := scanContainerRow(s.pool.QueryRow(ctx,
		`SELECT id, hub_id, code, kind, section, status, sealed_at, created_at FROM containers WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ContainerRow{}, fmt.Errorf("logistics: get container %s: %w", id, ErrContainerNotFound)
	}
	if err != nil {
		return ContainerRow{}, fmt.Errorf("logistics: get container %s: %w", id, err)
	}
	return row, nil
}

// ListContainers returns all containers, newest first.
func (s *Store) ListContainers(ctx context.Context) ([]ContainerRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, hub_id, code, kind, section, status, sealed_at, created_at FROM containers ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("logistics: list containers: %w", err)
	}
	defer rows.Close()
	out := make([]ContainerRow, 0, 8)
	for rows.Next() {
		row, err := scanContainerRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan container: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate containers: %w", err)
	}
	return out, nil
}

// SealContainer moves an open container to sealed (tamper-evident seal,
// LOGISTICS-OS.md §5). A container that is not open yields
// ErrAlreadySealed.
func (s *Store) SealContainer(ctx context.Context, id uuid.UUID) (ContainerRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE containers SET status = 'sealed', sealed_at = now() WHERE id = $1 AND status = 'open'`, id)
	if err != nil {
		return ContainerRow{}, fmt.Errorf("logistics: seal container %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetContainer(ctx, id); errors.Is(err, ErrContainerNotFound) {
			return ContainerRow{}, fmt.Errorf("logistics: seal container %s: %w", id, ErrContainerNotFound)
		}
		return ContainerRow{}, fmt.Errorf("logistics: seal container %s: %w", id, ErrAlreadySealed)
	}
	return s.GetContainer(ctx, id)
}

// ArriveContainer moves an in_transit container to arrived (destination hub
// receipt). Any other state yields ErrStatusGate.
func (s *Store) ArriveContainer(ctx context.Context, id uuid.UUID) (ContainerRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE containers SET status = 'arrived' WHERE id = $1 AND status = 'in_transit'`, id)
	if err != nil {
		return ContainerRow{}, fmt.Errorf("logistics: arrive container %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetContainer(ctx, id); errors.Is(err, ErrContainerNotFound) {
			return ContainerRow{}, fmt.Errorf("logistics: arrive container %s: %w", id, ErrContainerNotFound)
		}
		return ContainerRow{}, fmt.Errorf("logistics: arrive container %s: %w", id, ErrStatusGate)
	}
	return s.GetContainer(ctx, id)
}

// ---- shipments ----

// CreateShipment inserts a shipment with its first ('created') event and its
// packages in one transaction. The waybill number is server-assigned
// (WB-<8 hex>) and the unique order_id constraint enforces one shipment per
// order: a concurrent or duplicate create for the same order yields
// ErrAlreadyExists (SHIPMENT_ALREADY_EXISTS in the API layer).
func (s *Store) CreateShipment(ctx context.Context, in CreateShipmentInput) (ShipmentRow, error) {
	if in.PackageCount < 1 {
		in.PackageCount = 1
	}
	for attempt := 0; attempt < 3; attempt++ {
		waybill, err := newWaybill()
		if err != nil {
			return ShipmentRow{}, fmt.Errorf("logistics: generate waybill: %w", err)
		}
		row, err := s.insertShipment(ctx, in, waybill)
		if err == nil {
			return row, nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// A waybill collision is a coin flip, retry with a fresh number;
			// an order_id collision is business truth: already shipped.
			if pgErr.ConstraintName == "shipments_waybill_number_key" {
				continue
			}
			return ShipmentRow{}, fmt.Errorf("logistics: create shipment: %w", ErrAlreadyExists)
		}
		return ShipmentRow{}, err
	}
	return ShipmentRow{}, fmt.Errorf("logistics: create shipment: waybill generation exhausted: %w", ErrAlreadyExists)
}

func (s *Store) insertShipment(ctx context.Context, in CreateShipmentInput, waybill string) (ShipmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: begin create shipment tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := scanShipmentRow(tx.QueryRow(ctx,
		`INSERT INTO shipments (order_id, waybill_number, status, origin_hub_id, destination_hub_id)
		 VALUES ($1, $2, 'pending', $3, $4) RETURNING `+shipmentColumns,
		in.OrderID, waybill, in.OriginHubID, in.DestinationHubID))
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: insert shipment: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by) VALUES ($1, 'created', $2)`,
		row.ID, in.ActorID); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: insert created event: %w", err)
	}

	for i := 0; i < in.PackageCount; i++ {
		if _, err := tx.Exec(ctx,
			`INSERT INTO packages (shipment_id, attributes) VALUES ($1, $2)`,
			row.ID, `{"compatible":true}`); err != nil {
			return ShipmentRow{}, fmt.Errorf("logistics: insert package: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: commit create shipment: %w", err)
	}
	return row, nil
}

// GetShipment loads the shipment row; ErrNotFound when absent.
func (s *Store) GetShipment(ctx context.Context, id uuid.UUID) (*ShipmentRow, error) {
	row, err := scanShipmentRow(s.pool.QueryRow(ctx,
		`SELECT `+shipmentColumns+` FROM shipments WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("logistics: get shipment %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("logistics: get shipment %s: %w", id, err)
	}
	return &row, nil
}

// GetShipmentDetail loads the shipment row and its packages (two queries).
// ErrNotFound when absent.
func (s *Store) GetShipmentDetail(ctx context.Context, id uuid.UUID) (*ShipmentDetail, error) {
	row, err := s.GetShipment(ctx, id)
	if err != nil {
		return nil, err
	}
	packages, err := s.ListPackages(ctx, id)
	if err != nil {
		return nil, err
	}
	return &ShipmentDetail{Shipment: *row, Packages: packages}, nil
}

// ListPackages returns a shipment's packages, oldest first.
func (s *Store) ListPackages(ctx context.Context, shipmentID uuid.UUID) ([]PackageRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+packageColumns+` FROM packages WHERE shipment_id = $1 ORDER BY created_at, id`, shipmentID)
	if err != nil {
		return nil, fmt.Errorf("logistics: list packages: %w", err)
	}
	defer rows.Close()
	out := make([]PackageRow, 0, 4)
	for rows.Next() {
		row, err := scanPackageRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan package: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate packages: %w", err)
	}
	return out, nil
}

// ListShipments returns shipments, newest last, cursor-paginated on
// (created_at, id). status filters on the stored status ("" = all); limit is
// exclusive of the sentinel row. next is the base64 cursor of the last
// returned row when another page exists, else "". A malformed cursor yields
// ErrInvalidCursor.
func (s *Store) ListShipments(ctx context.Context, status string, limit int, cursor string) ([]ShipmentRow, string, error) {
	query := `SELECT ` + shipmentColumns + ` FROM shipments`
	args := make([]any, 0, 5)
	conds := make([]string, 0, 2)
	if status != "" {
		args = append(args, status)
		conds = append(conds, fmt.Sprintf("status = $%d", len(args)))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: list shipments: %w", ErrInvalidCursor)
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
		return nil, "", fmt.Errorf("logistics: list shipments: %w", err)
	}
	defer rows.Close()

	out := make([]ShipmentRow, 0, limit)
	var (
		last     ShipmentRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanShipmentRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: scan shipment row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("logistics: iterate shipment rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// UpdateShipment patches the editable shipment fields. A frozen shipment is
// guarded: every patch yields ErrFrozen (SHIPMENT_FROZEN).
func (s *Store) UpdateShipment(ctx context.Context, id uuid.UUID, in UpdateShipmentInput) (ShipmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: begin update shipment tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := scanShipmentRow(tx.QueryRow(ctx,
		`UPDATE shipments SET
			current_location = COALESCE($2, current_location),
			origin_hub_id = COALESCE($3, origin_hub_id),
			destination_hub_id = COALESCE($4, destination_hub_id),
			custody_kind = COALESCE($5, custody_kind),
			updated_at = now()
		 WHERE id = $1 AND frozen = false RETURNING `+shipmentColumns,
		id, in.CurrentLocation, in.OriginHubID, in.DestinationHubID, in.CustodyKind))
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := s.GetShipment(ctx, id); errors.Is(err, ErrNotFound) {
			return ShipmentRow{}, fmt.Errorf("logistics: update shipment %s: %w", id, ErrNotFound)
		}
		return ShipmentRow{}, fmt.Errorf("logistics: update shipment %s: %w", id, ErrFrozen)
	}
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: update shipment %s: %w", id, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: commit update shipment: %w", err)
	}
	return row, nil
}

// UpdateCustody transfers hub custody of a shipment (hub-to-hub handoff). The
// transfer is only valid while the shipment is at_hub or in_transit; a frozen
// shipment is blocked with ErrFrozen. The handoff is recorded on the ledger.
func (s *Store) UpdateCustody(ctx context.Context, shipmentID uuid.UUID, hubID *uuid.UUID, kind string, by *uuid.UUID, note string) (ShipmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: begin custody tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := s.lockShipment(ctx, tx, shipmentID)
	if err != nil {
		return ShipmentRow{}, err
	}
	if err := checkMovable(row); err != nil {
		return ShipmentRow{}, err
	}
	// Custody transfers are only valid while the shipment is moving between
	// network points; a terminal or not-yet-picked-up shipment cannot hand
	// over custody.
	if row.Status != StatusAtHub && row.Status != StatusInTransit {
		return ShipmentRow{}, fmt.Errorf("logistics: custody transfer %s: status %s: %w", row.ID, row.Status, ErrStatusGate)
	}
	if hubID != nil {
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM hubs WHERE id = $1`, *hubID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
			return ShipmentRow{}, fmt.Errorf("logistics: custody transfer: %w", ErrHubNotFound)
		} else if err != nil {
			return ShipmentRow{}, fmt.Errorf("logistics: custody transfer hub check: %w", err)
		}
	}

	updated, err := scanShipmentRow(tx.QueryRow(ctx,
		`UPDATE shipments SET custody_hub_id = $2, custody_kind = $3, updated_at = now()
		 WHERE id = $1 RETURNING `+shipmentColumns,
		shipmentID, hubID, kind))
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: update custody: %w", err)
	}

	ledgerNote := "custody transfer"
	if note != "" {
		ledgerNote = note
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note, hub_id) VALUES ($1, 'handoff', $2, $3, $4)`,
		shipmentID, by, ledgerNote, hubID); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: insert custody event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: commit custody transfer: %w", err)
	}
	return updated, nil
}

// ScanShipment records a waybill scan at a hub or vehicle and advances the
// shipment status per the scan type (first scan breaks pending -> at_hub;
// departures move to in_transit; arrivals back to at_hub; a delivery scan to
// out_for_delivery). The GPS fix is sanity-checked for plausibility by the
// caller and stored on the event; strict geofence verification is skipped at
// this milestone (LOGISTICS-OS.md §14 anomaly detection). A frozen shipment
// is blocked with ErrFrozen.
func (s *Store) ScanShipment(ctx context.Context, in ScanInput) (ShipmentRow, EventRow, error) {
	nextStatus, ok := scanNextStatus[in.ScanType]
	if !ok {
		return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: scan shipment: unknown scan type %q", in.ScanType)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: begin scan tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := s.lockShipment(ctx, tx, in.ShipmentID)
	if err != nil {
		return ShipmentRow{}, EventRow{}, err
	}
	if err := checkMovable(row); err != nil {
		return ShipmentRow{}, EventRow{}, err
	}
	if !contains(scanFromStatuses[in.ScanType], row.Status) {
		return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: scan shipment %s: status %s: %w", in.ShipmentID, row.Status, ErrStatusGate)
	}
	if in.HubID != nil {
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM hubs WHERE id = $1`, *in.HubID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
			return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: scan shipment: %w", ErrHubNotFound)
		} else if err != nil {
			return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: scan shipment hub check: %w", err)
		}
	}
	if in.VehicleID != nil {
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM vehicles WHERE id = $1`, *in.VehicleID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
			return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: scan shipment: %w", ErrVehicleNotFound)
		} else if err != nil {
			return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: scan shipment vehicle check: %w", err)
		}
	}

	updated, err := scanShipmentRow(tx.QueryRow(ctx,
		`UPDATE shipments SET status = $2, current_location = $3, custody_kind = $4, vehicle_id = $5, updated_at = now()
		 WHERE id = $1 RETURNING `+shipmentColumns,
		in.ShipmentID, nextStatus, nilString(in.Location), custodyKindForScan(in.ScanType), in.VehicleID))
	if err != nil {
		return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: advance shipment on scan: %w", err)
	}

	var noteArg any
	if in.Note != "" {
		noteArg = in.Note
	}
	event, err := scanEventRow(tx.QueryRow(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note, hub_id, vehicle_id, lat, lon)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING `+eventColumns,
		in.ShipmentID, scanEventStatus[in.ScanType], in.ActorID, noteArg, in.HubID, in.VehicleID, in.Lat, in.Lon))
	if err != nil {
		return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: insert scan event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ShipmentRow{}, EventRow{}, fmt.Errorf("logistics: commit scan: %w", err)
	}
	return updated, event, nil
}

// FreezeShipment puts an ops hold on a shipment (incident, security, legal
// hold): status becomes frozen and every movement endpoint is guarded. A
// delivered shipment cannot be frozen (ErrNotFreezable).
func (s *Store) FreezeShipment(ctx context.Context, id uuid.UUID, reason string, by *uuid.UUID) (ShipmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: begin freeze tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := scanShipmentRow(tx.QueryRow(ctx,
		`UPDATE shipments SET frozen = true, status = 'frozen',
			status_before_freeze = status, frozen_reason = $2, frozen_at = now(), updated_at = now()
		 WHERE id = $1 AND status <> 'delivered' RETURNING `+shipmentColumns,
		id, nilString(reason)))
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := s.GetShipment(ctx, id); errors.Is(err, ErrNotFound) {
			return ShipmentRow{}, fmt.Errorf("logistics: freeze shipment %s: %w", id, ErrNotFound)
		}
		return ShipmentRow{}, fmt.Errorf("logistics: freeze shipment %s: %w", id, ErrNotFreezable)
	}
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: freeze shipment %s: %w", id, err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note) VALUES ($1, 'frozen', $2, $3)`,
		id, by, nilString(reason)); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: insert freeze event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: commit freeze: %w", err)
	}
	return row, nil
}

// UnfreezeShipment lifts the ops hold and resumes the shipment from its
// pre-freeze status. A shipment that is not frozen yields ErrNotUnfreezable.
func (s *Store) UnfreezeShipment(ctx context.Context, id uuid.UUID, reason string, by *uuid.UUID) (ShipmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: begin unfreeze tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := scanShipmentRow(tx.QueryRow(ctx,
		`UPDATE shipments SET frozen = false,
			status = COALESCE(status_before_freeze, 'pending'),
			status_before_freeze = NULL, updated_at = now()
		 WHERE id = $1 AND frozen = true RETURNING `+shipmentColumns,
		id))
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := s.GetShipment(ctx, id); errors.Is(err, ErrNotFound) {
			return ShipmentRow{}, fmt.Errorf("logistics: unfreeze shipment %s: %w", id, ErrNotFound)
		}
		return ShipmentRow{}, fmt.Errorf("logistics: unfreeze shipment %s: %w", id, ErrNotUnfreezable)
	}
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: unfreeze shipment %s: %w", id, err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note) VALUES ($1, 'unfrozen', $2, $3)`,
		id, by, nilString(reason)); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: insert unfreeze event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: commit unfreeze: %w", err)
	}
	return row, nil
}

// ListEvents returns the append-only ledger (custody chain) for a shipment,
// oldest first. ErrNotFound when the shipment is absent.
func (s *Store) ListEvents(ctx context.Context, shipmentID uuid.UUID) ([]EventRow, error) {
	if _, err := s.GetShipment(ctx, shipmentID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+eventColumns+` FROM shipment_events WHERE shipment_id = $1 ORDER BY at, id`, shipmentID)
	if err != nil {
		return nil, fmt.Errorf("logistics: list shipment events: %w", err)
	}
	defer rows.Close()
	out := make([]EventRow, 0, 8)
	for rows.Next() {
		row, err := scanEventRow(rows)
		if err != nil {
			return nil, fmt.Errorf("logistics: scan event: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("logistics: iterate events: %w", err)
	}
	return out, nil
}

// ---- internals ----

// lockShipment loads a shipment row FOR UPDATE inside a transaction.
func (s *Store) lockShipment(ctx context.Context, tx pgx.Tx, id uuid.UUID) (ShipmentRow, error) {
	row, err := scanShipmentRow(tx.QueryRow(ctx,
		`SELECT `+shipmentColumns+` FROM shipments WHERE id = $1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ShipmentRow{}, fmt.Errorf("logistics: lock shipment %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return ShipmentRow{}, fmt.Errorf("logistics: lock shipment %s: %w", id, err)
	}
	return row, nil
}

// checkMovable rejects every movement on a frozen shipment with ErrFrozen.
func checkMovable(row ShipmentRow) error {
	if row.Frozen {
		return fmt.Errorf("logistics: shipment %s is frozen: %w", row.ID, ErrFrozen)
	}
	return nil
}

// custodyKindForScan derives the custody kind from the scan type.
func custodyKindForScan(scanType string) string {
	switch scanType {
	case "vehicle_load", "vehicle_unload", "hub_out", "handoff":
		return CustodyKindVehicle
	case "delivery":
		return CustodyKindRider
	default:
		return CustodyKindHub
	}
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// isUniqueViolation reports whether err is a Postgres unique-violation
// (SQLSTATE 23505).
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// nilString returns a *string for the given value, or nil when empty (lets
// COALESCE leave the column untouched).
func nilString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// newWaybill generates a WB-<8 hex> tracking number from 4 random bytes.
func newWaybill() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("WB-%08x", b), nil
}

// encodeCursor packs a row's (created_at, id) keyset into a URL-safe base64
// string; parseCursor is its inverse.
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor id: %w", err)
	}
	return createdAt, id, nil
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanHubRow(s rowScanner) (HubRow, error) {
	var row HubRow
	err := s.Scan(&row.ID, &row.Name, &row.City, &row.CityID, &row.Code, &row.Capacity, &row.Active, &row.CreatedAt)
	return row, err
}

func scanVehicleRow(s rowScanner) (VehicleRow, error) {
	var row VehicleRow
	err := s.Scan(&row.ID, &row.HubID, &row.Plate, &row.VehicleType, &row.CapacityKg, &row.Status, &row.CreatedAt)
	return row, err
}

func scanContainerRow(s rowScanner) (ContainerRow, error) {
	var row ContainerRow
	err := s.Scan(&row.ID, &row.HubID, &row.Code, &row.Kind, &row.Section, &row.Status, &row.SealedAt, &row.CreatedAt)
	return row, err
}

func scanShipmentRow(s rowScanner) (ShipmentRow, error) {
	var row ShipmentRow
	err := s.Scan(&row.ID, &row.OrderID, &row.WaybillNumber, &row.Status, &row.OriginHubID,
		&row.DestinationHubID, &row.CurrentLocation, &row.CustodyHubID, &row.CustodyKind,
		&row.VehicleID, &row.Frozen, &row.FrozenReason, &row.FrozenAt, &row.CreatedAt, &row.UpdatedAt)
	return row, err
}

func scanPackageRow(s rowScanner) (PackageRow, error) {
	var (
		row        PackageRow
		attributes []byte
	)
	err := s.Scan(&row.ID, &row.ShipmentID, &row.WeightKg, &row.VolumeL, &attributes, &row.CreatedAt)
	if err != nil {
		return PackageRow{}, err
	}
	if len(attributes) > 0 {
		_ = json.Unmarshal(attributes, &row.Attributes)
	}
	return row, nil
}

func scanEventRow(s rowScanner) (EventRow, error) {
	var row EventRow
	err := s.Scan(&row.ID, &row.ShipmentID, &row.Status, &row.At, &row.By, &row.Note,
		&row.HubID, &row.VehicleID, &row.Lat, &row.Lon)
	return row, err
}
