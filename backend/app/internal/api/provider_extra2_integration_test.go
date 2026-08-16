//go:build integration

// PROVIDER-EXTRA2 handlers against real PostgreSQL + Redis. Run via
// DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/ -run 'DispatchConsole|Trust|Copilot|ProviderContract|ListProviders|ApplyProvider' -count=1
// Every test seeds only its own rows (unique +2559* phones) and deletes
// exactly those rows in cleanup: provider_copilot_log/provider_trust/
// service_contracts/provider_service_plans/provider_services/bookings/
// reviews by provider_id, then the providers rows (the users rows are
// deleted by seedAdminUser's own cleanup; providers cascades on user
// delete). The shared tables are never truncated — the provider package
// truncates its own sub-resource tables in a separate process.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// provx2Provider seeds a provider-role user + providers row and returns the
// provider id and a session token for it. Cleanup deletes every row owned
// by this provider (FK-safe order; provider_copilot_log has no FK so it is
// cleaned explicitly).
func provx2Provider(t *testing.T, pool *pgxpool.Pool, s *Server, suffix, trade, verification string) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := uniqueAdminPhone(t, suffix)
	userID := seedAdminUser(t, pool, phone, "ProvX2 "+phone, "provider", time.Now())
	var providerID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO providers (owner_user_id, name, trade, verification)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		userID, "ProvX2 "+phone, trade, verification).Scan(&providerID); err != nil {
		t.Fatalf("seed provider: %v", err)
	}
	t.Cleanup(func() {
		ids := []uuid.UUID{providerID}
		_, _ = pool.Exec(ctx, `DELETE FROM provider_copilot_log WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM provider_trust WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM service_contracts WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM provider_service_plans WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM provider_services WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM provider_technicians WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM provider_availability WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE provider_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM reviews WHERE target_type = 'provider' AND target_id = ANY($1)`, ids)
		_, _ = pool.Exec(ctx, `DELETE FROM providers WHERE id = ANY($1)`, ids)
	})
	return providerID, tokenFor(t, s, phone, RoleProvider, false)
}

// provx2SeedBooking inserts one booking for the provider with a distinct
// customer user and registers deletion of exactly that booking.
func provx2SeedBooking(t *testing.T, pool *pgxpool.Pool, providerID, customerID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO bookings (customer_user_id, provider_id, status, scheduled_for, duration_minutes, description, subtotal_tzs)
		 VALUES ($1, $2, $3, now() + interval '1 day', 60, 'ProvX2 seeded job', 25000) RETURNING id`,
		customerID, providerID, status).Scan(&id); err != nil {
		t.Fatalf("seed booking %s: %v", status, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE id = $1`, id)
	})
	return id
}

// provx2SeedReview inserts one published provider review.
func provx2SeedReview(t *testing.T, pool *pgxpool.Pool, providerID, authorID uuid.UUID, rating int) {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO reviews (target_type, target_id, author_user_id, rating, body, state)
		 VALUES ('provider', $1, $2, $3, 'ProvX2 seeded review', 'published') RETURNING id`,
		providerID, authorID, rating).Scan(&id); err != nil {
		t.Fatalf("seed review %d: %v", rating, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM reviews WHERE id = $1`, id)
	})
}

// provx2SeedServiceAndPlan seeds one service + one plan for the provider
// (and registers their deletion via the provider-level cleanup).
func provx2SeedServiceAndPlan(t *testing.T, pool *pgxpool.Pool, providerID uuid.UUID, baseTZS int) (serviceID, planID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`INSERT INTO provider_services (provider_id, name, duration_minutes, pricing)
		 VALUES ($1, $2, 60, jsonb_build_object('baseTZS', $3::bigint)) RETURNING id`,
		providerID, "ProvX2 Service "+uuid.NewString()[:6], baseTZS).Scan(&serviceID); err != nil {
		t.Fatalf("seed service: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO provider_service_plans (provider_id, name, service_id, frequency, price_tzs)
		 VALUES ($1, 'ProvX2 Plan', $2, 'monthly', $3) RETURNING id`,
		providerID, serviceID, baseTZS).Scan(&planID); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	return serviceID, planID
}

// TestProviderDispatchConsoleAggregates: the console counts every active
// booking (provider_requested/provider_accepted/scheduled/in_progress),
// returns the latest 10 as job offers, reflects the availability row
// presence, aggregates published reviews honestly and lists the roster.
func TestProviderDispatchConsoleAggregates(t *testing.T) {
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	providerID, token := provx2Provider(t, pool, s, "p2da", "plumbing", "approved")
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "p2dc"), "ProvX2 Customer", "customer", time.Now())

	for i := 0; i < 12; i++ {
		provx2SeedBooking(t, pool, providerID, customerID, "provider_requested")
	}
	provx2SeedBooking(t, pool, providerID, customerID, "in_progress")
	provx2SeedBooking(t, pool, providerID, customerID, "completed") // must NOT count
	provx2SeedReview(t, pool, providerID, customerID, 4)
	// A second author: reviews are unique per (author, target, no order).
	secondAuthor := seedAdminUser(t, pool, uniqueAdminPhone(t, "p2dr"), "ProvX2 Reviewer", "customer", time.Now())
	provx2SeedReview(t, pool, providerID, secondAuthor, 5)
	if _, err := pool.Exec(ctx,
		`INSERT INTO provider_availability (provider_id, weekly) VALUES ($1, '{"1":{"startTime":"09:00"}}'::jsonb)`,
		providerID); err != nil {
		t.Fatalf("seed availability: %v", err)
	}
	var techID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO provider_technicians (provider_id, name, phone, trade, status)
		 VALUES ($1, 'Tec X2', '+255700000099', 'plumbing', 'idle') RETURNING id`,
		providerID).Scan(&techID); err != nil {
		t.Fatalf("seed technician: %v", err)
	}

	rec := authedGET(t, s.Router(), "/providers/me/dispatch", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("dispatch status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view struct {
		UnassignedJobs []struct {
			BookingId string `json:"bookingId"`
			Kind      string `json:"kind"`
		} `json:"unassignedJobs"`
		TechnicianSchedule []struct {
			TechnicianId string `json:"technicianId"`
			Name         string `json:"name"`
			Status       string `json:"status"`
		} `json:"technicianSchedule"`
		ActiveBookingCount int     `json:"activeBookingCount"`
		Available          bool    `json:"available"`
		RatingAverage      float64 `json:"ratingAverage"`
		ReviewCount        int     `json:"reviewCount"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&view); err != nil {
		t.Fatalf("decode dispatch: %v", err)
	}
	if view.ActiveBookingCount != 13 {
		t.Fatalf("activeBookingCount = %d, want 13 (12 requested + 1 in_progress)", view.ActiveBookingCount)
	}
	if len(view.UnassignedJobs) != 10 {
		t.Fatalf("unassignedJobs = %d, want latest 10", len(view.UnassignedJobs))
	}
	for _, j := range view.UnassignedJobs {
		if j.Kind != "offer" {
			t.Fatalf("job offer kind = %q, want offer", j.Kind)
		}
	}
	if !view.Available {
		t.Fatal("available = false, want true (availability row present)")
	}
	if view.RatingAverage != 4.5 {
		t.Fatalf("ratingAverage = %v, want 4.5", view.RatingAverage)
	}
	if view.ReviewCount != 2 {
		t.Fatalf("reviewCount = %d, want 2", view.ReviewCount)
	}
	if len(view.TechnicianSchedule) != 1 {
		t.Fatalf("technicianSchedule = %d rows, want 1", len(view.TechnicianSchedule))
	}
	if view.TechnicianSchedule[0].TechnicianId != techID.String() || view.TechnicianSchedule[0].Status != "idle" {
		t.Fatalf("technician schedule = %+v, want %s idle", view.TechnicianSchedule[0], techID)
	}

	// A fresh provider without reviews or availability reads honest zeros.
	freshID, freshToken := provx2Provider(t, pool, s, "p2df", "cleaning", "approved")
	provx2SeedBooking(t, pool, freshID, customerID, "scheduled")
	rec = authedGET(t, s.Router(), "/providers/me/dispatch", freshToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh dispatch status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&view); err != nil {
		t.Fatalf("decode fresh dispatch: %v", err)
	}
	if view.Available || view.RatingAverage != 0 || view.ReviewCount != 0 {
		t.Fatalf("fresh provider aggregates = available:%v rating:%v count:%d, want zeros",
			view.Available, view.RatingAverage, view.ReviewCount)
	}
}

// TestProviderTrustLazyCreateRoundtrip: the first read lazily creates the
// provider_trust row with zeroed defaults; a later score update round-trips
// onto trustScore/riskScore/tier.
func TestProviderTrustLazyCreateRoundtrip(t *testing.T) {
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	providerID, token := provx2Provider(t, pool, s, "p2ta", "electrical", "approved")

	rec := authedGET(t, s.Router(), "/providers/me/trust", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("trust status = %d (%s)", rec.Code, rec.Body)
	}
	var profile struct {
		TrustScore    int      `json:"trustScore"`
		RiskScore     int      `json:"riskScore"`
		Tier          string   `json:"tier"`
		VerifiedBadge bool     `json:"verifiedBadge"`
		Flags         []string `json:"flags"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&profile); err != nil {
		t.Fatalf("decode trust: %v", err)
	}
	if profile.TrustScore != 0 || profile.RiskScore != 100 || profile.Tier != "bronze" {
		t.Fatalf("fresh trust = %+v, want 0/100/bronze", profile)
	}
	if !profile.VerifiedBadge {
		t.Fatal("verifiedBadge = false, want true for an approved provider")
	}
	if profile.Flags == nil || len(profile.Flags) != 0 {
		t.Fatalf("flags = %v, want empty list", profile.Flags)
	}
	var trustRows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM provider_trust WHERE provider_id = $1`, providerID).Scan(&trustRows); err != nil {
		t.Fatalf("count provider_trust: %v", err)
	}
	if trustRows != 1 {
		t.Fatalf("provider_trust rows = %d, want 1 (lazily created)", trustRows)
	}

	// Score the provider directly (the scoring engine is a later milestone)
	// and confirm the read round-trips it (92.5 rounds half-away-from-zero
	// to 93).
	if _, err := pool.Exec(ctx,
		`UPDATE provider_trust SET score = 92.5, reviews_count = 7, completion_rate = 96.00
		 WHERE provider_id = $1`, providerID); err != nil {
		t.Fatalf("score provider: %v", err)
	}
	rec = authedGET(t, s.Router(), "/providers/me/trust", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("trust roundtrip status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&profile); err != nil {
		t.Fatalf("decode trust roundtrip: %v", err)
	}
	if profile.TrustScore != 93 || profile.RiskScore != 7 || profile.Tier != "platinum" {
		t.Fatalf("scored trust = %+v, want 93/7/platinum", profile)
	}
}

// TestProviderCopilotLogsAndAnswers: suggest_quote answers from the
// provider's own service price range and the exchange lands in
// provider_copilot_log.
func TestProviderCopilotLogsAndAnswers(t *testing.T) {
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	providerID, token := provx2Provider(t, pool, s, "p2ca", "repairs", "approved")
	provx2SeedServiceAndPlan(t, pool, providerID, 20000)
	provx2SeedServiceAndPlan(t, pool, providerID, 40000)

	rec := authedPOSTJSON(t, s.Router(), "/providers/me/copilot", `{"action":"suggest_quote"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("copilot status = %d (%s)", rec.Code, rec.Body)
	}
	var reply struct {
		Action string `json:"action"`
		Result string `json:"result"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&reply); err != nil {
		t.Fatalf("decode copilot: %v", err)
	}
	if reply.Action != "suggest_quote" {
		t.Fatalf("copilot action = %q, want suggest_quote", reply.Action)
	}
	if !strings.Contains(reply.Result, "20000") || !strings.Contains(reply.Result, "40000") {
		t.Fatalf("copilot result = %q, want the provider's 20000-40000 TZS range", reply.Result)
	}

	var logs int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM provider_copilot_log WHERE provider_id = $1`, providerID).Scan(&logs); err != nil {
		t.Fatalf("count copilot log: %v", err)
	}
	if logs != 1 {
		t.Fatalf("copilot log rows = %d, want 1", logs)
	}
	var requestJSON, responseJSON []byte
	if err := pool.QueryRow(ctx,
		`SELECT request, response FROM provider_copilot_log WHERE provider_id = $1`, providerID).
		Scan(&requestJSON, &responseJSON); err != nil {
		t.Fatalf("read copilot log: %v", err)
	}
	if !strings.Contains(string(requestJSON), "suggest_quote") || !strings.Contains(string(responseJSON), "20000") {
		t.Fatalf("copilot log transcript wrong: request=%s response=%s", requestJSON, responseJSON)
	}

	// The honest ML-gated action answers deterministically too.
	rec = authedPOSTJSON(t, s.Router(), "/providers/me/copilot", `{"action":"predict_travel_time"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("predict_travel_time status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&reply); err != nil {
		t.Fatalf("decode travel time: %v", err)
	}
	if !strings.Contains(reply.Result, "not available") {
		t.Fatalf("predict_travel_time result = %q, want the honest model-not-wired answer", reply.Result)
	}
}

// TestProviderContractCreate: a valid plan id creates the contract (201);
// an unknown plan id is 404 PLAN_NOT_FOUND.
func TestProviderContractCreate(t *testing.T) {
	s, pool := newPersistentServer(t)
	providerID, token := provx2Provider(t, pool, s, "p2ca", "cleaning", "approved")
	_, planID := provx2SeedServiceAndPlan(t, pool, providerID, 30000)

	body := fmt.Sprintf(`{"organizationName":"Acme Ltd","coveredServices":["deep_clean"],
		"slaResponseMinutes":45,"planId":%q}`, planID.String())
	rec := authedPOSTJSON(t, s.Router(), "/providers/me/contracts", body, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("contract status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var contract struct {
		Id               string `json:"id"`
		OrganizationName string `json:"organizationName"`
		Status           string `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&contract); err != nil {
		t.Fatalf("decode contract: %v", err)
	}
	if contract.OrganizationName != "Acme Ltd" || contract.Status != "active" || contract.Id == "" {
		t.Fatalf("contract = %+v, want active Acme Ltd with an id", contract)
	}
	var boundPlan uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT plan_id FROM service_contracts WHERE id = $1`, uuid.MustParse(contract.Id)).Scan(&boundPlan); err != nil {
		t.Fatalf("read contract plan_id: %v", err)
	}
	if boundPlan != planID {
		t.Fatalf("plan_id = %s, want %s", boundPlan, planID)
	}

	rec = authedPOSTJSON(t, s.Router(), "/providers/me/contracts",
		fmt.Sprintf(`{"organizationName":"Bogus Ltd","coveredServices":["x"],"slaResponseMinutes":30,"planId":%q}`, uuid.NewString()),
		token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown-plan contract status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PLAN_NOT_FOUND" {
		t.Fatalf("unknown-plan error code = %q, want PLAN_NOT_FOUND", errBody.Code)
	}
}

// TestProviderApplyAndPublicList: POST /providers creates a pending
// application (201, once per account — 409 on a second attempt) and GET
// /providers returns only approved providers.
func TestProviderApplyAndPublicList(t *testing.T) {
	s, pool := newPersistentServer(t)
	approvedID, approvedToken := provx2Provider(t, pool, s, "p2la", "plumbing", "approved")
	pendingID, _ := provx2Provider(t, pool, s, "p2lb", "electrical", "pending")
	// A provider-role user with NO providers row yet is the applicant.
	applyPhone := uniqueAdminPhone(t, "p2lx")
	seedAdminUser(t, pool, applyPhone, "ProvX2 Applicant", "provider", time.Now())
	applyToken := tokenFor(t, s, applyPhone, RoleProvider, false)
	// The application references a real cities row (providers.city_id FK).
	var cityID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name) VALUES ($1) RETURNING id`,
		"ProvX2 City "+applyPhone).Scan(&cityID); err != nil {
		t.Fatalf("seed city: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, cityID)
	})

	// ApplyProvider: the applicant submits (a second provider row with the
	// same owner is refused 409).
	applyBody := fmt.Sprintf(`{"name":"New Fix Co","city":%q,"trade":"repairs","serviceArea":"kimara"}`, cityID.String())
	rec := authedPOSTJSON(t, s.Router(), "/providers", applyBody, applyToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("apply status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var lead struct {
		Id     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&lead); err != nil {
		t.Fatalf("decode apply: %v", err)
	}
	if lead.Status != "submitted" || lead.Id == "" {
		t.Fatalf("lead = %+v, want submitted with an id", lead)
	}
	var verification string
	if err := pool.QueryRow(context.Background(),
		`SELECT verification FROM providers WHERE id = $1`, uuid.MustParse(lead.Id)).Scan(&verification); err != nil {
		t.Fatalf("read applied verification: %v", err)
	}
	if verification != "pending" {
		t.Fatalf("applied verification = %q, want pending", verification)
	}
	rec = authedPOSTJSON(t, s.Router(), "/providers", applyBody, applyToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-apply status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var conflictBody struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&conflictBody); err != nil {
		t.Fatalf("decode conflict: %v", err)
	}
	if conflictBody.Code != "CONFLICT" {
		t.Fatalf("re-apply error code = %q, want CONFLICT", conflictBody.Code)
	}

	// ListProviders: only the approved provider appears; pending ones never
	// leak. Any approved provider seeded by other suites may also appear.
	rec = authedGET(t, s.Router(), "/providers", approvedToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var list []struct {
		Id       string `json:"id"`
		Verified bool   `json:"verified"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	seenApproved := false
	for _, p := range list {
		if p.Id == pendingID.String() || p.Id == lead.Id {
			t.Fatalf("pending provider %s leaked into the public list", p.Id)
		}
		if !p.Verified {
			t.Fatalf("listed provider %s is not marked verified", p.Id)
		}
		if p.Id == approvedID.String() {
			seenApproved = true
		}
	}
	if !seenApproved {
		t.Fatal("approved provider missing from the public list")
	}
}
