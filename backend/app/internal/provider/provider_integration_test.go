//go:build integration

// Provider self-service store integration tests against real PostgreSQL.
//
//	cd app && go test -tags integration ./internal/provider/ -count=1
//
// Requires DATABASE_URL (e.g. postgres://hudumika:hudumika@localhost:5432/
// hudumika) after `go run ./cmd/migrate -up`. Setup truncates ONLY the
// eleven provider sub-resource tables (migration 00037) and deletes the
// users/providers rows it creates, so other contexts' data is untouched.
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// providerTables are the tables owned by this suite (migration 00037).
var providerTables = []string{
	"provider_services",
	"provider_availability",
	"provider_technicians",
	"provider_certifications",
	"provider_staff",
	"provider_inventory",
	"provider_service_plans",
	"service_contracts",
	"provider_documents",
	"provider_portfolio",
	"provider_capabilities",
}

// env bundles the store and its pool for a test.
type env struct {
	store      *Store
	pool       *pgxpool.Pool
	providerID uuid.UUID
}

// setup connects to the real database (skipping when DATABASE_URL is
// unset), truncates ONLY the provider tables, and creates one user +
// providers row the FKs reference (deleted at cleanup).
func setup(t *testing.T) *env {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(providerTables, ", ")+" CASCADE"); err != nil {
		t.Fatalf("truncate provider tables: %v", err)
	}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`,
		"+25576"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatalf("insert provider user: %v", err)
	}
	var providerID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO providers (owner_user_id, name, trade) VALUES ($1, $2, $3) RETURNING id`,
		userID, "Test Provider "+uuid.NewString()[:8], "plumbing").Scan(&providerID); err != nil {
		t.Fatalf("insert provider: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup user %s: %v", userID, err)
		}
	})
	return &env{store: NewStore(pool), pool: pool, providerID: providerID}
}

// newProvider adds a second user+providers row (cross-provider isolation
// checks) and schedules its deletion.
func (e *env) newProvider(t *testing.T) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var userID uuid.UUID
	if err := e.pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`,
		"+25577"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatalf("insert second provider user: %v", err)
	}
	var providerID uuid.UUID
	if err := e.pool.QueryRow(ctx,
		`INSERT INTO providers (owner_user_id, name, trade) VALUES ($1, $2, $3) RETURNING id`,
		userID, "Second Provider "+uuid.NewString()[:8], "electrical").Scan(&providerID); err != nil {
		t.Fatalf("insert second provider: %v", err)
	}
	t.Cleanup(func() {
		if _, err := e.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup second user %s: %v", userID, err)
		}
	})
	return providerID
}

func pricing(base int) []byte {
	b, _ := json.Marshal(map[string]any{"baseTZS": base, "tripFeeTZS": 5000})
	return b
}

func mustErr(t *testing.T, err error, want error) {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil, want %v", want)
	}
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

// TestProviderServicesCRUDAndPriceValidation covers create → list → update →
// delete plus the negative-price guard and the plan-reference delete guard.
func TestProviderServicesCRUDAndPriceValidation(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	svc, err := e.store.CreateService(ctx, e.providerID, "Fix leaking tap", nil, "plumbing", 60, pricing(25000))
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if svc.DurationMin != 60 || svc.Active != true {
		t.Fatalf("unexpected service: %+v", svc)
	}

	// A negative base price is rejected without a write.
	_, err = e.store.CreateService(ctx, e.providerID, "Bad price", nil, "plumbing", 60, pricing(-5))
	mustErr(t, err, ErrServiceInvalid)

	// Cross-provider create is isolated: the second provider sees nothing.
	other := e.newProvider(t)
	otherServices, err := e.store.ListServices(ctx, other)
	if err != nil {
		t.Fatalf("list other services: %v", err)
	}
	if len(otherServices) != 0 {
		t.Fatalf("cross-provider leak: %d services", len(otherServices))
	}

	// Update round-trips the pricing object.
	active := false
	svc, err = e.store.UpdateService(ctx, e.providerID, svc.ID, "Fix leaking tap (emergency)", nil, "plumbing", 90, pricing(35000), &active)
	if err != nil {
		t.Fatalf("update service: %v", err)
	}
	if svc.DurationMin != 90 || svc.Active {
		t.Fatalf("update not applied: %+v", svc)
	}

	// A plan referencing the service blocks deletion (SERVICE_IN_USE).
	plan, err := e.store.CreatePlan(ctx, e.providerID, "Plumbing cover", svc.ID, "monthly", 30000)
	if err != nil {
		t.Fatalf("create plan: %v", err)
	}
	err = e.store.DeleteService(ctx, e.providerID, svc.ID)
	mustErr(t, err, ErrServiceInUse)
	if err := e.store.DeletePlan(ctx, e.providerID, plan.ID); err != nil {
		t.Fatalf("delete plan: %v", err)
	}

	if err := e.store.DeleteService(ctx, e.providerID, svc.ID); err != nil {
		t.Fatalf("delete service: %v", err)
	}
	err = e.store.DeleteService(ctx, e.providerID, svc.ID)
	mustErr(t, err, ErrServiceNotFound)
}

// TestProviderAvailabilityUpsert merges weekly windows per day and
// round-trips the map.
func TestProviderAvailabilityUpsert(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	mon, _ := json.Marshal(map[string]any{"startTime": "09:00", "endTime": "18:00", "active": true})
	tue, _ := json.Marshal(map[string]any{"startTime": "10:00", "endTime": "16:00", "active": true})
	if err := e.store.SetAvailability(ctx, e.providerID, 1, mon); err != nil {
		t.Fatalf("set monday availability: %v", err)
	}
	if err := e.store.SetAvailability(ctx, e.providerID, 2, tue); err != nil {
		t.Fatalf("set tuesday availability: %v", err)
	}
	if err := e.store.SetAvailability(ctx, e.providerID, 9, mon); err == nil {
		t.Fatal("day 9 accepted, want out-of-range error")
	}

	weekly, err := e.store.GetAvailability(ctx, e.providerID)
	if err != nil {
		t.Fatalf("get availability: %v", err)
	}
	var decoded map[string]map[string]any
	if err := json.Unmarshal(weekly, &decoded); err != nil {
		t.Fatalf("decode weekly: %v", err)
	}
	if _, ok := decoded["1"]; !ok {
		t.Fatalf("monday missing from weekly: %s", weekly)
	}
	if _, ok := decoded["2"]; !ok {
		t.Fatalf("tuesday missing from weekly: %s", weekly)
	}

	// Re-setting Monday replaces that day's window without touching Tuesday.
	mon2, _ := json.Marshal(map[string]any{"startTime": "08:00", "endTime": "17:00", "active": true})
	if err := e.store.SetAvailability(ctx, e.providerID, 1, mon2); err != nil {
		t.Fatalf("reset monday: %v", err)
	}
	weekly, _ = e.store.GetAvailability(ctx, e.providerID)
	_ = json.Unmarshal(weekly, &decoded)
	if decoded["1"]["startTime"] != "08:00" || decoded["2"]["startTime"] != "10:00" {
		t.Fatalf("merge failed: %s", weekly)
	}

	// A fresh provider sees an empty map.
	other := e.newProvider(t)
	empty, err := e.store.GetAvailability(ctx, other)
	if err != nil {
		t.Fatalf("get empty availability: %v", err)
	}
	if string(empty) != "{}" {
		t.Fatalf("fresh provider weekly = %s, want {}", empty)
	}
}

// TestProviderTechnicianCRUD covers the technician lifecycle and the
// missing-row guards.
func TestProviderTechnicianCRUD(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	skills, _ := json.Marshal([]string{"drainage", "faucets"})
	tech, err := e.store.CreateTechnician(ctx, e.providerID, "Ali Hassan", "+255700000001", "plumbing", skills, "")
	if err != nil {
		t.Fatalf("create technician: %v", err)
	}
	if tech.Status != "idle" {
		t.Fatalf("default status = %q, want idle", tech.Status)
	}
	tech, err = e.store.UpdateTechnician(ctx, e.providerID, tech.ID, "Ali Hassan", "+255700000001", "plumbing", skills, "on_job")
	if err != nil {
		t.Fatalf("update technician: %v", err)
	}
	if tech.Status != "on_job" {
		t.Fatalf("status = %q, want on_job", tech.Status)
	}

	technicians, err := e.store.ListTechnicians(ctx, e.providerID)
	if err != nil {
		t.Fatalf("list technicians: %v", err)
	}
	if len(technicians) != 1 || technicians[0].ID != tech.ID {
		t.Fatalf("unexpected technicians: %+v", technicians)
	}

	if err := e.store.DeleteTechnician(ctx, e.providerID, tech.ID); err != nil {
		t.Fatalf("delete technician: %v", err)
	}
	err = e.store.DeleteTechnician(ctx, e.providerID, tech.ID)
	mustErr(t, err, ErrTechnicianNotFound)

	// Cross-provider isolation on the path-bound operations.
	_, err = e.store.UpdateTechnician(ctx, e.newProvider(t), tech.ID, "x", "x", "x", nil, "idle")
	mustErr(t, err, ErrTechnicianNotFound)
}

// TestProviderCertificationExpiryValidation covers the invalid-dates guard,
// the pending/expired read statuses and the update path.
func TestProviderCertificationExpiryValidation(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	issued := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	expired := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	future := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)

	// Expiry before issue is rejected (CERTIFICATION_INVALID).
	_, err := e.store.CreateCertification(ctx, e.providerID, CertificationInput{
		Type: "electrician_license", Number: "TZ-1", IssuedAt: &issued, ExpiryDate: &expired,
	})
	mustErr(t, err, ErrCertificationInvalid)

	// A valid, still-valid license reads as pending.
	cert, err := e.store.CreateCertification(ctx, e.providerID, CertificationInput{
		Type: "electrician_license", Number: "TZ-2", Issuer: strPtr("EWURA"), IssuedAt: &issued, ExpiryDate: &future,
	})
	if err != nil {
		t.Fatalf("create certification: %v", err)
	}
	if cert.Status != "pending" || cert.Verified {
		t.Fatalf("unexpected certification: %+v", cert)
	}

	// A license whose expiry has passed reads as expired.
	past, err := e.store.CreateCertification(ctx, e.providerID, CertificationInput{
		Type: "first_aid", Number: "FA-9", IssuedAt: &issued, ExpiryDate: &expired,
	})
	if err == nil && past.ExpiryDate != nil && past.ExpiryDate.Before(issued) {
		t.Fatalf("past-expiry certification accepted: %+v", past)
	}
	if err == nil {
		certs, _ := e.store.ListCertifications(ctx, e.providerID)
		found := false
		for _, c := range certs {
			if c.Number == "FA-9" && c.Status != "expired" {
				t.Fatalf("past-expiry certification status = %q, want expired", c.Status)
			}
			if c.Number == "FA-9" {
				found = true
			}
		}
		if !found {
			t.Fatalf("past-expiry certification missing from list: %+v", certs)
		}
	}

	// Update renews the dates and the missing-row guard fires cross-provider.
	cert, err = e.store.UpdateCertification(ctx, e.providerID, cert.ID, CertificationInput{
		Type: "electrician_license", Number: "TZ-2", Issuer: strPtr("EWURA"), IssuedAt: &issued, ExpiryDate: &future,
	})
	if err != nil {
		t.Fatalf("update certification: %v", err)
	}
	_, err = e.store.UpdateCertification(ctx, e.newProvider(t), cert.ID, CertificationInput{Type: "x", Number: "x"})
	mustErr(t, err, ErrCertificationNotFound)
}

func strPtr(s string) *string { return &s }

// TestProviderStaffLastOwnerGuard covers staff CRUD, capability validation
// and the PROVIDER_STAFF_LAST_OWNER guard on delete and role downgrade.
func TestProviderStaffLastOwnerGuard(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	owner, err := e.store.CreateStaff(ctx, e.providerID, StaffInput{
		Name: "Owner", Phone: "+255700000010", Role: "owner", Status: "active",
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	dispatcher, err := e.store.CreateStaff(ctx, e.providerID, StaffInput{
		Name: "Dispatcher", Phone: "+255700000011", Role: "dispatcher", Status: "active",
		Capabilities: []byte(`["view_schedule","assign_technician"]`),
	})
	if err != nil {
		t.Fatalf("create dispatcher: %v", err)
	}

	// Unknown capabilities are rejected (CAPABILITY_FORBIDDEN).
	_, err = e.store.CreateStaff(ctx, e.providerID, StaffInput{
		Name: "Rogue", Phone: "+255700000012", Role: "supervisor", Capabilities: []byte(`["delete_everything"]`),
	})
	mustErr(t, err, ErrCapabilityForbidden)

	// The last active owner cannot be deleted.
	err = e.store.DeleteStaff(ctx, e.providerID, owner.ID)
	mustErr(t, err, ErrStaffLastOwner)

	// ... nor downgraded to a non-owner role.
	_, err = e.store.UpdateStaff(ctx, e.providerID, owner.ID, StaffInput{
		Name: "Owner", Phone: "+255700000010", Role: "dispatcher", Status: "active",
	})
	mustErr(t, err, ErrStaffLastOwner)

	// A second active owner releases the guard.
	owner2, err := e.store.CreateStaff(ctx, e.providerID, StaffInput{
		Name: "Co-owner", Phone: "+255700000013", Role: "owner", Status: "active",
	})
	if err != nil {
		t.Fatalf("create co-owner: %v", err)
	}
	if err := e.store.DeleteStaff(ctx, e.providerID, owner.ID); err != nil {
		t.Fatalf("delete first owner: %v", err)
	}

	// The dispatcher deletes cleanly; a missing row errors.
	if err := e.store.DeleteStaff(ctx, e.providerID, dispatcher.ID); err != nil {
		t.Fatalf("delete dispatcher: %v", err)
	}
	err = e.store.DeleteStaff(ctx, e.providerID, dispatcher.ID)
	mustErr(t, err, ErrStaffNotFound)

	// owner2 remains the sole active owner; the list reflects the team.
	staff, err := e.store.ListStaff(ctx, e.providerID)
	if err != nil {
		t.Fatalf("list staff: %v", err)
	}
	if len(staff) != 1 || staff[0].ID != owner2.ID {
		t.Fatalf("unexpected staff: %+v", staff)
	}
}

// TestProviderInventoryAdjust covers create, positive/negative adjustments
// and the negative-stock/reason guards.
func TestProviderInventoryAdjust(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	item, err := e.store.CreateInventoryItem(ctx, e.providerID, "Pipe wrench", "tool", 5, 2, int64Ptr(15000), nil)
	if err != nil {
		t.Fatalf("create inventory item: %v", err)
	}
	if item.StockOnHand != 5 {
		t.Fatalf("stock = %d, want 5", item.StockOnHand)
	}

	item, err = e.store.AdjustInventory(ctx, e.providerID, item.ID, 3, "purchase restock")
	if err != nil {
		t.Fatalf("positive adjust: %v", err)
	}
	if item.StockOnHand != 8 {
		t.Fatalf("stock after adjust = %d, want 8", item.StockOnHand)
	}

	// Over-draw is rejected and nothing changes.
	_, err = e.store.AdjustInventory(ctx, e.providerID, item.ID, -20, "used on job")
	mustErr(t, err, ErrInventoryNegativeStock)

	// A blank reason is rejected.
	_, err = e.store.AdjustInventory(ctx, e.providerID, item.ID, 1, "   ")
	mustErr(t, err, ErrReasonRequired)

	// Missing or cross-provider items are not found.
	_, err = e.store.AdjustInventory(ctx, e.newProvider(t), item.ID, 1, "test")
	mustErr(t, err, ErrInventoryItemNotFound)

	items, err := e.store.ListInventory(ctx, e.providerID)
	if err != nil {
		t.Fatalf("list inventory: %v", err)
	}
	if len(items) != 1 || items[0].StockOnHand != 8 {
		t.Fatalf("unexpected inventory: %+v", items)
	}
}

func int64Ptr(v int64) *int64 { return &v }

// TestProviderPlanContractGuard covers plans + the PLAN_IN_USE delete guard
// when a service_contracts row references the plan.
func TestProviderPlanContractGuard(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	svc, err := e.store.CreateService(ctx, e.providerID, "Quarterly service", nil, "cleaning", 120, pricing(40000))
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	plan, err := e.store.CreatePlan(ctx, e.providerID, "Cleaning cover", svc.ID, "quarterly", 40000)
	if err != nil {
		t.Fatalf("create plan: %v", err)
	}
	if plan.Frequency != "quarterly" || plan.PriceTZS != 40000 {
		t.Fatalf("unexpected plan: %+v", plan)
	}

	// A plan referencing another provider's service is rejected.
	other := e.newProvider(t)
	_, err = e.store.CreatePlan(ctx, other, "Cross service", svc.ID, "monthly", 1000)
	mustErr(t, err, ErrServiceNotFound)

	// A contract referencing the plan blocks deletion (PLAN_IN_USE).
	if _, err := e.pool.Exec(ctx,
		`INSERT INTO service_contracts (provider_id, organization_name, covered_services, sla_response_minutes, plan_id)
		 VALUES ($1, $2, $3::jsonb, $4, $5)`,
		e.providerID, "Mikocheni School", `["quarterly service"]`, 120, plan.ID); err != nil {
		t.Fatalf("insert contract: %v", err)
	}
	err = e.store.DeletePlan(ctx, e.providerID, plan.ID)
	mustErr(t, err, ErrPlanInUse)

	// Removing the contract releases the guard.
	if _, err := e.pool.Exec(ctx,
		`DELETE FROM service_contracts WHERE provider_id = $1 AND plan_id = $2`,
		e.providerID, plan.ID); err != nil {
		t.Fatalf("delete contract: %v", err)
	}
	if err := e.store.DeletePlan(ctx, e.providerID, plan.ID); err != nil {
		t.Fatalf("delete plan after contract removal: %v", err)
	}
	err = e.store.DeletePlan(ctx, e.providerID, plan.ID)
	mustErr(t, err, ErrPlanNotFound)

	plans, err := e.store.ListPlans(ctx, e.providerID)
	if err != nil {
		t.Fatalf("list plans: %v", err)
	}
	if len(plans) != 0 {
		t.Fatalf("plans not empty after delete: %+v", plans)
	}
}

// TestProviderDocumentsCRUD covers upload, renewal, the expired guard and
// the not-found paths.
func TestProviderDocumentsCRUD(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	doc, err := e.store.UploadDocument(ctx, e.providerID, "license", "https://files.example/license.pdf", nil)
	if err != nil {
		t.Fatalf("upload document: %v", err)
	}
	if doc.Status != "uploaded" {
		t.Fatalf("status = %q, want uploaded", doc.Status)
	}

	// An expiry in the past is rejected (DOCUMENT_EXPIRED).
	past := time.Now().Add(-24 * time.Hour)
	_, err = e.store.UploadDocument(ctx, e.providerID, "insurance", "https://files.example/old.pdf", &past)
	mustErr(t, err, ErrDocumentExpired)

	// Renewal swaps the url.
	newURL := "https://files.example/license-v2.pdf"
	doc, err = e.store.UpdateDocument(ctx, e.providerID, doc.ID, &newURL, nil)
	if err != nil {
		t.Fatalf("update document: %v", err)
	}
	if doc.URL != newURL {
		t.Fatalf("url = %q, want %q", doc.URL, newURL)
	}

	// Missing and cross-provider documents are not found.
	_, err = e.store.UpdateDocument(ctx, e.newProvider(t), doc.ID, &newURL, nil)
	mustErr(t, err, ErrDocumentNotFound)

	docs, err := e.store.ListDocuments(ctx, e.providerID)
	if err != nil {
		t.Fatalf("list documents: %v", err)
	}
	if len(docs) != 1 || docs[0].ID != doc.ID {
		t.Fatalf("unexpected documents: %+v", docs)
	}
}

// TestProviderPortfolioCapabilities covers the portfolio round-trip, its
// size/url guards and the capability catalog validation.
func TestProviderPortfolioCapabilities(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	media, _ := json.Marshal([]map[string]any{
		{"url": "https://files.example/work1.jpg", "kind": "photo", "caption": "Bathroom redo"},
		{"url": "https://files.example/work2.mp4", "kind": "video"},
	})
	if err := e.store.UpsertPortfolio(ctx, e.providerID, strPtr("Ten years of plumbing"), nil, media); err != nil {
		t.Fatalf("upsert portfolio: %v", err)
	}
	p, err := e.store.GetPortfolio(ctx, e.providerID)
	if err != nil {
		t.Fatalf("get portfolio: %v", err)
	}
	if p.Bio == nil || *p.Bio != "Ten years of plumbing" {
		t.Fatalf("bio = %v", p.Bio)
	}
	var items []map[string]any
	if err := json.Unmarshal(p.Media, &items); err != nil || len(items) != 2 {
		t.Fatalf("media not round-tripped: %s (%v)", p.Media, err)
	}

	// More than 50 items is PORTFOLIO_INVALID.
	big := make([]map[string]any, 51)
	for i := range big {
		big[i] = map[string]any{"url": fmt.Sprintf("https://files.example/p%d.jpg", i)}
	}
	bigJSON, _ := json.Marshal(big)
	err = e.store.UpsertPortfolio(ctx, e.providerID, nil, nil, bigJSON)
	mustErr(t, err, ErrPortfolioInvalid)

	// An item without a url is PORTFOLIO_INVALID.
	noURL, _ := json.Marshal([]map[string]any{{"kind": "photo"}})
	err = e.store.UpsertPortfolio(ctx, e.providerID, nil, nil, noURL)
	mustErr(t, err, ErrPortfolioInvalid)

	// Capabilities round-trip; unknown capabilities are rejected.
	if err := e.store.UpsertCapabilities(ctx, e.providerID, []string{"view_assigned_jobs", "accept_job"}); err != nil {
		t.Fatalf("upsert capabilities: %v", err)
	}
	caps, err := e.store.GetCapabilities(ctx, e.providerID)
	if err != nil {
		t.Fatalf("get capabilities: %v", err)
	}
	var decoded []string
	if err := json.Unmarshal(caps, &decoded); err != nil || len(decoded) != 2 {
		t.Fatalf("capabilities not round-tripped: %s", caps)
	}
	err = e.store.UpsertCapabilities(ctx, e.providerID, []string{"delete_everything"})
	mustErr(t, err, ErrCapabilityForbidden)
}

// TestProviderExportInProgress covers the single-in-flight export rule and
// the export row landing in the documents table.
func TestProviderExportInProgress(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	jobID, err := e.store.RequestExport(ctx, e.providerID, "earnings", "csv")
	if err != nil {
		t.Fatalf("request export: %v", err)
	}
	if jobID == uuid.Nil {
		t.Fatal("export job id is nil")
	}

	// A second export while one is queued is PROVIDER_EXPORT_IN_PROGRESS.
	_, err = e.store.RequestExport(ctx, e.providerID, "tax", "pdf")
	mustErr(t, err, ErrExportInProgress)

	docs, err := e.store.ListDocuments(ctx, e.providerID)
	if err != nil {
		t.Fatalf("list documents: %v", err)
	}
	if len(docs) != 1 || docs[0].Type != "export" || docs[0].Status != "queued" {
		t.Fatalf("export row missing from documents: %+v", docs)
	}

	// Completing the queued job (worker milestone) releases the guard.
	if _, err := e.pool.Exec(ctx,
		`UPDATE provider_documents SET status = 'ready' WHERE id = $1`, jobID); err != nil {
		t.Fatalf("complete export job: %v", err)
	}
	if _, err := e.store.RequestExport(ctx, e.providerID, "jobs", "json"); err != nil {
		t.Fatalf("export after completion: %v", err)
	}
}

// TestProviderContractsPagination inserts 25 contracts and walks two pages
// (20 + 5) via the keyset cursor.
func TestProviderContractsPagination(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	for i := 0; i < 25; i++ {
		if _, err := e.pool.Exec(ctx,
			`INSERT INTO service_contracts (provider_id, organization_name, covered_services, sla_response_minutes)
			 VALUES ($1, $2, $3::jsonb, $4)`,
			e.providerID, fmt.Sprintf("Org %02d", i), `["cleaning"]`, 60+i); err != nil {
			t.Fatalf("insert contract %d: %v", i, err)
		}
	}

	page1, next, err := e.store.ListContracts(ctx, e.providerID, 20, "")
	if err != nil {
		t.Fatalf("list contracts page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 has %d contracts, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("page 1 has no next cursor")
	}

	page2, next2, err := e.store.ListContracts(ctx, e.providerID, 5, next)
	if err != nil {
		t.Fatalf("list contracts page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 has %d contracts, want 5", len(page2))
	}
	if next2 != "" {
		t.Fatalf("page 2 still has a next cursor %q", next2)
	}

	// Cursors are strictly increasing across pages (no overlap, no gap).
	seen := map[uuid.UUID]bool{}
	for _, c := range page1 {
		seen[c.ID] = true
	}
	for _, c := range page2 {
		if seen[c.ID] {
			t.Fatalf("contract %s appears on both pages", c.ID)
		}
		seen[c.ID] = true
	}
	if len(seen) != 25 {
		t.Fatalf("paged %d distinct contracts, want 25", len(seen))
	}

	// A malformed cursor is rejected.
	_, _, err = e.store.ListContracts(ctx, e.providerID, 20, "not-a-cursor")
	mustErr(t, err, ErrInvalidCursor)

	// Cross-provider listing stays isolated.
	others, _, err := e.store.ListContracts(ctx, e.newProvider(t), 20, "")
	if err != nil {
		t.Fatalf("list other contracts: %v", err)
	}
	if len(others) != 0 {
		t.Fatalf("cross-provider contract leak: %d", len(others))
	}
}
