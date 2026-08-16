//go:build integration

// Integration tests for the logistics-core bounded context against real
// PostgreSQL.
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/logistics/ -count=1
//
// Every run truncates ONLY this context's tables (shipments, packages,
// containers, vehicles, hubs, shipment_events) so the suite is isolated from
// other bounded contexts' tables and other agents' data.
package logistics

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// logisticsTables is every table owned by this bounded context. Migration
// 00027 must be applied before the suite runs. CASCADE is required because
// the trips lane (00028) references hubs/vehicles/shipments — the same
// pattern other suites use for cross-context FKs (auth, cities, merchants).
const logisticsTables = `shipment_events, packages, shipments, containers, vehicles, hubs`

// newTestPool connects to DATABASE_URL and truncates only the logistics
// tables so tests are isolated from other agents' tables.
func newTestPool(t *testing.T) *pgxpool.Pool {
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
	if _, err := pool.Exec(context.Background(), `TRUNCATE `+logisticsTables+` CASCADE`); err != nil {
		t.Fatalf("truncate logistics tables: %v", err)
	}
	return pool
}

// setupHub inserts a hub and returns its id.
func setupHub(t *testing.T, st *Store) HubRow {
	t.Helper()
	code := fmt.Sprintf("HUB-%d", time.Now().UnixNano()%1_000_000_000)
	hub, err := st.CreateHub(context.Background(), HubInput{Name: "Dar Sorting", Code: &code, Capacity: intPtr(1000)})
	if err != nil {
		t.Fatalf("create hub: %v", err)
	}
	return hub
}

// setupShipment creates a shipment for a fresh order id.
func setupShipment(t *testing.T, st *Store, origin *uuid.UUID) ShipmentRow {
	t.Helper()
	row, err := st.CreateShipment(context.Background(), CreateShipmentInput{
		OrderID:      uuid.New(),
		PackageCount: 2,
		OriginHubID:  origin,
		ActorID:      ptr(uuid.New()),
	})
	if err != nil {
		t.Fatalf("create shipment: %v", err)
	}
	return row
}

func intPtr(v int) *int { return &v }

func ptr(v uuid.UUID) *uuid.UUID { return &v }

func ptrBool(v bool) *bool { return &v }

// TestHubCRUD covers create -> get -> list -> update and the missing-row
// sentinel.
func TestHubCRUD(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	code := "HUB-TZ-001"
	hub, err := st.CreateHub(ctx, HubInput{Name: "Arusha Hub", Code: &code, Capacity: intPtr(500)})
	if err != nil {
		t.Fatalf("create hub: %v", err)
	}
	if hub.ID == uuid.Nil || hub.Code == nil || *hub.Code != code || hub.Capacity != 500 || !hub.Active {
		t.Fatalf("created hub = %+v", hub)
	}
	got, err := st.GetHub(ctx, hub.ID)
	if err != nil {
		t.Fatalf("get hub: %v", err)
	}
	if got.Name != "Arusha Hub" {
		t.Fatalf("get hub name = %q", got.Name)
	}
	if _, err := st.CreateHub(ctx, HubInput{Name: "Dup", Code: &code}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate hub code = %v, want ErrAlreadyExists", err)
	}
	active := true
	if _, err := st.UpdateHub(ctx, hub.ID, HubInput{Active: &active}); err != nil {
		t.Fatalf("update hub: %v", err)
	}
	updated, err := st.UpdateHub(ctx, hub.ID, HubInput{Active: ptrBool(false), Capacity: intPtr(700)})
	if err != nil {
		t.Fatalf("update hub (retry): %v", err)
	}
	if updated.Active || updated.Capacity != 700 {
		t.Fatalf("updated hub = %+v", updated)
	}
	hubs, err := st.ListHubs(ctx)
	if err != nil {
		t.Fatalf("list hubs: %v", err)
	}
	if len(hubs) != 1 {
		t.Fatalf("listed hubs = %d, want 1", len(hubs))
	}
	if _, err := st.GetHub(ctx, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing hub = %v, want ErrNotFound", err)
	}
}

// TestVehicleCRUD covers the registry lifecycle including the duplicate
// plate conflict.
func TestVehicleCRUD(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	hub := setupHub(t, st)
	v, err := st.CreateVehicle(ctx, VehicleInput{Plate: "T123ABC", VehicleType: "van", CapacityKg: float64Ptr(800), Status: "active", HubID: &hub.ID})
	if err != nil {
		t.Fatalf("create vehicle: %v", err)
	}
	if v.Plate != "T123ABC" || v.VehicleType != "van" || v.CapacityKg != 800 || v.Status != "active" {
		t.Fatalf("created vehicle = %+v", v)
	}
	got, err := st.GetVehicle(ctx, v.ID)
	if err != nil {
		t.Fatalf("get vehicle: %v", err)
	}
	if got.Plate != v.Plate {
		t.Fatalf("get vehicle plate = %q", got.Plate)
	}
	if _, err := st.CreateVehicle(ctx, VehicleInput{Plate: "T123ABC", VehicleType: "bike"}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate plate = %v, want ErrAlreadyExists", err)
	}
	updated, err := st.UpdateVehicle(ctx, v.ID, VehicleInput{Status: "maintenance"})
	if err != nil {
		t.Fatalf("update vehicle: %v", err)
	}
	if updated.Status != "maintenance" {
		t.Fatalf("updated vehicle status = %q", updated.Status)
	}
	vehicles, err := st.ListVehicles(ctx)
	if err != nil {
		t.Fatalf("list vehicles: %v", err)
	}
	if len(vehicles) != 1 {
		t.Fatalf("listed vehicles = %d, want 1", len(vehicles))
	}
	if _, err := st.GetVehicle(ctx, uuid.New()); !errors.Is(err, ErrVehicleNotFound) {
		t.Fatalf("missing vehicle = %v, want ErrVehicleNotFound", err)
	}
}

// TestContainerSealAndArrive covers open -> sealed -> (in_transit) -> arrived
// plus the double-seal conflict.
func TestContainerSealAndArrive(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	hub := setupHub(t, st)
	c, err := st.CreateContainer(ctx, ContainerInput{Code: "BAG-CN-000391", Kind: "bag", Section: strPtr("standard"), HubID: &hub.ID})
	if err != nil {
		t.Fatalf("create container: %v", err)
	}
	if c.Status != ContainerStatusOpen || c.Kind != "bag" {
		t.Fatalf("created container = %+v", c)
	}
	if _, err := st.CreateContainer(ctx, ContainerInput{Code: "BAG-CN-000391", Kind: "bag"}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate container code = %v, want ErrAlreadyExists", err)
	}
	sealed, err := st.SealContainer(ctx, c.ID)
	if err != nil {
		t.Fatalf("seal container: %v", err)
	}
	if sealed.Status != ContainerStatusSealed || sealed.SealedAt == nil {
		t.Fatalf("sealed container = %+v", sealed)
	}
	if _, err := st.SealContainer(ctx, c.ID); !errors.Is(err, ErrAlreadySealed) {
		t.Fatalf("double seal = %v, want ErrAlreadySealed", err)
	}

	// Arrival requires in_transit; the departure transition is driven by the
	// trips lane at a later milestone, so the test sets it directly.
	if _, err := pool.Exec(ctx, `UPDATE containers SET status = 'in_transit' WHERE id = $1`, c.ID); err != nil {
		t.Fatalf("force in_transit: %v", err)
	}
	arrived, err := st.ArriveContainer(ctx, c.ID)
	if err != nil {
		t.Fatalf("arrive container: %v", err)
	}
	if arrived.Status != ContainerStatusArrived {
		t.Fatalf("arrived container status = %q", arrived.Status)
	}
	if _, err := st.ArriveContainer(ctx, c.ID); !errors.Is(err, ErrStatusGate) {
		t.Fatalf("double arrive = %v, want ErrStatusGate", err)
	}
	if _, err := st.SealContainer(ctx, uuid.New()); !errors.Is(err, ErrContainerNotFound) {
		t.Fatalf("seal missing container = %v, want ErrContainerNotFound", err)
	}
}

// TestShipmentCreateWaybillAndEvents covers creation: unique waybills, the
// first 'created' event, the package rows, and the not-found sentinel.
func TestShipmentCreateWaybillAndEvents(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	hub := setupHub(t, st)
	row, err := st.CreateShipment(ctx, CreateShipmentInput{
		OrderID:      uuid.New(),
		PackageCount: 3,
		OriginHubID:  &hub.ID,
		ActorID:      ptr(uuid.New()),
	})
	if err != nil {
		t.Fatalf("create shipment: %v", err)
	}
	if !strings.HasPrefix(row.WaybillNumber, "WB-") {
		t.Fatalf("waybill = %q, want WB- prefix", row.WaybillNumber)
	}
	if row.Status != StatusPending || row.OrderID == nil {
		t.Fatalf("created shipment = %+v", row)
	}
	second, err := st.CreateShipment(ctx, CreateShipmentInput{OrderID: uuid.New(), PackageCount: 1})
	if err != nil {
		t.Fatalf("create second shipment: %v", err)
	}
	if second.WaybillNumber == row.WaybillNumber {
		t.Fatalf("waybills collide: %q", row.WaybillNumber)
	}

	detail, err := st.GetShipmentDetail(ctx, row.ID)
	if err != nil {
		t.Fatalf("get shipment detail: %v", err)
	}
	if len(detail.Packages) != 3 {
		t.Fatalf("packages = %d, want 3", len(detail.Packages))
	}
	events, err := st.ListEvents(ctx, row.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 1 || events[0].Status != "created" {
		t.Fatalf("events = %+v, want single 'created'", events)
	}
	if _, err := st.GetShipment(ctx, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing shipment = %v, want ErrNotFound", err)
	}
	if _, err := st.ListEvents(ctx, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("events for missing shipment = %v, want ErrNotFound", err)
	}
}

// TestCustodyTransferGates covers hub custody transfer: pending shipments are
// gated, at_hub/in_transit shipments transfer, unknown hubs are rejected and
// frozen shipments are blocked.
func TestCustodyTransferGates(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	hub := setupHub(t, st)
	hub2, err := st.CreateHub(ctx, HubInput{Name: "Mwanza Hub", Code: strPtr("HUB-MWZ-1")})
	if err != nil {
		t.Fatalf("create second hub: %v", err)
	}
	shipment := setupShipment(t, st, &hub.ID)

	// pending is not a movable state for custody transfer.
	if _, err := st.UpdateCustody(ctx, shipment.ID, &hub2.ID, CustodyKindHub, nil, ""); !errors.Is(err, ErrStatusGate) {
		t.Fatalf("custody on pending = %v, want ErrStatusGate", err)
	}

	// Break pending with the first scan, then transfer custody to hub2.
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, HubID: &hub.ID, ScanType: "pickup", Location: "Hub A"}); err != nil {
		t.Fatalf("pickup scan: %v", err)
	}
	transferred, err := st.UpdateCustody(ctx, shipment.ID, &hub2.ID, CustodyKindHub, nil, "handoff to Mwanza")
	if err != nil {
		t.Fatalf("custody transfer: %v", err)
	}
	if transferred.CustodyHubID == nil || *transferred.CustodyHubID != hub2.ID || transferred.CustodyKind != CustodyKindHub {
		t.Fatalf("transferred shipment = %+v", transferred)
	}
	events, err := st.ListEvents(ctx, shipment.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	// created + picked_up (the scan that broke pending) + handoff.
	if len(events) != 3 || events[2].Status != "handoff" || events[2].HubID == nil || *events[2].HubID != hub2.ID {
		t.Fatalf("custody events = %+v", events)
	}

	// Unknown destination hub.
	if _, err := st.UpdateCustody(ctx, shipment.ID, ptr(uuid.New()), CustodyKindHub, nil, ""); !errors.Is(err, ErrHubNotFound) {
		t.Fatalf("custody to unknown hub = %v, want ErrHubNotFound", err)
	}

	// Frozen blocks the transfer (ErrFrozen) even in a movable state.
	if _, err := st.FreezeShipment(ctx, shipment.ID, "ops hold", nil); err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if _, err := st.UpdateCustody(ctx, shipment.ID, &hub2.ID, CustodyKindHub, nil, ""); !errors.Is(err, ErrFrozen) {
		t.Fatalf("custody on frozen = %v, want ErrFrozen", err)
	}
}

// TestScanFlow covers the scan state machine: pickup breaks pending, hub_out
// departs, vehicle scans validate the vehicle, delivery starts the last mile,
// and scans on terminal/frozen shipments are blocked.
func TestScanFlow(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	hub := setupHub(t, st)
	vehicle, err := st.CreateVehicle(ctx, VehicleInput{Plate: "T789XYZ", VehicleType: "truck", Status: "active"})
	if err != nil {
		t.Fatalf("create vehicle: %v", err)
	}
	shipment := setupShipment(t, st, &hub.ID)

	// Unknown hub/vehicle on a scan. The unknown-hub check fires on the
	// pending shipment (hub_in is a legal first scan); the vehicle check is
	// exercised after pickup has moved the shipment to at_hub.
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, HubID: ptr(uuid.New()), ScanType: "hub_in", Location: "X"}); !errors.Is(err, ErrHubNotFound) {
		t.Fatalf("scan unknown hub = %v, want ErrHubNotFound", err)
	}
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, VehicleID: ptr(uuid.New()), ScanType: "vehicle_load", Location: "X"}); !errors.Is(err, ErrStatusGate) {
		t.Fatalf("vehicle scan on pending = %v, want ErrStatusGate", err)
	}
	row, event, err := st.ScanShipment(ctx, ScanInput{
		ShipmentID: shipment.ID, HubID: &hub.ID, ScanType: "pickup", Location: "Hub A",
		Lat: float64Ptr(-6.8), Lon: float64Ptr(39.2), Note: "picked up",
	})
	if err != nil {
		t.Fatalf("pickup scan: %v", err)
	}
	if row.Status != StatusAtHub {
		t.Fatalf("post-pickup status = %q", row.Status)
	}
	if event.Status != "picked_up" || event.Lat == nil || event.Lon == nil || event.HubID == nil {
		t.Fatalf("pickup event = %+v", event)
	}
	if row.CurrentLocation == nil || *row.CurrentLocation != "Hub A" {
		t.Fatalf("current location = %v", row.CurrentLocation)
	}
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, VehicleID: ptr(uuid.New()), ScanType: "vehicle_load", Location: "X"}); !errors.Is(err, ErrVehicleNotFound) {
		t.Fatalf("scan unknown vehicle = %v, want ErrVehicleNotFound", err)
	}

	// at_hub -> in_transit via hub_out.
	row, _, err = st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, HubID: &hub.ID, ScanType: "hub_out", Location: "Gate 3"})
	if err != nil {
		t.Fatalf("hub_out scan: %v", err)
	}
	if row.Status != StatusInTransit {
		t.Fatalf("post-departure status = %q", row.Status)
	}

	// vehicle_load on a real vehicle; in_transit -> at_hub on unload.
	row, event, err = st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, VehicleID: &vehicle.ID, ScanType: "vehicle_load", Location: "Bay 1"})
	if err != nil {
		t.Fatalf("vehicle_load scan: %v", err)
	}
	if row.VehicleID == nil || *row.VehicleID != vehicle.ID || event.VehicleID == nil {
		t.Fatalf("vehicle load = %+v / %+v", row, event)
	}
	row, _, err = st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, HubID: &hub.ID, ScanType: "vehicle_unload", Location: "Hub B"})
	if err != nil {
		t.Fatalf("vehicle_unload scan: %v", err)
	}
	if row.Status != StatusAtHub {
		t.Fatalf("post-unload status = %q", row.Status)
	}

	// delivery scan starts the last mile.
	row, event, err = st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, ScanType: "delivery", Location: "Last mile"})
	if err != nil {
		t.Fatalf("delivery scan: %v", err)
	}
	if row.Status != StatusOutForDelivery || event.Status != "out_for_delivery" {
		t.Fatalf("delivery = %+v / %+v", row, event)
	}

	// A frozen shipment blocks scans regardless of state; a delivered
	// shipment cannot be scanned either. Both terminal holds are exercised
	// from the out_for_delivery state.
	if _, err := st.FreezeShipment(ctx, shipment.ID, "hold", nil); err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, ScanType: "hub_in", Location: "X"}); !errors.Is(err, ErrFrozen) {
		t.Fatalf("scan on frozen = %v, want ErrFrozen", err)
	}
	if _, err := st.UnfreezeShipment(ctx, shipment.ID, "released", nil); err != nil {
		t.Fatalf("unfreeze: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE shipments SET status = 'delivered' WHERE id = $1`, shipment.ID); err != nil {
		t.Fatalf("force delivered: %v", err)
	}
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, ScanType: "hub_in", Location: "X"}); !errors.Is(err, ErrStatusGate) {
		t.Fatalf("scan on delivered = %v, want ErrStatusGate", err)
	}
}

// TestFreezeBlocksUpdates covers the ops hold: freezing sets the status,
// every movement endpoint returns ErrFrozen, delivered shipments cannot be
// frozen, and unfreezing restores movement.
func TestFreezeBlocksUpdates(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	hub := setupHub(t, st)
	shipment := setupShipment(t, st, &hub.ID)
	loc := "Hub A"
	if _, err := st.UpdateShipment(ctx, shipment.ID, UpdateShipmentInput{CurrentLocation: &loc}); err != nil {
		t.Fatalf("update shipment: %v", err)
	}
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, HubID: &hub.ID, ScanType: "pickup", Location: "Hub A"}); err != nil {
		t.Fatalf("pickup scan: %v", err)
	}

	frozen, err := st.FreezeShipment(ctx, shipment.ID, "legal hold", nil)
	if err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if !frozen.Frozen || frozen.Status != StatusFrozen || frozen.FrozenReason == nil || *frozen.FrozenReason != "legal hold" || frozen.FrozenAt == nil {
		t.Fatalf("frozen shipment = %+v", frozen)
	}
	if _, err := st.UpdateShipment(ctx, shipment.ID, UpdateShipmentInput{CurrentLocation: &loc}); !errors.Is(err, ErrFrozen) {
		t.Fatalf("update on frozen = %v, want ErrFrozen", err)
	}
	if _, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, ScanType: "hub_in", Location: "X"}); !errors.Is(err, ErrFrozen) {
		t.Fatalf("scan on frozen = %v, want ErrFrozen", err)
	}
	if _, err := st.UpdateCustody(ctx, shipment.ID, &hub.ID, CustodyKindHub, nil, ""); !errors.Is(err, ErrFrozen) {
		t.Fatalf("custody on frozen = %v, want ErrFrozen", err)
	}

	// A delivered shipment can never be frozen.
	other := setupShipment(t, st, &hub.ID)
	if _, err := pool.Exec(ctx, `UPDATE shipments SET status = 'delivered' WHERE id = $1`, other.ID); err != nil {
		t.Fatalf("force delivered: %v", err)
	}
	if _, err := st.FreezeShipment(ctx, other.ID, "hold", nil); !errors.Is(err, ErrNotFreezable) {
		t.Fatalf("freeze delivered = %v, want ErrNotFreezable", err)
	}

	// Unfreeze resumes the pre-freeze status.
	unfrozen, err := st.UnfreezeShipment(ctx, shipment.ID, "released by ops", nil)
	if err != nil {
		t.Fatalf("unfreeze: %v", err)
	}
	if unfrozen.Frozen || unfrozen.Status != StatusAtHub {
		t.Fatalf("unfrozen shipment = %+v", unfrozen)
	}
	if _, err := st.UnfreezeShipment(ctx, shipment.ID, "again", nil); !errors.Is(err, ErrNotUnfreezable) {
		t.Fatalf("double unfreeze = %v, want ErrNotUnfreezable", err)
	}
	// Movement works again after unfreezing.
	row, _, err := st.ScanShipment(ctx, ScanInput{ShipmentID: shipment.ID, HubID: &hub.ID, ScanType: "hub_out", Location: "Gate 3"})
	if err != nil {
		t.Fatalf("scan after unfreeze: %v", err)
	}
	if row.Status != StatusInTransit {
		t.Fatalf("post-unfreeze status = %q", row.Status)
	}
}

// TestShipmentPagination25 covers keyset pagination across two pages
// (20 + 5) with a cursor.
func TestShipmentPagination25(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	for i := 0; i < 25; i++ {
		setupShipment(t, st, nil)
	}
	page1, next, err := st.ListShipments(ctx, "", 20, "")
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("first page = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("missing next cursor after first page")
	}
	page2, next2, err := st.ListShipments(ctx, "", 5, next)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("second page = %d, want 5", len(page2))
	}
	if next2 != "" {
		t.Fatalf("second next = %q, want empty", next2)
	}
	if page1[19].ID == page2[0].ID {
		t.Fatal("pages overlap")
	}

	filtered, _, err := st.ListShipments(ctx, StatusPending, 100, "")
	if err != nil {
		t.Fatalf("status filter: %v", err)
	}
	if len(filtered) != 25 {
		t.Fatalf("pending-filtered = %d, want 25", len(filtered))
	}
	if _, _, err := st.ListShipments(ctx, "", 20, "garbage-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("bad cursor = %v, want ErrInvalidCursor", err)
	}
}

// TestConcurrentCreateSameOrder verifies the unique order_id constraint:
// racing creates for one order yield exactly one shipment and every loser
// observes ErrAlreadyExists (SHIPMENT_ALREADY_EXISTS at the API layer).
func TestConcurrentCreateSameOrder(t *testing.T) {
	pool := newTestPool(t)
	st := NewStore(pool)
	ctx := context.Background()

	orderID := uuid.New()
	const workers = 6
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		created int
		conflic int
		other   int
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := st.CreateShipment(ctx, CreateShipmentInput{OrderID: orderID, PackageCount: 1})
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				created++
			case errors.Is(err, ErrAlreadyExists):
				conflic++
			default:
				other++
			}
		}()
	}
	wg.Wait()
	if created != 1 || conflic != workers-1 || other != 0 {
		t.Fatalf("created=%d conflic=%d other=%d, want 1/%d/0", created, conflic, other, workers-1)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM shipments WHERE order_id = $1`, orderID).Scan(&count); err != nil {
		t.Fatalf("count shipments: %v", err)
	}
	if count != 1 {
		t.Fatalf("shipments for order = %d, want 1", count)
	}
}

func float64Ptr(v float64) *float64 { return &v }

func strPtr(v string) *string { return &v }
