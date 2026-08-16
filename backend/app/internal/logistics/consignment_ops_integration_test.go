//go:build integration

// Integration tests for the consignment ops lane (migration 00052,
// /linehaul/consignments/{consignmentId}/reconcile and .../replan) against
// real PostgreSQL.
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/logistics/ -count=1
//
// Setup truncates ONLY the consignment ops table (consignment_reconciliations)
// — the logistics-extra suite truncates consignments/routes/carriers and the
// ops suite truncates trips/vehicles/hubs in the same process, so this suite
// creates and removes its OWN rows (hubs, routes, carriers, consignments,
// vehicles, trips) with t.Cleanup and never assumes another suite's rows
// survive.
package logistics

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newConsignmentOpsPool connects to DATABASE_URL and truncates only
// consignment_reconciliations (this lane's table) so the suite is isolated
// from the logistics-extra and logistics-ops data.
func newConsignmentOpsPool(t *testing.T) *pgxpool.Pool {
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
	if _, err := pool.Exec(context.Background(), `TRUNCATE consignment_reconciliations CASCADE`); err != nil {
		t.Fatalf("truncate consignment_reconciliations: %v", err)
	}
	return pool
}

// consignmentOpsFixture bundles the store, the pool and the self-owned rows
// this suite creates. One t.Cleanup teardown removes every tracked row in
// FK-safe order (consignments/trips first, then carriers/routes/vehicles,
// then hubs) so LIFO registration order can never trip a foreign key.
type consignmentOpsFixture struct {
	pool         *pgxpool.Pool
	st           *ExtraStore
	core         *Store
	t            *testing.T
	consignments []uuid.UUID
	trips        []uuid.UUID
	carriers     []uuid.UUID
	routes       []uuid.UUID
	vehicles     []uuid.UUID
	hubs         []uuid.UUID
}

func newConsignmentOpsFixture(t *testing.T) *consignmentOpsFixture {
	pool := newConsignmentOpsPool(t)
	fx := &consignmentOpsFixture{pool: pool, st: NewExtraStore(pool), core: NewStore(pool), t: t}
	t.Cleanup(fx.teardown)
	return fx
}

// teardown deletes every tracked row in FK-safe order.
func (fx *consignmentOpsFixture) teardown() {
	ctx := context.Background()
	for _, id := range fx.consignments {
		if _, err := fx.pool.Exec(ctx, `DELETE FROM consignments WHERE id = $1`, id); err != nil {
			fx.t.Logf("consignment ops teardown consignment %s: %v", id, err)
		}
	}
	for _, id := range fx.trips {
		if _, err := fx.pool.Exec(ctx, `DELETE FROM trips WHERE id = $1`, id); err != nil {
			fx.t.Logf("consignment ops teardown trip %s: %v", id, err)
		}
	}
	for _, table := range []string{"carriers", "routes", "vehicles"} {
		ids := fx.carriers
		if table == "routes" {
			ids = fx.routes
		} else if table == "vehicles" {
			ids = fx.vehicles
		}
		for _, id := range ids {
			if _, err := fx.pool.Exec(ctx,
				`DELETE FROM `+table+` WHERE id = $1`, id); err != nil {
				fx.t.Logf("consignment ops teardown %s %s: %v", table, id, err)
			}
		}
	}
	for _, id := range fx.hubs {
		if _, err := fx.pool.Exec(ctx, `DELETE FROM hubs WHERE id = $1`, id); err != nil {
			fx.t.Logf("consignment ops teardown hub %s: %v", id, err)
		}
	}
}

// ownHub creates this suite's own hubs row (removed by teardown).
func (fx *consignmentOpsFixture) ownHub(t *testing.T) uuid.UUID {
	t.Helper()
	hub := setupHub(t, fx.core)
	fx.hubs = append(fx.hubs, hub.ID)
	return hub.ID
}

// setupRoute inserts an active route between the two hubs and returns it.
func (fx *consignmentOpsFixture) setupRoute(t *testing.T, from, to uuid.UUID) RouteRow {
	t.Helper()
	route, err := fx.st.CreateRoute(context.Background(), RouteInput{
		OriginHubID:      ptr(from),
		DestinationHubID: ptr(to),
		DistanceKm:       float64Ptr(512.5),
		DurationMinutes:  intPtr(720),
	})
	if err != nil {
		t.Fatalf("create route: %v", err)
	}
	fx.routes = append(fx.routes, route.ID)
	return route
}

// setupCarrier registers an active line-haul carrier and returns it.
func (fx *consignmentOpsFixture) setupCarrier(t *testing.T) CarrierRow {
	t.Helper()
	carrier, err := fx.st.CreateCarrier(context.Background(), CarrierInput{
		Name:    "Consign Ops Carrier",
		Mode:    CarrierModeLinehaul,
		Regions: []string{"dar", "mwanza"},
	})
	if err != nil {
		t.Fatalf("create carrier: %v", err)
	}
	fx.carriers = append(fx.carriers, carrier.ID)
	return carrier
}

// newVehicle creates this suite's own active vehicle and returns it.
func (fx *consignmentOpsFixture) newVehicle(t *testing.T, hubID uuid.UUID) VehicleRow {
	t.Helper()
	vehicle, err := fx.core.CreateVehicle(context.Background(), VehicleInput{
		HubID:       ptr(hubID),
		Plate:       "TRK-" + uuid.NewString()[:8],
		VehicleType: "van",
		CapacityKg:  float64Ptr(800),
		Status:      "active",
	})
	if err != nil {
		t.Fatalf("create vehicle: %v", err)
	}
	fx.vehicles = append(fx.vehicles, vehicle.ID)
	return vehicle
}

// newTrip creates this suite's own trip on the corridor and returns it.
func (fx *consignmentOpsFixture) newTrip(t *testing.T, vehicleID, origin, dest uuid.UUID) TripRow {
	t.Helper()
	trip, err := NewOpsStore(fx.pool).CreateTrip(context.Background(), vehicleID, origin, dest, nil)
	if err != nil {
		t.Fatalf("create trip: %v", err)
	}
	fx.trips = append(fx.trips, trip.ID)
	return trip
}

// consignmentFixture bundles the self-owned route/carrier/consignment of a
// corridor so tests can assert the replan swap against the originals.
type consignmentFixture struct {
	route   RouteRow
	carrier CarrierRow
	row     ConsignmentRow
}

// newConsignment creates a consignment (assembling) with the given orders on
// a fresh corridor (own hubs, route, carrier).
func (fx *consignmentOpsFixture) newConsignment(t *testing.T, orders []uuid.UUID) consignmentFixture {
	t.Helper()
	hubA, hubB := fx.ownHub(t), fx.ownHub(t)
	route := fx.setupRoute(t, hubA, hubB)
	carrier := fx.setupCarrier(t)
	row, err := fx.st.CreateConsignment(context.Background(), CreateConsignmentInput{
		RouteID:          route.ID,
		CarrierID:        carrier.ID,
		OriginHubID:      ptr(hubA),
		DestinationHubID: ptr(hubB),
		OrderIDs:         orders,
	})
	if err != nil {
		t.Fatalf("create consignment: %v", err)
	}
	fx.consignments = append(fx.consignments, row.ID)
	return consignmentFixture{route: route, carrier: carrier, row: row}
}

// logRow reads the latest consignment_reconciliations row for a consignment.
func (fx *consignmentOpsFixture) logRow(t *testing.T, consignmentID uuid.UUID) (ReconciliationRow, bool) {
	t.Helper()
	var (
		row    ReconciliationRow
		raw    []byte
		exists bool
	)
	err := fx.pool.QueryRow(context.Background(),
		`SELECT id, consignment_id, matched, missing, created_at
		 FROM consignment_reconciliations WHERE consignment_id = $1
		 ORDER BY created_at DESC, id LIMIT 1`, consignmentID,
	).Scan(&row.ID, &row.ConsignmentID, &row.Matched, &raw, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReconciliationRow{}, false
	}
	if err != nil {
		t.Fatalf("read reconciliation log: %v", err)
	}
	_ = json.Unmarshal(raw, &row.Missing)
	exists = true
	return row, exists
}

// TestReconcileFullMatch: a scan equal to the manifest on a sealed
// consignment returns the matched count, stamps reconciled_at and appends a
// consignment_reconciliations row with an empty missing list.
func TestReconcileFullMatch(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	o1, o2 := uuid.New(), uuid.New()
	cf := fx.newConsignment(t, []uuid.UUID{o1, o2})
	if _, err := fx.st.SealConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("seal consignment: %v", err)
	}

	matched, missing, err := fx.st.Reconcile(ctx, cf.row.ID, []uuid.UUID{o1, o2})
	if err != nil {
		t.Fatalf("reconcile full match: %v", err)
	}
	if matched != 2 || len(missing) != 0 {
		t.Fatalf("reconcile = matched %d missing %v, want 2 []", matched, missing)
	}
	log, ok := fx.logRow(t, cf.row.ID)
	if !ok || log.Matched != 2 || len(log.Missing) != 0 {
		t.Fatalf("reconciliation log = %+v, %v; want matched=2 missing=[]", log, ok)
	}
	var stamped *time.Time
	if err := fx.pool.QueryRow(ctx,
		`SELECT reconciled_at FROM consignments WHERE id = $1`, cf.row.ID).Scan(&stamped); err != nil {
		t.Fatalf("read reconciled_at: %v", err)
	}
	if stamped == nil {
		t.Fatalf("reconciled_at not stamped on full match")
	}
}

// TestReconcileOrderMismatch: a scan containing an order outside the manifest
// is ErrOrderMismatch and records no log row.
func TestReconcileOrderMismatch(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	o1, o2 := uuid.New(), uuid.New()
	cf := fx.newConsignment(t, []uuid.UUID{o1, o2})
	if _, err := fx.st.SealConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("seal consignment: %v", err)
	}

	if _, _, err := fx.st.Reconcile(ctx, cf.row.ID, []uuid.UUID{o1, uuid.New()}); !errors.Is(err, ErrOrderMismatch) {
		t.Fatalf("mismatch reconcile = %v, want ErrOrderMismatch", err)
	}
	if _, ok := fx.logRow(t, cf.row.ID); ok {
		t.Fatalf("mismatch reconcile recorded a log row")
	}
}

// TestReconcileMissingOrders: a short scan is ErrMissingOrders carrying the
// manifest ids that were not scanned; no log row is recorded.
func TestReconcileMissingOrders(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	o1, o2, o3 := uuid.New(), uuid.New(), uuid.New()
	cf := fx.newConsignment(t, []uuid.UUID{o1, o2, o3})
	if _, err := fx.st.SealConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("seal consignment: %v", err)
	}
	if _, err := fx.st.DepartConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("depart consignment: %v", err)
	}

	_, _, err := fx.st.Reconcile(ctx, cf.row.ID, []uuid.UUID{o1})
	if !errors.Is(err, ErrMissingOrders) {
		t.Fatalf("short reconcile = %v, want ErrMissingOrders", err)
	}
	var moe *MissingOrdersError
	if !errors.As(err, &moe) {
		t.Fatalf("missing error not extractable from %v", err)
	}
	got := map[uuid.UUID]bool{}
	for _, id := range moe.Missing {
		got[id] = true
	}
	if len(got) != 2 || !got[o2] || !got[o3] {
		t.Fatalf("missing list = %v, want {o2, o3}", moe.Missing)
	}
	if _, ok := fx.logRow(t, cf.row.ID); ok {
		t.Fatalf("short reconcile recorded a log row")
	}
}

// TestReconcileStateGates: reconcile is refused before sealing (assembling)
// and after arrival (both ErrConsignmentAlreadyDeparted); an unknown
// consignment is ErrConsignmentNotFound.
func TestReconcileStateGates(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	o1 := uuid.New()
	cf := fx.newConsignment(t, []uuid.UUID{o1})
	if _, _, err := fx.st.Reconcile(ctx, cf.row.ID, []uuid.UUID{o1}); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("reconcile while assembling = %v, want ErrConsignmentAlreadyDeparted", err)
	}
	if _, err := fx.st.SealConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("seal consignment: %v", err)
	}
	if _, err := fx.st.DepartConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("depart consignment: %v", err)
	}
	if _, err := fx.st.ArriveConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("arrive consignment: %v", err)
	}
	if _, _, err := fx.st.Reconcile(ctx, cf.row.ID, []uuid.UUID{o1}); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("reconcile after arrival = %v, want ErrConsignmentAlreadyDeparted", err)
	}
	if _, _, err := fx.st.Reconcile(ctx, uuid.New(), nil); !errors.Is(err, ErrConsignmentNotFound) {
		t.Fatalf("reconcile unknown consignment = %v, want ErrConsignmentNotFound", err)
	}
}

// TestReplanSwapsTripToAlternateCorridor: an assembling consignment moves to
// the alternate trip's corridor — route and carrier are replaced with the
// alternate route and the newest active line-haul carrier.
func TestReplanSwapsTripToAlternateCorridor(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	cf := fx.newConsignment(t, nil)
	hubC, hubD := fx.ownHub(t), fx.ownHub(t)
	altRoute := fx.setupRoute(t, hubC, hubD)
	altCarrier := fx.setupCarrier(t)
	vehicle := fx.newVehicle(t, hubC)
	trip := fx.newTrip(t, vehicle.ID, hubC, hubD)

	updated, err := fx.st.Replan(ctx, cf.row.ID, ReplanInput{
		AlternateTripID: ptr(trip.ID),
		Reason:          "vehicle breakdown",
	})
	if err != nil {
		t.Fatalf("replan: %v", err)
	}
	if updated.RouteID != altRoute.ID {
		t.Fatalf("route = %s, want %s", updated.RouteID, altRoute.ID)
	}
	if updated.CarrierID == nil || *updated.CarrierID != altCarrier.ID {
		t.Fatalf("carrier = %v, want %s", updated.CarrierID, altCarrier.ID)
	}
	if updated.Status != ConsignmentStatusAssembling {
		t.Fatalf("status = %s, want assembling", updated.Status)
	}
}

// TestReplanVehicleOnly: a bare alternateVehicleId is validated for existence
// and the route/carrier stay put.
func TestReplanVehicleOnly(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	cf := fx.newConsignment(t, nil)
	hubC := fx.ownHub(t)
	vehicle := fx.newVehicle(t, hubC)

	updated, err := fx.st.Replan(ctx, cf.row.ID, ReplanInput{
		AlternateVehicleID: ptr(vehicle.ID),
		Reason:             "swap vehicle",
	})
	if err != nil {
		t.Fatalf("replan vehicle only: %v", err)
	}
	if updated.RouteID != cf.route.ID {
		t.Fatalf("route = %s, want %s", updated.RouteID, cf.route.ID)
	}
	if updated.CarrierID == nil || *updated.CarrierID != cf.carrier.ID {
		t.Fatalf("carrier = %v, want %s", updated.CarrierID, cf.carrier.ID)
	}
}

// TestReplanStateAndLookupErrors covers the replan guards: departed is
// ErrConsignmentAlreadyDeparted, an unknown trip ErrTripNotFound, a corridor
// without a configured route ErrRouteNotFound, a corridor with no active
// carrier ErrCarrierUnavailable and an unknown vehicle ErrVehicleNotFound.
func TestReplanStateAndLookupErrors(t *testing.T) {
	fx := newConsignmentOpsFixture(t)
	ctx := context.Background()

	cf := fx.newConsignment(t, nil)
	if _, err := fx.st.SealConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("seal consignment: %v", err)
	}
	if _, err := fx.st.DepartConsignment(ctx, cf.row.ID); err != nil {
		t.Fatalf("depart consignment: %v", err)
	}
	if _, err := fx.st.Replan(ctx, cf.row.ID, ReplanInput{AlternateTripID: ptr(uuid.New())}); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("replan after departure = %v, want ErrConsignmentAlreadyDeparted", err)
	}

	cf2 := fx.newConsignment(t, nil)
	if _, err := fx.st.Replan(ctx, cf2.row.ID, ReplanInput{AlternateTripID: ptr(uuid.New())}); !errors.Is(err, ErrTripNotFound) {
		t.Fatalf("replan unknown trip = %v, want ErrTripNotFound", err)
	}

	// Corridor without a configured route.
	cf3 := fx.newConsignment(t, nil)
	hubC, hubD := fx.ownHub(t), fx.ownHub(t)
	vehicle := fx.newVehicle(t, hubC)
	trip := fx.newTrip(t, vehicle.ID, hubC, hubD)
	if _, err := fx.st.Replan(ctx, cf3.row.ID, ReplanInput{AlternateTripID: ptr(trip.ID)}); !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("replan corridor without route = %v, want ErrRouteNotFound", err)
	}

	// Corridor with a route but no active carrier: suspend every line-haul
	// carrier (this suite's own plus any residue from the logistics-extra
	// suite — that suite truncates its own ephemeral carriers at its next
	// setup), then replan onto the corridor.
	cf4 := fx.newConsignment(t, nil)
	if _, err := fx.pool.Exec(ctx,
		`UPDATE carriers SET status = 'suspended' WHERE mode = 'linehaul' AND status = 'active'`); err != nil {
		t.Fatalf("suspend carriers: %v", err)
	}
	hubE, hubF := fx.ownHub(t), fx.ownHub(t)
	fx.setupRoute(t, hubE, hubF)
	vehicle2 := fx.newVehicle(t, hubE)
	trip2 := fx.newTrip(t, vehicle2.ID, hubE, hubF)
	if _, err := fx.st.Replan(ctx, cf4.row.ID, ReplanInput{AlternateTripID: ptr(trip2.ID)}); !errors.Is(err, ErrCarrierUnavailable) {
		t.Fatalf("replan corridor without carrier = %v, want ErrCarrierUnavailable", err)
	}

	if _, err := fx.st.Replan(ctx, cf4.row.ID, ReplanInput{AlternateVehicleID: ptr(uuid.New())}); !errors.Is(err, ErrVehicleNotFound) {
		t.Fatalf("replan unknown vehicle = %v, want ErrVehicleNotFound", err)
	}
}
