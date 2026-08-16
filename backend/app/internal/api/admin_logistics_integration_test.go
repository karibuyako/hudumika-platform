//go:build integration

// ADMIN-LOGISTICS integration tests against real PostgreSQL + Redis
// (docker compose). Run via `make test-integration` after `make migrate`.
// Setup truncates ONLY the tables owned by migration 00039
// (cod_reconciliation_sessions, shipment_escalations); every other row this
// suite touches (users, roles, riders, hubs, vehicles, shipments, trips,
// risk_events) is seeded with the test's own prefix and deleted in cleanup
// — the shared tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// alPrefix marks every row this suite seeds so cleanup can delete exactly
// its own rows (phones, waybills, hub codes, trip codes).
const alPrefix = "adml"

// alUnique builds a per-run unique string under the suite prefix.
func alUnique(t *testing.T, kind string) string {
	t.Helper()
	return fmt.Sprintf("%s-%s-%09d", alPrefix, kind, time.Now().UnixNano()%1_000_000_000)
}

// alSetup truncates the migration-00039 tables and returns a fresh server
// with a staff token bound to a real user (so reviewed_by / escalated_by
// resolve).
func alSetup(t *testing.T) (*Server, *pgxpool.Pool, string) {
	t.Helper()
	s, pool := newPersistentServer(t)
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE cod_reconciliation_sessions, shipment_escalations`); err != nil {
		t.Fatalf("truncate migration-00039 tables: %v", err)
	}
	phone := alUnique(t, "staff")
	var staffID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "ADML Staff "+phone).Scan(&staffID); err != nil {
		t.Fatalf("seed staff user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, staffID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, staffID)
	})
	return s, pool, tokenFor(t, s, phone, RoleAdmin, true)
}

// alSeedUser inserts a user with the given role and registers cleanup.
func alSeedUser(t *testing.T, pool *pgxpool.Pool, phone, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "ADML User "+phone).Scan(&id); err != nil {
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

// alSeedRider inserts a riders row and registers cleanup (cod sessions
// cascade with the rider).
func alSeedRider(t *testing.T, pool *pgxpool.Pool, owner uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, vehicle, verification)
		 VALUES ($1, $2, 'motorcycle', 'approved') RETURNING id`,
		owner, "ADML Rider "+owner.String()).Scan(&id); err != nil {
		t.Fatalf("seed rider: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE id = $1`, id)
	})
	return id
}

// alSeedHub inserts a hubs row and registers cleanup (vehicles and
// shipments referencing it must be deleted first by their own cleanups).
func alSeedHub(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	code := alUnique(t, "hub")
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO hubs (name, code) VALUES ($1, $2) RETURNING id`,
		"ADML Hub "+code, code).Scan(&id); err != nil {
		t.Fatalf("seed hub: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM hubs WHERE id = $1`, id)
	})
	return id
}

// alSeedVehicle inserts a vehicles row parked at hub and registers cleanup.
func alSeedVehicle(t *testing.T, pool *pgxpool.Pool, hubID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	plate := alUnique(t, "veh")
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO vehicles (hub_id, plate, vehicle_type) VALUES ($1, $2, 'bike') RETURNING id`,
		hubID, plate).Scan(&id); err != nil {
		t.Fatalf("seed vehicle: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM vehicles WHERE id = $1`, id)
	})
	return id
}

// alSeedShipment inserts a shipments row with the given status held at hub
// and registers cleanup (events/packages/escalations cascade).
func alSeedShipment(t *testing.T, pool *pgxpool.Pool, hubID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	waybill := alUnique(t, "wb")
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO shipments (waybill_number, status, custody_hub_id, custody_kind)
		 VALUES ($1, $2, $3, 'hub') RETURNING id`,
		waybill, status, hubID).Scan(&id); err != nil {
		t.Fatalf("seed shipment: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM shipments WHERE id = $1`, id)
	})
	return id
}

// alSeedTrip inserts a trips row (origin -> destination, status) and
// registers cleanup.
func alSeedTrip(t *testing.T, pool *pgxpool.Pool, vehicleID, originHubID, destHubID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	code := alUnique(t, "trip")
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO trips (code, vehicle_id, origin_hub_id, destination_hub_id, status)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		code, vehicleID, originHubID, destHubID, status).Scan(&id); err != nil {
		t.Fatalf("seed trip: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM trips WHERE id = $1`, id)
	})
	return id
}

// alSeedRiskCase inserts a risk_events row and registers cleanup.
func alSeedRiskCase(t *testing.T, pool *pgxpool.Pool, signal string, score float64, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO risk_events (entity_type, entity_id, signal, score, status)
		 VALUES ('order', $1, $2, $3, $4) RETURNING id`,
		uuid.New(), signal, score, status).Scan(&id); err != nil {
		t.Fatalf("seed risk case: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM risk_events WHERE id = $1`, id)
	})
	return id
}

// alDecodeError decodes an error envelope.
func alDecodeError(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error envelope: %v (%s)", err, rec.Body)
	}
	return errBody
}

// TestAdminHubDashboardIntegration: the dashboard buckets the shipments
// physically at the hub by status, counts the parked vehicles and reports
// honest zeros for the not-yet-wired surfaces.
func TestAdminHubDashboardIntegration(t *testing.T) {
	s, pool, token := alSetup(t)
	h := s.Router()

	hubA := alSeedHub(t, pool)
	hubB := alSeedHub(t, pool)
	alSeedVehicle(t, pool, hubA)
	alSeedVehicle(t, pool, hubA)
	alSeedVehicle(t, pool, hubB)

	incoming := alSeedShipment(t, pool, hubA, "at_hub")
	alSeedShipment(t, pool, hubA, "at_hub")
	outgoing := alSeedShipment(t, pool, hubA, "in_transit")
	alSeedShipment(t, pool, hubA, "pending")
	exception := alSeedShipment(t, pool, hubA, "exception")
	alSeedShipment(t, pool, hubA, "delivered")
	// Another hub's shipments and vehicles must not leak into hub A's load.
	alSeedShipment(t, pool, hubB, "in_transit")
	_ = incoming
	_ = outgoing
	_ = exception

	if _, err := pool.Exec(context.Background(),
		`INSERT INTO shipment_escalations (shipment_id, reason) VALUES ($1, 'driver dispute')`,
		exception); err != nil {
		t.Fatalf("seed escalation: %v", err)
	}

	rec := authedGET(t, h, "/admin/hubs/"+hubA.String()+"/dashboard", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("hub dashboard = %d (%s)", rec.Code, rec.Body)
	}
	var dash gen.HubDashboard
	if err := json.NewDecoder(rec.Body).Decode(&dash); err != nil {
		t.Fatalf("decode hub dashboard: %v", err)
	}
	if dash.HubId != openapi_types.UUID(hubA) || dash.Name == "" {
		t.Fatalf("hub identity = %s / %q", dash.HubId, dash.Name)
	}
	if dash.Load.Incoming == nil || *dash.Load.Incoming != 2 {
		t.Fatalf("load.incoming = %v, want 2", dash.Load.Incoming)
	}
	if dash.Load.Outgoing == nil || *dash.Load.Outgoing != 1 {
		t.Fatalf("load.outgoing = %v, want 1", dash.Load.Outgoing)
	}
	if dash.Load.AwaitingSort == nil || *dash.Load.AwaitingSort != 1 {
		t.Fatalf("load.awaitingSort = %v, want 1", dash.Load.AwaitingSort)
	}
	if dash.Load.Exceptions == nil || *dash.Load.Exceptions != 1 {
		t.Fatalf("load.exceptions = %v, want 1", dash.Load.Exceptions)
	}
	if dash.Load.CapacityPct == nil || *dash.Load.CapacityPct != 0 {
		t.Fatalf("load.capacityPct = %v, want honest 0", dash.Load.CapacityPct)
	}
	if dash.VehiclesPresent == nil || *dash.VehiclesPresent != 2 {
		t.Fatalf("vehiclesPresent = %v, want 2", dash.VehiclesPresent)
	}
	if dash.StaffOnDuty == nil || *dash.StaffOnDuty != 0 {
		t.Fatalf("staffOnDuty = %v, want honest 0", dash.StaffOnDuty)
	}
	if dash.SortationQueues == nil || len(*dash.SortationQueues) != 0 {
		t.Fatalf("sortationQueues = %+v, want []", dash.SortationQueues)
	}
	if dash.UpdatedAt == nil || dash.UpdatedAt.IsZero() {
		t.Fatalf("updatedAt = %v, want the hub's last activity", dash.UpdatedAt)
	}

	rec = authedGET(t, h, "/admin/hubs/"+uuid.New().String()+"/dashboard", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing hub dashboard = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "HUB_DASHBOARD_UNAVAILABLE" {
		t.Fatalf("missing hub error code = %q, want HUB_DASHBOARD_UNAVAILABLE", errBody.Code)
	}
}

// TestLogisticsControlTowerIntegration: the tower aggregates the whole
// network — shipments by status, in-progress trips (total and per origin
// hub) and open escalations as the at-risk set. The network is shared with
// other integration suites, so the assertions compare deltas against a
// baseline read instead of absolute counts.
func TestLogisticsControlTowerIntegration(t *testing.T) {
	s, pool, token := alSetup(t)
	h := s.Router()

	// Baseline: the tower before this test's rows exist.
	baseline := alReadTowerTotals(t, h, token)

	hubA := alSeedHub(t, pool)
	hubB := alSeedHub(t, pool)
	vehicle := alSeedVehicle(t, pool, hubA)
	alSeedTrip(t, pool, vehicle, hubA, hubB, "in_progress")
	alSeedTrip(t, pool, vehicle, hubA, hubB, "planned")

	alSeedShipment(t, pool, hubA, "in_transit")
	alSeedShipment(t, pool, hubA, "in_transit")
	alSeedShipment(t, pool, hubA, "at_hub")
	exception := alSeedShipment(t, pool, hubA, "exception")
	alSeedShipment(t, pool, hubA, "delivered")
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO shipment_escalations (shipment_id, reason) VALUES ($1, 'safety incident')`,
		exception); err != nil {
		t.Fatalf("seed escalation: %v", err)
	}

	rec := authedGET(t, h, "/admin/logistics/control-tower", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("control tower = %d (%s)", rec.Code, rec.Body)
	}
	var tower gen.ControlTower
	if err := json.NewDecoder(rec.Body).Decode(&tower); err != nil {
		t.Fatalf("decode control tower: %v", err)
	}
	if tower.GeneratedAt.IsZero() {
		t.Fatal("generatedAt is zero")
	}
	if tower.Totals.ActiveShipments == nil || *tower.Totals.ActiveShipments != baseline.activeShipments+3 {
		t.Fatalf("totals.activeShipments = %v, want baseline %d + 3", *tower.Totals.ActiveShipments, baseline.activeShipments)
	}
	if tower.Totals.Exceptions == nil || *tower.Totals.Exceptions != baseline.exceptions+1 {
		t.Fatalf("totals.exceptions = %v, want baseline %d + 1", *tower.Totals.Exceptions, baseline.exceptions)
	}
	if tower.Totals.Delayed == nil || *tower.Totals.Delayed != 0 {
		t.Fatalf("totals.delayed = %v, want honest 0", tower.Totals.Delayed)
	}
	if tower.Totals.AtRisk == nil || *tower.Totals.AtRisk != baseline.atRisk+1 {
		t.Fatalf("totals.atRisk = %v, want baseline %d + the open escalation", *tower.Totals.AtRisk, baseline.atRisk)
	}
	if tower.Totals.ActiveTrips == nil || *tower.Totals.ActiveTrips != baseline.activeTrips+1 {
		t.Fatalf("totals.activeTrips = %v, want baseline %d + 1", *tower.Totals.ActiveTrips, baseline.activeTrips)
	}
	if tower.Totals.TripsByHub == nil || len(*tower.Totals.TripsByHub) == 0 {
		t.Fatalf("totals.tripsByHub = %+v, want at least the origin hub", tower.Totals.TripsByHub)
	}
	tripsAtOrigin := 0
	hubName := ""
	for _, row := range *tower.Totals.TripsByHub {
		if row.Trips > tripsAtOrigin {
			tripsAtOrigin, hubName = row.Trips, row.HubName
		}
	}
	if hubName == "" {
		t.Fatalf("tripsByHub has no origin hub entry: %+v", tower.Totals.TripsByHub)
	}
	if len(tower.CriticalExceptions) != 0 {
		t.Fatalf("criticalExceptions = %+v, want [] (no typed exception pipeline)", tower.CriticalExceptions)
	}
}

// alTowerTotals is a typed projection of the ControlTower totals for delta
// comparisons.
type alTowerSnapshot struct {
	activeShipments, exceptions, atRisk, activeTrips int
}

// alTowerTotals reads the current control-tower totals.
func alReadTowerTotals(t *testing.T, h http.Handler, token string) alTowerSnapshot {
	t.Helper()
	rec := authedGET(t, h, "/admin/logistics/control-tower", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("control tower baseline = %d (%s)", rec.Code, rec.Body)
	}
	var tower gen.ControlTower
	if err := json.NewDecoder(rec.Body).Decode(&tower); err != nil {
		t.Fatalf("decode control tower baseline: %v", err)
	}
	out := alTowerSnapshot{}
	if tower.Totals.ActiveShipments != nil {
		out.activeShipments = *tower.Totals.ActiveShipments
	}
	if tower.Totals.Exceptions != nil {
		out.exceptions = *tower.Totals.Exceptions
	}
	if tower.Totals.AtRisk != nil {
		out.atRisk = *tower.Totals.AtRisk
	}
	if tower.Totals.ActiveTrips != nil {
		out.activeTrips = *tower.Totals.ActiveTrips
	}
	return out
}

// TestAdminEscalateShipmentIntegration: only in-transit/exception shipments
// escalate; the escalation row and the 'escalated' waybill event land
// together; wrong-status and missing-shipment answers are conflict/not-found.
func TestAdminEscalateShipmentIntegration(t *testing.T) {
	s, pool, token := alSetup(t)
	h := s.Router()

	hub := alSeedHub(t, pool)
	escalatable := alSeedShipment(t, pool, hub, "in_transit")
	delivered := alSeedShipment(t, pool, hub, "delivered")

	path := "/admin/shipments/" + escalatable.String() + "/escalate"
	rec := authedRequest(t, h, http.MethodPost, path, token, `{"reason":"rider reported a customer threat"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("escalate = %d (%s)", rec.Code, rec.Body)
	}
	var shipment gen.Shipment
	if err := json.NewDecoder(rec.Body).Decode(&shipment); err != nil {
		t.Fatalf("decode shipment: %v", err)
	}
	if shipment.Id != openapi_types.UUID(escalatable) || shipment.Status != gen.ShipmentStatusInTransit {
		t.Fatalf("shipment = %s / %q, want the escalated in-transit shipment", shipment.Id, shipment.Status)
	}
	var escalationCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM shipment_escalations WHERE shipment_id = $1 AND status = 'open'`,
		escalatable).Scan(&escalationCount); err != nil {
		t.Fatalf("escalation row query: %v", err)
	}
	if escalationCount != 1 {
		t.Fatalf("escalation rows = %d, want 1", escalationCount)
	}
	var eventCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM shipment_events WHERE shipment_id = $1 AND status = 'escalated'`,
		escalatable).Scan(&eventCount); err != nil {
		t.Fatalf("escalation event query: %v", err)
	}
	if eventCount != 1 {
		t.Fatalf("escalated events = %d, want 1", eventCount)
	}

	rec = authedRequest(t, h, http.MethodPost, "/admin/shipments/"+delivered.String()+"/escalate", token, `{"reason":"late"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("delivered escalate = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "SHIPMENT_NOT_ESCALATABLE" {
		t.Fatalf("error code = %q, want SHIPMENT_NOT_ESCALATABLE", errBody.Code)
	}

	rec = authedRequest(t, h, http.MethodPost, path, token, `{"reason":""}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty reason = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "ADMIN_REASON_REQUIRED" {
		t.Fatalf("error code = %q, want ADMIN_REASON_REQUIRED", errBody.Code)
	}

	rec = authedRequest(t, h, http.MethodPost, "/admin/shipments/"+uuid.New().String()+"/escalate", token, `{"reason":"lost"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing shipment = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "SHIPMENT_NOT_FOUND" {
		t.Fatalf("error code = %q, want SHIPMENT_NOT_FOUND", errBody.Code)
	}
}

// TestAdminRiderCodReconciliationIntegration: the sessions and totals return
// per rider; a rider without any session gets an open one; a missing rider
// is 404.
func TestAdminRiderCodReconciliationIntegration(t *testing.T) {
	s, pool, token := alSetup(t)
	h := s.Router()

	owner := alSeedUser(t, pool, alUnique(t, "cust"), "customer")
	rider := alSeedRider(t, pool, owner)
	other := alSeedRider(t, pool, alSeedUser(t, pool, alUnique(t, "cust2"), "customer"))

	var sessionIDs []uuid.UUID
	for _, seed := range []struct {
		expected  int64
		collected int64
		status    string
		note      string
	}{
		{0, 5000, "open", ""},
		{3000, 3000, "reconciled", "shift closed by ops"},
	} {
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO cod_reconciliation_sessions (rider_id, expected_tzs, collected_tzs, status, note, reconciled_by)
			 VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6) RETURNING id`,
			rider, seed.expected, seed.collected, seed.status, seed.note, owner).Scan(&id); err != nil {
			t.Fatalf("seed cod session: %v", err)
		}
		sessionIDs = append(sessionIDs, id)
	}
	// Another rider's sessions must not leak into the totals.
	alSeedRiderSession(t, pool, other, 9000, 9000)

	rec := authedGET(t, h, "/admin/riders/"+rider.String()+"/cod", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("cod reconciliation = %d (%s)", rec.Code, rec.Body)
	}
	var cod gen.RiderCodReconciliation
	if err := json.NewDecoder(rec.Body).Decode(&cod); err != nil {
		t.Fatalf("decode cod reconciliation: %v", err)
	}
	if cod.RiderId != openapi_types.UUID(rider) {
		t.Fatalf("riderId = %s, want %s", cod.RiderId, rider)
	}
	if len(cod.Shifts) != 2 {
		t.Fatalf("shifts = %d, want 2 (%+v)", len(cod.Shifts), cod.Shifts)
	}
	seen := map[openapi_types.UUID]bool{}
	var expectedTotal, collectedTotal int
	for _, shift := range cod.Shifts {
		seen[shift.ShiftId] = true
		expectedTotal += shift.ExpectedTZS
		collectedTotal += shift.CollectedTZS
		if shift.Date.Time.IsZero() {
			t.Fatalf("shift %s has no date", shift.ShiftId)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("shift ids are not unique: %+v", seen)
	}
	if cod.Totals == nil {
		t.Fatal("totals missing")
	}
	if cod.Totals.ExpectedTZS == nil || *cod.Totals.ExpectedTZS != 3000 {
		t.Fatalf("totals.expectedTZS = %v, want 3000", cod.Totals.ExpectedTZS)
	}
	if cod.Totals.CollectedTZS == nil || *cod.Totals.CollectedTZS != 8000 {
		t.Fatalf("totals.collectedTZS = %v, want 8000", cod.Totals.CollectedTZS)
	}
	if cod.Totals.VarianceTZS == nil || *cod.Totals.VarianceTZS != 5000 {
		t.Fatalf("totals.varianceTZS = %v, want 5000", cod.Totals.VarianceTZS)
	}
	var reconciled, pending bool
	for _, shift := range cod.Shifts {
		switch shift.Status {
		case gen.RiderCodReconciliationShiftsStatusReconciled:
			reconciled = true
		case gen.RiderCodReconciliationShiftsStatusPending:
			pending = true
		}
	}
	if !reconciled || !pending {
		t.Fatalf("shift statuses = %+v, want one reconciled and one pending", cod.Shifts)
	}
	_ = sessionIDs

	// A rider without sessions gets an open one so the surface is actionable.
	freshOwner := alSeedUser(t, pool, alUnique(t, "cust3"), "customer")
	freshRider := alSeedRider(t, pool, freshOwner)
	rec = authedGET(t, h, "/admin/riders/"+freshRider.String()+"/cod", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh rider cod = %d (%s)", rec.Code, rec.Body)
	}
	var fresh gen.RiderCodReconciliation
	if err := json.NewDecoder(rec.Body).Decode(&fresh); err != nil {
		t.Fatalf("decode fresh cod: %v", err)
	}
	if len(fresh.Shifts) != 1 || fresh.Shifts[0].Status != gen.RiderCodReconciliationShiftsStatusPending {
		t.Fatalf("fresh shifts = %+v, want one open/pending session", fresh.Shifts)
	}
	if fresh.Totals == nil || *fresh.Totals.ExpectedTZS != 0 || *fresh.Totals.CollectedTZS != 0 || *fresh.Totals.VarianceTZS != 0 {
		t.Fatalf("fresh totals = %+v, want honest zeros", fresh.Totals)
	}
	var freshCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM cod_reconciliation_sessions WHERE rider_id = $1`, freshRider).Scan(&freshCount); err != nil {
		t.Fatalf("fresh session count: %v", err)
	}
	if freshCount != 1 {
		t.Fatalf("fresh session rows = %d, want the auto-opened session", freshCount)
	}

	rec = authedGET(t, h, "/admin/riders/"+uuid.New().String()+"/cod", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing rider = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

// alSeedRiderSession seeds a cod session without cleanup (the rider cleanup
// cascades).
func alSeedRiderSession(t *testing.T, pool *pgxpool.Pool, riderID uuid.UUID, expected, collected int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO cod_reconciliation_sessions (rider_id, expected_tzs, collected_tzs)
		 VALUES ($1, $2, $3)`, riderID, expected, collected); err != nil {
		t.Fatalf("seed other-rider session: %v", err)
	}
}

// TestAdminRiskCasesIntegration: the case list filters by status and
// severity; a review decides a case once (dismiss -> dismissed, other
// decisions -> resolved) and a second review is 409.
func TestAdminRiskCasesIntegration(t *testing.T) {
	s, pool, token := alSetup(t)
	h := s.Router()

	openHigh := alSeedRiskCase(t, pool, "multiple_accounts", 0.85, "open")
	openLow := alSeedRiskCase(t, pool, "refund_velocity", 0.2, "open")
	dismissed := alSeedRiskCase(t, pool, "chargeback", 0.7, "dismissed")

	rec := authedGET(t, h, "/admin/risk/cases", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("risk cases = %d (%s)", rec.Code, rec.Body)
	}
	var cases []gen.RiskCase
	if err := json.NewDecoder(rec.Body).Decode(&cases); err != nil {
		t.Fatalf("decode risk cases: %v", err)
	}
	find := func(id uuid.UUID) *gen.RiskCase {
		for i := range cases {
			if cases[i].Id == openapi_types.UUID(id) {
				return &cases[i]
			}
		}
		return nil
	}
	if find(openHigh) == nil || find(openLow) == nil || find(dismissed) == nil {
		t.Fatalf("seeded cases missing from list: %+v", cases)
	}
	if find(openHigh).Severity != gen.RiskCaseSeverityHigh || find(openLow).Severity != gen.RiskCaseSeverityLow {
		t.Fatalf("severity mapping wrong: openHigh=%q openLow=%q", find(openHigh).Severity, find(openLow).Severity)
	}
	if find(dismissed).Status != gen.RiskCaseStatusDismissed {
		t.Fatalf("dismissed status = %q", find(dismissed).Status)
	}
	if find(dismissed).DecidedAction == nil || *find(dismissed).DecidedAction != "dismiss" {
		t.Fatalf("dismissed decidedAction = %v, want dismiss", find(dismissed).DecidedAction)
	}
	if len(find(openHigh).Signals) != 1 || find(openHigh).Signals[0] != "multiple_accounts" {
		t.Fatalf("signals = %v, want the signal list", find(openHigh).Signals)
	}
	if find(openHigh).CreatedAt.IsZero() {
		t.Fatal("createdAt is zero")
	}

	rec = authedGET(t, h, "/admin/risk/cases?status=open", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("open risk cases = %d (%s)", rec.Code, rec.Body)
	}
	var open []gen.RiskCase
	if err := json.NewDecoder(rec.Body).Decode(&open); err != nil {
		t.Fatalf("decode open cases: %v", err)
	}
	if len(open) != 2 {
		t.Fatalf("open cases = %d, want 2 (%+v)", len(open), open)
	}

	rec = authedGET(t, h, "/admin/risk/cases?severity=high", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("high risk cases = %d (%s)", rec.Code, rec.Body)
	}
	var high []gen.RiskCase
	if err := json.NewDecoder(rec.Body).Decode(&high); err != nil {
		t.Fatalf("decode high cases: %v", err)
	}
	if len(high) != 2 {
		t.Fatalf("high cases = %d, want 2 (0.85 open + 0.7 dismissed)", len(high))
	}

	// Review the open high case: block_user resolves it.
	path := "/admin/risk/cases/" + openHigh.String() + "/review"
	rec = authedRequest(t, h, http.MethodPost, path, token, `{"action":"block_user","reason":"verified fraud ring"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("review = %d (%s)", rec.Code, rec.Body)
	}
	var decided gen.RiskCase
	if err := json.NewDecoder(rec.Body).Decode(&decided); err != nil {
		t.Fatalf("decode decided case: %v", err)
	}
	if decided.Status != gen.RiskCaseStatusResolved {
		t.Fatalf("decided status = %q, want resolved", decided.Status)
	}
	if decided.Reason == nil || *decided.Reason != "verified fraud ring" {
		t.Fatalf("decided reason = %v, want the review reason", decided.Reason)
	}

	// Re-reviewing the decided case is a conflict.
	rec = authedRequest(t, h, http.MethodPost, path, token, `{"action":"dismiss","reason":"reconsidered"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-review = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "RISK_CASE_ALREADY_DECIDED" {
		t.Fatalf("error code = %q, want RISK_CASE_ALREADY_DECIDED", errBody.Code)
	}

	// Dismissing the open low case lands dismissed.
	rec = authedRequest(t, h, http.MethodPost, "/admin/risk/cases/"+openLow.String()+"/review", token, `{"action":"dismiss","reason":"benign activity"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("dismiss = %d (%s)", rec.Code, rec.Body)
	}
	var dismissedCase gen.RiskCase
	if err := json.NewDecoder(rec.Body).Decode(&dismissedCase); err != nil {
		t.Fatalf("decode dismissed case: %v", err)
	}
	if dismissedCase.Status != gen.RiskCaseStatusDismissed {
		t.Fatalf("dismissed status = %q, want dismissed", dismissedCase.Status)
	}
	if dismissedCase.DecidedAction == nil || *dismissedCase.DecidedAction != "dismiss" {
		t.Fatalf("decidedAction = %v, want dismiss", dismissedCase.DecidedAction)
	}

	// Unknown case is 404; an empty reason is 422.
	rec = authedRequest(t, h, http.MethodPost, "/admin/risk/cases/"+uuid.New().String()+"/review", token, `{"action":"hold","reason":"x"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown case = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "RISK_CASE_NOT_FOUND" {
		t.Fatalf("error code = %q, want RISK_CASE_NOT_FOUND", errBody.Code)
	}
	rec = authedRequest(t, h, http.MethodPost, path, token, `{"action":"hold"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty reason = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := alDecodeError(t, rec); errBody.Code != "ADMIN_REASON_REQUIRED" {
		t.Fatalf("error code = %q, want ADMIN_REASON_REQUIRED", errBody.Code)
	}
}

// TestAdminRiskCasesPaginationIntegration: 25 seeded cases page as 20 + 5
// with no overlap and full coverage.
func TestAdminRiskCasesPaginationIntegration(t *testing.T) {
	s, pool, token := alSetup(t)
	h := s.Router()

	seedIDs := make(map[openapi_types.UUID]bool, 25)
	for i := 0; i < 25; i++ {
		seedIDs[openapi_types.UUID(alSeedRiskCase(t, pool, fmt.Sprintf("signal_%02d", i), 0.1, "open"))] = true
	}

	decodePage := func(t *testing.T, rec *httptest.ResponseRecorder) []gen.RiskCase {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("risk cases page = %d (%s)", rec.Code, rec.Body)
		}
		var page []gen.RiskCase
		if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
			t.Fatalf("decode page: %v", err)
		}
		return page
	}

	page1 := decodePage(t, authedGET(t, h, "/admin/risk/cases?limit=20", token))
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	page2 := decodePage(t, authedGET(t, h, "/admin/risk/cases?limit=20&offset=20", token))
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}

	seen := make(map[openapi_types.UUID]bool, 25)
	for _, row := range append(page1, page2...) {
		if seen[row.Id] {
			t.Fatalf("id %s appears on both pages", row.Id)
		}
		seen[row.Id] = true
	}
	for id := range seedIDs {
		if !seen[id] {
			t.Fatalf("seeded case %s missing from the two pages", id)
		}
	}
}
