//go:build integration

// RIDER-SELF handlers against real PostgreSQL + Redis (docker compose). Run
// via DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/
// -run 'RiderPreference|RiderGoal|RiderExpense|TrustedContact|RiderSecurity|DestinationFilter|SafetyEvent' -count=1
// Each test truncates ONLY the rider-self tables (rider_preferences,
// rider_goals, rider_expenses, trusted_contacts, rider_security,
// destination_filters, safety_events) at setup and seeds its own
// users/riders rows with per-run unique phones; cleanup deletes exactly
// those rows.
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
)

// truncateRiderSelf clears the rider-self tables before a test. These tables
// are exclusively owned by this suite, so a whole-table truncate is safe and
// keeps the tests independent of leftover state.
func truncateRiderSelf(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE rider_preferences, rider_goals, rider_expenses, trusted_contacts,
		          rider_security, destination_filters, safety_events`); err != nil {
		t.Fatalf("truncate rider-self tables: %v", err)
	}
}

// uniqueRiderSelfPhone builds a per-run unique phone so repeated integration
// runs never collide with rows left by earlier runs.
func uniqueRiderSelfPhone(suffix string) string {
	return fmt.Sprintf("+2559%09d-%s", time.Now().UnixNano()%1_000_000_000, suffix)
}

// seedRiderSelfUser inserts a users + roles row and registers cleanup that
// deletes exactly those rows.
func seedRiderSelfUser(t *testing.T, pool *pgxpool.Pool, phone, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name, created_at) VALUES ($1, $2, now()) RETURNING id`,
		phone, "Rider Self "+phone).Scan(&id); err != nil {
		t.Fatalf("seed rider-self user: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)`, id, role); err != nil {
		t.Fatalf("seed rider-self role: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// seedRiderSelfRiderSession creates the rider's users + cities + riders rows
// and returns the rider id with a minted rider token.
func seedRiderSelfRiderSession(t *testing.T, s *Server, pool *pgxpool.Pool, phone string) (ownerUserID, riderID uuid.UUID, riderToken string) {
	t.Helper()
	ownerUserID = seedRiderSelfUser(t, pool, phone, "rider")
	var cityID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		"RiderSelfCity "+phone).Scan(&cityID); err != nil {
		t.Fatalf("seed rider-self city: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, cityID)
	})
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, verification, online)
		 VALUES ($1, $2, $3, 'motorcycle', 'approved', false) RETURNING id`,
		ownerUserID, "Rider Self "+phone, cityID).Scan(&id); err != nil {
		t.Fatalf("seed rider-self rider: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE id = $1`, id)
	})
	return ownerUserID, id, tokenFor(t, s, phone, RoleRider, false)
}

// riderSelfWantError asserts the recorder carries the status + error code.
func riderSelfWantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
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

// TestRiderPreferenceRoundtrip: GET lazily creates the storage defaults
// (language "en"), PUT persists the contract surface and partial updates
// keep untouched fields, and a language outside en|sw|ar is 422
// PREFERENCES_INVALID.
func TestRiderPreferenceRoundtrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	phone := uniqueRiderSelfPhone("rpref")
	_, _, token := seedRiderSelfRiderSession(t, s, pool, phone)

	rec := authedGET(t, s.Router(), "/riders/me/preferences", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get defaults status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var prefs gen.RiderPreferences
	if err := json.NewDecoder(rec.Body).Decode(&prefs); err != nil {
		t.Fatalf("decode default preferences: %v", err)
	}
	if prefs.Language == nil || *prefs.Language != "en" {
		t.Fatalf("default language = %v, want en", prefs.Language)
	}

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/preferences", token,
		`{"language":"sw","soundNotifications":true,"autoAccept":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("put preferences status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&prefs); err != nil {
		t.Fatalf("decode put preferences: %v", err)
	}
	if prefs.Language == nil || *prefs.Language != "sw" || !prefs.SoundNotifications || prefs.AutoAccept == nil || !*prefs.AutoAccept {
		t.Fatalf("put response = %+v, want sw/sound/autoAccept", prefs)
	}

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/preferences", token,
		`{"language":"ar"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("put partial status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, s.Router(), "/riders/me/preferences", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get after partial status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&prefs); err != nil {
		t.Fatalf("decode after partial: %v", err)
	}
	if prefs.Language == nil || *prefs.Language != "ar" {
		t.Fatalf("language after partial = %v, want ar", prefs.Language)
	}
	if !prefs.SoundNotifications {
		t.Fatal("soundNotifications dropped by partial update")
	}

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/preferences", token,
		`{"language":"fr"}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "PREFERENCES_INVALID")

	var persisted string
	if err := pool.QueryRow(context.Background(),
		`SELECT language FROM rider_preferences rp
		 JOIN riders r ON r.id = rp.rider_id
		 JOIN users u ON u.id = r.owner_user_id
		 WHERE u.phone = $1`, phone).Scan(&persisted); err != nil {
		t.Fatalf("select persisted preference: %v", err)
	}
	if persisted != "ar" {
		t.Fatalf("persisted language = %q, want ar", persisted)
	}
}

// TestRiderGoalRoundtrip: GET reads the lazy zero row, PUT persists
// earningsGoalTZS (the only persisted goal field — see the package comment)
// and a negative goal is 422 GOALS_INVALID.
func TestRiderGoalRoundtrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, riderID, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rgoal"))

	rec := authedGET(t, s.Router(), "/riders/me/goals", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get zero goals status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var goals gen.RiderGoals
	if err := json.NewDecoder(rec.Body).Decode(&goals); err != nil {
		t.Fatalf("decode zero goals: %v", err)
	}
	if goals.EarningsGoalTZS != 0 || goals.HoursGoalPerWeek != 0 {
		t.Fatalf("zero goals = %+v, want all zero", goals)
	}

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/goals", token,
		`{"earningsGoalTZS":250000,"hoursGoalPerWeek":20}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("put goals status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&goals); err != nil {
		t.Fatalf("decode put goals: %v", err)
	}
	if goals.EarningsGoalTZS != 250000 {
		t.Fatalf("put earningsGoalTZS = %d, want 250000", goals.EarningsGoalTZS)
	}

	rec = authedGET(t, s.Router(), "/riders/me/goals", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get goals status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&goals); err != nil {
		t.Fatalf("decode goals after put: %v", err)
	}
	if goals.EarningsGoalTZS != 250000 {
		t.Fatalf("persisted earningsGoalTZS = %d, want 250000", goals.EarningsGoalTZS)
	}
	var stored int64
	if err := pool.QueryRow(context.Background(),
		`SELECT weekly_earnings_tzs FROM rider_goals WHERE rider_id = $1`, riderID).Scan(&stored); err != nil {
		t.Fatalf("select rider goal: %v", err)
	}
	if stored != 250000 {
		t.Fatalf("stored weekly_earnings_tzs = %d, want 250000", stored)
	}

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/goals", token,
		`{"earningsGoalTZS":-1,"hoursGoalPerWeek":0}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "GOALS_INVALID")

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/goals", token,
		`{"earningsGoalTZS":0,"hoursGoalPerWeek":-5}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "GOALS_INVALID")
}

// TestRiderExpenseCreateList: a valid expense lands with 201 and shows up in
// the rider's list; an unknown category, a negative amount and a missing
// incurredAt are 422 EXPENSE_INVALID.
func TestRiderExpenseCreateList(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, _, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rexp"))

	rec := authedRequest(t, s.Router(), http.MethodPost, "/riders/me/expenses", token,
		`{"category":"fuel","amountTZS":25000,"note":"tank","incurredAt":"2026-08-01T08:00:00Z"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create expense status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var expense gen.RiderExpense
	if err := json.NewDecoder(rec.Body).Decode(&expense); err != nil {
		t.Fatalf("decode created expense: %v", err)
	}
	if expense.Id == nil || expense.Category != gen.RiderExpenseCategoryFuel || expense.AmountTZS != 25000 {
		t.Fatalf("created expense = %+v", expense)
	}
	if expense.IncurredAt.IsZero() {
		t.Fatal("created expense missing incurredAt")
	}

	rec = authedGET(t, s.Router(), "/riders/me/expenses", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list expenses status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var expenses []gen.RiderExpense
	if err := json.NewDecoder(rec.Body).Decode(&expenses); err != nil {
		t.Fatalf("decode expense list: %v", err)
	}
	if len(expenses) != 1 || expenses[0].Id == nil || *expenses[0].Id != *expense.Id {
		t.Fatalf("expense list = %+v, want the created expense", expenses)
	}

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/expenses", token,
		`{"category":"food","amountTZS":1000,"incurredAt":"2026-08-01T08:00:00Z"}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "EXPENSE_INVALID")

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/expenses", token,
		`{"category":"fuel","amountTZS":-1,"incurredAt":"2026-08-01T08:00:00Z"}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "EXPENSE_INVALID")

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/expenses", token,
		`{"category":"fuel","amountTZS":1000}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "EXPENSE_INVALID")

	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM rider_expenses`).Scan(&count); err != nil {
		t.Fatalf("count rider_expenses: %v", err)
	}
	if count != 1 {
		t.Fatalf("rider_expenses rows = %d, want 1", count)
	}
}

// TestTrustedContactLimit: the 11th trusted contact is 409
// CONTACT_LIMIT_REACHED and the list stays at 10; an empty phone is 422
// VALIDATION_FAILED.
func TestTrustedContactLimit(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, _, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rcon"))

	for i := 1; i <= 10; i++ {
		rec := authedRequest(t, s.Router(), http.MethodPost, "/riders/me/contacts", token,
			fmt.Sprintf(`{"name":"Contact %d","phone":"+25570000%04d","relationship":"family"}`, i, 1000+i))
		if rec.Code != http.StatusCreated {
			t.Fatalf("create contact %d status = %d, want 201 (%s)", i, rec.Code, rec.Body)
		}
	}

	rec := authedRequest(t, s.Router(), http.MethodPost, "/riders/me/contacts", token,
		`{"name":"Eleventh","phone":"+255700009999"}`)
	riderSelfWantError(t, rec, http.StatusConflict, "CONTACT_LIMIT_REACHED")

	rec = authedGET(t, s.Router(), "/riders/me/contacts", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list contacts status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var contacts []gen.TrustedContact
	if err := json.NewDecoder(rec.Body).Decode(&contacts); err != nil {
		t.Fatalf("decode contact list: %v", err)
	}
	if len(contacts) != 10 {
		t.Fatalf("contact count = %d, want 10", len(contacts))
	}
	for _, c := range contacts {
		if c.Id == nil || c.Name == "" || c.Phone == "" {
			t.Fatalf("incomplete contact %+v", c)
		}
	}

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/contacts", token,
		`{"name":"No Phone"}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
}

// TestRiderSecurityHonestZero: GET /riders/me/security is rider-gated and
// answers the contract body — securityScore 0 with an empty alert list (no
// fraud engine and no PIN/masked-phone surface exist in the contract; see
// the package comment).
func TestRiderSecurityHonestZero(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, _, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rsec"))

	rec := authedGET(t, s.Router(), "/riders/me/security", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("security status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var body struct {
		SecurityScore int             `json:"securityScore"`
		Alerts        json.RawMessage `json:"alerts"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode security body: %v", err)
	}
	if body.SecurityScore != 0 {
		t.Fatalf("securityScore = %d, want 0", body.SecurityScore)
	}
	if string(body.Alerts) != "[]" {
		t.Fatalf("alerts = %s, want []", body.Alerts)
	}
}

// TestDestinationFilterSetClear: PUT saves the filter (validated), a filter
// with neither area nor coordinates is 422 DEST_FILTER_INVALID, and DELETE
// clears it with 204 — idempotently.
func TestDestinationFilterSetClear(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, riderID, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rdf"))

	rec := authedRequest(t, s.Router(), http.MethodPut, "/riders/me/destination-filter", token,
		`{"area":"Kariakoo","lat":-6.8199,"lon":39.2802,"enabled":true,"maxDetourKm":3}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("set filter status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var filter gen.DestinationFilter
	if err := json.NewDecoder(rec.Body).Decode(&filter); err != nil {
		t.Fatalf("decode filter response: %v", err)
	}
	if filter.Area == nil || *filter.Area != "Kariakoo" || !filter.Enabled {
		t.Fatalf("filter response = %+v", filter)
	}
	var areas []byte
	if err := pool.QueryRow(context.Background(),
		`SELECT areas FROM destination_filters WHERE rider_id = $1`, riderID).Scan(&areas); err != nil {
		t.Fatalf("select destination filter: %v", err)
	}
	var stored []gen.DestinationFilter
	if err := json.Unmarshal(areas, &stored); err != nil {
		t.Fatalf("decode stored filter: %v", err)
	}
	if len(stored) != 1 || stored[0].Area == nil || *stored[0].Area != "Kariakoo" {
		t.Fatalf("stored filter = %+v", stored)
	}

	rec = authedRequest(t, s.Router(), http.MethodPut, "/riders/me/destination-filter", token,
		`{"enabled":true}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "DEST_FILTER_INVALID")

	rec = authedRequest(t, s.Router(), http.MethodDelete, "/riders/me/destination-filter", token, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("clear filter status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authedRequest(t, s.Router(), http.MethodDelete, "/riders/me/destination-filter", token, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("second clear status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	var remains int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM destination_filters WHERE rider_id = $1`, riderID).Scan(&remains); err != nil {
		t.Fatalf("count destination filters: %v", err)
	}
	if remains != 0 {
		t.Fatalf("destination filter rows = %d, want 0", remains)
	}
}

// TestSafetyEventCreateRateLimit: valid reports land with 201, the per-rider
// budget is 3 per hour (the 4th is 429 SAFETY_EVENT_RATE_LIMITED), and
// unknown type/source values are 422 SAFETY_EVENT_INVALID.
func TestSafetyEventCreateRateLimit(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, riderID, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rsafe"))

	for i := 1; i <= 3; i++ {
		rec := authedRequest(t, s.Router(), http.MethodPost, "/riders/me/safety-events", token,
			`{"source":"manual","type":"fatigue_detected","lat":-6.8199,"lon":39.2802,"details":{"note":"feeling tired"}}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("report %d status = %d, want 201 (%s)", i, rec.Code, rec.Body)
		}
		var event gen.SafetyEvent
		if err := json.NewDecoder(rec.Body).Decode(&event); err != nil {
			t.Fatalf("decode report %d: %v", i, err)
		}
		if event.Id == nil || event.Type != gen.SafetyEventType("fatigue_detected") || event.Source != gen.SafetyEventSourceManual {
			t.Fatalf("report %d body = %+v", i, event)
		}
		if event.Lat == nil || *event.Lat != -6.8199 || event.Lon == nil || *event.Lon != 39.2802 {
			t.Fatalf("report %d lat/lon = %v/%v, want -6.8199/39.2802", i, event.Lat, event.Lon)
		}
		if event.Details == nil || (*event.Details)["note"] != "feeling tired" {
			t.Fatalf("report %d details = %v", i, event.Details)
		}
	}

	rec := authedRequest(t, s.Router(), http.MethodPost, "/riders/me/safety-events", token,
		`{"source":"manual","type":"crash_detected"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4th report status = %d, want 429 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode 429 body: %v", err)
	}
	if errBody.Code != "SAFETY_EVENT_RATE_LIMITED" {
		t.Fatalf("4th report code = %q, want SAFETY_EVENT_RATE_LIMITED", errBody.Code)
	}

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/safety-events", token,
		`{"source":"manual","type":"moonwalk"}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "SAFETY_EVENT_INVALID")

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/safety-events", token,
		`{"source":"telepathy","type":"crash_detected"}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "SAFETY_EVENT_INVALID")

	rec = authedRequest(t, s.Router(), http.MethodPost, "/riders/me/safety-events", token,
		`{"source":"manual","type":"crash_detected","lat":95,"lon":0}`)
	riderSelfWantError(t, rec, http.StatusUnprocessableEntity, "LOCATION_INVALID")

	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM safety_events WHERE rider_id = $1`, riderID).Scan(&count); err != nil {
		t.Fatalf("count safety events: %v", err)
	}
	if count != 3 {
		t.Fatalf("safety_events rows = %d, want 3", count)
	}
}

// TestRiderExpensesPagination: the documented limit/offset extension pages
// through 25 expenses in 20 + 5.
func TestRiderExpensesPagination(t *testing.T) {
	s, pool := newPersistentServer(t)
	truncateRiderSelf(t, pool)
	_, riderID, token := seedRiderSelfRiderSession(t, s, pool, uniqueRiderSelfPhone("rpgx"))

	for i := 1; i <= 25; i++ {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO rider_expenses (id, rider_id, category, amount_tzs, created_at)
			 VALUES ($1, $2, 'fuel', $3, now() + ($4 * interval '1 minute'))`,
			uuid.New(), riderID, i*100, i); err != nil {
			t.Fatalf("seed expense %d: %v", i, err)
		}
	}

	rec := authedGET(t, s.Router(), "/riders/me/expenses", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.RiderExpense
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 count = %d, want 20", len(page1))
	}

	rec = authedGET(t, s.Router(), "/riders/me/expenses?offset=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.RiderExpense
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 count = %d, want 5", len(page2))
	}
	seen := map[uuid.UUID]bool{}
	for _, expense := range append(page1, page2...) {
		if expense.Id == nil || seen[uuid.UUID(*expense.Id)] {
			t.Fatalf("duplicate expense %v across pages", expense.Id)
		}
		seen[uuid.UUID(*expense.Id)] = true
	}
}
