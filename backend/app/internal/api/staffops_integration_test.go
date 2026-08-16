//go:build integration

// Staff-ops and devices integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Staff|Device|Shift|Attendance|Commission|Clock' -count=1
//
// This suite owns the staff-ops tables (migration 00024): it truncates
// merchant_staff, devices, staff_shifts, attendance and commission_rules at
// setup, and clears its own users (phone prefix +255877...) — it never
// truncates shared tables.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// staffOpsPhonePrefix identifies every users row this suite inserts.
const staffOpsPhonePrefix = "+255877"

// staffOpsTables are the tables owned by this suite (migration 00024), in
// foreign-key order.
var staffOpsTables = []string{"attendance", "staff_shifts", "commission_rules", "device_tests", "devices", "merchant_staff"}

// staffOpsSetup wires a persistent server and truncates only this suite's
// tables plus its own users. All five tables are truncated in one statement
// so the attendance→staff_shifts→merchant_staff FK chain is satisfied
// without CASCADE.
func staffOpsSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(staffOpsTables, ", ")+" CASCADE"); err != nil {
		t.Fatalf("truncate staff ops tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+staffOpsPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear staff ops users: %v", err)
	}
	return s, pool
}

// staffOpsMerchant inserts a users row with a per-run unique phone and
// returns the merchant id and a merchant-role token for it. The same phone
// doubles as the staff self-service phone in clock-in/out tests.
func staffOpsMerchant(t *testing.T, s *Server, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", staffOpsPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert staff ops merchant user: %v", err)
	}
	return userID, phone
}

// staffOpsStaff inserts one merchant_staff row and returns its id.
func staffOpsStaff(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, phone string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO merchant_staff (merchant_id, name, role, phone)
		 VALUES ($1, $2, 'cashier', $3) RETURNING id`,
		merchantID, "Staff "+phone, phone).Scan(&id); err != nil {
		t.Fatalf("insert merchant staff: %v", err)
	}
	return id
}

// staffOpsShift inserts a staff_shifts row directly (seeding for
// performance/pagination tests).
func staffOpsShift(t *testing.T, pool *pgxpool.Pool, merchantID, staffID uuid.UUID, startAt, endAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO staff_shifts (merchant_id, staff_id, start_at, end_at, status)
		 VALUES ($1, $2, $3, $4, 'scheduled')`,
		merchantID, staffID, startAt, endAt); err != nil {
		t.Fatalf("insert staff shift: %v", err)
	}
}

// staffOpsAttendance inserts a closed attendance record directly.
func staffOpsAttendance(t *testing.T, pool *pgxpool.Pool, merchantID, staffID uuid.UUID, in, out time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO attendance (merchant_id, staff_id, clocked_in_at, clocked_out_at)
		 VALUES ($1, $2, $3, $4)`,
		merchantID, staffID, in, out); err != nil {
		t.Fatalf("insert attendance: %v", err)
	}
}

// staffOpsPOST sends an authenticated POST without a body.
func staffOpsPOST(t *testing.T, h http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return authedDo(t, h, http.MethodPost, path, "", token)
}

// TestDeviceLifecycle covers register → list → update → delete → not found.
func TestDeviceLifecycle(t *testing.T) {
	s, pool := staffOpsSetup(t)
	merchantID, phone := staffOpsMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/devices", `{"type":"printer","label":"Kitchen Printer"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register device = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.MerchantDevice
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode device: %v", err)
	}
	if created.Id == nil || created.Label != "Kitchen Printer" || created.Type != "printer" {
		t.Fatalf("unexpected created device: %+v", created)
	}
	if created.Status == nil || *created.Status != "offline" {
		t.Fatalf("default device status = %v, want offline", created.Status)
	}

	// kitchen_display normalizes to the storage kiosk enum and round-trips.
	rec = authedDo(t, h, http.MethodPost, "/devices", `{"type":"kitchen_display","label":"Kitchen Screen"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register kitchen display = %d (%s)", rec.Code, rec.Body)
	}
	var display gen.MerchantDevice
	if err := json.NewDecoder(rec.Body).Decode(&display); err != nil {
		t.Fatalf("decode kitchen display: %v", err)
	}
	if display.Type != "kitchen_display" {
		t.Fatalf("kitchen display type round-trip = %q, want kitchen_display", display.Type)
	}

	rec = authedGET(t, h, "/devices", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list devices = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.MerchantDevice
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode device list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("device count = %d, want 2", len(list))
	}

	rec = authedDo(t, h, http.MethodPatch, "/devices/"+created.Id.String(),
		`{"type":"pos","label":"Front POS","status":"online"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update device = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.MerchantDevice
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated device: %v", err)
	}
	if updated.Label != "Front POS" || updated.Type != "pos" || updated.Status == nil || *updated.Status != "online" {
		t.Fatalf("unexpected updated device: %+v", updated)
	}

	rec = authedDo(t, h, http.MethodDelete, "/devices/"+created.Id.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete device = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/devices/"+created.Id.String(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing device = %d, want 404", rec.Code)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode delete error: %v", err)
	}
	if errBody.Code != "DEVICE_NOT_FOUND" {
		t.Fatalf("delete error code = %q, want DEVICE_NOT_FOUND", errBody.Code)
	}
	_ = merchantID
}

// TestShiftCreationAndConflicts covers create, list, update, delete, and the
// SHIFT_IN_PAST / SHIFT_OVERLAP / STAFF_NOT_FOUND rules.
func TestShiftCreationAndConflicts(t *testing.T) {
	s, pool := staffOpsSetup(t)
	merchantID, phone := staffOpsMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	staffID := staffOpsStaff(t, pool, merchantID, phone+"x")

	now := time.Now().UTC()
	shiftBody := func(start, end time.Time) string {
		return fmt.Sprintf(`{"staffId":%q,"startAt":%q,"endAt":%q}`,
			staffID.String(), start.Format(time.RFC3339), end.Format(time.RFC3339))
	}

	rec := authedDo(t, h, http.MethodPost, "/staff/shifts",
		shiftBody(now.Add(1*time.Hour), now.Add(3*time.Hour)), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create shift = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.StaffShift
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode shift: %v", err)
	}
	if created.Id == nil || created.Status == nil || *created.Status != "scheduled" {
		t.Fatalf("unexpected created shift: %+v", created)
	}
	if created.Role == nil || *created.Role != "cashier" {
		t.Fatalf("shift role = %v, want cashier", created.Role)
	}

	// Overlap with the existing shift (2h..4h vs 1h..3h).
	rec = authedDo(t, h, http.MethodPost, "/staff/shifts",
		shiftBody(now.Add(2*time.Hour), now.Add(4*time.Hour)), token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("overlapping shift = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode overlap error: %v", err)
	}
	if errBody.Code != "SHIFT_OVERLAP" {
		t.Fatalf("overlap error code = %q, want SHIFT_OVERLAP", errBody.Code)
	}

	// Start in the past.
	rec = authedDo(t, h, http.MethodPost, "/staff/shifts",
		shiftBody(now.Add(-1*time.Hour), now.Add(1*time.Hour)), token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("past shift = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode past error: %v", err)
	}
	if errBody.Code != "SHIFT_IN_PAST" {
		t.Fatalf("past error code = %q, want SHIFT_IN_PAST", errBody.Code)
	}

	// Unknown staff.
	rec = authedDo(t, h, http.MethodPost, "/staff/shifts",
		fmt.Sprintf(`{"staffId":%q,"startAt":%q,"endAt":%q}`,
			uuid.NewString(), now.Add(1*time.Hour).Format(time.RFC3339), now.Add(3*time.Hour).Format(time.RFC3339)), token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown staff shift = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode staff error: %v", err)
	}
	if errBody.Code != "STAFF_NOT_FOUND" {
		t.Fatalf("staff error code = %q, want STAFF_NOT_FOUND", errBody.Code)
	}

	// List within the day window.
	from := now.Format("2006-01-02")
	to := now.Add(24 * time.Hour).Format("2006-01-02")
	rec = authedGET(t, h, "/staff/shifts?from="+from+"&to="+to, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list shifts = %d (%s)", rec.Code, rec.Body)
	}
	var shifts []gen.StaffShift
	if err := json.NewDecoder(rec.Body).Decode(&shifts); err != nil {
		t.Fatalf("decode shift list: %v", err)
	}
	if len(shifts) != 1 || shifts[0].Id == nil || *shifts[0].Id != *created.Id {
		t.Fatalf("unexpected shift list: %+v", shifts)
	}

	// Update: move the shift later, mark it completed.
	rec = authedDo(t, h, http.MethodPatch, "/staff/shifts/"+created.Id.String(),
		fmt.Sprintf(`{"staffId":%q,"startAt":%q,"endAt":%q,"status":"completed"}`,
			staffID.String(), now.Add(5*time.Hour).Format(time.RFC3339), now.Add(7*time.Hour).Format(time.RFC3339)), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update shift = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.StaffShift
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated shift: %v", err)
	}
	if updated.Status == nil || *updated.Status != "completed" {
		t.Fatalf("updated shift status = %v, want completed", updated.Status)
	}

	// Update to an overlap with the still-scheduled... (none left) — update
	// of a missing shift is 404 SHIFT_NOT_FOUND.
	rec = authedDo(t, h, http.MethodPatch, "/staff/shifts/"+uuid.NewString(),
		shiftBody(now.Add(9*time.Hour), now.Add(11*time.Hour)), token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update missing shift = %d, want 404", rec.Code)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode missing shift error: %v", err)
	}
	if errBody.Code != "SHIFT_NOT_FOUND" {
		t.Fatalf("missing shift error code = %q, want SHIFT_NOT_FOUND", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodDelete, "/staff/shifts/"+created.Id.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete shift = %d (%s)", rec.Code, rec.Body)
	}
}

// TestClockInClockOutLifecycle covers the staff self-service flow: open
// record conflicts on double clock-in and missing open record conflicts on
// clock-out.
func TestClockInClockOutLifecycle(t *testing.T) {
	s, pool := staffOpsSetup(t)
	merchantID, phone := staffOpsMerchant(t, s, pool)
	// The staff self-service phone equals the session subject.
	staffID := staffOpsStaff(t, pool, merchantID, phone)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := staffOpsPOST(t, h, "/staff/attendance/clock-in", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-in = %d (%s)", rec.Code, rec.Body)
	}
	var first gen.AttendanceRecord
	if err := json.NewDecoder(rec.Body).Decode(&first); err != nil {
		t.Fatalf("decode clock-in: %v", err)
	}
	if first.Id.String() == "" || first.StaffId.String() != staffID.String() || first.ClockedOutAt != nil {
		t.Fatalf("unexpected clock-in record: %+v", first)
	}

	// Double clock-in conflicts.
	rec = staffOpsPOST(t, h, "/staff/attendance/clock-in", token)
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode double clock-in error: %v", err)
	}
	if rec.Code != http.StatusConflict || errBody.Code != "ATTENDANCE_ALREADY_CLOCKED_IN" {
		t.Fatalf("double clock-in = %d code %q (%s)", rec.Code, errBody.Code, rec.Body)
	}

	rec = staffOpsPOST(t, h, "/staff/attendance/clock-out", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("clock-out = %d (%s)", rec.Code, rec.Body)
	}
	var closed gen.AttendanceRecord
	if err := json.NewDecoder(rec.Body).Decode(&closed); err != nil {
		t.Fatalf("decode clock-out: %v", err)
	}
	if closed.ClockedOutAt == nil || closed.DurationMinutes == nil {
		t.Fatalf("clock-out record not closed: %+v", closed)
	}

	// Clock-out without an open record conflicts.
	rec = staffOpsPOST(t, h, "/staff/attendance/clock-out", token)
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode double clock-out error: %v", err)
	}
	if rec.Code != http.StatusConflict || errBody.Code != "ATTENDANCE_NOT_CLOCKED_IN" {
		t.Fatalf("double clock-out = %d code %q (%s)", rec.Code, errBody.Code, rec.Body)
	}

	// A new clock-in after clock-out opens a fresh record.
	rec = staffOpsPOST(t, h, "/staff/attendance/clock-in", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("re clock-in = %d (%s)", rec.Code, rec.Body)
	}
	var reopened gen.AttendanceRecord
	if err := json.NewDecoder(rec.Body).Decode(&reopened); err != nil {
		t.Fatalf("decode re clock-in: %v", err)
	}
	if reopened.Id.String() == first.Id.String() || reopened.ClockedOutAt != nil {
		t.Fatalf("re clock-in did not open a fresh record: %+v", reopened)
	}
}

// TestStaffPerformanceAggregates verifies the per-staff hours aggregate:
// attendanceRate is the share of scheduled shift time covered by attendance.
func TestStaffPerformanceAggregates(t *testing.T) {
	s, pool := staffOpsSetup(t)
	merchantID, phone := staffOpsMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	// Staff A: one 2-hour shift, 3 hours attendance (2h + 1h) → rate capped
	// at 100. Staff B: one 2-hour shift, 1 hour attendance → rate 50.
	day := time.Now().UTC().Truncate(24 * time.Hour)
	staffA := staffOpsStaff(t, pool, merchantID, phone+"A")
	staffB := staffOpsStaff(t, pool, merchantID, phone+"B")
	staffOpsShift(t, pool, merchantID, staffA, day.Add(9*time.Hour), day.Add(11*time.Hour))
	staffOpsShift(t, pool, merchantID, staffB, day.Add(9*time.Hour), day.Add(11*time.Hour))
	staffOpsAttendance(t, pool, merchantID, staffA, day.Add(9*time.Hour), day.Add(11*time.Hour))
	staffOpsAttendance(t, pool, merchantID, staffA, day.Add(14*time.Hour), day.Add(15*time.Hour))
	staffOpsAttendance(t, pool, merchantID, staffB, day.Add(9*time.Hour), day.Add(10*time.Hour))

	rec := authedGET(t, h, "/staff/performance?from="+day.Format("2006-01-02")+"&to="+day.Format("2006-01-02"), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("staff performance = %d (%s)", rec.Code, rec.Body)
	}
	var perfs []gen.StaffPerformance
	if err := json.NewDecoder(rec.Body).Decode(&perfs); err != nil {
		t.Fatalf("decode performance: %v", err)
	}
	if len(perfs) != 2 {
		t.Fatalf("performance rows = %d, want 2 (%+v)", len(perfs), perfs)
	}
	byID := map[string]gen.StaffPerformance{}
	for _, p := range perfs {
		byID[p.StaffId.String()] = p
	}
	a, okA := byID[staffA.String()]
	b, okB := byID[staffB.String()]
	if !okA || !okB {
		t.Fatalf("missing performance rows for staff: %+v", perfs)
	}
	if a.AttendanceRate == nil || *a.AttendanceRate != 100 {
		t.Fatalf("staff A attendanceRate = %v, want 100", a.AttendanceRate)
	}
	if b.AttendanceRate == nil || *b.AttendanceRate != 50 {
		t.Fatalf("staff B attendanceRate = %v, want 50", b.AttendanceRate)
	}
	if a.OrdersProcessed == nil || *a.OrdersProcessed != 0 || a.Cancellations == nil || *a.Cancellations != 0 {
		t.Fatalf("staff A honest zeros missing: %+v", a)
	}

	// Outside the range there are no records: rates drop to 0.
	rec = authedGET(t, h, "/staff/performance?from=2020-01-01&to=2020-01-02", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("out-of-range performance = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&perfs); err != nil {
		t.Fatalf("decode empty performance: %v", err)
	}
	if len(perfs) != 2 {
		t.Fatalf("out-of-range rows = %d, want 2", len(perfs))
	}
	for _, p := range perfs {
		if p.AttendanceRate == nil || *p.AttendanceRate != 0 {
			t.Fatalf("out-of-range attendanceRate = %v, want 0", p.AttendanceRate)
		}
	}
}

// TestCommissionRuleValidation covers the replace-all semantics, the
// COMMISSION_RULE_INVALID rule and the list round-trip.
func TestCommissionRuleValidation(t *testing.T) {
	s, pool := staffOpsSetup(t)
	_, phone := staffOpsMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPut, "/staff/commissions",
		`{"rules":[{"type":"per_order","rateBps":500},{"type":"per_service","rateBps":1200}]}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("put commission rules = %d (%s)", rec.Code, rec.Body)
	}
	var rules []gen.CommissionRule
	if err := json.NewDecoder(rec.Body).Decode(&rules); err != nil {
		t.Fatalf("decode rules: %v", err)
	}
	if len(rules) != 2 {
		t.Fatalf("rule count = %d, want 2", len(rules))
	}
	seen := map[gen.CommissionRuleType]int{}
	for _, r := range rules {
		seen[r.Type] = r.RateBps
	}
	if seen["per_order"] != 500 || seen["per_service"] != 1200 {
		t.Fatalf("unexpected rules round-trip: %+v", rules)
	}

	// rateBps beyond 10000 is invalid.
	rec = authedDo(t, h, http.MethodPut, "/staff/commissions",
		`{"rules":[{"type":"per_order","rateBps":20000}]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("oversized rateBps = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode rule error: %v", err)
	}
	if errBody.Code != "COMMISSION_RULE_INVALID" {
		t.Fatalf("rule error code = %q, want COMMISSION_RULE_INVALID", errBody.Code)
	}

	// Unknown/empty type (the rule "name") is invalid.
	rec = authedDo(t, h, http.MethodPut, "/staff/commissions",
		`{"rules":[{"type":"","rateBps":100}]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty type = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode empty-type error: %v", err)
	}
	if errBody.Code != "COMMISSION_RULE_INVALID" {
		t.Fatalf("empty type code = %q, want COMMISSION_RULE_INVALID", errBody.Code)
	}

	// Replace-all: the second PUT overwrote the first set.
	rec = authedDo(t, h, http.MethodPut, "/staff/commissions",
		`{"rules":[{"type":"per_revenue","rateBps":3000}]}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("replace rules = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, h, "/staff/commissions", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get commission rules = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&rules); err != nil {
		t.Fatalf("decode rules list: %v", err)
	}
	if len(rules) != 1 || rules[0].Type != "per_revenue" || rules[0].RateBps != 3000 {
		t.Fatalf("replace-all result = %+v, want single per_revenue 3000", rules)
	}
}

// TestAttendancePagination verifies the 20-record default page and the
// limit/offset extension over 25 seeded records.
func TestAttendancePagination(t *testing.T) {
	s, pool := staffOpsSetup(t)
	merchantID, phone := staffOpsMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	staffID := staffOpsStaff(t, pool, merchantID, phone+"P")

	day := time.Now().UTC().Truncate(24 * time.Hour)
	for i := 0; i < 25; i++ {
		in := day.Add(time.Duration(i) * time.Minute)
		staffOpsAttendance(t, pool, merchantID, staffID, in, in.Add(30*time.Minute))
	}

	rec := authedGET(t, h, "/staff/attendance", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list attendance = %d (%s)", rec.Code, rec.Body)
	}
	var page []gen.AttendanceRecord
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode attendance page: %v", err)
	}
	if len(page) != 20 {
		t.Fatalf("first page = %d records, want 20", len(page))
	}

	rec = authedGET(t, h, "/staff/attendance?offset=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("second page = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode second page: %v", err)
	}
	if len(page) != 5 {
		t.Fatalf("second page = %d records, want 5", len(page))
	}

	// staffId filter returns the same 25 across pages.
	rec = authedGET(t, h, "/staff/attendance?staffId="+staffID.String(), token)
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode staffId page: %v", err)
	}
	if len(page) != 20 {
		t.Fatalf("staffId first page = %d, want 20", len(page))
	}
	rec = authedGET(t, h, "/staff/attendance?staffId="+staffID.String()+"&offset=20", token)
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode staffId second page: %v", err)
	}
	if len(page) != 5 {
		t.Fatalf("staffId second page = %d, want 5", len(page))
	}
}

// TestConcurrentClockInSingleWinner races two clock-ins for the same staff:
// the partial unique index on open records guarantees exactly one winner.
func TestConcurrentClockInSingleWinner(t *testing.T) {
	s, pool := staffOpsSetup(t)
	merchantID, phone := staffOpsMerchant(t, s, pool)
	staffOpsStaff(t, pool, merchantID, phone)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	const racers = 8
	results := make([]int, racers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			req := httptest.NewRequest(http.MethodPost, "/staff/attendance/clock-in", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			results[i] = rec.Code
		}(i)
	}
	close(start)
	wg.Wait()

	wins := 0
	conflicts := 0
	for _, code := range results {
		switch code {
		case http.StatusOK:
			wins++
		case http.StatusConflict:
			conflicts++
		default:
			t.Fatalf("unexpected clock-in status %d", code)
		}
	}
	if wins != 1 || conflicts != racers-1 {
		t.Fatalf("clock-in outcomes = %d wins / %d conflicts, want 1/%d", wins, conflicts, racers-1)
	}

	var open int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM attendance WHERE staff_id IN (SELECT id FROM merchant_staff WHERE merchant_id = $1) AND clocked_out_at IS NULL`,
		merchantID).Scan(&open); err != nil {
		t.Fatalf("open record count: %v", err)
	}
	if open != 1 {
		t.Fatalf("open attendance records = %d, want exactly 1", open)
	}
}
