//go:build integration

// MERCHANT-EXTRA integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'MerchantClaim|MerchantStaff|StoreSetting|MerchantStore|PayoutAccount|ClosureProtection|ListMerchants' -count=1
//
// This suite owns the 00045 tables (merchant_claims, store_settings,
// merchant_payout_accounts, closure_protection): it truncates only those at
// setup and deletes its own users (phone prefix +2559...), whose merchants
// and chain_stores rows cascade away. merchant_staff (00024) is shared with
// the staffops suite, so only the rows this suite's own merchants created
// are cleaned up — never a truncate.
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

	"github.com/hudumika/api-backend/internal/gen"
)

// merchxPhonePrefix identifies every users row this suite inserts.
const merchxPhonePrefix = "+2559"

// merchxTables are the 00045 tables owned by this suite (no FKs between
// them, so one truncate statement suffices).
var merchxTables = []string{"merchant_claims", "store_settings", "merchant_payout_accounts", "closure_protection", "chain_store_settings", "chain_stores"}

// merchxSetup wires a persistent server, truncates only this suite's 00045
// tables and clears leftover users (and their cascaded merchants/chain
// stores plus this suite's own merchant_staff rows) from earlier runs.
func merchxSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(merchxTables, ", ")+" CASCADE"); err != nil {
		t.Fatalf("truncate merch extra tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM merchant_staff WHERE merchant_id IN (
		SELECT m.id FROM merchants m
		JOIN users u ON u.id = m.owner_user_id
		WHERE u.phone LIKE '`+merchxPhonePrefix+`%')`); err != nil {
		t.Fatalf("clear merch extra staff: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+merchxPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear merch extra users: %v", err)
	}
	return s, pool
}

// merchxCity creates a per-run unique city for the suite's merchants and
// cleans it up afterwards.
func merchxCity(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name) VALUES ($1) RETURNING id`,
		"MerchX "+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatalf("insert city: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup city %s: %v", id, err)
		}
	})
	return id
}

// merchxUser inserts a users row with a per-run unique phone.
func merchxUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", merchxPhonePrefix, time.Now().UnixNano()%100_000_000)
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, phone
}

// merchxMerchant inserts a merchant owned by the user with the given
// verification state and returns the merchant id plus a merchant-role token
// for the owner.
func merchxMerchant(t *testing.T, s *Server, pool *pgxpool.Pool, cityID uuid.UUID, verification string) (uuid.UUID, string) {
	t.Helper()
	userID, phone := merchxUser(t, pool)
	return merchxMerchantForUser(t, s, pool, cityID, verification, userID), tokenFor(t, s, phone, RoleMerchant, false)
}

// merchxMerchantForUser inserts a merchant for an existing user id.
func merchxMerchantForUser(t *testing.T, s *Server, pool *pgxpool.Pool, cityID uuid.UUID, verification string, userID uuid.UUID) uuid.UUID {
	t.Helper()
	var merchantID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, city_id, verification)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		userID, "MerchX "+uuid.NewString()[:8], cityID, verification).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	return merchantID
}

// TestListMerchantsPublicApprovedOnly: the public list shows only approved
// merchants, scoped to the city, and works with and without a token; an
// approved-less city answers `[]`.
func TestListMerchantsPublicApprovedOnly(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	approvedID, _ := merchxMerchant(t, s, pool, city, "approved")
	_, _ = merchxMerchant(t, s, pool, city, "pending")
	_, _ = merchxMerchant(t, s, pool, city, "rejected")
	h := s.Router()

	rec := doJSON(t, h, http.MethodGet, "/merchants?cityId="+city.String(), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("public GET /merchants status = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.MerchantPublic
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 || list[0].Id.String() != approvedID.String() {
		t.Fatalf("public list = %+v, want exactly the approved merchant %s", list, approvedID)
	}

	// The same response with an authenticated session.
	customerToken := tokenFor(t, s, "+255900000001", RoleCustomer, false)
	rec = authedGET(t, h, "/merchants?cityId="+city.String(), customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("authed GET /merchants status = %d (%s)", rec.Code, rec.Body)
	}
	list = nil
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 || list[0].Id.String() != approvedID.String() {
		t.Fatalf("authed list = %+v, want exactly the approved merchant", list)
	}

	// A city without approved merchants answers `[]`.
	emptyCity := merchxCity(t, pool)
	rec = doJSON(t, h, http.MethodGet, "/merchants?cityId="+emptyCity.String(), "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty city status = %d body = %q, want 200 []", rec.Code, rec.Body)
	}

	// The contract category filter is accepted but has no column (deviation
	// documented in merchant_extra.go).
	rec = doJSON(t, h, http.MethodGet, "/merchants?cityId="+city.String()+"&category=restaurant", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("category-filtered GET /merchants status = %d (%s)", rec.Code, rec.Body)
	}
}

// TestListMerchantsPagination: keyset pagination returns 20 then the
// remainder for 25 approved merchants in one city, with X-Next-Cursor only
// between pages.
func TestListMerchantsPagination(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	for i := 0; i < 25; i++ {
		userID, _ := merchxUser(t, pool)
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO merchants (owner_user_id, business_name, city_id, verification)
			 VALUES ($1, $2, $3, 'approved')`,
			userID, fmt.Sprintf("Page %02d %s", i, uuid.NewString()[:8]), city); err != nil {
			t.Fatalf("insert merchant %d: %v", i, err)
		}
	}
	h := s.Router()
	_, phone := merchxUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	base := "/merchants?cityId=" + city.String()

	rec := authedGET(t, h, base+"&limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.MerchantPublic
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	next := rec.Header().Get("X-Next-Cursor")
	if next == "" {
		t.Fatal("page 1 missing X-Next-Cursor")
	}

	rec = authedGET(t, h, base+"&limit=20&cursor="+next, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.MerchantPublic
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatalf("page 2 must not carry X-Next-Cursor, got %q", rec.Header().Get("X-Next-Cursor"))
	}

	// A malformed but URL-safe cursor is rejected (422); invalid URL
	// escapes are dropped by the router's query parser before the handler
	// runs, so the cursor must be plain valid-URL garbage.
	rec = authedGET(t, h, base+"&cursor=notbase64!", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}

// TestMerchantClaimFlow: claim → 201, duplicate pending claim → 409
// CLAIM_ALREADY_PENDING, claiming one's own listing → 409
// CLAIM_LISTING_OWNED, missing listing → 404 CLAIM_LISTING_NOT_FOUND.
func TestMerchantClaimFlow(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	merchantID, ownerToken := merchxMerchant(t, s, pool, city, "approved")
	claimerID, claimerPhone := merchxUser(t, pool)
	claimerToken := tokenFor(t, s, claimerPhone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/merchants/claim",
		`{"merchantId":"00000000-0000-4000-8000-0000000000aa","contactPhone":"+255712345678"}`, claimerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("claim missing listing status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "CLAIM_LISTING_NOT_FOUND" {
		t.Fatalf("missing listing code = %q, want CLAIM_LISTING_NOT_FOUND", errBody.Code)
	}

	// Claim a listing owned by someone else.
	rec = authedDo(t, h, http.MethodPost, "/merchants/claim",
		`{"merchantId":"`+merchantID.String()+`","contactPhone":"`+claimerPhone+`","documentsNote":"Business license attached"}`, claimerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("claim status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var lead gen.LeadCreated
	if err := json.NewDecoder(rec.Body).Decode(&lead); err != nil {
		t.Fatalf("decode claim: %v", err)
	}
	if lead.Status != gen.LeadCreatedStatusSubmitted || lead.Id == uuid.Nil {
		t.Fatalf("unexpected claim response: %+v", lead)
	}

	// Duplicate pending claim.
	rec = authedDo(t, h, http.MethodPost, "/merchants/claim",
		`{"merchantId":"`+merchantID.String()+`","contactPhone":"`+claimerPhone+`"}`, claimerToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate claim status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "CLAIM_ALREADY_PENDING" {
		t.Fatalf("duplicate claim code = %q, want CLAIM_ALREADY_PENDING", errBody.Code)
	}

	// The listing owner cannot claim their own listing.
	rec = authedDo(t, h, http.MethodPost, "/merchants/claim",
		`{"merchantId":"`+merchantID.String()+`","contactPhone":"+255712345678"}`, ownerToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("owner claim status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "CLAIM_LISTING_OWNED" {
		t.Fatalf("owner claim code = %q, want CLAIM_LISTING_OWNED", errBody.Code)
	}

	// Missing contactPhone is rejected.
	rec = authedDo(t, h, http.MethodPost, "/merchants/claim",
		`{"merchantId":"`+merchantID.String()+`"}`, claimerToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("claim without phone status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	_ = claimerID
}

// TestMerchantStaffLifecycle: create → 201 with active status, duplicate
// phone per merchant → 409, forbidden roles → 422 STAFF_ROLE_FORBIDDEN,
// list returns the created staff and `[]` for a fresh merchant.
func TestMerchantStaffLifecycle(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	_, token := merchxMerchant(t, s, pool, city, "approved")
	h := s.Router()

	rec := authedGET(t, h, "/merchants/me/staff", token)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty staff list status = %d body = %q, want 200 []", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/merchants/me/staff",
		`{"name":"Zainab","phone":"+255977000001","role":"cashier"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create staff status = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.MerchantStaff
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode staff: %v", err)
	}
	if created.Id == nil || created.Name != "Zainab" || created.Role != gen.MerchantStaffRoleCashier ||
		created.Status == nil || *created.Status != gen.MerchantStaffStatusActive {
		t.Fatalf("unexpected created staff: %+v", created)
	}

	rec = authedDo(t, h, http.MethodPost, "/merchants/me/staff",
		`{"name":"Dup","phone":"+255977000001","role":"manager"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate staff phone status = %d, want 409 (%s)", rec.Code, rec.Body)
	}

	for _, role := range []string{"owner", "waiter", "delivery"} {
		rec = authedDo(t, h, http.MethodPost, "/merchants/me/staff",
			`{"name":"Role","phone":"+255988000001","role":"`+role+`"}`, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("role %s status = %d, want 422 (%s)", role, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "STAFF_ROLE_FORBIDDEN" {
			t.Fatalf("role %s code = %q, want STAFF_ROLE_FORBIDDEN", role, errBody.Code)
		}
	}

	rec = authedDo(t, h, http.MethodPost, "/merchants/me/staff",
		`{"name":"Kitchen","phone":"+255988000002","role":"kitchen"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create kitchen staff status = %d (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/merchants/me/staff", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("staff list status = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.MerchantStaff
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode staff list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("staff list length = %d, want 2 (%+v)", len(list), list)
	}

	// A merchant session that owns no merchant answers 404.
	lonerPhone := "+2559" + "99000001"
	lonerID, _ := merchxUser(t, pool)
	_ = lonerID
	lonerToken := tokenFor(t, s, lonerPhone, RoleMerchant, false)
	rec = authedGET(t, h, "/merchants/me/staff", lonerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("staff list without merchant status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

// TestStoreSettingsRoundtrip: GET returns lazy defaults, PUT upserts and
// round-trips the supported fields, and invalid hours/currency/timezone are
// rejected with HOURS_INVALID / VALIDATION_FAILED.
func TestStoreSettingsRoundtrip(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	_, token := merchxMerchant(t, s, pool, city, "approved")
	h := s.Router()

	rec := authedGET(t, h, "/merchants/me/settings", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("settings get status = %d (%s)", rec.Code, rec.Body)
	}
	var got gen.StoreSettings
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if got.AcceptanceMethod != gen.StoreSettingsAcceptanceMethodManual || len(got.BusinessHours) != 0 {
		t.Fatalf("default settings = %+v", got)
	}

	putBody := `{
		"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"08:00","close":"17:00"}]}],
		"acceptWhileClosed":true,
		"preordersEnabled":true,
		"deliverySettings":{"minimumOrderTZS":5000},
		"currency":"USD",
		"timezone":"Europe/Berlin"
	}`
	rec = authedDo(t, h, http.MethodPut, "/merchants/me/settings", putBody, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("settings put status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode settings response: %v", err)
	}
	if len(got.BusinessHours) != 1 || got.BusinessHours[0].DayOfWeek != 1 ||
		got.BusinessHours[0].Open != "08:00" || got.BusinessHours[0].Close != "17:00" {
		t.Fatalf("round-tripped hours = %+v", got.BusinessHours)
	}
	if got.OrderReceiving == nil || got.OrderReceiving.AcceptWhileClosed == nil || !*got.OrderReceiving.AcceptWhileClosed {
		t.Fatalf("acceptWhileClosed not round-tripped: %+v", got.OrderReceiving)
	}
	if got.DeliverySettings == nil || got.DeliverySettings.MinimumOrderTZS == nil || *got.DeliverySettings.MinimumOrderTZS != 5000 {
		t.Fatalf("minimumOrderTZS not round-tripped: %+v", got.DeliverySettings)
	}

	rec = authedGET(t, h, "/merchants/me/settings", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("settings re-get status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode re-get settings: %v", err)
	}
	if len(got.BusinessHours) != 1 || got.BusinessHours[0].Open != "08:00" || got.BusinessHours[0].Close != "17:00" {
		t.Fatalf("re-get hours = %+v", got.BusinessHours)
	}
	if got.DeliverySettings == nil || got.DeliverySettings.MinimumOrderTZS == nil || *got.DeliverySettings.MinimumOrderTZS != 5000 {
		t.Fatalf("re-get minimumOrderTZS = %+v", got.DeliverySettings)
	}

	// Equal open/close and inverted ranges are HOURS_INVALID.
	for _, body := range []string{
		`{"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"09:00","close":"09:00"}]}]}`,
		`{"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"17:00","close":"08:00"}]}]}`,
		`{"businessHours":[{"businessHours":[{"dayOfWeek":7,"open":"08:00","close":"17:00"}]}]}`,
	} {
		rec = authedDo(t, h, http.MethodPut, "/merchants/me/settings", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("hours body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "HOURS_INVALID" {
			t.Fatalf("hours body %s code = %q, want HOURS_INVALID", body, errBody.Code)
		}
	}

	// Bad currency/timezone/minimum order are VALIDATION_FAILED.
	for _, body := range []string{
		`{"currency":"usd"}`,
		`{"timezone":"Mars/Olympus"}`,
		`{"deliverySettings":{"minimumOrderTZS":-5}}`,
	} {
		rec = authedDo(t, h, http.MethodPut, "/merchants/me/settings", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("validation body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("validation body %s code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}

	// A partial update preserves the previously stored hours.
	rec = authedDo(t, h, http.MethodPut, "/merchants/me/settings", `{"currency":"TZS"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("partial update status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode partial update: %v", err)
	}
	if len(got.BusinessHours) != 1 || got.BusinessHours[0].Open != "08:00" {
		t.Fatalf("partial update dropped hours: %+v", got.BusinessHours)
	}
}

// TestListMyStores: /merchants/me/stores returns exactly the session user's
// chain_stores rows; a user without stores answers `[]`.
func TestListMyStores(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	userID, phone := merchxUser(t, pool)
	merchantID := merchxMerchantForUser(t, s, pool, city, "approved", userID)
	otherID, _ := merchxMerchant(t, s, pool, city, "approved")
	otherUserID, _ := merchxUser(t, pool)
	t.Cleanup(func() {
		// chain_stores reference cities; remove them before the city cleanup.
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM chain_stores WHERE owner_user_id = ANY($1)`,
			[]uuid.UUID{userID, otherUserID})
	})
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	if _, err := pool.Exec(context.Background(),
		`INSERT INTO chain_stores (owner_user_id, merchant_id, name, city_id) VALUES ($1, $2, $3, $4), ($1, $5, $6, $4)`,
		userID, merchantID, "Store One", city, otherID, "Store Two"); err != nil {
		t.Fatalf("insert chain stores: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO chain_stores (owner_user_id, merchant_id, name, city_id) VALUES ($1, $2, $3, $4)`,
		otherUserID, otherID, "Not Mine", city); err != nil {
		t.Fatalf("insert foreign chain store: %v", err)
	}

	rec := authedGET(t, h, "/merchants/me/stores", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("stores list status = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.ChainStore
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode stores: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("stores length = %d, want 2 (%+v)", len(list), list)
	}
	seen := map[string]bool{}
	for _, st := range list {
		seen[st.BusinessName] = true
		if !st.IsOpen {
			t.Fatalf("chain store %s should be open (merchant is_open)", st.BusinessName)
		}
	}
	if !seen["Store One"] || !seen["Store Two"] {
		t.Fatalf("stores = %+v, want Store One and Store Two", list)
	}

	lonerPhone := "+2559" + "99000002"
	lonerID, _ := merchxUser(t, pool)
	_ = lonerID
	lonerToken := tokenFor(t, s, lonerPhone, RoleMerchant, false)
	// The stores surface is merchant-gated: without a merchants row the
	// handler answers the NOT_FOUND gate like GetMyMerchant.
	rec = authedGET(t, h, "/merchants/me/stores", lonerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("loner stores status = %d body = %q, want 404 NOT_FOUND gate", rec.Code, rec.Body)
	}
	_ = phone
}

// TestPayoutAccountLifecycle: get before set → 404 PAYOUT_ACCOUNT_NOT_SET,
// put validates type/number/name, upserts unverified and always responds
// with the masked number.
func TestPayoutAccountLifecycle(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	_, token := merchxMerchant(t, s, pool, city, "approved")
	h := s.Router()

	rec := authedGET(t, h, "/merchants/me/payout-account", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("payout get before set status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "PAYOUT_ACCOUNT_NOT_SET" {
		t.Fatalf("payout get before set code = %q, want PAYOUT_ACCOUNT_NOT_SET", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPut, "/merchants/me/payout-account",
		`{"type":"mobile_money","provider":"mpesa","accountNumber":"255712345678","accountHolderName":"Zainab Ali"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("payout put status = %d (%s)", rec.Code, rec.Body)
	}
	var account gen.PayoutAccount
	if err := json.NewDecoder(rec.Body).Decode(&account); err != nil {
		t.Fatalf("decode payout account: %v", err)
	}
	if account.AccountMasked != "****5678" || account.Verified || account.Type != gen.PayoutAccountTypeMobileMoney {
		t.Fatalf("unexpected payout account: %+v", account)
	}
	if account.AccountHolderName == nil || *account.AccountHolderName != "Zainab Ali" {
		t.Fatalf("accountHolderName = %+v", account.AccountHolderName)
	}

	rec = authedGET(t, h, "/merchants/me/payout-account", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("payout get after set status = %d (%s)", rec.Code, rec.Body)
	}
	account = gen.PayoutAccount{}
	if err := json.NewDecoder(rec.Body).Decode(&account); err != nil {
		t.Fatalf("decode re-get payout account: %v", err)
	}
	if account.AccountMasked != "****5678" || account.Verified {
		t.Fatalf("re-get payout account = %+v, want masked and unverified", account)
	}

	// Unsupported type.
	rec = authedDo(t, h, http.MethodPut, "/merchants/me/payout-account",
		`{"type":"crypto","provider":"btc","accountNumber":"1234567890","accountHolderName":"X"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unsupported type status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED" {
		t.Fatalf("unsupported type code = %q, want PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED", errBody.Code)
	}

	// Bad account numbers and names.
	for _, body := range []string{
		`{"type":"bank","provider":"bank","accountNumber":"1234","accountHolderName":"X"}`,
		`{"type":"bank","provider":"bank","accountNumber":"12ab56","accountHolderName":"X"}`,
		`{"type":"bank","provider":"bank","accountNumber":"12345678901234567890123456789012345","accountHolderName":"X"}`,
		`{"type":"bank","provider":"bank","accountNumber":"1234567890","accountHolderName":""}`,
	} {
		rec = authedDo(t, h, http.MethodPut, "/merchants/me/payout-account", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("payout body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("payout body %s code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}

	// A change re-marks the account unverified.
	rec = authedDo(t, h, http.MethodPut, "/merchants/me/payout-account",
		`{"type":"bank","provider":"bank","accountNumber":"1111222233334444","accountHolderName":"Zainab"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("payout change status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&account); err != nil {
		t.Fatalf("decode changed account: %v", err)
	}
	if account.AccountMasked != "****4444" || account.Type != gen.PayoutAccountTypeBank {
		t.Fatalf("changed account = %+v", account)
	}
}

// TestClosureProtectionQuota: applying protection consumes one annual slot
// (default quota 2); the third application answers 409
// CLOSURE_ANNUAL_QUOTA, cancelling releases the slot and annualQuota is
// validated as 1-12.
func TestClosureProtectionQuota(t *testing.T) {
	s, pool := merchxSetup(t)
	city := merchxCity(t, pool)
	_, token := merchxMerchant(t, s, pool, city, "approved")
	h := s.Router()

	apply := func(body string) int {
		rec := authedDo(t, h, http.MethodPost, "/merchants/me/closure-protection", body, token)
		return rec.Code
	}
	for i := 0; i < 2; i++ {
		if code := apply(`{"active":true,"reason":"renovation"}`); code != http.StatusOK {
			t.Fatalf("apply %d status = %d, want 200", i, code)
		}
	}
	if code := apply(`{"active":true,"reason":"renovation"}`); code != http.StatusConflict {
		t.Fatalf("third apply status = %d, want 409", code)
	}
	if code := apply(`{"active":false,"reason":"reopened early"}`); code != http.StatusOK {
		t.Fatalf("cancel status = %d, want 200", code)
	}
	if code := apply(`{"active":true,"reason":"renovation"}`); code != http.StatusOK {
		t.Fatalf("re-apply after cancel status = %d, want 200", code)
	}
	if code := apply(`{"active":true,"reason":"renovation"}`); code != http.StatusConflict {
		t.Fatalf("second cycle third apply status = %d, want 409", code)
	}

	for _, quota := range []string{"0", "13"} {
		if code := apply(`{"active":false,"annualQuota":` + quota + `}`); code != http.StatusUnprocessableEntity {
			t.Fatalf("annualQuota %s status = %d, want 422", quota, code)
		}
	}
	if code := apply(`{"active":false,"annualQuota":3}`); code != http.StatusOK {
		t.Fatalf("annualQuota 3 status = %d, want 200", code)
	}
	// One slot was already used (cancel lowered 2 -> 1), so quota 3 leaves
	// room for exactly two more applications.
	for i := 0; i < 2; i++ {
		if code := apply(`{"active":true,"reason":"renovation"}`); code != http.StatusOK {
			t.Fatalf("quota 3 apply %d status = %d, want 200", i, code)
		}
	}
	if code := apply(`{"active":true,"reason":"renovation"}`); code != http.StatusConflict {
		t.Fatalf("quota 3 exceeded status = %d, want 409", code)
	}

	// A too-long reason is rejected.
	if code := apply(`{"active":true,"reason":"` + strings.Repeat("x", 501) + `"}`); code != http.StatusUnprocessableEntity {
		t.Fatalf("long reason status = %d, want 422", code)
	}
}
