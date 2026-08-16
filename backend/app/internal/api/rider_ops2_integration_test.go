//go:build integration

// RIDER-OPS2 handlers against real PostgreSQL + Redis (docker compose). Run
// via DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/
// -run 'Maintenance|Mission|Training|SyncBatch|SyncStatus|RiderExport|RiderPerformance|CheckIn' -count=1
// Each test truncates ONLY the rider-ops2 tables (vehicle_maintenance,
// rider_missions, rider_training_progress, training_modules, rider_sync_state,
// rider_exports) at setup and seeds its own users/riders/orders/rider_shifts
// rows with per-run unique phones; cleanup deletes exactly those rows. The
// suite reuses the rider-ops seeding helpers (seedRiderOpsRiderSession etc).
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

// truncateRiderOps2 clears the rider-ops2 tables before a test. These tables
// are exclusively owned by this suite, so a whole-table truncate is safe and
// keeps the tests independent of leftover state (training_modules is global
// catalog content that only this suite writes).
func truncateRiderOps2(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE vehicle_maintenance, rider_missions, rider_training_progress,
		          training_modules, rider_sync_state, rider_exports`); err != nil {
		t.Fatalf("truncate rider-ops2 tables: %v", err)
	}
}

// seedRiderOps2Order inserts an order bound to the rider with the given
// status and totals, and registers cleanup for exactly this order.
func seedRiderOps2Order(t *testing.T, pool *pgxpool.Pool, customerUserID, riderID uuid.UUID, status string, totalTZS int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, rider_id, status, subtotal_tzs, delivery_fee_tzs, total_tzs)
		 VALUES ($1, $2, $3, $4, $5, 0, $5) RETURNING id`,
		customerUserID, uuid.New(), riderID, status, totalTZS).Scan(&id); err != nil {
		t.Fatalf("seed rider-ops2 order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// seedRiderOps2Shift inserts a rider_shifts row (this suite owns only its own
// shift rows; the rider-ops suite owns the table) and registers cleanup.
func seedRiderOps2Shift(t *testing.T, pool *pgxpool.Pool, riderID uuid.UUID, clockedInAt, clockedOutAt *time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	start := time.Now().Add(-8 * time.Hour)
	if clockedInAt != nil {
		start = *clockedInAt
	}
	end := start.Add(8 * time.Hour)
	if clockedOutAt != nil {
		end = *clockedOutAt
	}
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO rider_shifts (rider_id, start_at, end_at, status, clocked_in_at, clocked_out_at)
		 VALUES ($1, $2, $3, 'ended', $4, $5) RETURNING id`,
		riderID, start, end, clockedInAt, clockedOutAt).Scan(&id); err != nil {
		t.Fatalf("seed rider-ops2 shift: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM rider_shifts WHERE id = $1`, id)
	})
	return id
}

// TestRiderOps2MaintenanceCrudAndPagination: a rider creates a maintenance
// record (201, round-trips the contract fields), invalid kinds and empty
// notes are 422 MAINTENANCE_INVALID, and the paginated list pages through 25
// records in 20 + 5.
func TestRiderOps2MaintenanceCrudAndPagination(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("mnt"))

	body := `{"type":"oil_change","notes":"Engine oil replaced","mileageKm":12000,"performedAt":"2026-01-10T08:00:00Z"}`
	rec := authedPOSTJSON(t, s.Router(), "/riders/me/vehicle/maintenance", body, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create maintenance status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var created gen.VehicleMaintenance
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created maintenance: %v", err)
	}
	if created.Type != gen.OilChange {
		t.Fatalf("created type = %q, want oil_change", created.Type)
	}
	if created.Notes == nil || *created.Notes != "Engine oil replaced" {
		t.Fatalf("created notes = %v, want the submitted notes", created.Notes)
	}
	if created.MileageKm == nil || *created.MileageKm != 12000 {
		t.Fatalf("created mileageKm = %v, want 12000", created.MileageKm)
	}
	if created.Id == nil {
		t.Fatal("created maintenance id missing")
	}
	var persisted uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT rider_id FROM vehicle_maintenance WHERE id = $1`, uuid.UUID(*created.Id)).Scan(&persisted); err != nil {
		t.Fatalf("select maintenance rider: %v", err)
	}
	if persisted != riderID {
		t.Fatalf("maintenance rider_id = %s, want %s", persisted, riderID)
	}

	for _, bad := range []string{
		`{"type":"paint_job","notes":"x","performedAt":"2026-01-10T08:00:00Z"}`,
		`{"type":"oil_change","performedAt":"2026-01-10T08:00:00Z"}`,
		`{"type":"oil_change","notes":"","performedAt":"2026-01-10T08:00:00Z"}`,
		`{"type":"oil_change","notes":"x"}`,
	} {
		rec = authedPOSTJSON(t, s.Router(), "/riders/me/vehicle/maintenance", bad, token)
		wantError(t, rec, http.StatusUnprocessableEntity, "MAINTENANCE_INVALID")
	}

	for i := 0; i < 25; i++ {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO vehicle_maintenance (rider_id, kind, description, scheduled_at)
			 VALUES ($1, 'general_service', 'bulk ' || $2, now() - ($3 * interval '1 minute'))`,
			riderID, fmt.Sprintf("%d", i+1), i+1); err != nil {
			t.Fatalf("seed maintenance %d: %v", i, err)
		}
	}
	rec = authedGET(t, s.Router(), "/riders/me/vehicle/maintenance", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.VehicleMaintenance
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 count = %d, want 20", len(page1))
	}
	rec = authedGET(t, s.Router(), "/riders/me/vehicle/maintenance?offset=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.VehicleMaintenance
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 6 {
		t.Fatalf("page 2 count = %d, want 6 (25 bulk + 1 created)", len(page2))
	}
}

// TestRiderOps2MissionList: seeded missions map onto the contract shape —
// completedDeliveries/targetDeliveries, derived status (active/completed/
// expired), claimed and canClaim — and the status filter narrows the list.
// The contract has no mission claim path, so claimed rows simply read back
// with claimed=true and canClaim=false.
func TestRiderOps2MissionList(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("msn"))

	seed := func(title string, progress, target int, claimed bool, expiresIn time.Duration) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO rider_missions (rider_id, kind, title, progress, target, claimed, expires_at)
			 VALUES ($1, 'bonus', $2, $3, $4, $5, now() + $6) RETURNING id`,
			riderID, title, progress, target, claimed, expiresIn).Scan(&id); err != nil {
			t.Fatalf("seed mission: %v", err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM rider_missions WHERE id = $1`, id) })
		return id
	}
	activeID := seed("active", 2, 5, false, 24*time.Hour)
	completedID := seed("done", 5, 5, false, 24*time.Hour)
	claimedID := seed("claimed", 5, 5, true, 24*time.Hour)
	expiredID := seed("expired", 1, 5, false, -time.Hour)

	rec := authedGET(t, s.Router(), "/riders/me/missions", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var missions []gen.RiderMission
	if err := json.NewDecoder(rec.Body).Decode(&missions); err != nil {
		t.Fatalf("decode missions: %v", err)
	}
	if len(missions) != 4 {
		t.Fatalf("mission count = %d, want 4 (%+v)", len(missions), missions)
	}
	byID := map[uuid.UUID]gen.RiderMission{}
	for _, m := range missions {
		byID[uuid.UUID(m.Id)] = m
	}
	active := byID[activeID]
	if active.Status != gen.RiderMissionStatusActive || active.TargetDeliveries != 5 || *active.CompletedDeliveries != 2 {
		t.Fatalf("active mission = %+v", active)
	}
	if active.CanClaim == nil || *active.CanClaim {
		t.Fatalf("active mission canClaim = %v, want false", active.CanClaim)
	}
	completed := byID[completedID]
	if completed.Status != gen.RiderMissionStatusCompleted || *completed.CanClaim != true {
		t.Fatalf("completed mission = %+v", completed)
	}
	claimed := byID[claimedID]
	if *claimed.Claimed != true || *claimed.CanClaim != false || claimed.Status != gen.RiderMissionStatusCompleted {
		t.Fatalf("claimed mission = %+v", claimed)
	}
	expired := byID[expiredID]
	if expired.Status != gen.RiderMissionStatusExpired || *expired.CanClaim != false {
		t.Fatalf("expired mission = %+v", expired)
	}

	rec = authedGET(t, s.Router(), "/riders/me/missions?status=active", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("active filter status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var activeOnly []gen.RiderMission
	if err := json.NewDecoder(rec.Body).Decode(&activeOnly); err != nil {
		t.Fatalf("decode active filter: %v", err)
	}
	if len(activeOnly) != 1 || uuid.UUID(activeOnly[0].Id) != activeID {
		t.Fatalf("active filter = %+v, want only the active mission", activeOnly)
	}

	rec = authedGET(t, s.Router(), "/riders/me/missions?status=expired", token)
	var expiredOnly []gen.RiderMission
	if err := json.NewDecoder(rec.Body).Decode(&expiredOnly); err != nil {
		t.Fatalf("decode expired filter: %v", err)
	}
	if len(expiredOnly) != 1 {
		t.Fatalf("expired filter = %+v, want 1", expiredOnly)
	}
}

// TestRiderOps2TrainingModules: the catalog lists all modules with the
// rider's completion flags; completing a module flips its status to
// completed with progressPct 100 and a completedAt; a repeat completion is
// idempotent; an unknown module is 404 TRAINING_MODULE_NOT_FOUND.
func TestRiderOps2TrainingModules(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("trn"))

	insertModule := func(title string, sortOrder int) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO training_modules (title, content, sort_order) VALUES ($1, 'body', $2) RETURNING id`,
			title, sortOrder).Scan(&id); err != nil {
			t.Fatalf("seed training module: %v", err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM training_modules WHERE id = $1`, id) })
		return id
	}
	moduleA := insertModule("Safety 101", 1)
	moduleB := insertModule("Onboarding", 2)

	rec := authedGET(t, s.Router(), "/riders/me/training", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var before []gen.TrainingModule
	if err := json.NewDecoder(rec.Body).Decode(&before); err != nil {
		t.Fatalf("decode training list: %v", err)
	}
	if len(before) != 2 || before[0].Status != gen.TrainingModuleStatusNotStarted || before[1].Status != gen.TrainingModuleStatusNotStarted {
		t.Fatalf("initial modules = %+v, want 2 not_started in sort order", before)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/training/"+moduleA.String()+"/complete", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("complete status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var completed gen.TrainingModule
	if err := json.NewDecoder(rec.Body).Decode(&completed); err != nil {
		t.Fatalf("decode completed module: %v", err)
	}
	if completed.Status != gen.TrainingModuleStatusCompleted || completed.ProgressPct == nil || *completed.ProgressPct != 100 || completed.CompletedAt == nil {
		t.Fatalf("completed module = %+v", completed)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/training/"+moduleA.String()+"/complete", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("repeat complete status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM rider_training_progress WHERE rider_id = $1 AND module_id = $2`,
		riderID, moduleA).Scan(&count); err != nil {
		t.Fatalf("count progress: %v", err)
	}
	if count != 1 {
		t.Fatalf("progress rows = %d, want 1 (idempotent)", count)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/training/"+uuid.NewString()+"/complete", "", token)
	wantError(t, rec, http.StatusNotFound, "TRAINING_MODULE_NOT_FOUND")

	rec = authedGET(t, s.Router(), "/riders/me/training", token)
	var after []gen.TrainingModule
	if err := json.NewDecoder(rec.Body).Decode(&after); err != nil {
		t.Fatalf("decode training list 2: %v", err)
	}
	byID := map[uuid.UUID]gen.TrainingModule{}
	for _, m := range after {
		byID[uuid.UUID(m.Id)] = m
	}
	if byID[moduleA].Status != gen.TrainingModuleStatusCompleted || byID[moduleB].Status != gen.TrainingModuleStatusNotStarted {
		t.Fatalf("after completion = %+v", after)
	}
}

// TestRiderOps2SyncBatch: a batch starting at seq 1 advances the high-water
// mark; the post-ack apply reports per-event outcomes — supported types are
// applied (or rejected with a per-event code), the other contract types
// (location/pod) are skipped, so accepted counts applied events only and
// rejected carries {seq, code} for the rest. A gap (first seq != last_seq+1,
// or non-consecutive seqs inside the batch) is 409 SYNC_SEQUENCE_GAP; a
// malformed body (no events, seq 0, missing payload, bad type) is 422
// SYNC_BATCH_INVALID.
func TestRiderOps2SyncBatch(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("syn"))

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch",
		`{"events":[{"seq":1,"type":"location","payload":{"lat":-6.8,"lon":39.2}},{"seq":2,"type":"order_status","payload":{"orderId":"abc"}}]}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var batch struct {
		Accepted int `json:"accepted"`
		Rejected []struct {
			Seq  int    `json:"seq"`
			Code string `json:"code"`
		} `json:"rejected"`
		HighWaterMark int `json:"highWaterMark"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&batch); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if batch.Accepted != 0 || batch.HighWaterMark != 2 {
		t.Fatalf("batch response = %+v, want accepted 0 / highWaterMark 2", batch)
	}
	if len(batch.Rejected) != 2 || batch.Rejected[0].Seq != 1 || batch.Rejected[0].Code != "SKIPPED" ||
		batch.Rejected[1].Seq != 2 || batch.Rejected[1].Code != "SKIPPED" {
		t.Fatalf("batch rejected = %+v, want seq 1 + 2 both SKIPPED", batch.Rejected)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch",
		`{"events":[{"seq":4,"type":"location","payload":{"lat":1}}]}`, token)
	wantError(t, rec, http.StatusConflict, "SYNC_SEQUENCE_GAP")

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch",
		`{"events":[{"seq":3,"type":"location","payload":{"lat":1}},{"seq":5,"type":"pod","payload":{"ok":true}}]}`, token)
	wantError(t, rec, http.StatusConflict, "SYNC_SEQUENCE_GAP")

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch", `{"events":[]}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID")
	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch", `{"events":[{"seq":0,"type":"location","payload":{}}]}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID")
	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch", `{"events":[{"seq":1,"type":"location"}]}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID")
	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch", `{"events":[{"seq":1,"type":"teleport","payload":{}}]}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID")
}

// riderOps2OrderState reads back {status, version} for an order.
func riderOps2OrderState(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) (string, int) {
	t.Helper()
	var status string
	var version int
	if err := pool.QueryRow(context.Background(),
		`SELECT status, version FROM orders WHERE id = $1`, orderID).Scan(&status, &version); err != nil {
		t.Fatalf("select order state: %v", err)
	}
	return status, version
}

// TestRiderOps2SyncBatchAppliesOrderStatus: a rider's offline order_status
// events replay onto the rider's own order. A paid order (version 1) with
// events picked_up (expectedVersion 1) then delivering (expectedVersion 2) in
// one batch is advanced to delivering (version 3) with per-event accepted
// counts and order_events rows by the rider's user id; the jump paid →
// picked_up is legal because the replay from-set admits every earlier
// fulfillment status.
func TestRiderOps2SyncBatchAppliesOrderStatus(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	ownerUserID, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("osa"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("osc"), "customer")
	orderID := seedRiderOps2Order(t, pool, customerID, riderID, "paid", 15000)

	status, version := riderOps2OrderState(t, pool, orderID)
	if status != "paid" || version != 1 {
		t.Fatalf("seeded order = %s v%d, want paid v1", status, version)
	}

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch",
		fmt.Sprintf(`{"events":[
			{"seq":1,"type":"order_status","payload":{"orderId":%q,"status":"picked_up","expectedVersion":1}},
			{"seq":2,"type":"order_status","payload":{"orderId":%q,"status":"delivering","expectedVersion":2}}]}`,
			orderID.String(), orderID.String()), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var batch struct {
		Accepted int `json:"accepted"`
		Rejected []struct {
			Seq  int    `json:"seq"`
			Code string `json:"code"`
		} `json:"rejected"`
		HighWaterMark int `json:"highWaterMark"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&batch); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if batch.Accepted != 2 || batch.HighWaterMark != 2 || len(batch.Rejected) != 0 {
		t.Fatalf("batch response = %+v, want accepted 2 / highWaterMark 2 / no rejections", batch)
	}

	status, version = riderOps2OrderState(t, pool, orderID)
	if status != "delivering" || version != 3 {
		t.Fatalf("order after replay = %s v%d, want delivering v3", status, version)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT status FROM order_events WHERE order_id = $1 AND by = $2 ORDER BY at`, orderID, ownerUserID)
	if err != nil {
		t.Fatalf("query order_events: %v", err)
	}
	var eventStatuses []string
	for rows.Next() {
		var st string
		if err := rows.Scan(&st); err != nil {
			rows.Close()
			t.Fatalf("scan order_event: %v", err)
		}
		eventStatuses = append(eventStatuses, st)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate order_events: %v", err)
	}
	if len(eventStatuses) != 2 || eventStatuses[0] != "picked_up" || eventStatuses[1] != "delivering" {
		t.Fatalf("order_events = %v, want [picked_up delivering] by the rider user", eventStatuses)
	}
}

// TestRiderOps2SyncBatchRejectsConflicts: a stale expectedVersion, an unknown
// order and an order bound to another rider are each reported per-event
// (ORDER_STATUS_CONFLICT / ORDER_NOT_FOUND) without failing the batch or
// crashing; the high-water mark advances anyway.
func TestRiderOps2SyncBatchRejectsConflicts(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("oac"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("occ"), "customer")
	orderID := seedRiderOps2Order(t, pool, customerID, riderID, "paid", 15000)

	_, otherRiderID, _ := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("oar"))
	otherOrderID := seedRiderOps2Order(t, pool, customerID, otherRiderID, "paid", 15000)

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch",
		fmt.Sprintf(`{"events":[
			{"seq":1,"type":"order_status","payload":{"orderId":%q,"status":"delivering","expectedVersion":99}},
			{"seq":2,"type":"order_status","payload":{"orderId":%q,"status":"picked_up","expectedVersion":1}},
			{"seq":3,"type":"order_status","payload":{"orderId":%q,"status":"picked_up","expectedVersion":1}}]}`,
			orderID.String(), uuid.NewString(), otherOrderID.String()), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var batch struct {
		Accepted int `json:"accepted"`
		Rejected []struct {
			Seq  int    `json:"seq"`
			Code string `json:"code"`
		} `json:"rejected"`
		HighWaterMark int `json:"highWaterMark"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&batch); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if batch.Accepted != 0 || batch.HighWaterMark != 3 || len(batch.Rejected) != 3 {
		t.Fatalf("batch response = %+v, want accepted 0 / highWaterMark 3 / 3 rejections", batch)
	}
	codes := map[int]string{}
	for _, rj := range batch.Rejected {
		codes[rj.Seq] = rj.Code
	}
	if codes[1] != "ORDER_STATUS_CONFLICT" || codes[2] != "ORDER_NOT_FOUND" || codes[3] != "ORDER_NOT_FOUND" {
		t.Fatalf("rejected codes = %v, want 1=ORDER_STATUS_CONFLICT 2=ORDER_NOT_FOUND 3=ORDER_NOT_FOUND", codes)
	}

	// Nothing was applied: the rider's order is untouched and the other
	// rider's order is untouched.
	status, version := riderOps2OrderState(t, pool, orderID)
	if status != "paid" || version != 1 {
		t.Fatalf("conflicting order = %s v%d, want untouched paid v1", status, version)
	}
	status, version = riderOps2OrderState(t, pool, otherOrderID)
	if status != "paid" || version != 1 {
		t.Fatalf("other rider order = %s v%d, want untouched paid v1", status, version)
	}
}

// TestRiderOps2SyncStatusRoundtrip: a fresh rider reads back the lazy zero
// row; after an accepted batch the status reflects the high-water mark and
// the last sync time.
func TestRiderOps2SyncStatusRoundtrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("sst"))

	rec := authedGET(t, s.Router(), "/riders/me/sync/status", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var fresh gen.SyncStatus
	if err := json.NewDecoder(rec.Body).Decode(&fresh); err != nil {
		t.Fatalf("decode fresh status: %v", err)
	}
	if fresh.HighWaterMark != 0 || fresh.PendingCount != 0 {
		t.Fatalf("fresh status = %+v, want the lazy zero row", fresh)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/sync/batch",
		`{"events":[{"seq":1,"type":"cod_cash","payload":{"amount":5000}}]}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, s.Router(), "/riders/me/sync/status", token)
	var synced gen.SyncStatus
	if err := json.NewDecoder(rec.Body).Decode(&synced); err != nil {
		t.Fatalf("decode synced status: %v", err)
	}
	if synced.HighWaterMark != 1 || synced.LastSyncedAt == nil {
		t.Fatalf("synced status = %+v, want highWaterMark 1 with lastSyncedAt", synced)
	}
	var persisted int64
	if err := pool.QueryRow(context.Background(),
		`SELECT last_seq FROM rider_sync_state WHERE rider_id = $1`, riderID).Scan(&persisted); err != nil {
		t.Fatalf("select sync state: %v", err)
	}
	if persisted != 1 {
		t.Fatalf("persisted last_seq = %d, want 1", persisted)
	}
}

// TestRiderOps2RiderExport: the first export answers 202 {jobId, status:
// queued} and leaves a durable rider_exports row; a second while one is
// queued is 409 EXPORT_IN_PROGRESS; invalid reportType/format are 422.
func TestRiderOps2RiderExport(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("exp"))

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/exports",
		`{"reportType":"trips","format":"csv","from":"2026-01-01","to":"2026-01-31"}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("export status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var created struct {
		JobId  uuid.UUID `json:"jobId"`
		Status string    `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode export response: %v", err)
	}
	if created.Status != "queued" {
		t.Fatalf("export status = %q, want queued", created.Status)
	}
	var scope, status string
	var fileURL *string
	if err := pool.QueryRow(context.Background(),
		`SELECT scope, status, file_url FROM rider_exports WHERE id = $1`, created.JobId).
		Scan(&scope, &status, &fileURL); err != nil {
		t.Fatalf("select rider_export: %v", err)
	}
	if scope != "trips" || status != "queued" || fileURL != nil {
		t.Fatalf("rider_export row = %q/%q/%v", scope, status, fileURL)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/exports", `{"reportType":"trips","format":"csv"}`, token)
	wantError(t, rec, http.StatusConflict, "EXPORT_IN_PROGRESS")

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/exports", `{"reportType":"audit","format":"csv"}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	rec = authedPOSTJSON(t, s.Router(), "/riders/me/exports", `{"reportType":"trips","format":"docx"}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "VALIDATION_FAILED")

	// A completed row no longer blocks a new export.
	if _, err := pool.Exec(context.Background(),
		`UPDATE rider_exports SET status = 'completed' WHERE id = $1`, created.JobId); err != nil {
		t.Fatalf("complete export row: %v", err)
	}
	rec = authedPOSTJSON(t, s.Router(), "/riders/me/exports", `{"reportType":"earnings","format":"json"}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("second export status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var riderID2 uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT rider_id FROM rider_exports WHERE rider_id = $1 ORDER BY created_at DESC LIMIT 1`, riderID).Scan(&riderID2); err != nil {
		t.Fatalf("latest export rider: %v", err)
	}
	if riderID2 != riderID {
		t.Fatalf("export rider = %s, want %s", riderID2, riderID)
	}
}

// TestRiderOps2RiderPerformanceAggregates: completed orders (delivered/completed)
// count toward completedOrders with their total_tzs summed into earningsTZS,
// other orders and other riders' orders are excluded, and worked hours come
// from clocked rider_shifts.
func TestRiderOps2RiderPerformanceAggregates(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("prf"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("prc"), "customer")

	seedRiderOps2Order(t, pool, customerID, riderID, "delivered", 12000)
	seedRiderOps2Order(t, pool, customerID, riderID, "completed", 5000)
	seedRiderOps2Order(t, pool, customerID, riderID, "cancelled", 90000)
	seedRiderOps2Order(t, pool, customerID, riderID, "rider_assigned", 7000)

	clockedIn := time.Now().UTC().Add(-3 * time.Hour)
	clockedOut := time.Now().UTC().Add(-time.Hour)
	seedRiderOps2Shift(t, pool, riderID, &clockedIn, &clockedOut)
	seedRiderOps2Shift(t, pool, riderID, nil, nil)
	openIn := time.Now().UTC().Add(-2 * time.Hour)
	seedRiderOps2Shift(t, pool, riderID, &openIn, nil)

	rec := authedGET(t, s.Router(), "/riders/me/performance", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("performance status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var perf gen.RiderPerformance
	if err := json.NewDecoder(rec.Body).Decode(&perf); err != nil {
		t.Fatalf("decode performance: %v", err)
	}
	if perf.CompletedOrders != 2 {
		t.Fatalf("completedOrders = %d, want 2", perf.CompletedOrders)
	}
	if perf.EarningsTZS == nil || *perf.EarningsTZS != 17000 {
		t.Fatalf("earningsTZS = %v, want 17000", perf.EarningsTZS)
	}
	if perf.AvgPerTripTZS == nil || *perf.AvgPerTripTZS != 8500 {
		t.Fatalf("avgPerTripTZS = %v, want 8500", perf.AvgPerTripTZS)
	}
	if perf.OnlineHoursWeek == nil || *perf.OnlineHoursWeek < 1.9 || *perf.OnlineHoursWeek > 2.1 {
		t.Fatalf("onlineHoursWeek = %v, want ~2.0 (only the closed 2 h shift counts)", perf.OnlineHoursWeek)
	}
	if perf.AcceptanceRate != 0 || perf.OnTimePct != 0 || perf.RatingAverage != 0 {
		t.Fatalf("honest zero telemetry fields = %+v", perf)
	}
}

// TestRiderOps2RiderPerformanceEmptyWindow: a from/to window that excludes every
// order and shift yields an all-zeros scorecard (zeros are the documented
// behavior for no data — PERFORMANCE_UNAVAILABLE is never raised).
func TestRiderOps2RiderPerformanceEmptyWindow(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("prw"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("prx"), "customer")
	seedRiderOps2Order(t, pool, customerID, riderID, "delivered", 12000)

	rec := authedGET(t, s.Router(), "/riders/me/performance?from=2020-01-01&to=2020-01-31", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("performance status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var perf gen.RiderPerformance
	if err := json.NewDecoder(rec.Body).Decode(&perf); err != nil {
		t.Fatalf("decode performance: %v", err)
	}
	if perf.CompletedOrders != 0 || perf.EarningsTZS == nil || *perf.EarningsTZS != 0 {
		t.Fatalf("windowed performance = %+v, want zeros", perf)
	}
}

// TestRiderOps2CheckIn: a check-in with coords stores {date, streak, lat,
// lon} in Redis with the 48 h TTL and answers 200 with streakDays 1; a
// second check-in the same day is 429 LOCATION_RATE_LIMITED; out-of-range
// coords are 422 LOCATION_INVALID. Skipped when REDIS_URL is unset (the
// persistent server helper skips already when either URL is missing).
func TestRiderOps2CheckIn(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps2(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("cki"))

	rec := authedPOSTJSON(t, s.Router(), "/check-in", `{"lat":-6.7924,"lon":39.2083}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("check-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var created struct {
		PointsEarned int    `json:"pointsEarned"`
		StreakDays   int    `json:"streakDays"`
		BonusPoints  int    `json:"bonusPoints"`
		CheckedInAt  string `json:"checkedInAt"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode check-in response: %v", err)
	}
	if created.StreakDays != 1 || created.PointsEarned != 0 || created.CheckedInAt == "" {
		t.Fatalf("check-in response = %+v", created)
	}

	client := s.stores.Redis.Client()
	key := "rider:checkin:" + riderID.String()
	fields, err := client.HGetAll(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("hgetall check-in: %v", err)
	}
	today := time.Now().UTC().Format("2006-01-02")
	if fields["date"] != today || fields["streak"] != "1" {
		t.Fatalf("check-in hash = %v, want date %s streak 1", fields, today)
	}
	if fields["lat"] == "" || fields["lon"] == "" {
		t.Fatalf("check-in hash missing coords: %v", fields)
	}
	ttl, err := client.TTL(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("check-in ttl: %v", err)
	}
	if ttl < 47*time.Hour || ttl > 48*time.Hour {
		t.Fatalf("check-in TTL = %v, want ~48h", ttl)
	}

	rec = authedPOSTJSON(t, s.Router(), "/check-in", `{"lat":-6.8,"lon":39.2}`, token)
	wantError(t, rec, http.StatusTooManyRequests, "LOCATION_RATE_LIMITED")

	rec = authedPOSTJSON(t, s.Router(), "/check-in", `{"lat":91,"lon":39.2}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "LOCATION_INVALID")
	rec = authedPOSTJSON(t, s.Router(), "/check-in", `{"lat":-6.8}`, token)
	wantError(t, rec, http.StatusUnprocessableEntity, "LOCATION_INVALID")

	// A body-less check-in (the contract defines no body) is also accepted
	// for a fresh rider.
	_, rider2, token2 := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("cki2"))
	rec = authedPOSTJSON(t, s.Router(), "/check-in", "", token2)
	if rec.Code != http.StatusOK {
		t.Fatalf("body-less check-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	fields2, err := client.HGetAll(context.Background(), "rider:checkin:"+rider2.String()).Result()
	if err != nil {
		t.Fatalf("hgetall body-less check-in: %v", err)
	}
	if fields2["date"] != today || fields2["lat"] != "" || fields2["lon"] != "" {
		t.Fatalf("body-less check-in hash = %v", fields2)
	}

	// A consecutive-day check-in carries the streak forward: seed a hash
	// dated yesterday with streak 3 for a fresh rider, then check in.
	_, rider3, token3 := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("cki3"))
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	if err := client.HSet(context.Background(), "rider:checkin:"+rider3.String(),
		map[string]interface{}{"date": yesterday, "streak": "3"}).Err(); err != nil {
		t.Fatalf("seed yesterday hash: %v", err)
	}
	rec = authedPOSTJSON(t, s.Router(), "/check-in", "", token3)
	if rec.Code != http.StatusOK {
		t.Fatalf("streak check-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var streakResp struct {
		StreakDays int `json:"streakDays"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&streakResp); err != nil {
		t.Fatalf("decode streak response: %v", err)
	}
	if streakResp.StreakDays != 4 {
		t.Fatalf("streakDays = %d, want 4 (yesterday's streak 3 + 1)", streakResp.StreakDays)
	}
	fields3, err := client.HGetAll(context.Background(), "rider:checkin:"+rider3.String()).Result()
	if err != nil {
		t.Fatalf("hgetall streak check-in: %v", err)
	}
	if fields3["date"] != today || fields3["streak"] != "4" {
		t.Fatalf("streak check-in hash = %v, want date %s streak 4", fields3, today)
	}
}
