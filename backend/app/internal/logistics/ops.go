// Package logistics is the bounded context for the logistics lane
// (backend/LOGISTICS-OS.md, backend/INTERCITY-LOGISTICS.md). ops.go owns the
// OPERATIONS half of the lane: trips (one vehicle departure over a route),
// trip legs (first_mile/line_haul/last_mile), handoffs (custody transfers
// between hubs/vehicles with seal verification) and the append-only waybill
// event trail behind /trips and /orders/{orderId}/waybill.
//
// The trips status vocabulary is planned -> in_progress -> completed
// (cancelled is terminal); a trip cannot close until every leg is completed
// (TRIP_CANNOT_CLOSE, LOGISTICS-OS.md §7). The contract vocabulary
// (loading/in_transit/unloading) is mapped in the API layer.
package logistics

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors for the ops lane. ErrHubNotFound and ErrVehicleNotFound are
// shared with the core store (same package, same HTTP mapping).
var (
	ErrTripNotFound        = errors.New("logistics: trip not found")
	ErrTripAlreadyActive   = errors.New("logistics: trip or vehicle already active")
	ErrCannotClose         = errors.New("logistics: trip cannot close with pending legs")
	ErrLegNotFound         = errors.New("logistics: leg not found")
	ErrLegAlreadyCompleted = errors.New("logistics: leg already completed")
	ErrHandoffInvalid      = errors.New("logistics: invalid handoff")
	ErrSealBroken          = errors.New("logistics: handoff seal broken")
	ErrShipmentNotFound    = errors.New("logistics: shipment not found")
	ErrWaybillInvalid      = errors.New("logistics: waybill invalid")
)

// Trip statuses (trips.status CHECK).
const (
	TripStatusPlanned    = "planned"
	TripStatusInProgress = "in_progress"
	TripStatusCompleted  = "completed"
	TripStatusCancelled  = "cancelled"
	LegStatusPending     = "pending"
	LegStatusInProgress  = "in_progress"
	LegStatusCompleted   = "completed"
	LegModeFirstMile     = "first_mile"
	LegModeLineHaul      = "line_haul"
	LegModeLastMile      = "last_mile"
	HandoffEntityHub     = "hub"
	HandoffEntityVehicle = "vehicle"
	WaybillEventDeparted = "departed"
	WaybillEventArrived  = "arrived"
	WaybillEventHandoff  = "handoff"
	WaybillEventScan     = "scan"
)

// OpsStore is the persistence layer for the logistics operations lane. It
// shares the package with the logistics core store; each lane keeps its own
// store type and row types.
type OpsStore struct {
	pool *pgxpool.Pool
}

// NewOpsStore returns an OpsStore bound to the given pool.
func NewOpsStore(pool *pgxpool.Pool) *OpsStore {
	return &OpsStore{pool: pool}
}

// TripRow is one trips row.
type TripRow struct {
	ID               uuid.UUID
	Code             string
	VehicleID        uuid.UUID
	OriginHubID      uuid.UUID
	DestinationHubID uuid.UUID
	Status           string
	PlannedDeparture *time.Time
	DepartedAt       *time.Time
	ArrivedAt        *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// TripLegRow is one trip_legs row.
type TripLegRow struct {
	ID          uuid.UUID
	TripID      uuid.UUID
	Sequence    int
	Mode        string
	FromHubID   uuid.UUID
	ToHubID     uuid.UUID
	Status      string
	CompletedAt *time.Time
	CreatedAt   time.Time
}

// HandoffRow is one handoffs row.
type HandoffRow struct {
	ID             uuid.UUID
	TripID         uuid.UUID
	LegID          *uuid.UUID
	FromEntityType string
	FromEntityID   uuid.UUID
	ToEntityType   string
	ToEntityID     uuid.UUID
	SealVerified   bool
	Note           *string
	CreatedAt      time.Time
}

// CreateHandoffInput carries the custody transfer to persist.
type CreateHandoffInput struct {
	TripID         uuid.UUID
	LegID          *uuid.UUID
	FromEntityType string
	FromEntityID   uuid.UUID
	ToEntityType   string
	ToEntityID     uuid.UUID
	SealVerified   bool
	Note           *string
}

// WaybillEventRow is one waybill_tracking row (append-only).
type WaybillEventRow struct {
	ID         uuid.UUID
	ShipmentID uuid.UUID
	TripID     *uuid.UUID
	Event      string
	At         time.Time
	Location   *string
	Note       *string
}

// WaybillRow is the waybill projection: the shipment plus its full event
// trail, oldest first.
type WaybillRow struct {
	ShipmentID    uuid.UUID
	WaybillNumber string
	OrderID       *uuid.UUID
	Status        string
	OriginHubID   *uuid.UUID
	DestHubID     *uuid.UUID
	VehicleID     *uuid.UUID
	Events        []WaybillEventRow
}

const tripColumns = `id, code, vehicle_id, origin_hub_id, destination_hub_id, status, planned_departure, departed_at, arrived_at, created_at, updated_at`

const legColumns = `id, trip_id, sequence, mode, from_hub_id, to_hub_id, status, completed_at, created_at`

const handoffColumns = `id, trip_id, leg_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, seal_verified, note, created_at`

const waybillEventColumns = `id, shipment_id, trip_id, event, at, location, note`

// CreateTrip creates a trip for a vehicle over the route origin -> destination
// and auto-creates its legs in the same transaction: first_mile +
// line_haul + last_mile when the route spans hubs, a single first_mile leg
// otherwise. The vehicle must exist and must not already be on an active
// (planned or in_progress) trip.
func (s *OpsStore) CreateTrip(ctx context.Context, vehicleID, originHubID, destHubID uuid.UUID, plannedDeparture *time.Time) (TripRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TripRow{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vehicles WHERE id = $1)`, vehicleID).Scan(&exists); err != nil {
		return TripRow{}, fmt.Errorf("vehicle existence: %w", err)
	}
	if !exists {
		return TripRow{}, ErrVehicleNotFound
	}
	for _, hubID := range []uuid.UUID{originHubID, destHubID} {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM hubs WHERE id = $1)`, hubID).Scan(&exists); err != nil {
			return TripRow{}, fmt.Errorf("hub existence: %w", err)
		}
		if !exists {
			return TripRow{}, ErrHubNotFound
		}
	}
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM trips WHERE vehicle_id = $1 AND status IN ($2, $3))`,
		vehicleID, TripStatusPlanned, TripStatusInProgress).Scan(&exists); err != nil {
		return TripRow{}, fmt.Errorf("active trip check: %w", err)
	}
	if exists {
		return TripRow{}, ErrTripAlreadyActive
	}

	code := "TRP-" + strings.ToUpper(uuid.NewString()[:8])
	trip := TripRow{}
	if err := tx.QueryRow(ctx,
		`INSERT INTO trips (code, vehicle_id, origin_hub_id, destination_hub_id, status, planned_departure)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING `+tripColumns,
		code, vehicleID, originHubID, destHubID, TripStatusPlanned, plannedDeparture,
	).Scan(&trip.ID, &trip.Code, &trip.VehicleID, &trip.OriginHubID, &trip.DestinationHubID,
		&trip.Status, &trip.PlannedDeparture, &trip.DepartedAt, &trip.ArrivedAt, &trip.CreatedAt, &trip.UpdatedAt); err != nil {
		return TripRow{}, fmt.Errorf("insert trip: %w", err)
	}

	legs := []struct {
		sequence int
		mode     string
		from     uuid.UUID
		to       uuid.UUID
	}{
		{1, LegModeFirstMile, originHubID, originHubID},
	}
	if originHubID != destHubID {
		legs = []struct {
			sequence int
			mode     string
			from     uuid.UUID
			to       uuid.UUID
		}{
			{1, LegModeFirstMile, originHubID, originHubID},
			{2, LegModeLineHaul, originHubID, destHubID},
			{3, LegModeLastMile, destHubID, destHubID},
		}
	}
	for _, leg := range legs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO trip_legs (trip_id, sequence, mode, from_hub_id, to_hub_id)
			 VALUES ($1, $2, $3, $4, $5)`,
			trip.ID, leg.sequence, leg.mode, leg.from, leg.to); err != nil {
			return TripRow{}, fmt.Errorf("insert leg %d: %w", leg.sequence, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return TripRow{}, fmt.Errorf("commit: %w", err)
	}
	return trip, nil
}

// GetTrip returns a trip by id; ErrTripNotFound when it does not exist.
func (s *OpsStore) GetTrip(ctx context.Context, id uuid.UUID) (TripRow, error) {
	row := TripRow{}
	if err := s.pool.QueryRow(ctx,
		`SELECT `+tripColumns+` FROM trips WHERE id = $1`, id,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TripRow{}, ErrTripNotFound
		}
		return TripRow{}, fmt.Errorf("get trip: %w", err)
	}
	return row, nil
}

// ListTrips returns trips filtered by status ("" for all), keyset-paginated
// by id descending after the cursor.
func (s *OpsStore) ListTrips(ctx context.Context, status string, limit int, cursor *uuid.UUID) ([]TripRow, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+tripColumns+` FROM trips
		 WHERE ($1 = '' OR status = $1) AND ($2::uuid IS NULL OR id < $2)
		 ORDER BY id DESC LIMIT $3`,
		status, cursor, limit)
	if err != nil {
		return nil, fmt.Errorf("list trips: %w", err)
	}
	defer rows.Close()
	out := []TripRow{}
	for rows.Next() {
		row := TripRow{}
		if err := rows.Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
			&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan trip: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// StartTrip advances a planned trip to in_progress and stamps departed_at.
// Guarded: only one caller wins; the rest get ErrTripAlreadyActive (or
// ErrTripNotFound when the trip does not exist).
func (s *OpsStore) StartTrip(ctx context.Context, id uuid.UUID) (TripRow, error) {
	row := TripRow{}
	err := s.pool.QueryRow(ctx,
		`UPDATE trips SET status = $1, departed_at = COALESCE(departed_at, now()), updated_at = now()
		 WHERE id = $2 AND status = $3
		 RETURNING `+tripColumns,
		TripStatusInProgress, id, TripStatusPlanned,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return TripRow{}, fmt.Errorf("start trip: %w", err)
	}
	exists, err := s.tripExists(ctx, id)
	if err != nil {
		return TripRow{}, err
	}
	if !exists {
		return TripRow{}, ErrTripNotFound
	}
	return TripRow{}, ErrTripAlreadyActive
}

// MarkDeparted idempotently stamps departed_at on an in_progress trip
// (the contract's "depart" action after the trip started).
func (s *OpsStore) MarkDeparted(ctx context.Context, id uuid.UUID) (TripRow, error) {
	row := TripRow{}
	err := s.pool.QueryRow(ctx,
		`UPDATE trips SET departed_at = COALESCE(departed_at, now()), updated_at = now()
		 WHERE id = $1 AND status = $2
		 RETURNING `+tripColumns,
		id, TripStatusInProgress,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return TripRow{}, fmt.Errorf("mark departed: %w", err)
	}
	exists, err := s.tripExists(ctx, id)
	if err != nil {
		return TripRow{}, err
	}
	if !exists {
		return TripRow{}, ErrTripNotFound
	}
	return TripRow{}, ErrTripAlreadyActive
}

// MarkArrived stamps arrived_at on an in_progress trip (the contract's
// "arrive" action, before the final complete).
func (s *OpsStore) MarkArrived(ctx context.Context, id uuid.UUID) (TripRow, error) {
	row := TripRow{}
	err := s.pool.QueryRow(ctx,
		`UPDATE trips SET arrived_at = COALESCE(arrived_at, now()), updated_at = now()
		 WHERE id = $1 AND status = $2
		 RETURNING `+tripColumns,
		id, TripStatusInProgress,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return TripRow{}, fmt.Errorf("mark arrived: %w", err)
	}
	exists, err := s.tripExists(ctx, id)
	if err != nil {
		return TripRow{}, err
	}
	if !exists {
		return TripRow{}, ErrTripNotFound
	}
	return TripRow{}, ErrCannotClose
}

// CompleteTrip closes an in_progress trip (completed + arrived_at) in a
// transaction, but only when every leg is completed — a trip with pending
// legs cannot close (TRIP_CANNOT_CLOSE, LOGISTICS-OS.md §7 reconciliation).
func (s *OpsStore) CompleteTrip(ctx context.Context, id uuid.UUID) (TripRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TripRow{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var row TripRow
	if err := tx.QueryRow(ctx,
		`SELECT `+tripColumns+` FROM trips WHERE id = $1 FOR UPDATE`, id,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TripRow{}, ErrTripNotFound
		}
		return TripRow{}, fmt.Errorf("lock trip: %w", err)
	}
	if row.Status != TripStatusInProgress {
		return TripRow{}, ErrCannotClose
	}
	var pending int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM trip_legs WHERE trip_id = $1 AND status <> $2`, id, LegStatusCompleted,
	).Scan(&pending); err != nil {
		return TripRow{}, fmt.Errorf("pending legs: %w", err)
	}
	if pending > 0 {
		return TripRow{}, ErrCannotClose
	}
	if err := tx.QueryRow(ctx,
		`UPDATE trips SET status = $1, arrived_at = COALESCE(arrived_at, now()), updated_at = now()
		 WHERE id = $2 RETURNING `+tripColumns,
		TripStatusCompleted, id,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt); err != nil {
		return TripRow{}, fmt.Errorf("complete trip: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return TripRow{}, fmt.Errorf("commit: %w", err)
	}
	return row, nil
}

// UpdateTripVehicle reassigns the vehicle of a planned trip only. The new
// vehicle must exist and must not be on another active trip.
func (s *OpsStore) UpdateTripVehicle(ctx context.Context, id, vehicleID uuid.UUID) (TripRow, error) {
	row := TripRow{}
	err := s.pool.QueryRow(ctx,
		`UPDATE trips SET vehicle_id = $1, updated_at = now()
		 WHERE id = $2 AND status = $3
		 RETURNING `+tripColumns,
		vehicleID, id, TripStatusPlanned,
	).Scan(&row.ID, &row.Code, &row.VehicleID, &row.OriginHubID, &row.DestinationHubID,
		&row.Status, &row.PlannedDeparture, &row.DepartedAt, &row.ArrivedAt, &row.CreatedAt, &row.UpdatedAt)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return TripRow{}, fmt.Errorf("update trip vehicle: %w", err)
	}
	tripExists, err := s.tripExists(ctx, id)
	if err != nil {
		return TripRow{}, err
	}
	if !tripExists {
		return TripRow{}, ErrTripNotFound
	}
	var vehicleExists, busy bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vehicles WHERE id = $1)`, vehicleID).Scan(&vehicleExists); err != nil {
		return TripRow{}, fmt.Errorf("vehicle existence: %w", err)
	}
	if !vehicleExists {
		return TripRow{}, ErrVehicleNotFound
	}
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM trips WHERE vehicle_id = $1 AND id <> $2 AND status IN ($3, $4))`,
		vehicleID, id, TripStatusPlanned, TripStatusInProgress).Scan(&busy); err != nil {
		return TripRow{}, fmt.Errorf("vehicle busy check: %w", err)
	}
	if busy {
		return TripRow{}, ErrTripAlreadyActive
	}
	return TripRow{}, ErrTripAlreadyActive
}

// CreateLeg adds a leg to an existing trip. The trip must exist; the mode is
// enforced by the CHECK constraint.
func (s *OpsStore) CreateLeg(ctx context.Context, tripID uuid.UUID, sequence int, mode string, fromHub, toHub uuid.UUID) (TripLegRow, error) {
	exists, err := s.tripExists(ctx, tripID)
	if err != nil {
		return TripLegRow{}, err
	}
	if !exists {
		return TripLegRow{}, ErrTripNotFound
	}
	row := TripLegRow{}
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO trip_legs (trip_id, sequence, mode, from_hub_id, to_hub_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING `+legColumns,
		tripID, sequence, mode, fromHub, toHub,
	).Scan(&row.ID, &row.TripID, &row.Sequence, &row.Mode, &row.FromHubID, &row.ToHubID,
		&row.Status, &row.CompletedAt, &row.CreatedAt); err != nil {
		return TripLegRow{}, fmt.Errorf("insert leg: %w", err)
	}
	return row, nil
}

// GetLeg returns a leg by id; ErrLegNotFound when it does not exist.
func (s *OpsStore) GetLeg(ctx context.Context, id uuid.UUID) (TripLegRow, error) {
	row := TripLegRow{}
	if err := s.pool.QueryRow(ctx,
		`SELECT `+legColumns+` FROM trip_legs WHERE id = $1`, id,
	).Scan(&row.ID, &row.TripID, &row.Sequence, &row.Mode, &row.FromHubID, &row.ToHubID,
		&row.Status, &row.CompletedAt, &row.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TripLegRow{}, ErrLegNotFound
		}
		return TripLegRow{}, fmt.Errorf("get leg: %w", err)
	}
	return row, nil
}

// ListLegs returns the trip's legs ordered by sequence.
func (s *OpsStore) ListLegs(ctx context.Context, tripID uuid.UUID) ([]TripLegRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+legColumns+` FROM trip_legs WHERE trip_id = $1 ORDER BY sequence, id`, tripID)
	if err != nil {
		return nil, fmt.Errorf("list legs: %w", err)
	}
	defer rows.Close()
	out := []TripLegRow{}
	for rows.Next() {
		row := TripLegRow{}
		if err := rows.Scan(&row.ID, &row.TripID, &row.Sequence, &row.Mode, &row.FromHubID, &row.ToHubID,
			&row.Status, &row.CompletedAt, &row.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan leg: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// StartLeg advances a pending leg to in_progress (the contract's "start"
// action); ErrLegAlreadyCompleted when it is past pending.
func (s *OpsStore) StartLeg(ctx context.Context, legID uuid.UUID) (TripLegRow, error) {
	row := TripLegRow{}
	err := s.pool.QueryRow(ctx,
		`UPDATE trip_legs SET status = $1 WHERE id = $2 AND status = $3 RETURNING `+legColumns,
		LegStatusInProgress, legID, LegStatusPending,
	).Scan(&row.ID, &row.TripID, &row.Sequence, &row.Mode, &row.FromHubID, &row.ToHubID,
		&row.Status, &row.CompletedAt, &row.CreatedAt)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return TripLegRow{}, fmt.Errorf("start leg: %w", err)
	}
	exists, err := s.legExists(ctx, legID)
	if err != nil {
		return TripLegRow{}, err
	}
	if !exists {
		return TripLegRow{}, ErrLegNotFound
	}
	return TripLegRow{}, ErrLegAlreadyCompleted
}

// CompleteLeg advances a pending or in_progress leg to completed (guarded);
// ErrLegAlreadyCompleted when it is already completed, ErrLegNotFound when
// the leg does not exist.
func (s *OpsStore) CompleteLeg(ctx context.Context, legID uuid.UUID) (TripLegRow, error) {
	row := TripLegRow{}
	err := s.pool.QueryRow(ctx,
		`UPDATE trip_legs SET status = $1, completed_at = COALESCE(completed_at, now())
		 WHERE id = $2 AND status IN ($3, $4) RETURNING `+legColumns,
		LegStatusCompleted, legID, LegStatusPending, LegStatusInProgress,
	).Scan(&row.ID, &row.TripID, &row.Sequence, &row.Mode, &row.FromHubID, &row.ToHubID,
		&row.Status, &row.CompletedAt, &row.CreatedAt)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return TripLegRow{}, fmt.Errorf("complete leg: %w", err)
	}
	exists, err := s.legExists(ctx, legID)
	if err != nil {
		return TripLegRow{}, err
	}
	if !exists {
		return TripLegRow{}, ErrLegNotFound
	}
	return TripLegRow{}, ErrLegAlreadyCompleted
}

// CreateHandoff records a custody transfer between a hub and/or a vehicle.
// Both entities must exist and use a known entity type; a handoff touching a
// vehicle requires the tamper-evident seal to be verified (ErrSealBroken,
// LOGISTICS-OS.md §4).
func (s *OpsStore) CreateHandoff(ctx context.Context, in CreateHandoffInput) (HandoffRow, error) {
	if (in.FromEntityType != HandoffEntityHub && in.FromEntityType != HandoffEntityVehicle) ||
		(in.ToEntityType != HandoffEntityHub && in.ToEntityType != HandoffEntityVehicle) {
		return HandoffRow{}, ErrHandoffInvalid
	}
	exists, err := s.tripExists(ctx, in.TripID)
	if err != nil {
		return HandoffRow{}, err
	}
	if !exists {
		return HandoffRow{}, ErrTripNotFound
	}
	if in.LegID != nil {
		var legTrip uuid.UUID
		if err := s.pool.QueryRow(ctx,
			`SELECT trip_id FROM trip_legs WHERE id = $1`, *in.LegID).Scan(&legTrip); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return HandoffRow{}, ErrLegNotFound
			}
			return HandoffRow{}, fmt.Errorf("handoff leg lookup: %w", err)
		}
		if legTrip != in.TripID {
			return HandoffRow{}, ErrHandoffInvalid
		}
	}
	for _, entity := range []struct {
		typ string
		id  uuid.UUID
	}{{in.FromEntityType, in.FromEntityID}, {in.ToEntityType, in.ToEntityID}} {
		var ok bool
		switch entity.typ {
		case HandoffEntityHub:
			if err := s.pool.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM hubs WHERE id = $1)`, entity.id).Scan(&ok); err != nil {
				return HandoffRow{}, fmt.Errorf("handoff hub lookup: %w", err)
			}
		case HandoffEntityVehicle:
			if err := s.pool.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM vehicles WHERE id = $1)`, entity.id).Scan(&ok); err != nil {
				return HandoffRow{}, fmt.Errorf("handoff vehicle lookup: %w", err)
			}
		}
		if !ok {
			return HandoffRow{}, ErrHandoffInvalid
		}
	}
	if (in.FromEntityType == HandoffEntityVehicle || in.ToEntityType == HandoffEntityVehicle) && !in.SealVerified {
		return HandoffRow{}, ErrSealBroken
	}
	row := HandoffRow{}
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO handoffs (trip_id, leg_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, seal_verified, note)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING `+handoffColumns,
		in.TripID, in.LegID, in.FromEntityType, in.FromEntityID, in.ToEntityType, in.ToEntityID, in.SealVerified, in.Note,
	).Scan(&row.ID, &row.TripID, &row.LegID, &row.FromEntityType, &row.FromEntityID, &row.ToEntityType, &row.ToEntityID,
		&row.SealVerified, &row.Note, &row.CreatedAt); err != nil {
		return HandoffRow{}, fmt.Errorf("insert handoff: %w", err)
	}
	return row, nil
}

// TrackEvent appends one event to the waybill trail of a shipment (the
// physical twin of an order). The shipment must exist
// (ErrShipmentNotFound); an unknown event kind is rejected before the write.
func (s *OpsStore) TrackEvent(ctx context.Context, shipmentID uuid.UUID, tripID *uuid.UUID, event, location string, note *string) (WaybillEventRow, error) {
	switch event {
	case WaybillEventDeparted, WaybillEventArrived, WaybillEventHandoff, WaybillEventScan:
	default:
		return WaybillEventRow{}, ErrWaybillInvalid
	}
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM shipments WHERE id = $1)`, shipmentID).Scan(&exists); err != nil {
		return WaybillEventRow{}, fmt.Errorf("shipment existence: %w", err)
	}
	if !exists {
		return WaybillEventRow{}, ErrShipmentNotFound
	}
	if tripID != nil {
		var tripExists bool
		if err := s.pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM trips WHERE id = $1)`, *tripID).Scan(&tripExists); err != nil {
			return WaybillEventRow{}, fmt.Errorf("trip existence: %w", err)
		}
		if !tripExists {
			return WaybillEventRow{}, ErrTripNotFound
		}
	}
	row := WaybillEventRow{}
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO waybill_tracking (shipment_id, trip_id, event, location, note)
		 VALUES ($1, $2, $3, $4, $5) RETURNING `+waybillEventColumns,
		shipmentID, tripID, event, location, note,
	).Scan(&row.ID, &row.ShipmentID, &row.TripID, &row.Event, &row.At, &row.Location, &row.Note); err != nil {
		return WaybillEventRow{}, fmt.Errorf("insert tracking event: %w", err)
	}
	return row, nil
}

// GetWaybill resolves a waybill number to its shipment (one query) plus the
// full tracking event trail (one batched query), oldest first. An unknown
// waybill number is ErrWaybillInvalid.
func (s *OpsStore) GetWaybill(ctx context.Context, waybillNumber string) (WaybillRow, error) {
	var row WaybillRow
	if err := s.pool.QueryRow(ctx,
		`SELECT id, waybill_number, order_id, status, origin_hub_id, destination_hub_id, vehicle_id
		 FROM shipments WHERE waybill_number = $1`, waybillNumber,
	).Scan(&row.ShipmentID, &row.WaybillNumber, &row.OrderID, &row.Status, &row.OriginHubID, &row.DestHubID, &row.VehicleID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WaybillRow{}, ErrWaybillInvalid
		}
		return WaybillRow{}, fmt.Errorf("get shipment by waybill: %w", err)
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+waybillEventColumns+` FROM waybill_tracking
		 WHERE shipment_id = $1 ORDER BY at, id`, row.ShipmentID)
	if err != nil {
		return WaybillRow{}, fmt.Errorf("list waybill events: %w", err)
	}
	defer rows.Close()
	row.Events = []WaybillEventRow{}
	for rows.Next() {
		event := WaybillEventRow{}
		if err := rows.Scan(&event.ID, &event.ShipmentID, &event.TripID, &event.Event, &event.At, &event.Location, &event.Note); err != nil {
			return WaybillRow{}, fmt.Errorf("scan waybill event: %w", err)
		}
		row.Events = append(row.Events, event)
	}
	return row, rows.Err()
}

// tripExists reports whether a trips row exists.
func (s *OpsStore) tripExists(ctx context.Context, id uuid.UUID) (bool, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM trips WHERE id = $1)`, id).Scan(&exists); err != nil {
		return false, fmt.Errorf("trip existence: %w", err)
	}
	return exists, nil
}

// legExists reports whether a trip_legs row exists.
func (s *OpsStore) legExists(ctx context.Context, id uuid.UUID) (bool, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM trip_legs WHERE id = $1)`, id).Scan(&exists); err != nil {
		return false, fmt.Errorf("leg existence: %w", err)
	}
	return exists, nil
}
