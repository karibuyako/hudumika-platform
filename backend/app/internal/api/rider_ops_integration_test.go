//go:build integration

// RIDER-OPS handlers against real PostgreSQL + Redis (docker compose). Run
// via DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/
// -run 'RiderShift|ClockIn|ClockOut|Break|Swap|Trip|Share|Reorder' -count=1
// Each test truncates ONLY the rider-ops tables (rider_shifts,
// rider_breaks, trip_shares) at setup and seeds its own users/riders/orders
// rows with per-run unique phones; cleanup deletes exactly those rows.
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

// truncateRiderOps clears the rider-ops tables before a test. These tables
// are exclusively owned by this suite, so a whole-table truncate is safe and
// keeps the tests independent of leftover state.
func truncateRiderOps(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE rider_shifts, rider_breaks, trip_shares`); err != nil {
		t.Fatalf("truncate rider-ops tables: %v", err)
	}
}

// uniqueRiderOpsPhone builds a per-run unique phone so repeated integration
// runs never collide with rows left by earlier runs.
func uniqueRiderOpsPhone(suffix string) string {
	return fmt.Sprintf("+2558%09d-%s", time.Now().UnixNano()%1_000_000_000, suffix)
}

// seedRiderOpsUser inserts a users + roles row and registers cleanup that
// deletes exactly those rows.
func seedRiderOpsUser(t *testing.T, pool *pgxpool.Pool, phone, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name, created_at) VALUES ($1, $2, now()) RETURNING id`,
		phone, "Rider Ops "+phone).Scan(&id); err != nil {
		t.Fatalf("seed rider-ops user: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)`, id, role); err != nil {
		t.Fatalf("seed rider-ops role: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// seedRiderOpsRider creates the rider's users + cities + riders rows and
// registers cleanup for exactly those rows. The city row exists because
// riders.GetByOwner scans city_id into a plain string.
func seedRiderOpsRider(t *testing.T, pool *pgxpool.Pool, phone string) (ownerUserID, riderID uuid.UUID, riderToken string) {
	t.Helper()
	ownerUserID = seedRiderOpsUser(t, pool, phone, "rider")
	var cityID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		"RiderOpsCity "+phone).Scan(&cityID); err != nil {
		t.Fatalf("seed rider-ops city: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, cityID)
	})
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, verification, online)
		 VALUES ($1, $2, $3, 'motorcycle', 'approved', false) RETURNING id`,
		ownerUserID, "Rider Ops "+phone, cityID).Scan(&id); err != nil {
		t.Fatalf("seed rider-ops rider: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE id = $1`, id)
	})
	return ownerUserID, id, ""
}

// seedRiderOpsRiderSession is seedRiderOpsRider plus a minted rider token.
func seedRiderOpsRiderSession(t *testing.T, s *Server, pool *pgxpool.Pool, phone string) (ownerUserID, riderID uuid.UUID, riderToken string) {
	t.Helper()
	ownerUserID, riderID, _ = seedRiderOpsRider(t, pool, phone)
	return ownerUserID, riderID, tokenFor(t, s, phone, RoleRider, false)
}

// seedRiderOpsOrder inserts an order bound to the rider with the given
// status and registers cleanup for exactly this order. customerUserID must
// be a real users row (orders.customer_user_id has an FK).
func seedRiderOpsOrder(t *testing.T, pool *pgxpool.Pool, customerUserID, riderID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, rider_id, status, subtotal_tzs, delivery_fee_tzs, total_tzs)
		 VALUES ($1, $2, $3, $4, 12000, 2000, 15000) RETURNING id`,
		customerUserID, uuid.New(), riderID, status).Scan(&id); err != nil {
		t.Fatalf("seed rider-ops order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// createRiderShiftAt creates a shift via the internal create handler and
// returns the recorder.
func createRiderShiftAt(t *testing.T, s *Server, token, startAt, endAt string, swappable bool) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"startAt":%q,"endAt":%q,"swappable":%v}`, startAt, endAt, swappable)
	return authedPOSTJSON(t, riderCreateShiftHandler(s), "/riders/me/shifts", body, token)
}

// createRiderShiftOK creates a shift and returns its id, failing the test on
// any non-201 response.
func createRiderShiftOK(t *testing.T, s *Server, token, startAt, endAt string, swappable bool) uuid.UUID {
	t.Helper()
	rec := createRiderShiftAt(t, s, token, startAt, endAt, swappable)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create shift status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var shift gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&shift); err != nil {
		t.Fatalf("decode created shift: %v", err)
	}
	return uuid.UUID(shift.Id)
}

func clockIn(t *testing.T, s *Server, token, shiftID string) *httptest.ResponseRecorder {
	t.Helper()
	return authedPOSTJSON(t, s.Router(), "/riders/me/shifts/clock-in",
		fmt.Sprintf(`{"shiftId":%q}`, shiftID), token)
}

func clockOut(t *testing.T, s *Server, token, shiftID string, cash int, reconciled bool) *httptest.ResponseRecorder {
	t.Helper()
	return authedPOSTJSON(t, s.Router(), "/riders/me/shifts/clock-out",
		fmt.Sprintf(`{"shiftId":%q,"cashCollectedTZS":%d,"cashReconciled":%v}`, shiftID, cash, reconciled), token)
}

func breakAction(t *testing.T, s *Server, token, shiftID, action string) *httptest.ResponseRecorder {
	t.Helper()
	return authedPOSTJSON(t, s.Router(), "/riders/me/shifts/"+shiftID+"/break",
		fmt.Sprintf(`{"action":%q}`, action), token)
}

func swapRequest(t *testing.T, s *Server, token, shiftID, targetRiderID string) *httptest.ResponseRecorder {
	t.Helper()
	return authedPOSTJSON(t, s.Router(), "/riders/me/shifts/"+shiftID+"/swap-request",
		fmt.Sprintf(`{"targetRiderId":%q,"note":"please take my shift"}`, targetRiderID), token)
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, status, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != code {
		t.Fatalf("error code = %q, want %q", errBody.Code, code)
	}
}

// TestRiderShiftCreateAndList: a rider creates two future shifts and lists
// them via the upcoming scope; the shifts come back scheduled with the
// requested window and the list is rider-scoped.
func TestRiderShiftCreateAndList(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsc"))

	shiftA := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", true)
	shiftB := createRiderShiftOK(t, s, token, "2099-01-02T08:00:00Z", "2099-01-02T12:00:00Z", false)

	var rider uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT rider_id FROM rider_shifts WHERE id = $1`, shiftA).Scan(&rider); err != nil {
		t.Fatalf("select shift rider: %v", err)
	}
	if rider != riderID {
		t.Fatalf("shift rider_id = %s, want %s", rider, riderID)
	}

	rec := authedGET(t, s.Router(), "/riders/me/shifts?scope=upcoming", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var shifts []gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&shifts); err != nil {
		t.Fatalf("decode shift list: %v", err)
	}
	if len(shifts) != 2 {
		t.Fatalf("shift count = %d, want 2 (%+v)", len(shifts), shifts)
	}
	for _, shift := range shifts {
		if shift.Status != gen.RiderShiftStatusScheduled {
			t.Fatalf("shift status = %q, want scheduled", shift.Status)
		}
		if uuid.UUID(shift.Id) != shiftA && uuid.UUID(shift.Id) != shiftB {
			t.Fatalf("unexpected shift id %s", shift.Id)
		}
		if shift.EndsAt == nil {
			t.Fatal("missing endsAt on listed shift")
		}
	}
}

// TestRiderShiftCreatePastStart: a shift starting in the past is 422
// SHIFT_IN_PAST.
func TestRiderShiftCreatePastStart(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsp"))

	rec := createRiderShiftAt(t, s, token, "2020-01-01T08:00:00Z", "2020-01-01T12:00:00Z", false)
	wantError(t, rec, http.StatusUnprocessableEntity, "SHIFT_IN_PAST")
}

// TestRiderShiftCreateOverlap: a shift overlapping a scheduled one is 409
// SHIFT_OVERLAP; a back-to-back shift is accepted.
func TestRiderShiftCreateOverlap(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rso"))

	createRiderShiftOK(t, s, token, "2099-03-01T08:00:00Z", "2099-03-01T12:00:00Z", false)

	rec := createRiderShiftAt(t, s, token, "2099-03-01T11:00:00Z", "2099-03-01T14:00:00Z", false)
	wantError(t, rec, http.StatusConflict, "SHIFT_OVERLAP")

	rec = createRiderShiftAt(t, s, token, "2099-03-01T12:00:00Z", "2099-03-01T14:00:00Z", false)
	if rec.Code != http.StatusCreated {
		t.Fatalf("back-to-back shift status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
}

// TestRiderShiftCreateForeignRiderScoping: shifts of another rider never
// clash with this rider's schedule and never appear in this rider's list.
func TestRiderShiftCreateForeignRiderScoping(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, tokenA := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsa"))
	_, _, tokenB := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsb"))

	createRiderShiftOK(t, s, tokenA, "2099-04-01T08:00:00Z", "2099-04-01T12:00:00Z", false)
	rec := createRiderShiftAt(t, s, tokenB, "2099-04-01T09:00:00Z", "2099-04-01T11:00:00Z", false)
	if rec.Code != http.StatusCreated {
		t.Fatalf("rider B same-window shift status = %d, want 201 (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, s.Router(), "/riders/me/shifts?scope=upcoming", tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var shifts []gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&shifts); err != nil {
		t.Fatalf("decode shift list: %v", err)
	}
	if len(shifts) != 1 {
		t.Fatalf("rider B shift count = %d, want 1 (%+v)", len(shifts), shifts)
	}
}

// TestRiderClockInLifecycle: clocking into a scheduled shift flips it to
// active with clockedInAt set; the shift is persisted.
func TestRiderClockInLifecycle(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rci"))

	shiftID := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)

	rec := clockIn(t, s, token, shiftID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var shift gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&shift); err != nil {
		t.Fatalf("decode clock-in response: %v", err)
	}
	if shift.Status != gen.RiderShiftStatusActive {
		t.Fatalf("clocked-in status = %q, want active", shift.Status)
	}
	if shift.ClockedInAt == nil {
		t.Fatal("clockedInAt not set")
	}
	var status string
	var clockedIn *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT status, clocked_in_at FROM rider_shifts WHERE id = $1`, shiftID).
		Scan(&status, &clockedIn); err != nil {
		t.Fatalf("select shift: %v", err)
	}
	if status != "active" || clockedIn == nil {
		t.Fatalf("persisted status/clockedInAt = %q/%v, want active/non-nil", status, clockedIn)
	}

	rec = clockIn(t, s, token, shiftID.String())
	wantError(t, rec, http.StatusConflict, "SHIFT_ALREADY_ACTIVE")
}

// TestRiderClockInDoubleClockIn: a second scheduled shift cannot be
// activated while another shift is already active — 409 SHIFT_ALREADY_ACTIVE.
func TestRiderClockInDoubleClockIn(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rcd"))

	shiftA := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)
	shiftB := createRiderShiftOK(t, s, token, "2099-01-02T08:00:00Z", "2099-01-02T12:00:00Z", false)

	rec := clockIn(t, s, token, shiftA.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("first clock-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	rec = clockIn(t, s, token, shiftB.String())
	wantError(t, rec, http.StatusConflict, "SHIFT_ALREADY_ACTIVE")
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM rider_shifts WHERE id = $1`, shiftB).Scan(&status); err != nil {
		t.Fatalf("select shift B: %v", err)
	}
	if status != "scheduled" {
		t.Fatalf("shift B status = %q, want scheduled", status)
	}
}

// TestRiderClockInForeignShift: clocking into a shift the rider does not own
// is 404 SHIFT_NOT_FOUND.
func TestRiderClockInForeignShift(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, tokenA := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rcf"))
	_, _, tokenB := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rcg"))

	shiftA := createRiderShiftOK(t, s, tokenA, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)
	rec := clockIn(t, s, tokenB, shiftA.String())
	wantError(t, rec, http.StatusNotFound, "SHIFT_NOT_FOUND")
}

// TestRiderClockOutWithoutClockIn: clocking out of a shift that was never
// clocked into is 409 SHIFT_CLOCKOUT_WITHOUT_CLOCKIN.
func TestRiderClockOutWithoutClockIn(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rcw"))

	shiftID := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)
	rec := clockOut(t, s, token, shiftID.String(), 0, true)
	wantError(t, rec, http.StatusConflict, "SHIFT_CLOCKOUT_WITHOUT_CLOCKIN")
}

// TestRiderClockOutLifecycle: an active shift ends on clock-out with the COD
// cash recorded; unreconciled cash blocks the clock-out with
// SHIFT_CASH_MISMATCH, and a second clock-out is rejected.
func TestRiderClockOutLifecycle(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rco"))

	shiftID := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)
	rec := clockIn(t, s, token, shiftID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}

	rec = clockOut(t, s, token, shiftID.String(), 5000, false)
	wantError(t, rec, http.StatusConflict, "SHIFT_CASH_MISMATCH")

	rec = clockOut(t, s, token, shiftID.String(), 5000, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-out status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var shift gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&shift); err != nil {
		t.Fatalf("decode clock-out response: %v", err)
	}
	if shift.Status != gen.RiderShiftStatusCompleted {
		t.Fatalf("clocked-out status = %q, want completed", shift.Status)
	}
	if shift.ClockedOutAt == nil {
		t.Fatal("clockedOutAt not set")
	}
	if shift.CashCollectedTZS == nil || *shift.CashCollectedTZS != 5000 {
		t.Fatalf("cashCollectedTZS = %v, want 5000", shift.CashCollectedTZS)
	}
	var status string
	var cash int64
	if err := pool.QueryRow(context.Background(),
		`SELECT status, collected_cash_tzs FROM rider_shifts WHERE id = $1`, shiftID).
		Scan(&status, &cash); err != nil {
		t.Fatalf("select shift: %v", err)
	}
	if status != "ended" || cash != 5000 {
		t.Fatalf("persisted status/cash = %q/%d, want ended/5000", status, cash)
	}

	rec = clockOut(t, s, token, shiftID.String(), 0, true)
	wantError(t, rec, http.StatusConflict, "SHIFT_CLOCKOUT_WITHOUT_CLOCKIN")
}

// TestRiderBreakLifecycle: a break opens and closes inside an active shift;
// a second open break is BREAK_ALREADY_ACTIVE, ending a closed break is
// BREAK_NOT_ALLOWED, and breaks inside a non-active shift are
// BREAK_NOT_ALLOWED.
func TestRiderBreakLifecycle(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rbl"))

	shiftID := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)
	otherID := createRiderShiftOK(t, s, token, "2099-01-02T08:00:00Z", "2099-01-02T12:00:00Z", false)

	rec := breakAction(t, s, token, otherID.String(), "start")
	wantError(t, rec, http.StatusConflict, "BREAK_NOT_ALLOWED")

	rec = clockIn(t, s, token, shiftID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}

	rec = breakAction(t, s, token, shiftID.String(), "start")
	if rec.Code != http.StatusOK {
		t.Fatalf("break start status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var shift gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&shift); err != nil {
		t.Fatalf("decode break response: %v", err)
	}
	if shift.Status != gen.RiderShiftStatusActive {
		t.Fatalf("shift status during break = %q, want active", shift.Status)
	}

	rec = breakAction(t, s, token, shiftID.String(), "start")
	wantError(t, rec, http.StatusConflict, "BREAK_ALREADY_ACTIVE")

	rec = breakAction(t, s, token, shiftID.String(), "end")
	if rec.Code != http.StatusOK {
		t.Fatalf("break end status = %d, want 200 (%s)", rec.Code, rec.Body)
	}

	rec = breakAction(t, s, token, shiftID.String(), "end")
	wantError(t, rec, http.StatusConflict, "BREAK_NOT_ALLOWED")

	// A fresh break can open again once the previous one closed.
	rec = breakAction(t, s, token, shiftID.String(), "start")
	if rec.Code != http.StatusOK {
		t.Fatalf("second break start status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var openCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM rider_breaks WHERE shift_id = $1 AND ended_at IS NULL`,
		shiftID).Scan(&openCount); err != nil {
		t.Fatalf("count open breaks: %v", err)
	}
	if openCount != 1 {
		t.Fatalf("open breaks = %d, want 1", openCount)
	}

	rec = breakAction(t, s, token, uuid.NewString(), "start")
	wantError(t, rec, http.StatusNotFound, "SHIFT_NOT_FOUND")
}

// TestRiderSwapRequestGates: a non-swappable or active shift is
// SWAP_NOT_ALLOWED, a second request is SWAP_ALREADY_REQUESTED, a foreign
// shift is SHIFT_NOT_FOUND and an unknown target rider is NOT_FOUND.
func TestRiderSwapRequestGates(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, _, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsw"))
	_, targetID, _ := seedRiderOpsRider(t, pool, uniqueRiderOpsPhone("rst"))

	plainID := createRiderShiftOK(t, s, token, "2099-01-01T08:00:00Z", "2099-01-01T12:00:00Z", false)
	swappableID := createRiderShiftOK(t, s, token, "2099-01-02T08:00:00Z", "2099-01-02T12:00:00Z", true)
	activeID := createRiderShiftOK(t, s, token, "2099-01-03T08:00:00Z", "2099-01-03T12:00:00Z", true)

	rec := swapRequest(t, s, token, plainID.String(), targetID.String())
	wantError(t, rec, http.StatusConflict, "SWAP_NOT_ALLOWED")

	rec = swapRequest(t, s, token, uuid.NewString(), targetID.String())
	wantError(t, rec, http.StatusNotFound, "SHIFT_NOT_FOUND")

	rec = swapRequest(t, s, token, swappableID.String(), uuid.NewString())
	wantError(t, rec, http.StatusNotFound, "NOT_FOUND")

	rec = swapRequest(t, s, token, swappableID.String(), targetID.String())
	if rec.Code != http.StatusCreated {
		t.Fatalf("swap status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var created struct {
		SwapRequestId openapi_types.UUID `json:"swapRequestId"`
		Status        string             `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode swap response: %v", err)
	}
	if uuid.UUID(created.SwapRequestId) != swappableID {
		t.Fatalf("swapRequestId = %s, want shift %s", created.SwapRequestId, swappableID)
	}
	if created.Status != "pending" {
		t.Fatalf("swap status = %q, want pending", created.Status)
	}
	var requestedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT swap_requested_at FROM rider_shifts WHERE id = $1`, swappableID).Scan(&requestedAt); err != nil {
		t.Fatalf("select swap_requested_at: %v", err)
	}
	if requestedAt == nil {
		t.Fatal("swap_requested_at not set")
	}

	rec = swapRequest(t, s, token, swappableID.String(), targetID.String())
	wantError(t, rec, http.StatusConflict, "SWAP_ALREADY_REQUESTED")

	rec = clockIn(t, s, token, activeID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-in status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	rec = swapRequest(t, s, token, activeID.String(), targetID.String())
	wantError(t, rec, http.StatusConflict, "SWAP_NOT_ALLOWED")
}

// TestRiderTripShowsAssignedOrders: the rider's trip bundle is exactly their
// in-flight orders — never delivered ones, never another rider's — and the
// trip id resolves to any order id within the bundle.
func TestRiderTripShowsAssignedOrders(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, riderA, tokenA := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rta"))
	_, _, tokenB := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rtb"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("rtc"), "customer")

	orderA1 := seedRiderOpsOrder(t, pool, customerID, riderA, "rider_assigned")
	orderA2 := seedRiderOpsOrder(t, pool, customerID, riderA, "picked_up")
	orderA3 := seedRiderOpsOrder(t, pool, customerID, riderA, "delivering")
	seedRiderOpsOrder(t, pool, customerID, riderA, "delivered")
	orderB1 := seedRiderOpsOrder(t, pool, customerID, riderA, "rider_assigned")
	if _, err := pool.Exec(context.Background(),
		`UPDATE orders SET rider_id = $1 WHERE id = $2`, uuid.New(), orderB1); err != nil {
		t.Fatalf("reassign order B: %v", err)
	}

	rec := authedGET(t, s.Router(), "/riders/me/trips", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("active trip status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var trip gen.Trip
	if err := json.NewDecoder(rec.Body).Decode(&trip); err != nil {
		t.Fatalf("decode trip: %v", err)
	}
	if trip.Status != gen.TripStatusActive {
		t.Fatalf("trip status = %q, want active", trip.Status)
	}
	got := map[uuid.UUID]bool{}
	for _, id := range trip.OrderIds {
		got[uuid.UUID(id)] = true
	}
	if len(got) != 3 || !got[orderA1] || !got[orderA2] || !got[orderA3] {
		t.Fatalf("trip orderIds = %v, want exactly %s, %s, %s", trip.OrderIds, orderA1, orderA2, orderA3)
	}
	if got[orderB1] {
		t.Fatal("order B leaked into trip A")
	}
	if len(trip.Stops) != 3 {
		t.Fatalf("trip stops = %d, want 3", len(trip.Stops))
	}
	for i, stop := range trip.Stops {
		if stop.Sequence != i+1 {
			t.Fatalf("stop %d sequence = %d, want %d", i, stop.Sequence, i+1)
		}
	}

	rec = authedGET(t, s.Router(), "/riders/me/trips/"+orderA2.String(), tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("trip detail status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, s.Router(), "/riders/me/trips/"+uuid.NewString(), tokenA)
	wantError(t, rec, http.StatusNotFound, "TRIP_NOT_FOUND")

	rec = authedGET(t, s.Router(), "/riders/me/trips", tokenB)
	wantError(t, rec, http.StatusNotFound, "TRIP_NOT_FOUND")
}

// TestRiderShareTrip: sharing an in-flight order creates a pending
// trip_share row with the requested expiry and answers shareToken +
// expiresAt; sharing an order that is not the rider's in-flight trip is
// TRIP_SHARE_NOT_ALLOWED.
func TestRiderShareTrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, riderA, tokenA := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsh"))
	_, _, tokenB := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rsi"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("rsc"), "customer")

	orderID := seedRiderOpsOrder(t, pool, customerID, riderA, "picked_up")
	deliveredID := seedRiderOpsOrder(t, pool, customerID, riderA, "delivered")

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+orderID.String()+"/share",
		`{"recipients":["+255700011111"],"expiresInHours":2}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("share status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var shared struct {
		ShareToken string    `json:"shareToken"`
		ExpiresAt  time.Time `json:"expiresAt"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&shared); err != nil {
		t.Fatalf("decode share response: %v", err)
	}
	if shared.ShareToken == "" {
		t.Fatal("missing shareToken")
	}
	if shared.ExpiresAt.Before(time.Now().Add(90 * time.Minute)) {
		t.Fatalf("expiresAt = %v, want ~2h out", shared.ExpiresAt)
	}
	var (
		status    string
		order     uuid.UUID
		expiresAt time.Time
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT status, order_id, expires_at FROM trip_shares WHERE id = $1`,
		uuid.MustParse(shared.ShareToken)).Scan(&status, &order, &expiresAt); err != nil {
		t.Fatalf("select trip_share: %v", err)
	}
	if status != "pending" || order != orderID {
		t.Fatalf("trip_share status/order = %q/%s, want pending/%s", status, order, orderID)
	}
	if expiresAt.Sub(shared.ExpiresAt) > time.Minute {
		t.Fatalf("trip_share expires_at = %v, response = %v", expiresAt, shared.ExpiresAt)
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+deliveredID.String()+"/share",
		`{"recipients":["+255700011111"]}`, tokenA)
	wantError(t, rec, http.StatusConflict, "TRIP_SHARE_NOT_ALLOWED")

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+orderID.String()+"/share",
		`{"recipients":["+255700011111"]}`, tokenB)
	wantError(t, rec, http.StatusConflict, "TRIP_SHARE_NOT_ALLOWED")

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+orderID.String()+"/share",
		`{"recipients":[]}`, tokenA)
	wantError(t, rec, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
}

// TestRiderReorderTripStops: reordering the bundle echoes the new sequence
// and rejects unknown order ids with REORDER_INVALID and foreign trips with
// TRIP_NOT_FOUND.
func TestRiderReorderTripStops(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, riderA, tokenA := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rre"))
	customerID := seedRiderOpsUser(t, pool, uniqueRiderOpsPhone("rrc"), "customer")

	order1 := seedRiderOpsOrder(t, pool, customerID, riderA, "rider_assigned")
	order2 := seedRiderOpsOrder(t, pool, customerID, riderA, "picked_up")
	order3 := seedRiderOpsOrder(t, pool, customerID, riderA, "delivering")

	rec := authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+order1.String()+"/reorder",
		fmt.Sprintf(`{"orderIds":[%q,%q,%q]}`, order3, order1, order2), tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("reorder status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var trip gen.Trip
	if err := json.NewDecoder(rec.Body).Decode(&trip); err != nil {
		t.Fatalf("decode reorder response: %v", err)
	}
	if len(trip.OrderIds) != 3 {
		t.Fatalf("reordered orderIds = %v, want 3", trip.OrderIds)
	}
	if trip.OrderIds[0] != openapi_types.UUID(order3) || trip.OrderIds[1] != openapi_types.UUID(order1) || trip.OrderIds[2] != openapi_types.UUID(order2) {
		t.Fatalf("reordered orderIds = %v, want %s, %s, %s", trip.OrderIds, order3, order1, order2)
	}
	if trip.Stops[0].Sequence != 1 || trip.Stops[0].OrderId != openapi_types.UUID(order3) {
		t.Fatalf("first reordered stop = %+v", trip.Stops[0])
	}

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+order1.String()+"/reorder",
		fmt.Sprintf(`{"orderIds":[%q,%q]}`, order1, uuid.NewString()), tokenA)
	wantError(t, rec, http.StatusConflict, "REORDER_INVALID")

	rec = authedPOSTJSON(t, s.Router(), "/riders/me/trips/"+uuid.NewString()+"/reorder",
		fmt.Sprintf(`{"orderIds":[%q]}`, order1), tokenA)
	wantError(t, rec, http.StatusNotFound, "TRIP_NOT_FOUND")
}

// TestRiderShiftsPagination: the documented limit/offset extension pages
// through 25 shifts in 20 + 5.
func TestRiderShiftsPagination(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderOps(t, pool)
	_, riderID, token := seedRiderOpsRiderSession(t, s, pool, uniqueRiderOpsPhone("rpg"))

	for i := 0; i < 25; i++ {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO rider_shifts (rider_id, start_at, end_at, status)
			 VALUES ($1, now() + ($2 * interval '1 day'), now() + (($2 + 8) * interval '1 day'), 'scheduled')`,
			riderID, i+1); err != nil {
			t.Fatalf("seed shift %d: %v", i, err)
		}
	}

	rec := authedGET(t, s.Router(), "/riders/me/shifts?scope=upcoming", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 count = %d, want 20", len(page1))
	}

	rec = authedGET(t, s.Router(), "/riders/me/shifts?scope=upcoming&offset=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.RiderShift
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 count = %d, want 5", len(page2))
	}
	seen := map[uuid.UUID]bool{}
	for _, shift := range append(page1, page2...) {
		if seen[uuid.UUID(shift.Id)] {
			t.Fatalf("duplicate shift %s across pages", shift.Id)
		}
		seen[uuid.UUID(shift.Id)] = true
	}
}
