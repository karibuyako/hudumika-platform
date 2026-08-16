//go:build integration

// ORDER-ROUTE / SCHEDULED-ADVANCE / SHIPMENT-REASSIGN integration tests
// against real PostgreSQL + Redis (docker compose). Run via
// DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/ -run 'OrderRoute|ScheduledOrder|ReassignShipment' -count=1
// Every test seeds only its own rows (unique +2559* phones, own hubs,
// vehicles, trips, legs, shipments, route legs, orders) and deletes exactly
// those rows in cleanup — the shared tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// orouPrefix marks every row this suite seeds so cleanup can delete exactly
// its own rows.
const orouPrefix = "orou"

// orouUnique builds a per-run unique string under the suite prefix.
func orouUnique(t *testing.T, kind string) string {
	t.Helper()
	return fmt.Sprintf("%s-%s-%09d", orouPrefix, kind, time.Now().UnixNano()%1_000_000_000)
}

// orouSeedUser inserts a users + roles pair and registers cleanup that
// deletes exactly this user's rows (orders are deleted by their own
// cleanups before the user goes).
func orouSeedUser(t *testing.T, pool *pgxpool.Pool, phone, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "OROU "+role+" "+phone).Scan(&id); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)`, id, role); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// orouSeedOrder inserts one order (optionally scheduled) and registers
// cleanup for exactly this order's route legs, events and row.
func orouSeedOrder(t *testing.T, pool *pgxpool.Pool, customerID, merchantID uuid.UUID, status string, scheduledAt *time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs, delivery_fee_tzs, platform_fee_tzs, total_tzs, scheduled_at)
		 VALUES ($1, $2, $3, 12000, 2000, 1000, 15000, $4) RETURNING id`,
		customerID, merchantID, status, scheduledAt).Scan(&id); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_route_legs WHERE order_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_events WHERE order_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// orouSeedHubs inserts two hubs and registers cleanup (deletes vehicles at
// the hub defensively; runs after the vehicle cleanups under LIFO).
func orouSeedHubs(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	seed := func() uuid.UUID {
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO hubs (name, code) VALUES ($1, $2) RETURNING id`,
			"OROU Hub "+orouUnique(t, "hub"), orouUnique(t, "hubcode")).Scan(&id); err != nil {
			t.Fatalf("seed hub: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM vehicles WHERE hub_id = $1`, id)
			_, _ = pool.Exec(context.Background(), `DELETE FROM hubs WHERE id = $1`, id)
		})
		return id
	}
	return seed(), seed()
}

// orouSeedVehicle inserts one vehicle parked at hub and registers cleanup.
func orouSeedVehicle(t *testing.T, pool *pgxpool.Pool, hubID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO vehicles (hub_id, plate, vehicle_type) VALUES ($1, $2, 'van') RETURNING id`,
		hubID, orouUnique(t, "plate")).Scan(&id); err != nil {
		t.Fatalf("seed vehicle: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM vehicles WHERE id = $1`, id)
	})
	return id
}

// orouSeedTrip inserts a planned trip (3 legs over the two hubs) and
// registers cleanup for the trip (legs cascade with the trip).
func orouSeedTrip(t *testing.T, pool *pgxpool.Pool, vehicleID, hubA, hubB uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO trips (code, vehicle_id, origin_hub_id, destination_hub_id, status)
		 VALUES ($1, $2, $3, $4, 'planned') RETURNING id`,
		"ORU-"+orouUnique(t, "trip"), vehicleID, hubA, hubB).Scan(&id); err != nil {
		t.Fatalf("seed trip: %v", err)
	}
	for i, leg := range []struct {
		seq  int
		mode string
		from uuid.UUID
		to   uuid.UUID
	}{
		{1, "first_mile", hubA, hubA},
		{2, "line_haul", hubA, hubB},
		{3, "last_mile", hubB, hubB},
	} {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO trip_legs (trip_id, sequence, mode, from_hub_id, to_hub_id)
			 VALUES ($1, $2, $3, $4, $5)`,
			id, leg.seq, leg.mode, leg.from, leg.to); err != nil {
			t.Fatalf("seed trip leg %d: %v", i, err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM trips WHERE id = $1`, id)
	})
	return id
}

// orouSeedShipment inserts one shipment and registers cleanup (its events,
// tracking rows and the row itself; runs before the trip cleanup under LIFO
// because shipments.trip_id references trips).
func orouSeedShipment(t *testing.T, pool *pgxpool.Pool, orderID, hubA, hubB uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO shipments (order_id, waybill_number, status, origin_hub_id, destination_hub_id, custody_kind)
		 VALUES ($1, $2, $3, $4, $5, 'none') RETURNING id`,
		orderID, orouUnique(t, "wb"), status, hubA, hubB).Scan(&id); err != nil {
		t.Fatalf("seed shipment: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM shipment_events WHERE shipment_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM waybill_tracking WHERE shipment_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM shipments WHERE id = $1`, id)
	})
	return id
}

// orouLinkRouteLegs mirrors each trip leg onto the order's route legs.
func orouLinkRouteLegs(t *testing.T, pool *pgxpool.Pool, orderID, tripID uuid.UUID) {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id, sequence, mode FROM trip_legs WHERE trip_id = $1 ORDER BY sequence`, tripID)
	if err != nil {
		t.Fatalf("list trip legs: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			legID    uuid.UUID
			sequence int
			mode     string
		)
		if err := rows.Scan(&legID, &sequence, &mode); err != nil {
			t.Fatalf("scan trip leg: %v", err)
		}
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO order_route_legs (order_id, leg_id, sequence, mode)
			 VALUES ($1, $2, $3, $4)`, orderID, legID, sequence, mode); err != nil {
			t.Fatalf("link route leg: %v", err)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate trip legs: %v", err)
	}
}

// orouSetShipmentStatus rewrites a shipment's status (test fixture helper).
func orouSetShipmentStatus(t *testing.T, pool *pgxpool.Pool, shipmentID uuid.UUID, status string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE shipments SET status = $2, updated_at = now() WHERE id = $1`, shipmentID, status); err != nil {
		t.Fatalf("move shipment to %s: %v", status, err)
	}
}

// TestOrderRouteSegmentsReturned: a scheduled route with mirrored legs comes
// back as RouteSegment[] in sequence order with the trip-leg hub ids and the
// per-leg status.
func TestOrderRouteSegmentsReturned(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c1"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m1"), "merchant")
	customerToken := tokenFor(t, s, phoneOf(t, pool, customerID), RoleCustomer, true)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)
	hubA, hubB := orouSeedHubs(t, pool)
	vehicleID := orouSeedVehicle(t, pool, hubA)
	tripID := orouSeedTrip(t, pool, vehicleID, hubA, hubB)
	orouLinkRouteLegs(t, pool, orderID, tripID)

	rec := authedGET(t, s.Router(), "/orders/"+orderID.String()+"/route", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("route status = %d (%s)", rec.Code, rec.Body)
	}
	var segments []gen.RouteSegment
	if err := json.NewDecoder(rec.Body).Decode(&segments); err != nil {
		t.Fatalf("decode segments: %v", err)
	}
	if len(segments) != 3 {
		t.Fatalf("segments = %d, want 3", len(segments))
	}
	wantTypes := []gen.RouteSegmentType{gen.FirstMile, gen.Linehaul, gen.LastMile}
	for i, seg := range segments {
		if seg.Sequence != i+1 {
			t.Fatalf("segment %d sequence = %d, want %d", i, seg.Sequence, i+1)
		}
		if seg.Type != wantTypes[i] {
			t.Fatalf("segment %d type = %q, want %q", i, seg.Type, wantTypes[i])
		}
		if seg.Status != gen.RouteSegmentStatusPending {
			t.Fatalf("segment %d status = %q, want pending", i, seg.Status)
		}
		if seg.LegId == uuid.Nil {
			t.Fatalf("segment %d legId is nil", i)
		}
		if i == 1 && (seg.FromHubId == nil || seg.ToHubId == nil) {
			t.Fatalf("segment %d hub ids missing", i)
		}
	}
}

// TestOrderRouteWithoutLegsIsEmptyArray: an order with no route legs answers
// the contract's empty shape — a JSON array, never null.
func TestOrderRouteWithoutLegsIsEmptyArray(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c2"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m2"), "merchant")
	customerToken := tokenFor(t, s, phoneOf(t, pool, customerID), RoleCustomer, true)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)

	rec := authedGET(t, s.Router(), "/orders/"+orderID.String()+"/route", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("route status = %d (%s)", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if body != "[]" && body != "[]\n" {
		t.Fatalf("empty route body = %q, want []", body)
	}
}

// TestOrderRouteNonPartyNotFound: a customer who does not own the order sees
// the same 404 ORDER_NOT_FOUND as a missing order (existence never leaks).
func TestOrderRouteNonPartyNotFound(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c3"), "customer")
	otherID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c4"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m3"), "merchant")
	otherToken := tokenFor(t, s, phoneOf(t, pool, otherID), RoleCustomer, true)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)

	rec := authedGET(t, s.Router(), "/orders/"+orderID.String()+"/route", otherToken)
	wantError(t, rec, http.StatusNotFound, "ORDER_NOT_FOUND")
}

// TestOrderRouteMissingOrder: a random order id is 404 ORDER_NOT_FOUND.
func TestOrderRouteMissingOrder(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c5"), "customer")
	customerToken := tokenFor(t, s, phoneOf(t, pool, customerID), RoleCustomer, true)

	rec := authedGET(t, s.Router(), "/orders/"+uuid.NewString()+"/route", customerToken)
	wantError(t, rec, http.StatusNotFound, "ORDER_NOT_FOUND")
}

// TestAdvanceScheduledOrderHappy: the owning customer advances a scheduled
// paid order into preparing; the order row, the version and the response
// reflect the move.
func TestAdvanceScheduledOrderHappy(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c6"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m6"), "merchant")
	customerToken := tokenFor(t, s, phoneOf(t, pool, customerID), RoleCustomer, true)
	future := time.Now().Add(2 * time.Hour)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", &future)

	h := s.RequireAuth(http.HandlerFunc(s.AdvanceScheduledOrder))
	body := fmt.Sprintf(`{"orderId":%q,"status":"preparing"}`, orderID.String())
	rec := authedPOSTJSON(t, h, "/orders/me/advance", body, customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("advance status = %d (%s)", rec.Code, rec.Body)
	}
	var out gen.Order
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode order: %v", err)
	}
	if out.Status != gen.OrderStatus("preparing") {
		t.Fatalf("order status = %q, want preparing", out.Status)
	}
	if out.Version == nil || *out.Version != 2 {
		t.Fatalf("order version = %v, want 2", out.Version)
	}
	if out.ScheduledAt == nil {
		t.Fatalf("scheduledAt is nil, want the order's scheduled time")
	}
	if out.ScheduledAt.Sub(future) > time.Second || future.Sub(*out.ScheduledAt) > time.Second {
		t.Fatalf("scheduledAt = %v, want ~%v", out.ScheduledAt, future)
	}
	var dbStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM orders WHERE id = $1`, orderID).Scan(&dbStatus); err != nil {
		t.Fatalf("read order status: %v", err)
	}
	if dbStatus != "preparing" {
		t.Fatalf("db status = %q, want preparing", dbStatus)
	}
}

// TestAdvanceScheduledOrderWrongState: a scheduled order past the
// confirmation window (already preparing) is 409 ORDER_MODIFICATION_NOT_ALLOWED.
func TestAdvanceScheduledOrderWrongState(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c7"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m7"), "merchant")
	customerToken := tokenFor(t, s, phoneOf(t, pool, customerID), RoleCustomer, true)
	future := time.Now().Add(2 * time.Hour)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "preparing", &future)

	h := s.RequireAuth(http.HandlerFunc(s.AdvanceScheduledOrder))
	rec := authedPOSTJSON(t, h, "/orders/me/advance",
		fmt.Sprintf(`{"orderId":%q,"status":"preparing"}`, orderID.String()), customerToken)
	wantError(t, rec, http.StatusConflict, "ORDER_MODIFICATION_NOT_ALLOWED")
}

// TestAdvanceScheduledOrderNotScheduled: an order without scheduled_at is not
// a pre-order and refuses advancement with 409 PREORDERS_DISABLED.
func TestAdvanceScheduledOrderNotScheduled(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c8"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m8"), "merchant")
	customerToken := tokenFor(t, s, phoneOf(t, pool, customerID), RoleCustomer, true)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)

	h := s.RequireAuth(http.HandlerFunc(s.AdvanceScheduledOrder))
	rec := authedPOSTJSON(t, h, "/orders/me/advance",
		fmt.Sprintf(`{"orderId":%q,"status":"preparing"}`, orderID.String()), customerToken)
	wantError(t, rec, http.StatusConflict, "PREORDERS_DISABLED")
}

// TestAdvanceScheduledOrderNotOwner: another customer's scheduled order is
// 404 ORDER_NOT_FOUND.
func TestAdvanceScheduledOrderNotOwner(t *testing.T) {
	s, pool := newPersistentServer(t)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c9"), "customer")
	otherID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c10"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m9"), "merchant")
	otherToken := tokenFor(t, s, phoneOf(t, pool, otherID), RoleCustomer, true)
	future := time.Now().Add(2 * time.Hour)
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", &future)

	h := s.RequireAuth(http.HandlerFunc(s.AdvanceScheduledOrder))
	rec := authedPOSTJSON(t, h, "/orders/me/advance",
		fmt.Sprintf(`{"orderId":%q,"status":"preparing"}`, orderID.String()), otherToken)
	wantError(t, rec, http.StatusNotFound, "ORDER_NOT_FOUND")
}

// TestReassignShipmentHappy: the dispatcher moves a pending shipment onto a
// planned trip; the shipment binds trip_id + the trip's vehicle and the
// reassigned event lands in the ledger.
func TestReassignShipmentHappy(t *testing.T) {
	s, pool := newPersistentServer(t)
	staffToken := tokenFor(t, s, orouPhone(t, pool, "orou-s1"), RoleAdmin, true)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c11"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m11"), "merchant")
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)
	hubA, hubB := orouSeedHubs(t, pool)
	vehicleID := orouSeedVehicle(t, pool, hubA)
	tripID := orouSeedTrip(t, pool, vehicleID, hubA, hubB)
	shipmentID := orouSeedShipment(t, pool, orderID, hubA, hubB, "pending")

	body := fmt.Sprintf(`{"reason":"consolidation","tripId":%q}`, tripID.String())
	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+shipmentID.String()+"/reassign", body, staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("reassign status = %d (%s)", rec.Code, rec.Body)
	}
	var out gen.Shipment
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode shipment: %v", err)
	}
	if out.Status != gen.ShipmentStatusPlanned {
		t.Fatalf("shipment status = %q, want planned", out.Status)
	}
	var (
		dbTripID    *uuid.UUID
		dbVehicleID *uuid.UUID
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT trip_id, vehicle_id FROM shipments WHERE id = $1`, shipmentID).
		Scan(&dbTripID, &dbVehicleID); err != nil {
		t.Fatalf("read shipment: %v", err)
	}
	if dbTripID == nil || *dbTripID != tripID {
		t.Fatalf("trip_id = %v, want %s", dbTripID, tripID)
	}
	if dbVehicleID == nil || *dbVehicleID != vehicleID {
		t.Fatalf("vehicle_id = %v, want %s", dbVehicleID, vehicleID)
	}
	var eventCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM shipment_events WHERE shipment_id = $1 AND status = 'reassigned'`, shipmentID).
		Scan(&eventCount); err != nil {
		t.Fatalf("count reassigned events: %v", err)
	}
	if eventCount != 1 {
		t.Fatalf("reassigned events = %d, want 1", eventCount)
	}
}

// TestReassignShipmentAfterDeparture: a shipment on the road cannot be
// reassigned (409 SHIPMENT_NOT_REASSIGNABLE).
func TestReassignShipmentAfterDeparture(t *testing.T) {
	s, pool := newPersistentServer(t)
	staffToken := tokenFor(t, s, orouPhone(t, pool, "orou-s2"), RoleAdmin, true)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c12"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m12"), "merchant")
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)
	hubA, hubB := orouSeedHubs(t, pool)
	vehicleID := orouSeedVehicle(t, pool, hubA)
	tripID := orouSeedTrip(t, pool, vehicleID, hubA, hubB)
	shipmentID := orouSeedShipment(t, pool, orderID, hubA, hubB, "pending")
	orouSetShipmentStatus(t, pool, shipmentID, "in_transit")

	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+shipmentID.String()+"/reassign",
		fmt.Sprintf(`{"reason":"reroute","tripId":%q}`, tripID.String()), staffToken)
	wantError(t, rec, http.StatusConflict, "SHIPMENT_NOT_REASSIGNABLE")
}

// TestReassignShipmentUnknownTrip: a random trip id is 404 TRIP_NOT_FOUND.
func TestReassignShipmentUnknownTrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	staffToken := tokenFor(t, s, orouPhone(t, pool, "orou-s3"), RoleAdmin, true)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c13"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m13"), "merchant")
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)
	hubA, hubB := orouSeedHubs(t, pool)
	shipmentID := orouSeedShipment(t, pool, orderID, hubA, hubB, "pending")

	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+shipmentID.String()+"/reassign",
		fmt.Sprintf(`{"reason":"reroute","tripId":%q}`, uuid.NewString()), staffToken)
	wantError(t, rec, http.StatusNotFound, "TRIP_NOT_FOUND")
}

// TestReassignShipmentUnknownShipment: a random shipment id is 404
// SHIPMENT_NOT_FOUND.
func TestReassignShipmentUnknownShipment(t *testing.T) {
	s, pool := newPersistentServer(t)
	staffToken := tokenFor(t, s, orouPhone(t, pool, "orou-s4"), RoleAdmin, true)
	hubA, hubB := orouSeedHubs(t, pool)
	vehicleID := orouSeedVehicle(t, pool, hubA)
	tripID := orouSeedTrip(t, pool, vehicleID, hubA, hubB)

	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+uuid.NewString()+"/reassign",
		fmt.Sprintf(`{"reason":"reroute","tripId":%q}`, tripID.String()), staffToken)
	wantError(t, rec, http.StatusNotFound, "SHIPMENT_NOT_FOUND")
}

// TestReassignShipmentVehicleBusy: the target trip's vehicle already rides
// another active trip — 409 TRIP_ALREADY_ACTIVE.
func TestReassignShipmentVehicleBusy(t *testing.T) {
	s, pool := newPersistentServer(t)
	staffToken := tokenFor(t, s, orouPhone(t, pool, "orou-s5"), RoleAdmin, true)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c14"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m14"), "merchant")
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)
	hubA, hubB := orouSeedHubs(t, pool)
	vehicleID := orouSeedVehicle(t, pool, hubA)
	targetTrip := orouSeedTrip(t, pool, vehicleID, hubA, hubB)
	busyTrip := orouSeedTrip(t, pool, vehicleID, hubA, hubB)
	shipmentID := orouSeedShipment(t, pool, orderID, hubA, hubB, "pending")

	// The busy trip shares the vehicle and is itself active (planned); the
	// second trip insert is a direct SQL fixture because OpsStore.CreateTrip
	// refuses a vehicle on two active trips by design.
	if _, err := pool.Exec(context.Background(),
		`UPDATE trips SET status = 'in_progress' WHERE id = $1`, busyTrip); err != nil {
		t.Fatalf("start busy trip: %v", err)
	}

	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+shipmentID.String()+"/reassign",
		fmt.Sprintf(`{"reason":"reroute","tripId":%q}`, targetTrip.String()), staffToken)
	wantError(t, rec, http.StatusConflict, "TRIP_ALREADY_ACTIVE")
}

// TestReassignShipmentClosedTrip: a completed trip cannot take a
// reassignment (409 TRIP_ALREADY_ACTIVE).
func TestReassignShipmentClosedTrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	staffToken := tokenFor(t, s, orouPhone(t, pool, "orou-s6"), RoleAdmin, true)
	customerID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-c15"), "customer")
	merchantID := orouSeedUser(t, pool, uniqueAdminPhone(t, "orou-m15"), "merchant")
	orderID := orouSeedOrder(t, pool, customerID, merchantID, "paid", nil)
	hubA, hubB := orouSeedHubs(t, pool)
	vehicleID := orouSeedVehicle(t, pool, hubA)
	tripID := orouSeedTrip(t, pool, vehicleID, hubA, hubB)
	shipmentID := orouSeedShipment(t, pool, orderID, hubA, hubB, "pending")

	if _, err := pool.Exec(context.Background(),
		`UPDATE trips SET status = 'completed' WHERE id = $1`, tripID); err != nil {
		t.Fatalf("close trip: %v", err)
	}
	rec := authedPOSTJSON(t, s.Router(), "/admin/shipments/"+shipmentID.String()+"/reassign",
		fmt.Sprintf(`{"reason":"reroute","tripId":%q}`, tripID.String()), staffToken)
	wantError(t, rec, http.StatusConflict, "TRIP_ALREADY_ACTIVE")
}

// phoneOf resolves the seeded user's phone for the token subject.
func phoneOf(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) string {
	t.Helper()
	var phone string
	if err := pool.QueryRow(context.Background(),
		`SELECT phone FROM users WHERE id = $1`, userID).Scan(&phone); err != nil {
		t.Fatalf("read user phone: %v", err)
	}
	return phone
}

// orouPhone seeds a staff user (users row only — the roles CHECK constraint
// admits no staff role, and auth rides the JWT claim, matching
// seedDispatchAdmin) and returns its phone, registering cleanup.
func orouPhone(t *testing.T, pool *pgxpool.Pool, kind string) string {
	t.Helper()
	phone := uniqueAdminPhone(t, kind)
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "OROU staff "+phone).Scan(&id); err != nil {
		t.Fatalf("seed staff user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return phone
}
