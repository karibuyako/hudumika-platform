//go:build integration

// End-to-end tests for the logistics operations lane (trips, legs, handoffs,
// waybill tracking) against real PostgreSQL. Run via
// `go test -tags integration ./internal/logistics/ -count=1` after
// `go run ./cmd/migrate -up`.
//
// The lane depends on the logistics core tables (hubs, vehicles, shipments,
// 00027) written by the core agent in the same milestone; setup polls for
// them and truncates only the ops tables owned here.
package logistics

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	opsTablePollInterval = 5 * time.Second
	opsTablePollTimeout  = 240 * time.Second
)

// opsTestFixture holds the shared hub/vehicle/shipment rows the ops tests
// run against.
type opsTestFixture struct {
	originHub uuid.UUID
	destHub   uuid.UUID
	vehicle   uuid.UUID
	shipment  uuid.UUID
	order     uuid.UUID
	waybill   string
}

// newOpsTestPool connects to DATABASE_URL and truncates only the logistics
// OPS tables (the core agent's tables stay untouched — this lane never
// clears foreign rows).
func newOpsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE waybill_tracking, handoffs, trip_legs, trips CASCADE`); err != nil {
		t.Fatalf("truncate ops tables: %v", err)
	}
	return pool
}

// waitForCoreTables polls for the logistics core tables (00027) until they
// exist or the timeout elapses; a missing core lane skips the suite.
func waitForCoreTables(t *testing.T, pool *pgxpool.Pool) bool {
	t.Helper()
	deadline := time.Now().Add(opsTablePollTimeout)
	for time.Now().Before(deadline) {
		var hubs, vehicles, shipments bool
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass('public.hubs') IS NOT NULL,
			        to_regclass('public.vehicles') IS NOT NULL,
			        to_regclass('public.shipments') IS NOT NULL`,
		).Scan(&hubs, &vehicles, &shipments); err == nil && hubs && vehicles && shipments {
			return true
		}
		time.Sleep(opsTablePollInterval)
	}
	t.Skip("integration: logistics core tables (hubs/vehicles/shipments) not present after poll timeout")
	return false
}

// opsSetup inserts the fixture rows and returns them.
func opsSetup(t *testing.T, pool *pgxpool.Pool) opsTestFixture {
	t.Helper()
	ctx := context.Background()
	fx := opsTestFixture{order: uuid.New()}
	if err := pool.QueryRow(ctx,
		`INSERT INTO hubs (name, city, code) VALUES ('Ops Origin Hub', 'Dar es Salaam', $1) RETURNING id`,
		"OPS-"+uuid.NewString()[:6]).Scan(&fx.originHub); err != nil {
		t.Fatalf("insert origin hub: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO hubs (name, city, code) VALUES ('Ops Dest Hub', 'Mwanza', $1) RETURNING id`,
		"OPS-"+uuid.NewString()[:6]).Scan(&fx.destHub); err != nil {
		t.Fatalf("insert dest hub: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO vehicles (hub_id, plate, vehicle_type) VALUES ($1, $2, 'truck') RETURNING id`,
		fx.originHub, "OPS-"+uuid.NewString()[:6]).Scan(&fx.vehicle); err != nil {
		t.Fatalf("insert vehicle: %v", err)
	}
	fx.waybill = fmt.Sprintf("WB-%s", uuid.NewString()[:8])
	if err := pool.QueryRow(ctx,
		`INSERT INTO shipments (order_id, waybill_number, origin_hub_id, destination_hub_id, vehicle_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		fx.order, fx.waybill, fx.originHub, fx.destHub, fx.vehicle).Scan(&fx.shipment); err != nil {
		t.Fatalf("insert shipment: %v", err)
	}
	return fx
}

// newOpsStore builds the store under test.
func newOpsStore(t *testing.T, pool *pgxpool.Pool) *OpsStore {
	t.Helper()
	return NewOpsStore(pool)
}

// createCompletedTrip creates a trip whose legs are all completed, so it can
// be closed or reused as a vehicle-free fixture.
func createCompletedTrip(t *testing.T, st *OpsStore, vehicle, origin, dest uuid.UUID) TripRow {
	t.Helper()
	trip, err := st.CreateTrip(context.Background(), vehicle, origin, dest, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	if _, err := st.StartTrip(context.Background(), trip.ID); err != nil {
		t.Fatalf("start trip: %v", err)
	}
	legs, err := st.ListLegs(context.Background(), trip.ID)
	if err != nil {
		t.Fatalf("list legs: %v", err)
	}
	for _, leg := range legs {
		if _, err := st.CompleteLeg(context.Background(), leg.ID); err != nil {
			t.Fatalf("complete leg %d: %v", leg.Sequence, err)
		}
	}
	trip, err = st.CompleteTrip(context.Background(), trip.ID)
	if err != nil {
		t.Fatalf("complete trip: %v", err)
	}
	return trip
}

// TestCreateTripAutoCreatesLegs verifies the route is decomposed into
// first_mile + line_haul + last_mile across hubs, and a single leg within
// one hub.
func TestCreateTripAutoCreatesLegs(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	trip, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	if trip.Status != TripStatusPlanned {
		t.Fatalf("status = %q, want planned", trip.Status)
	}
	if trip.Code == "" {
		t.Fatal("trip code is empty")
	}
	legs, err := st.ListLegs(ctx, trip.ID)
	if err != nil {
		t.Fatalf("list legs: %v", err)
	}
	if len(legs) != 3 {
		t.Fatalf("legs = %d, want 3 (first_mile + line_haul + last_mile)", len(legs))
	}
	if legs[0].Mode != LegModeFirstMile || legs[1].Mode != LegModeLineHaul || legs[2].Mode != LegModeLastMile {
		t.Fatalf("leg modes = %q/%q/%q, want first_mile/line_haul/last_mile", legs[0].Mode, legs[1].Mode, legs[2].Mode)
	}
	if legs[1].FromHubID != fx.originHub || legs[1].ToHubID != fx.destHub {
		t.Fatalf("line_haul hubs = %s->%s, want origin->dest", legs[1].FromHubID, legs[1].ToHubID)
	}
	if legs[0].Status != LegStatusPending || legs[1].Status != LegStatusPending || legs[2].Status != LegStatusPending {
		t.Fatalf("leg statuses not pending: %q/%q/%q", legs[0].Status, legs[1].Status, legs[2].Status)
	}

	single, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.originHub, nil)
	if err == nil {
		legs, err = st.ListLegs(ctx, single.ID)
		if err != nil {
			t.Fatalf("list single-leg trip: %v", err)
		}
		if len(legs) != 1 {
			t.Fatalf("single-hub trip legs = %d, want 1", len(legs))
		}
	}
}

// TestCreateTripVehicleAlreadyActive verifies a vehicle cannot ride two
// active trips at once.
func TestCreateTripVehicleAlreadyActive(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	if _, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil); err != nil {
		t.Fatalf("first trip: %v", err)
	}
	_, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil)
	if !errors.Is(err, ErrTripAlreadyActive) {
		t.Fatalf("second trip error = %v, want ErrTripAlreadyActive", err)
	}
	if _, err := st.GetTrip(ctx, uuid.Nil); !errors.Is(err, ErrTripNotFound) {
		t.Fatalf("get missing trip error = %v, want ErrTripNotFound", err)
	}
}

// TestCompleteTripRequiresAllLegs verifies TRIP_CANNOT_CLOSE until every leg
// is completed, and that the trip closes once they are.
func TestCompleteTripRequiresAllLegs(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	trip, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	trip, err = st.StartTrip(ctx, trip.ID)
	if err != nil {
		t.Fatalf("start trip: %v", err)
	}
	if trip.Status != TripStatusInProgress || trip.DepartedAt == nil {
		t.Fatalf("started trip = status %q departed %v, want in_progress + departed_at", trip.Status, trip.DepartedAt)
	}
	if _, err := st.CompleteTrip(ctx, trip.ID); !errors.Is(err, ErrCannotClose) {
		t.Fatalf("complete with pending legs error = %v, want ErrCannotClose", err)
	}
	legs, err := st.ListLegs(ctx, trip.ID)
	if err != nil {
		t.Fatalf("list legs: %v", err)
	}
	for i, leg := range legs {
		row, err := st.CompleteLeg(ctx, leg.ID)
		if err != nil {
			t.Fatalf("complete leg %d: %v", i, err)
		}
		if row.Status != LegStatusCompleted || row.CompletedAt == nil {
			t.Fatalf("leg %d status = %q, want completed", i, row.Status)
		}
	}
	trip, err = st.CompleteTrip(ctx, trip.ID)
	if err != nil {
		t.Fatalf("complete trip after legs: %v", err)
	}
	if trip.Status != TripStatusCompleted || trip.ArrivedAt == nil {
		t.Fatalf("completed trip = status %q arrived %v, want completed + arrived_at", trip.Status, trip.ArrivedAt)
	}
}

// TestCompleteLegGuards verifies a leg cannot be completed twice and that a
// missing leg is LEG_NOT_FOUND.
func TestCompleteLegGuards(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	trip, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	legs, err := st.ListLegs(ctx, trip.ID)
	if err != nil {
		t.Fatalf("list legs: %v", err)
	}
	if _, err := st.CompleteLeg(ctx, legs[0].ID); err != nil {
		t.Fatalf("complete leg: %v", err)
	}
	if _, err := st.CompleteLeg(ctx, legs[0].ID); !errors.Is(err, ErrLegAlreadyCompleted) {
		t.Fatalf("double complete error = %v, want ErrLegAlreadyCompleted", err)
	}
	if _, err := st.CompleteLeg(ctx, uuid.Nil); !errors.Is(err, ErrLegNotFound) {
		t.Fatalf("complete missing leg error = %v, want ErrLegNotFound", err)
	}
}

// TestHandoffSealRequiredForVehicle verifies a vehicle handoff without a
// verified seal is blocked (HANDOFF_SEAL_BROKEN), hub handoffs are stored,
// and unknown entities are rejected.
func TestHandoffSealRequiredForVehicle(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	trip, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	legs, err := st.ListLegs(ctx, trip.ID)
	if err != nil {
		t.Fatalf("list legs: %v", err)
	}
	legID := legs[0].ID

	_, err = st.CreateHandoff(ctx, CreateHandoffInput{
		TripID:         trip.ID,
		LegID:          &legID,
		FromEntityType: HandoffEntityVehicle,
		FromEntityID:   fx.vehicle,
		ToEntityType:   HandoffEntityHub,
		ToEntityID:     fx.originHub,
		SealVerified:   false,
	})
	if !errors.Is(err, ErrSealBroken) {
		t.Fatalf("vehicle handoff without seal error = %v, want ErrSealBroken", err)
	}

	row, err := st.CreateHandoff(ctx, CreateHandoffInput{
		TripID:         trip.ID,
		LegID:          &legID,
		FromEntityType: HandoffEntityVehicle,
		FromEntityID:   fx.vehicle,
		ToEntityType:   HandoffEntityHub,
		ToEntityID:     fx.originHub,
		SealVerified:   true,
	})
	if err != nil {
		t.Fatalf("sealed vehicle handoff: %v", err)
	}
	if !row.SealVerified {
		t.Fatal("seal_verified not persisted")
	}

	hubRow, err := st.CreateHandoff(ctx, CreateHandoffInput{
		TripID:         trip.ID,
		LegID:          &legID,
		FromEntityType: HandoffEntityHub,
		FromEntityID:   fx.originHub,
		ToEntityType:   HandoffEntityHub,
		ToEntityID:     fx.destHub,
		SealVerified:   false,
	})
	if err != nil {
		t.Fatalf("hub handoff: %v", err)
	}
	if hubRow.FromEntityID != fx.originHub || hubRow.ToEntityID != fx.destHub {
		t.Fatalf("hub handoff entities = %s->%s, want origin->dest", hubRow.FromEntityID, hubRow.ToEntityID)
	}

	if _, err := st.CreateHandoff(ctx, CreateHandoffInput{
		TripID:         trip.ID,
		FromEntityType: HandoffEntityHub,
		FromEntityID:   uuid.Nil,
		ToEntityType:   HandoffEntityHub,
		ToEntityID:     fx.destHub,
	}); !errors.Is(err, ErrHandoffInvalid) {
		t.Fatalf("unknown hub error = %v, want ErrHandoffInvalid", err)
	}
	if _, err := st.CreateHandoff(ctx, CreateHandoffInput{
		TripID:         trip.ID,
		FromEntityType: "rider",
		FromEntityID:   fx.originHub,
		ToEntityType:   HandoffEntityHub,
		ToEntityID:     fx.destHub,
	}); !errors.Is(err, ErrHandoffInvalid) {
		t.Fatalf("unknown entity type error = %v, want ErrHandoffInvalid", err)
	}
	if _, err := st.CreateHandoff(ctx, CreateHandoffInput{
		TripID:         uuid.Nil,
		FromEntityType: HandoffEntityHub,
		FromEntityID:   fx.originHub,
		ToEntityType:   HandoffEntityHub,
		ToEntityID:     fx.destHub,
	}); !errors.Is(err, ErrTripNotFound) {
		t.Fatalf("unknown trip error = %v, want ErrTripNotFound", err)
	}
}

// TestTrackingEventsAndWaybill verifies the waybill aggregation: appended
// events come back ordered, joined to the shipment's waybill number.
func TestTrackingEventsAndWaybill(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	trip, err := st.CreateTrip(ctx, fx.vehicle, fx.originHub, fx.destHub, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	tripID := trip.ID
	note := "seal verified"
	if _, err := st.TrackEvent(ctx, fx.shipment, &tripID, WaybillEventScan, "Hub A", nil); err != nil {
		t.Fatalf("track scan: %v", err)
	}
	if _, err := st.TrackEvent(ctx, fx.shipment, &tripID, WaybillEventDeparted, "Hub A", nil); err != nil {
		t.Fatalf("track departed: %v", err)
	}
	if _, err := st.TrackEvent(ctx, fx.shipment, &tripID, WaybillEventArrived, "Hub B", &note); err != nil {
		t.Fatalf("track arrived: %v", err)
	}

	waybill, err := st.GetWaybill(ctx, fx.waybill)
	if err != nil {
		t.Fatalf("get waybill: %v", err)
	}
	if waybill.WaybillNumber != fx.waybill || waybill.ShipmentID != fx.shipment {
		t.Fatalf("waybill header = %s/%s, want %s/%s", waybill.WaybillNumber, waybill.ShipmentID, fx.waybill, fx.shipment)
	}
	if len(waybill.Events) != 3 {
		t.Fatalf("events = %d, want 3", len(waybill.Events))
	}
	if waybill.Events[0].Event != WaybillEventScan || waybill.Events[1].Event != WaybillEventDeparted || waybill.Events[2].Event != WaybillEventArrived {
		t.Fatalf("event order = %q/%q/%q", waybill.Events[0].Event, waybill.Events[1].Event, waybill.Events[2].Event)
	}
	if waybill.Events[2].Note == nil || *waybill.Events[2].Note != note {
		t.Fatalf("arrived note = %v, want %q", waybill.Events[2].Note, note)
	}

	if _, err := st.GetWaybill(ctx, "WB-UNKNOWN"); !errors.Is(err, ErrWaybillInvalid) {
		t.Fatalf("unknown waybill error = %v, want ErrWaybillInvalid", err)
	}
	if _, err := st.TrackEvent(ctx, uuid.Nil, &tripID, WaybillEventScan, "Hub A", nil); !errors.Is(err, ErrShipmentNotFound) {
		t.Fatalf("track unknown shipment error = %v, want ErrShipmentNotFound", err)
	}
	if _, err := st.TrackEvent(ctx, fx.shipment, &tripID, "teleport", "Hub A", nil); !errors.Is(err, ErrWaybillInvalid) {
		t.Fatalf("track unknown event error = %v, want ErrWaybillInvalid", err)
	}
}

// TestListTripsPagination verifies keyset pagination across a full page
// boundary (20 + 5 of 25).
func TestListTripsPagination(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)
	ctx := context.Background()

	vehicleID := fx.vehicle
	ids := make([]uuid.UUID, 0, 25)
	for i := 0; i < 25; i++ {
		var id uuid.UUID
		if err := pool.QueryRow(ctx,
			`INSERT INTO trips (code, vehicle_id, origin_hub_id, destination_hub_id, status)
			 VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
			fmt.Sprintf("PAG-%02d-%s", i, uuid.NewString()[:6]), vehicleID, fx.originHub, fx.destHub).Scan(&id); err != nil {
			t.Fatalf("insert trip %d: %v", i, err)
		}
		ids = append(ids, id)
	}
	page1, err := st.ListTrips(ctx, "", 20, nil)
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 = %d trips, want 20", len(page1))
	}
	cursor := page1[len(page1)-1].ID
	page2, err := st.ListTrips(ctx, "", 20, &cursor)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 = %d trips, want 5", len(page2))
	}
	seen := make(map[uuid.UUID]bool, 25)
	for _, tr := range append(page1, page2...) {
		if seen[tr.ID] {
			t.Fatalf("duplicate trip %s across pages", tr.ID)
		}
		seen[tr.ID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("trip %s missing across pages", id)
		}
	}
	// The status filter only returns matching trips.
	plannedOnly, err := st.ListTrips(ctx, TripStatusPlanned, 20, nil)
	if err != nil {
		t.Fatalf("planned filter: %v", err)
	}
	if len(plannedOnly) != 0 {
		t.Fatalf("planned filter = %d trips, want 0 (all are completed)", len(plannedOnly))
	}
}

// TestConcurrentStartTrip verifies the guarded start: exactly one concurrent
// caller wins and the rest observe TRIP_ALREADY_ACTIVE.
func TestConcurrentStartTrip(t *testing.T) {
	pool := newOpsTestPool(t)
	if !waitForCoreTables(t, pool) {
		return
	}
	fx := opsSetup(t, pool)
	st := newOpsStore(t, pool)

	trip, err := st.CreateTrip(context.Background(), fx.vehicle, fx.originHub, fx.destHub, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	const racers = 8
	start := make(chan struct{})
	errs := make(chan error, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := st.StartTrip(context.Background(), trip.ID)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	winners, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrTripAlreadyActive):
			conflicts++
		default:
			t.Fatalf("unexpected start error: %v", err)
		}
	}
	if winners != 1 || conflicts != racers-1 {
		t.Fatalf("winners = %d, conflicts = %d, want 1/%d", winners, conflicts, racers-1)
	}
	row, err := st.GetTrip(context.Background(), trip.ID)
	if err != nil {
		t.Fatalf("reload trip: %v", err)
	}
	if row.Status != TripStatusInProgress || row.DepartedAt == nil {
		t.Fatalf("trip after race = status %q departed %v, want in_progress + departed_at", row.Status, row.DepartedAt)
	}
}
