//go:build integration

// Marketing integration tests against real PostgreSQL + Redis.
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika REDIS_URL=redis://localhost:6379/0 \
//	  go test -tags integration ./internal/api/ -run 'Marketing|PlatformEvent|FlashSale|Precision|Dianjin|BrandDisplay|SelfService' -count=1
//
// This suite owns the six marketing tables (migration 00031): it truncates
// exactly those tables at setup and clears its own users (phone prefix
// +255879...) — it never truncates shared tables.
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// marketingPhonePrefix identifies every users row this suite inserts.
const marketingPhonePrefix = "+255879"

// marketingTables are the tables owned by this suite (migration 00031).
var marketingTables = []string{
	"platform_events",
	"flash_sales",
	"precision_campaigns",
	"dianjin_campaigns",
	"brand_display",
	"self_service",
}

// marketingSetup wires a persistent server and truncates only this suite's
// tables plus its own users, in one statement.
func marketingSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(marketingTables, ", ")); err != nil {
		t.Fatalf("truncate marketing tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+marketingPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear marketing users: %v", err)
	}
	return s, pool
}

// marketingMerchant inserts a users row with a per-run unique phone and
// returns the merchant id and the phone (the session subject).
func marketingMerchant(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", marketingPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(t.Context(), `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert marketing merchant user: %v", err)
	}
	return userID, phone
}

// marketingErr decodes an error envelope and asserts its code.
func marketingErr(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return errBody
}

// TestMarketingPlatformEventLifecycle covers list, status filter, enroll and
// the closed-event conflict. Platform events have no create endpoint in the
// contract (only list + enroll), so rows are seeded via SQL.
func TestMarketingPlatformEventLifecycle(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	openID := uuid.New()
	activeID := uuid.New()
	closedID := uuid.New()
	for _, ev := range []struct {
		id     uuid.UUID
		name   string
		status string
	}{
		{openID, "Open Campaign Week", "scheduled"},
		{activeID, "Active Festival", "active"},
		{closedID, "Past Campaign", "closed"},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO platform_events (id, name, starts_at, ends_at, status)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '8 days', $3)`,
			ev.id, ev.name, ev.status); err != nil {
			t.Fatalf("seed platform event %s: %v", ev.name, err)
		}
	}

	rec := authedGET(t, h, "/marketing/platform-events", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list platform events = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.PlatformEvent
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode platform event list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("platform event count = %d, want 3", len(list))
	}
	if list[0].Status != gen.PlatformEventStatusOpen || list[0].Title != "Open Campaign Week" {
		t.Fatalf("unexpected first event: %+v", list[0])
	}
	if list[0].Enrolled == nil || *list[0].Enrolled {
		t.Fatalf("unseeded event enrolled: %+v", list[0])
	}

	// Status filter maps open/enrolling onto scheduled rows.
	rec = authedGET(t, h, "/marketing/platform-events?status=open", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("filtered list = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode filtered list: %v", err)
	}
	if len(list) != 1 || list[0].Id.String() != openID.String() {
		t.Fatalf("open filter = %+v, want only %s", list, openID)
	}
	rec = authedGET(t, h, "/marketing/platform-events?status=bogus", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bogus status = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	// Enroll in the open event: enrolled=true.
	rec = authedDo(t, h, http.MethodPost, "/marketing/platform-events/"+openID.String()+"/enroll", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll open event = %d (%s)", rec.Code, rec.Body)
	}
	var event gen.PlatformEvent
	if err := json.NewDecoder(rec.Body).Decode(&event); err != nil {
		t.Fatalf("decode enrolled event: %v", err)
	}
	if event.Enrolled == nil || !*event.Enrolled {
		t.Fatalf("enrolled event not marked: %+v", event)
	}

	// A closed event refuses enrollment.
	rec = authedDo(t, h, http.MethodPost, "/marketing/platform-events/"+closedID.String()+"/enroll", "", token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("enroll closed event = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "PLATFORM_EVENT_CLOSED" {
		t.Fatalf("error code = %q, want PLATFORM_EVENT_CLOSED", errBody.Code)
	}

	// An unknown event is not found.
	rec = authedDo(t, h, http.MethodPost, "/marketing/platform-events/"+uuid.NewString()+"/enroll", "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("enroll missing event = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "PLATFORM_EVENT_NOT_FOUND" {
		t.Fatalf("error code = %q, want PLATFORM_EVENT_NOT_FOUND", errBody.Code)
	}
}

// TestMarketingPlatformEventsPagination seeds 25 events (20 + 5) and
// verifies the default limit returns all 25 and explicit paging slices them.
func TestMarketingPlatformEventsPagination(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	for i := 0; i < 25; i++ {
		if _, err := pool.Exec(ctx,
			`INSERT INTO platform_events (name, starts_at, ends_at, status)
			 VALUES ($1, now() + ($2::int || ' days')::interval, now() + interval '30 days', 'scheduled')`,
			fmt.Sprintf("Paged Event %02d", i), i); err != nil {
			t.Fatalf("seed paged event %d: %v", i, err)
		}
	}

	rec := authedGET(t, h, "/marketing/platform-events", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list 25 events = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.PlatformEvent
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 25 {
		t.Fatalf("default list count = %d, want 25", len(list))
	}

	rec = authedGET(t, h, "/marketing/platform-events?limit=10&offset=20", token)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode paged list: %v", err)
	}
	if len(list) != 5 {
		t.Fatalf("paged list count = %d, want 5", len(list))
	}
}

// TestMarketingFlashSaleLifecycle covers create, the discount validation,
// update and the not-found path.
func TestMarketingFlashSaleLifecycle(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	itemID := uuid.NewString()

	// price >= original_price is a broken discount.
	rec := authedDo(t, h, http.MethodPost, "/marketing/flash-sales",
		fmt.Sprintf(`{"title":"Bogus","itemId":%q,"priceTZS":15000,"originalPriceTZS":10000,"quantity":10,"startsAt":"2026-09-01T10:00:00Z","endsAt":"2026-09-08T10:00:00Z"}`, itemID), token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("flat discount = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/flash-sales",
		fmt.Sprintf(`{"title":"Weekend Blitz","itemId":%q,"priceTZS":8000,"originalPriceTZS":10000,"quantity":25,"startsAt":"2026-09-01T10:00:00Z","endsAt":"2026-09-08T10:00:00Z"}`, itemID), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create flash sale = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.FlashSale
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created flash sale: %v", err)
	}
	if created.Id == nil || len(created.ItemIds) != 1 || created.ItemIds[0].String() != itemID {
		t.Fatalf("unexpected created flash sale: %+v", created)
	}
	if created.DiscountBps != 2000 {
		t.Fatalf("discountBps = %d, want 2000", created.DiscountBps)
	}
	if created.QuantityLimit == nil || *created.QuantityLimit != 25 {
		t.Fatalf("quantityLimit not round-tripped: %+v", created)
	}
	if created.Status == nil || *created.Status != gen.FlashSaleStatusScheduled {
		t.Fatalf("status = %v, want scheduled", created.Status)
	}

	// PATCH: flip to active, keep the discount window.
	rec = authedDo(t, h, http.MethodPatch, "/marketing/flash-sales/"+created.Id.String(),
		`{"status":"active","quantity":30}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update flash sale = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.FlashSale
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated flash sale: %v", err)
	}
	if updated.Status == nil || *updated.Status != gen.FlashSaleStatusLive {
		t.Fatalf("updated status = %v, want live", updated.Status)
	}
	if updated.QuantityLimit == nil || *updated.QuantityLimit != 30 {
		t.Fatalf("updated quantity = %+v, want 30", updated.QuantityLimit)
	}
	if updated.DiscountBps != 2000 {
		t.Fatalf("updated discountBps = %d, want 2000 (merge preserved money)", updated.DiscountBps)
	}

	rec = authedGET(t, h, "/marketing/flash-sales", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list flash sales = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.FlashSale
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode flash sale list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("flash sale count = %d, want 1", len(list))
	}

	rec = authedDo(t, h, http.MethodPatch, "/marketing/flash-sales/"+uuid.NewString(),
		`{"status":"active"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update missing flash sale = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "FLASH_SALE_NOT_FOUND" {
		t.Fatalf("error code = %q, want FLASH_SALE_NOT_FOUND", errBody.Code)
	}
}

// TestMarketingPrecisionCampaignLifecycle covers the empty-segment rejection,
// create, list and send with the not-found path.
func TestMarketingPrecisionCampaignLifecycle(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/marketing/precision",
		`{"name":"Q3 Push","segment":{},"budgetTZS":200000}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty segment = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "PRECISION_SEGMENT_EMPTY" {
		t.Fatalf("error code = %q, want PRECISION_SEGMENT_EMPTY", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/precision",
		`{"name":"Q3 Push","segment":{"city":"Dar es Salaam","minOrderTZS":15000},"budgetTZS":200000,"offer":{"type":"discount","value":"10"}}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create precision campaign = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.PrecisionCampaign
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created precision campaign: %v", err)
	}
	if created.Id == nil || created.Name != "Q3 Push" {
		t.Fatalf("unexpected created campaign: %+v", created)
	}
	if created.Offer.Type != gen.PrecisionCampaignOfferTypeDiscount || created.Offer.Value == nil || *created.Offer.Value != "10" {
		t.Fatalf("offer not round-tripped: %+v", created.Offer)
	}
	if created.Status == nil || *created.Status != gen.PrecisionCampaignStatusDraft {
		t.Fatalf("status = %v, want draft", created.Status)
	}

	rec = authedGET(t, h, "/marketing/precision", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list precision campaigns = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.PrecisionCampaign
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode precision list: %v", err)
	}
	if len(list) != 1 || list[0].Id.String() != created.Id.String() {
		t.Fatalf("precision list = %+v, want the created campaign", list)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/precision/"+created.Id.String()+"/send", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("send precision campaign = %d (%s)", rec.Code, rec.Body)
	}
	var sent gen.PrecisionCampaign
	if err := json.NewDecoder(rec.Body).Decode(&sent); err != nil {
		t.Fatalf("decode sent campaign: %v", err)
	}
	if sent.Status == nil || *sent.Status != gen.PrecisionCampaignStatusActive {
		t.Fatalf("sent status = %v, want active", sent.Status)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/precision/"+uuid.NewString()+"/send", "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("send missing campaign = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "PRECISION_CAMPAIGN_NOT_FOUND" {
		t.Fatalf("error code = %q, want PRECISION_CAMPAIGN_NOT_FOUND", errBody.Code)
	}
}

// TestMarketingDianjinLifecycle covers the budget guard, create, list and
// the pause/resume toggle with the not-found path.
func TestMarketingDianjinLifecycle(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/marketing/dianjin",
		`{"name":"PPC","budgetTZS":0}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("zero budget = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "DIANJIN_BUDGET_EXCEEDED" {
		t.Fatalf("error code = %q, want DIANJIN_BUDGET_EXCEEDED", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/dianjin",
		`{"name":"PPC Q3","budgetTZS":500000,"bidBps":150}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create dianjin campaign = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.DianjinCampaign
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created dianjin campaign: %v", err)
	}
	if created.Id == nil || created.Name != "PPC Q3" || created.BudgetTZS != 500000 {
		t.Fatalf("unexpected created campaign: %+v", created)
	}
	if created.Active == nil || *created.Active {
		t.Fatalf("created campaign active: %+v", created)
	}

	// Resume: pause (active=false), then resume (active=true).
	rec = authedDo(t, h, http.MethodPatch, "/marketing/dianjin/"+created.Id.String()+"/toggle",
		`{"active":true}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("resume dianjin campaign = %d (%s)", rec.Code, rec.Body)
	}
	var resumed gen.DianjinCampaign
	if err := json.NewDecoder(rec.Body).Decode(&resumed); err != nil {
		t.Fatalf("decode resumed campaign: %v", err)
	}
	if resumed.Active == nil || !*resumed.Active {
		t.Fatalf("resumed campaign not active: %+v", resumed)
	}

	rec = authedDo(t, h, http.MethodPatch, "/marketing/dianjin/"+created.Id.String()+"/toggle",
		`{"active":false}`, token)
	if err := json.NewDecoder(rec.Body).Decode(&resumed); err != nil {
		t.Fatalf("decode paused campaign: %v", err)
	}
	if resumed.Active == nil || *resumed.Active {
		t.Fatalf("paused campaign still active: %+v", resumed)
	}

	rec = authedGET(t, h, "/marketing/dianjin", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list dianjin campaigns = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.DianjinCampaign
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode dianjin list: %v", err)
	}
	if len(list) != 1 || list[0].Id.String() != created.Id.String() {
		t.Fatalf("dianjin list = %+v, want the created campaign", list)
	}

	rec = authedDo(t, h, http.MethodPatch, "/marketing/dianjin/"+uuid.NewString()+"/toggle",
		`{"active":true}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("toggle missing campaign = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "DIANJIN_CAMPAIGN_NOT_FOUND" {
		t.Fatalf("error code = %q, want DIANJIN_CAMPAIGN_NOT_FOUND", errBody.Code)
	}
}

// TestMarketingBrandDisplayToggleConflict covers the honest default, the
// enable/disable round-trip and the BRAND_DISPLAY_ALREADY_ACTIVE guard.
func TestMarketingBrandDisplayToggleConflict(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/marketing/brand-display", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get brand display = %d (%s)", rec.Code, rec.Body)
	}
	var campaign gen.BrandDisplayCampaign
	if err := json.NewDecoder(rec.Body).Decode(&campaign); err != nil {
		t.Fatalf("decode brand display: %v", err)
	}
	if campaign.Active == nil || *campaign.Active {
		t.Fatalf("unconfigured brand display active: %+v", campaign)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/brand-display",
		`{"active":true,"name":"Brand display","budgetTZS":0,"startsAt":"2026-09-01T10:00:00Z","endsAt":"2026-10-01T10:00:00Z","bannerUrl":"https://cdn.example/banner.png"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("enable brand display = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&campaign); err != nil {
		t.Fatalf("decode enabled brand display: %v", err)
	}
	if campaign.Active == nil || !*campaign.Active {
		t.Fatalf("enabled brand display not active: %+v", campaign)
	}

	// Enabling while already enabled conflicts.
	rec = authedDo(t, h, http.MethodPost, "/marketing/brand-display", `{"active":true}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-enable brand display = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "BRAND_DISPLAY_ALREADY_ACTIVE" {
		t.Fatalf("error code = %q, want BRAND_DISPLAY_ALREADY_ACTIVE", errBody.Code)
	}

	// Disabling is always allowed and sticks.
	rec = authedDo(t, h, http.MethodPost, "/marketing/brand-display", `{"active":false}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable brand display = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&campaign); err != nil {
		t.Fatalf("decode disabled brand display: %v", err)
	}
	if campaign.Active == nil || *campaign.Active {
		t.Fatalf("disabled brand display still active: %+v", campaign)
	}
}

// TestMarketingSelfServiceToggleConflict covers the honest default and the
// SELF_SERVICE_ALREADY_TOGGLED guard for same-value toggles.
func TestMarketingSelfServiceToggleConflict(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phone := marketingMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/marketing/self-service", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get self-service = %d (%s)", rec.Code, rec.Body)
	}
	var promo gen.SelfServicePromotion
	if err := json.NewDecoder(rec.Body).Decode(&promo); err != nil {
		t.Fatalf("decode self-service: %v", err)
	}
	if promo.Active {
		t.Fatalf("unconfigured self-service active: %+v", promo)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/self-service", `{"active":true}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("enable self-service = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&promo); err != nil {
		t.Fatalf("decode enabled self-service: %v", err)
	}
	if !promo.Active {
		t.Fatalf("enabled self-service not active: %+v", promo)
	}

	// Toggling to the same value conflicts.
	rec = authedDo(t, h, http.MethodPost, "/marketing/self-service", `{"active":true}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-enable self-service = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "SELF_SERVICE_ALREADY_TOGGLED" {
		t.Fatalf("error code = %q, want SELF_SERVICE_ALREADY_TOGGLED", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/marketing/self-service", `{"active":false}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable self-service = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&promo); err != nil {
		t.Fatalf("decode disabled self-service: %v", err)
	}
	if promo.Active {
		t.Fatalf("disabled self-service still active: %+v", promo)
	}

	// Toggling false on an already-disabled store conflicts too.
	rec = authedDo(t, h, http.MethodPost, "/marketing/self-service", `{"active":false}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-disable self-service = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingErr(t, rec); errBody.Code != "SELF_SERVICE_ALREADY_TOGGLED" {
		t.Fatalf("error code = %q, want SELF_SERVICE_ALREADY_TOGGLED", errBody.Code)
	}
}

// TestMarketingMerchantIsolation verifies one merchant never sees another
// merchant's campaigns.
func TestMarketingMerchantIsolation(t *testing.T) {
	s, pool := marketingSetup(t)
	_, phoneA := marketingMerchant(t, pool)
	_, phoneB := marketingMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/marketing/dianjin",
		`{"name":"A only","budgetTZS":100000}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create merchant A campaign = %d (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/marketing/dianjin", tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("list merchant B = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.DianjinCampaign
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode merchant B list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("merchant B saw %d campaigns, want 0", len(list))
	}
}
