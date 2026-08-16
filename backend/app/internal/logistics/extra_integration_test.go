//go:build integration

// Integration tests for the logistics-extra bounded context (migration
// 00041) against real PostgreSQL.
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/logistics/ -count=1
//
// Every run truncates ONLY this context's tables (routes, warehouses,
// carriers, facilities, consignments, delivery_exceptions) so the suite is
// isolated from the core logistics lane and other agents' tables. Hubs and
// shipments are the core lane's rows: this suite inserts its OWN hub and
// shipment rows (the core suite truncates its own tables in another
// process) and removes them on cleanup.
package logistics

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// extraTables is every table owned by this bounded context (migration
// 00041). CASCADE covers the consignments FKs onto routes/carriers.
const extraTables = `delivery_exceptions, consignments, facilities, carriers, warehouses, routes`

// newExtraTestPool connects to DATABASE_URL and truncates only the
// logistics-extra tables so the suite is isolated from other agents' data.
func newExtraTestPool(t *testing.T) *pgxpool.Pool {
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
	if _, err := pool.Exec(context.Background(), `TRUNCATE `+extraTables+` CASCADE`); err != nil {
		t.Fatalf("truncate logistics-extra tables: %v", err)
	}
	return pool
}

// extraFixture bundles the store, the pool and the self-owned core-lane rows
// (hubs, shipments) this suite creates; cleanup removes them.
type extraFixture struct {
	pool *pgxpool.Pool
	st   *ExtraStore
	core *Store
}

func newExtraFixture(t *testing.T) *extraFixture {
	pool := newExtraTestPool(t)
	return &extraFixture{pool: pool, st: NewExtraStore(pool), core: NewStore(pool)}
}

// ownHub creates this suite's own hubs row and removes it on cleanup (the
// core suite truncates the hubs table in another process, so rows are never
// assumed to survive).
func (fx *extraFixture) ownHub(t *testing.T) uuid.UUID {
	t.Helper()
	hub := setupHub(t, fx.core)
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(context.Background(), `DELETE FROM hubs WHERE id = $1`, hub.ID)
	})
	return hub.ID
}

// ownShipment creates this suite's own shipments row and removes it on
// cleanup (its shipment_events/packages rows cascade away).
func (fx *extraFixture) ownShipment(t *testing.T) uuid.UUID {
	t.Helper()
	shipment := setupShipment(t, fx.core, nil)
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(context.Background(), `DELETE FROM shipments WHERE id = $1`, shipment.ID)
	})
	return shipment.ID
}

// setupRoute inserts an active route between the two hubs and returns it.
func (fx *extraFixture) setupRoute(t *testing.T, from, to uuid.UUID) RouteRow {
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
	return route
}

// setupCarrier registers an active line-haul carrier and returns it.
func (fx *extraFixture) setupCarrier(t *testing.T) CarrierRow {
	t.Helper()
	carrier, err := fx.st.CreateCarrier(context.Background(), CarrierInput{
		Name:    "SF Tanzania",
		Mode:    CarrierModeLinehaul,
		Regions: []string{"dar", "mwanza"},
	})
	if err != nil {
		t.Fatalf("create carrier: %v", err)
	}
	return carrier
}

// TestRouteWarehouseCarrierFacilityCRUD covers the registry lifecycle: create
// -> get -> list plus the duplicate and missing-row sentinels.
func TestRouteWarehouseCarrierFacilityCRUD(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	hubA, hubB := fx.ownHub(t), fx.ownHub(t)
	route, err := fx.st.CreateRoute(ctx, RouteInput{
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
		DistanceKm: float64Ptr(512.5), DurationMinutes: intPtr(720),
	})
	if err != nil {
		t.Fatalf("create route: %v", err)
	}
	if route.ID == uuid.Nil || route.DistanceKm != 512.5 || route.DurationMinutes != 720 || !route.Active {
		t.Fatalf("created route = %+v", route)
	}
	if _, err := fx.st.CreateRoute(ctx, RouteInput{OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB)}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate route pair = %v, want ErrAlreadyExists", err)
	}
	got, err := fx.st.GetRoute(ctx, route.ID)
	if err != nil || got.DurationMinutes != 720 {
		t.Fatalf("get route = %+v, %v", got, err)
	}
	found, err := fx.st.FindRoute(ctx, hubA, hubB)
	if err != nil || found.ID != route.ID {
		t.Fatalf("find route = %+v, %v", found, err)
	}
	if _, err := fx.st.FindRoute(ctx, hubB, hubA); !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("find reverse route = %v, want ErrRouteNotFound", err)
	}
	if _, err := fx.st.GetRoute(ctx, uuid.New()); !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("missing route = %v, want ErrRouteNotFound", err)
	}
	routes, err := fx.st.ListRoutes(ctx)
	if err != nil || len(routes) != 1 {
		t.Fatalf("listed routes = %d, %v", len(routes), err)
	}

	wh, err := fx.st.CreateWarehouse(ctx, WarehouseInput{Name: "Kariakoo", City: strPtr("Dar es Salaam"), CapacityKg: float64Ptr(1000)})
	if err != nil {
		t.Fatalf("create warehouse: %v", err)
	}
	if wh.Name != "Kariakoo" || wh.CapacityKg != 1000 || wh.Status != WarehouseStatusActive {
		t.Fatalf("created warehouse = %+v", wh)
	}
	if _, err := fx.st.GetWarehouse(ctx, wh.ID); err != nil {
		t.Fatalf("get warehouse: %v", err)
	}
	if _, err := fx.st.GetWarehouse(ctx, uuid.New()); !errors.Is(err, ErrWarehouseNotFound) {
		t.Fatalf("missing warehouse = %v, want ErrWarehouseNotFound", err)
	}
	warehouses, err := fx.st.ListWarehouses(ctx)
	if err != nil || len(warehouses) != 1 {
		t.Fatalf("listed warehouses = %d, %v", len(warehouses), err)
	}

	carrier, err := fx.st.CreateCarrier(ctx, CarrierInput{Name: "SF Tanzania", Mode: CarrierModeLinehaul, Regions: []string{"dar"}})
	if err != nil {
		t.Fatalf("create carrier: %v", err)
	}
	if carrier.Mode != CarrierModeLinehaul || carrier.Status != CarrierStatusActive {
		t.Fatalf("created carrier = %+v", carrier)
	}
	if _, err := fx.st.GetCarrier(ctx, carrier.ID); err != nil {
		t.Fatalf("get carrier: %v", err)
	}
	if _, err := fx.st.GetCarrier(ctx, uuid.New()); !errors.Is(err, ErrCarrierNotFound) {
		t.Fatalf("missing carrier = %v, want ErrCarrierNotFound", err)
	}
	carriers, err := fx.st.ListCarriers(ctx)
	if err != nil || len(carriers) != 1 {
		t.Fatalf("listed carriers = %d, %v", len(carriers), err)
	}

	facility, err := fx.st.CreateFacility(ctx, FacilityInput{Name: "Mikocheni Gate", Kind: FacilityKindHub, HubID: ptr(hubA)})
	if err != nil {
		t.Fatalf("create facility: %v", err)
	}
	if facility.Name != "Mikocheni Gate" || facility.Kind != FacilityKindHub || facility.HubID == nil || *facility.HubID != hubA {
		t.Fatalf("created facility = %+v", facility)
	}
	if _, err := fx.st.GetFacility(ctx, facility.ID); err != nil {
		t.Fatalf("get facility: %v", err)
	}
	if _, err := fx.st.GetFacility(ctx, uuid.New()); !errors.Is(err, ErrFacilityNotFound) {
		t.Fatalf("missing facility = %v, want ErrFacilityNotFound", err)
	}
	facilities, err := fx.st.ListFacilities(ctx)
	if err != nil || len(facilities) != 1 {
		t.Fatalf("listed facilities = %d, %v", len(facilities), err)
	}
}

// TestConsignmentCreateValidation covers the create guards: an unconfigured
// route is ErrRouteNotFound, an unavailable carrier is ErrCarrierUnavailable
// and a happy create lands with a CN- code and the assembling status.
func TestConsignmentCreateValidation(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	hubA, hubB := fx.ownHub(t), fx.ownHub(t)

	if _, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: uuid.New(), CarrierID: uuid.New(),
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
	}); !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("consignment on missing route = %v, want ErrRouteNotFound", err)
	}

	route := fx.setupRoute(t, hubA, hubB)
	if _, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: uuid.New(),
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
	}); !errors.Is(err, ErrCarrierUnavailable) {
		t.Fatalf("consignment on missing carrier = %v, want ErrCarrierUnavailable", err)
	}

	if _, err := fx.st.FindActiveCarrier(ctx, CarrierModeLinehaul); !errors.Is(err, ErrCarrierUnavailable) {
		t.Fatalf("find active carrier before registration = %v, want ErrCarrierUnavailable", err)
	}
	suspended := CarrierStatusSuspended
	if _, err := fx.st.CreateCarrier(ctx, CarrierInput{Name: "Idle", Mode: CarrierModeLinehaul, Status: &suspended}); err != nil {
		t.Fatalf("create suspended carrier: %v", err)
	}
	if _, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: uuid.New(),
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
	}); !errors.Is(err, ErrCarrierUnavailable) {
		t.Fatalf("consignment on missing carrier (suspended only) = %v, want ErrCarrierUnavailable", err)
	}

	carrier := fx.setupCarrier(t)
	active, err := fx.st.FindActiveCarrier(ctx, CarrierModeLinehaul)
	if err != nil || active.ID != carrier.ID {
		t.Fatalf("find active carrier = %+v, %v", active, err)
	}
	orderID := uuid.New()
	row, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: carrier.ID,
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
		OrderIDs: []uuid.UUID{orderID},
	})
	if err != nil {
		t.Fatalf("create consignment: %v", err)
	}
	if !strings.HasPrefix(row.Code, "CN-") || len(row.Code) != len("CN-")+8 {
		t.Fatalf("consignment code = %q, want CN-<8 hex>", row.Code)
	}
	if row.Status != ConsignmentStatusAssembling || len(row.OrderIDs) != 1 || row.OrderIDs[0] != orderID {
		t.Fatalf("created consignment = %+v", row)
	}
	if row.RouteID != route.ID || row.CarrierID == nil || *row.CarrierID != carrier.ID {
		t.Fatalf("created consignment refs = %+v", row)
	}
}

// TestConsignmentCapacityExceeded covers the weight guard: a payload heavier
// than the consignment capacity is ErrCapacityWeightExceeded; an equal or
// lighter payload lands.
func TestConsignmentCapacityExceeded(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	hubA, hubB := fx.ownHub(t), fx.ownHub(t)
	route := fx.setupRoute(t, hubA, hubB)
	carrier := fx.setupCarrier(t)

	if _, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: carrier.ID,
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
		CapacityKg: float64Ptr(100), WeightKg: float64Ptr(150),
	}); !errors.Is(err, ErrCapacityWeightExceeded) {
		t.Fatalf("overweight consignment = %v, want ErrCapacityWeightExceeded", err)
	}
	row, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: carrier.ID,
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
		CapacityKg: float64Ptr(100), WeightKg: float64Ptr(100),
	})
	if err != nil {
		t.Fatalf("at-capacity consignment: %v", err)
	}
	if row.CapacityKg != 100 || row.WeightKg != 100 {
		t.Fatalf("created consignment = %+v", row)
	}
}

// TestConsignmentAddOrder covers the manifest ceiling (50 orders) and the
// status gate (orders only land while assembling).
func TestConsignmentAddOrder(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	hubA, hubB := fx.ownHub(t), fx.ownHub(t)
	route := fx.setupRoute(t, hubA, hubB)
	carrier := fx.setupCarrier(t)
	row, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: carrier.ID,
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
	})
	if err != nil {
		t.Fatalf("create consignment: %v", err)
	}

	for i := 0; i < maxConsignmentOrders; i++ {
		if _, err := fx.st.AddOrderToConsignment(ctx, row.ID, uuid.New()); err != nil {
			t.Fatalf("add order %d: %v", i, err)
		}
	}
	if _, err := fx.st.AddOrderToConsignment(ctx, row.ID, uuid.New()); !errors.Is(err, ErrConsignmentFull) {
		t.Fatalf("51st order = %v, want ErrConsignmentFull", err)
	}
	full, err := fx.st.GetConsignment(ctx, row.ID)
	if err != nil || len(full.OrderIDs) != maxConsignmentOrders {
		t.Fatalf("manifest length = %d, %v", len(full.OrderIDs), err)
	}

	if _, err := fx.st.SealConsignment(ctx, row.ID); err != nil {
		t.Fatalf("seal consignment: %v", err)
	}
	if _, err := fx.st.AddOrderToConsignment(ctx, row.ID, uuid.New()); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("add order to sealed consignment = %v, want ErrConsignmentAlreadyDeparted", err)
	}
}

// TestConsignmentLifecycle covers assembling -> sealed -> departed -> arrived
// plus the double-transition and missing-row conflicts.
func TestConsignmentLifecycle(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	hubA, hubB := fx.ownHub(t), fx.ownHub(t)
	route := fx.setupRoute(t, hubA, hubB)
	carrier := fx.setupCarrier(t)
	row, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: carrier.ID,
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
		OrderIDs: []uuid.UUID{uuid.New()},
	})
	if err != nil {
		t.Fatalf("create consignment: %v", err)
	}
	if row.Status != ConsignmentStatusAssembling {
		t.Fatalf("initial status = %q", row.Status)
	}

	sealed, err := fx.st.SealConsignment(ctx, row.ID)
	if err != nil || sealed.Status != ConsignmentStatusSealed {
		t.Fatalf("seal = %+v, %v", sealed, err)
	}
	if _, err := fx.st.SealConsignment(ctx, row.ID); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("double seal = %v, want ErrConsignmentAlreadyDeparted", err)
	}

	departed, err := fx.st.DepartConsignment(ctx, row.ID)
	if err != nil || departed.Status != ConsignmentStatusDeparted {
		t.Fatalf("depart = %+v, %v", departed, err)
	}
	if _, err := fx.st.DepartConsignment(ctx, row.ID); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("double depart = %v, want ErrConsignmentAlreadyDeparted", err)
	}

	arrived, err := fx.st.ArriveConsignment(ctx, row.ID)
	if err != nil || arrived.Status != ConsignmentStatusArrived {
		t.Fatalf("arrive = %+v, %v", arrived, err)
	}
	if _, err := fx.st.ArriveConsignment(ctx, row.ID); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("double arrive = %v, want ErrConsignmentAlreadyDeparted", err)
	}

	// A second consignment shows the depart gate from assembling.
	other, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
		RouteID: route.ID, CarrierID: carrier.ID,
		OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
	})
	if err != nil {
		t.Fatalf("create second consignment: %v", err)
	}
	if _, err := fx.st.DepartConsignment(ctx, other.ID); !errors.Is(err, ErrConsignmentAlreadyDeparted) {
		t.Fatalf("depart assembling consignment = %v, want ErrConsignmentAlreadyDeparted", err)
	}

	for _, fn := range []func(uuid.UUID) (ConsignmentRow, error){
		func(id uuid.UUID) (ConsignmentRow, error) { return fx.st.SealConsignment(ctx, id) },
		func(id uuid.UUID) (ConsignmentRow, error) { return fx.st.DepartConsignment(ctx, id) },
		func(id uuid.UUID) (ConsignmentRow, error) { return fx.st.ArriveConsignment(ctx, id) },
	} {
		if _, err := fn(uuid.New()); !errors.Is(err, ErrConsignmentNotFound) {
			t.Fatalf("transition on missing consignment = %v, want ErrConsignmentNotFound", err)
		}
	}
	if _, err := fx.st.GetConsignment(ctx, uuid.New()); !errors.Is(err, ErrConsignmentNotFound) {
		t.Fatalf("get missing consignment = %v, want ErrConsignmentNotFound", err)
	}
}

// TestExceptionLifecycle covers create (with the shipment guard), list
// (status and kind filters) and resolve (with the already-resolved guard).
func TestExceptionLifecycle(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	if _, err := fx.st.CreateException(ctx, uuid.New(), ExceptionKindDamage, "no shipment"); !errors.Is(err, ErrShipmentNotFound) {
		t.Fatalf("exception on missing shipment = %v, want ErrShipmentNotFound", err)
	}
	shipmentID := fx.ownShipment(t)

	row, err := fx.st.CreateException(ctx, shipmentID, ExceptionKindDamage, "box crushed")
	if err != nil {
		t.Fatalf("create exception: %v", err)
	}
	if row.ShipmentID != shipmentID || row.Kind != ExceptionKindDamage || row.Status != ExceptionStatusOpen || row.ResolvedAt != nil {
		t.Fatalf("created exception = %+v", row)
	}
	if row.Description == nil || *row.Description != "box crushed" {
		t.Fatalf("exception description = %v", row.Description)
	}
	got, err := fx.st.GetException(ctx, row.ID)
	if err != nil || got.Status != ExceptionStatusOpen {
		t.Fatalf("get exception = %+v, %v", got, err)
	}

	all, _, err := fx.st.ListExceptions(ctx, "", 20, "")
	if err != nil || len(all) != 1 {
		t.Fatalf("list exceptions = %d, %v", len(all), err)
	}
	damage, _, err := fx.st.ListExceptionsByKind(ctx, ExceptionKindDamage, "", 20, "")
	if err != nil || len(damage) != 1 {
		t.Fatalf("list damage exceptions = %d, %v", len(damage), err)
	}
	delay, _, err := fx.st.ListExceptionsByKind(ctx, ExceptionKindDelay, "", 20, "")
	if err != nil || len(delay) != 0 {
		t.Fatalf("list delay exceptions = %d, %v", len(delay), err)
	}
	open, _, err := fx.st.ListExceptions(ctx, "open", 20, "")
	if err != nil || len(open) != 1 {
		t.Fatalf("list open exceptions = %d, %v", len(open), err)
	}

	resolved, err := fx.st.ResolveException(ctx, row.ID)
	if err != nil {
		t.Fatalf("resolve exception: %v", err)
	}
	if resolved.Status != ExceptionStatusResolved || resolved.ResolvedAt == nil {
		t.Fatalf("resolved exception = %+v", resolved)
	}
	if _, err := fx.st.ResolveException(ctx, row.ID); !errors.Is(err, ErrExceptionAlreadyResolved) {
		t.Fatalf("double resolve = %v, want ErrExceptionAlreadyResolved", err)
	}
	if _, err := fx.st.ResolveException(ctx, uuid.New()); !errors.Is(err, ErrExceptionNotFound) {
		t.Fatalf("resolve missing exception = %v, want ErrExceptionNotFound", err)
	}
	stillOpen, _, err := fx.st.ListExceptions(ctx, "open", 20, "")
	if err != nil || len(stillOpen) != 0 {
		t.Fatalf("list open after resolve = %d, %v", len(stillOpen), err)
	}
	done, _, err := fx.st.ListExceptions(ctx, "resolved", 20, "")
	if err != nil || len(done) != 1 {
		t.Fatalf("list resolved = %d, %v", len(done), err)
	}
}

// TestConsignmentPagination25 covers keyset pagination across two pages
// (20 + 5) with a cursor and the status filter.
func TestConsignmentPagination25(t *testing.T) {
	fx := newExtraFixture(t)
	ctx := context.Background()

	hubA, hubB := fx.ownHub(t), fx.ownHub(t)
	route := fx.setupRoute(t, hubA, hubB)
	carrier := fx.setupCarrier(t)
	for i := 0; i < 25; i++ {
		if _, err := fx.st.CreateConsignment(ctx, CreateConsignmentInput{
			RouteID: route.ID, CarrierID: carrier.ID,
			OriginHubID: ptr(hubA), DestinationHubID: ptr(hubB),
			OrderIDs: []uuid.UUID{uuid.New()},
		}); err != nil {
			t.Fatalf("create consignment %d: %v", i, err)
		}
	}

	page1, next, err := fx.st.ListConsignments(ctx, "", 20, "")
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("first page = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("missing next cursor after first page")
	}
	page2, next2, err := fx.st.ListConsignments(ctx, "", 5, next)
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

	manifesting, _, err := fx.st.ListConsignments(ctx, "manifesting", 100, "")
	if err != nil {
		t.Fatalf("manifesting filter: %v", err)
	}
	if len(manifesting) != 25 {
		t.Fatalf("manifesting-filtered = %d, want 25", len(manifesting))
	}
	delivered, _, err := fx.st.ListConsignments(ctx, "delivered", 100, "")
	if err != nil || len(delivered) != 0 {
		t.Fatalf("delivered-filtered = %d, %v", len(delivered), err)
	}
	if _, _, err := fx.st.ListConsignments(ctx, "", 20, "garbage-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("bad cursor = %v, want ErrInvalidCursor", err)
	}
	if _, _, err := fx.st.ListConsignments(ctx, "bogus", 20, ""); err == nil {
		t.Fatal("unknown status filter = nil error")
	}
}
