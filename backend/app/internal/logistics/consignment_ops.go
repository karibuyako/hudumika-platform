// CONSIGNMENT OPS (API-CONTRACT.yaml
// /linehaul/consignments/{consignmentId}/reconcile and .../replan,
// ERROR-CODES.md CONSIGNMENT_ORDER_MISMATCH / CONSIGNMENT_MISSING_ORDERS /
// TRIP_NOT_FOUND / VEHICLE_NOT_FOUND / ROUTE_NOT_FOUND / CARRIER_UNAVAILABLE):
// Reconcile compares the scanned order set against the consignment manifest
// while the consignment is sealed or departed (a loading/unloading scan) and
// stamps reconciled_at plus appends a consignment_reconciliations row on a
// full match; Replan moves an assembling/sealed consignment onto an alternate
// trip's corridor (route + carrier) or validates an alternate vehicle.
//
// The methods live on ExtraStore (migration 00052): they share the
// consignment row type, the FOR UPDATE lock and the consignments column set
// with the logistics-extra lane (extra.go) rather than duplicating them on a
// new store type. Replan resolves the trip's corridor onto a configured
// active route and the newest active line-haul carrier (the same resolution
// CreateConsignment uses); the contract's alternateVehicleId is validated for
// existence but not persisted (the consignments table has no vehicle column
// at this milestone — the trip's vehicle captures the transport plan).
package logistics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Sentinels for the consignment ops lane: the scan vs manifest comparison
// (CONSIGNMENT_ORDER_MISMATCH, CONSIGNMENT_MISSING_ORDERS) and the replan
// guards. ErrConsignmentNotFound / ErrConsignmentAlreadyDeparted are shared
// with the logistics-extra lane (same package, same HTTP mapping).
var (
	ErrOrderMismatch = errors.New("logistics: scanned orders not in consignment manifest")
	ErrMissingOrders = errors.New("logistics: consignment reconciliation missing orders")
)

// MissingOrdersError carries the manifest order ids that were not scanned;
// errors.Is(err, ErrMissingOrders) matches it and errors.As extracts the
// list for the CONSIGNMENT_MISSING_ORDERS payload.
type MissingOrdersError struct {
	Missing []uuid.UUID
}

func (e *MissingOrdersError) Error() string {
	return fmt.Sprintf("logistics: consignment reconciliation missing %d orders: %v", len(e.Missing), e.Missing)
}

func (e *MissingOrdersError) Unwrap() error { return ErrMissingOrders }

// ReconciliationRow is one consignment_reconciliations row (migration 00052).
type ReconciliationRow struct {
	ID            uuid.UUID
	ConsignmentID uuid.UUID
	Matched       int
	Missing       []uuid.UUID
	CreatedAt     time.Time
}

// ReplanInput carries the mutable plan fields of a replan (contract
// ReplanConsignment body: alternateTripId / alternateVehicleId / reason).
// Reason is validated in the API layer but not persisted (no column).
type ReplanInput struct {
	AlternateTripID    *uuid.UUID
	AlternateVehicleID *uuid.UUID
	Reason             string
}

// Reconcile compares the scanned order set against the consignment manifest.
// A missing consignment is ErrConsignmentNotFound; a consignment that is not
// sealed or departed (assembling, arrived) is ErrConsignmentAlreadyDeparted;
// a scanned order outside the manifest is ErrOrderMismatch; manifest orders
// that were not scanned are ErrMissingOrders (the list rides on the error).
// On a full match the reconciled_at stamp is set and a
// consignment_reconciliations row is appended in the same transaction;
// matched is the number of scanned orders found in the manifest.
func (s *ExtraStore) Reconcile(ctx context.Context, consignmentID uuid.UUID, scannedOrderIDs []uuid.UUID) (matched int, missing []uuid.UUID, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, nil, fmt.Errorf("logistics: begin reconcile tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := s.lockConsignment(ctx, tx, consignmentID)
	if err != nil {
		return 0, nil, err
	}
	if row.Status != ConsignmentStatusSealed && row.Status != ConsignmentStatusDeparted {
		return 0, nil, fmt.Errorf("logistics: reconcile consignment %s: status %s: %w", consignmentID, row.Status, ErrConsignmentAlreadyDeparted)
	}

	expectedSet := make(map[uuid.UUID]bool, len(row.OrderIDs))
	for _, id := range row.OrderIDs {
		expectedSet[id] = true
	}
	scannedSet := make(map[uuid.UUID]bool, len(scannedOrderIDs))
	matched = 0
	for _, id := range scannedOrderIDs {
		if !expectedSet[id] {
			return matched, nil, fmt.Errorf("logistics: reconcile consignment %s: scanned order %s not in manifest: %w", consignmentID, id, ErrOrderMismatch)
		}
		scannedSet[id] = true
		matched++
	}
	missing = make([]uuid.UUID, 0, len(row.OrderIDs))
	for _, id := range row.OrderIDs {
		if !scannedSet[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return matched, missing, fmt.Errorf("logistics: reconcile consignment %s: %w", consignmentID, &MissingOrdersError{Missing: missing})
	}

	if _, err := tx.Exec(ctx,
		`UPDATE consignments SET reconciled_at = now(), updated_at = now() WHERE id = $1`, consignmentID); err != nil {
		return 0, nil, fmt.Errorf("logistics: reconcile consignment %s: stamp: %w", consignmentID, err)
	}
	missingRaw, err := json.Marshal(missing)
	if err != nil {
		return 0, nil, fmt.Errorf("logistics: reconcile consignment %s: marshal missing: %w", consignmentID, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO consignment_reconciliations (consignment_id, matched, missing)
		 VALUES ($1, $2, $3)`,
		consignmentID, matched, missingRaw); err != nil {
		return 0, nil, fmt.Errorf("logistics: reconcile consignment %s: log: %w", consignmentID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, fmt.Errorf("logistics: commit reconcile: %w", err)
	}
	return matched, nil, nil
}

// Replan moves an assembling/sealed consignment onto an alternate trip: the
// trip's corridor (origin -> destination) is resolved onto a configured
// active route (ErrRouteNotFound) with the newest active line-haul carrier
// (ErrCarrierUnavailable); an unknown trip is ErrTripNotFound. A bare
// alternateVehicleId is validated for existence (ErrVehicleNotFound) and the
// consignment keeps its route/carrier. The guarded UPDATE refuses a
// consignment that left assembling/sealed concurrently
// (ErrConsignmentAlreadyDeparted).
func (s *ExtraStore) Replan(ctx context.Context, consignmentID uuid.UUID, in ReplanInput) (ConsignmentRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: begin replan tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := s.lockConsignment(ctx, tx, consignmentID)
	if err != nil {
		return ConsignmentRow{}, err
	}
	if row.Status != ConsignmentStatusAssembling && row.Status != ConsignmentStatusSealed {
		return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: status %s: %w", consignmentID, row.Status, ErrConsignmentAlreadyDeparted)
	}

	routeID, carrierID := row.RouteID, row.CarrierID
	if in.AlternateTripID != nil {
		var originHub, destHub uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT origin_hub_id, destination_hub_id FROM trips WHERE id = $1`, *in.AlternateTripID,
		).Scan(&originHub, &destHub); errors.Is(err, pgx.ErrNoRows) {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: %w", consignmentID, ErrTripNotFound)
		} else if err != nil {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: trip lookup: %w", consignmentID, err)
		}
		if err := tx.QueryRow(ctx,
			`SELECT id FROM routes WHERE origin_hub_id = $1 AND destination_hub_id = $2 AND active = true`,
			originHub, destHub,
		).Scan(&routeID); errors.Is(err, pgx.ErrNoRows) {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: corridor %s->%s: %w", consignmentID, originHub, destHub, ErrRouteNotFound)
		} else if err != nil {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: route lookup: %w", consignmentID, err)
		}
		var id uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM carriers WHERE mode = $1 AND status = 'active' ORDER BY created_at DESC, id LIMIT 1`,
			CarrierModeLinehaul,
		).Scan(&id); errors.Is(err, pgx.ErrNoRows) {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: %w", consignmentID, ErrCarrierUnavailable)
		} else if err != nil {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: carrier lookup: %w", consignmentID, err)
		}
		carrierID = &id
	} else if in.AlternateVehicleID != nil {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM vehicles WHERE id = $1)`, *in.AlternateVehicleID,
		).Scan(&exists); err != nil {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: vehicle lookup: %w", consignmentID, err)
		}
		if !exists {
			return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: %w", consignmentID, ErrVehicleNotFound)
		}
	} else {
		return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: alternate trip or vehicle is required", consignmentID)
	}

	updated, err := scanConsignmentRow(tx.QueryRow(ctx,
		`UPDATE consignments SET route_id = $2, carrier_id = $3, updated_at = now()
		 WHERE id = $1 AND status IN ('assembling', 'sealed')
		 RETURNING `+consignmentColumns,
		consignmentID, routeID, carrierID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: %w", consignmentID, ErrConsignmentAlreadyDeparted)
	}
	if err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: replan consignment %s: update: %w", consignmentID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ConsignmentRow{}, fmt.Errorf("logistics: commit replan: %w", err)
	}
	return updated, nil
}
