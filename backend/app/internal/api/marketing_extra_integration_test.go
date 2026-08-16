//go:build integration

// MARKETING-EXTRA integration tests against real PostgreSQL + Redis.
//
//	cd app && DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika REDIS_URL=redis://localhost:6379/0 \
//	  go test -tags integration ./internal/api/ -run 'VerifyCoupon|PublicCoupon|Experiment|Journey|Segment|HelpArticle' -count=1
//
// This suite owns the three marketing-extra tables (migration 00047) and
// truncates exactly those at setup. Its coupons/coupon_campaigns/help_articles
// rows are inserted with distinctive MKTX9 prefixes and deleted by prefix —
// the promotions suite truncates its own tables elsewhere; shared tables are
// never truncated here.
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

// marketingExtraPhonePrefix identifies every users row this suite inserts.
const marketingExtraPhonePrefix = "+255878"

// marketingExtraCouponPrefix identifies every coupons row this suite inserts
// (coupons.code is globally unique, so the prefix keeps cleanup scoped).
const marketingExtraCouponPrefix = "MKTX9-"

// marketingExtraCampaignTitlePrefix identifies this suite's coupon_campaigns
// rows; marketingExtraHelpTitlePrefix its help_articles rows.
const (
	marketingExtraCampaignTitlePrefix = "MKTX9-CAMP "
	marketingExtraHelpTitlePrefix     = "MKTX9-HELP "
)

// marketingExtraTables are the tables owned by this suite (migration 00047).
var marketingExtraTables = []string{"experiments", "journeys", "segments"}

// marketingExtraSetup wires a persistent server and clears only this suite's
// tables plus its own rows (coupons/campaigns/help_articles by prefix, users
// by phone prefix).
func marketingExtraSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(marketingExtraTables, ", ")); err != nil {
		t.Fatalf("truncate marketing-extra tables: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM coupons WHERE code LIKE '`+marketingExtraCouponPrefix+`%'`); err != nil {
		t.Fatalf("clear suite coupons: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM coupon_campaigns WHERE title LIKE '`+marketingExtraCampaignTitlePrefix+`%'`); err != nil {
		t.Fatalf("clear suite campaigns: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM help_articles WHERE title LIKE '`+marketingExtraHelpTitlePrefix+`%'`); err != nil {
		t.Fatalf("clear suite help articles: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+marketingExtraPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear marketing-extra users: %v", err)
	}
	return s, pool
}

// marketingExtraUser inserts a users row with a per-run unique phone and
// returns the id and the phone (the session subject).
func marketingExtraUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", marketingExtraPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(t.Context(), `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert marketing-extra user: %v", err)
	}
	return userID, phone
}

// marketingExtraErr decodes an error envelope and asserts its code.
func marketingExtraErr(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return errBody
}

// TestMarketingExtraVerifyCoupon covers the coupon verification gates:
// valid -> 200 with the discount, used -> 409 COUPON_ALREADY_USED, expired
// -> 409 COUPON_EXPIRED, unknown -> 404 VOUCHER_INVALID_CODE, and the
// minimum-spend gate -> 409 COUPON_MINIMUM_SPEND_NOT_MET.
func TestMarketingExtraVerifyCoupon(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	merchantID, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	openID := uuid.New()
	spendyID := uuid.New()
	for _, camp := range []struct {
		id       uuid.UUID
		minSpend int64
	}{
		{openID, 0},
		{spendyID, 10000},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO coupon_campaigns (id, merchant_id, title, discount_tzs, minimum_spend_tzs, quantity, valid_until, status)
			 VALUES ($1, $2, $3, 2000, $4, 100, $5, 'live')`,
			camp.id, merchantID, marketingExtraCampaignTitlePrefix+camp.id.String()[:8], camp.minSpend,
			time.Now().Add(30*24*time.Hour)); err != nil {
			t.Fatalf("seed campaign %s: %v", camp.id, err)
		}
	}
	seedCoupon := func(code string, campaignID uuid.UUID, status string, expiresAt time.Time) {
		t.Helper()
		// One coupon per (campaign, customer): the unique index
		// idx_coupons_campaign_customer forbids two coupons on the same
		// campaign for one customer, so each seed gets its own customer.
		customerID, _ := marketingExtraUser(t, pool)
		if _, err := pool.Exec(ctx,
			`INSERT INTO coupons (campaign_id, code, customer_user_id, status, claimed_at, used_at, expires_at)
			 VALUES ($1, $2, $3, $4, now(), CASE WHEN $4 = 'used' THEN now() END, $5)`,
			campaignID, code, customerID, status, expiresAt); err != nil {
			t.Fatalf("seed coupon %s: %v", code, err)
		}
	}
	seedCoupon(marketingExtraCouponPrefix+"VALID", openID, "claimed", time.Now().Add(10*24*time.Hour))
	seedCoupon(marketingExtraCouponPrefix+"USED", openID, "used", time.Now().Add(10*24*time.Hour))
	seedCoupon(marketingExtraCouponPrefix+"EXPIRED", openID, "expired", time.Now().Add(-24*time.Hour))
	seedCoupon(marketingExtraCouponPrefix+"PASTEXP", openID, "claimed", time.Now().Add(-24*time.Hour))
	seedCoupon(marketingExtraCouponPrefix+"SPENDY", spendyID, "claimed", time.Now().Add(10*24*time.Hour))

	// Valid coupon: 200 with the campaign discount denormalized.
	rec := authedDo(t, h, http.MethodPost, "/marketing/coupons/verify",
		`{"code":"`+marketingExtraCouponPrefix+`VALID","amountTZS":5000}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify valid coupon = %d (%s)", rec.Code, rec.Body)
	}
	var coupon gen.Coupon
	if err := json.NewDecoder(rec.Body).Decode(&coupon); err != nil {
		t.Fatalf("decode verified coupon: %v", err)
	}
	if coupon.Status != gen.CouponStatusClaimed || coupon.DiscountTZS == nil || *coupon.DiscountTZS != 2000 {
		t.Fatalf("unexpected verified coupon: %+v", coupon)
	}
	if coupon.Title == nil || !strings.HasPrefix(*coupon.Title, marketingExtraCampaignTitlePrefix) {
		t.Fatalf("campaign title not denormalized: %+v", coupon)
	}

	// Already used -> 409 COUPON_ALREADY_USED.
	rec = authedDo(t, h, http.MethodPost, "/marketing/coupons/verify",
		`{"code":"`+marketingExtraCouponPrefix+`USED"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("verify used coupon = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingExtraErr(t, rec); errBody.Code != "COUPON_ALREADY_USED" {
		t.Fatalf("error code = %q, want COUPON_ALREADY_USED", errBody.Code)
	}

	// Expired -> 409 COUPON_EXPIRED, both via status and via past expires_at.
	for _, code := range []string{marketingExtraCouponPrefix + "EXPIRED", marketingExtraCouponPrefix + "PASTEXP"} {
		rec = authedDo(t, h, http.MethodPost, "/marketing/coupons/verify",
			`{"code":"`+code+`"}`, token)
		if rec.Code != http.StatusConflict {
			t.Fatalf("verify expired coupon %s = %d, want 409 (%s)", code, rec.Code, rec.Body)
		}
		if errBody := marketingExtraErr(t, rec); errBody.Code != "COUPON_EXPIRED" {
			t.Fatalf("error code = %q, want COUPON_EXPIRED", errBody.Code)
		}
	}

	// Unknown code -> 404 VOUCHER_INVALID_CODE (no COUPON_INVALID_CODE in
	// the catalog; see marketing_extra.go header).
	rec = authedDo(t, h, http.MethodPost, "/marketing/coupons/verify",
		`{"code":"`+marketingExtraCouponPrefix+`NOPE"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("verify unknown coupon = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingExtraErr(t, rec); errBody.Code != "VOUCHER_INVALID_CODE" {
		t.Fatalf("error code = %q, want VOUCHER_INVALID_CODE", errBody.Code)
	}

	// Minimum-spend gate: below -> 409 COUPON_MINIMUM_SPEND_NOT_MET, at or
	// above -> 200.
	rec = authedDo(t, h, http.MethodPost, "/marketing/coupons/verify",
		`{"code":"`+marketingExtraCouponPrefix+`SPENDY","amountTZS":5000}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("verify below min spend = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingExtraErr(t, rec); errBody.Code != "COUPON_MINIMUM_SPEND_NOT_MET" {
		t.Fatalf("error code = %q, want COUPON_MINIMUM_SPEND_NOT_MET", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/marketing/coupons/verify",
		`{"code":"`+marketingExtraCouponPrefix+`SPENDY","amountTZS":10000}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify at min spend = %d, want 200 (%s)", rec.Code, rec.Body)
	}
}

// TestMarketingExtraPublicCouponCampaigns: the /coupon-campaigns feed shows
// only live campaigns still within their window.
func TestMarketingExtraPublicCouponCampaigns(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	merchantID, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	for _, camp := range []struct {
		title  string
		status string
		until  time.Time
	}{
		{marketingExtraCampaignTitlePrefix + "LIVE", "live", time.Now().Add(30 * 24 * time.Hour)},
		{marketingExtraCampaignTitlePrefix + "PAST", "live", time.Now().Add(-24 * time.Hour)},
		{marketingExtraCampaignTitlePrefix + "DRAFT", "draft", time.Now().Add(30 * 24 * time.Hour)},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO coupon_campaigns (merchant_id, title, discount_tzs, minimum_spend_tzs, quantity, valid_until, status)
			 VALUES ($1, $2, 1500, 0, 50, $3, $4)`,
			merchantID, camp.title, camp.until, camp.status); err != nil {
			t.Fatalf("seed campaign %s: %v", camp.title, err)
		}
	}

	rec := authedGET(t, h, "/coupon-campaigns", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list public campaigns = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.CouponCampaign
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode public campaigns: %v", err)
	}
	// Other suites share the coupon_campaigns table (they truncate their own
	// rows in their own processes), so scope the assertions to this suite's
	// prefix.
	var mine []gen.CouponCampaign
	for _, camp := range list {
		if strings.HasPrefix(camp.Title, marketingExtraCampaignTitlePrefix) {
			mine = append(mine, camp)
		}
	}
	if len(mine) != 1 || !strings.HasPrefix(mine[0].Title, marketingExtraCampaignTitlePrefix+"LIVE") {
		t.Fatalf("public campaigns = %+v, want only the live in-window campaign", mine)
	}
	if mine[0].DiscountTZS != 1500 || mine[0].MinimumSpendTZS != 0 {
		t.Fatalf("campaign terms not round-tripped: %+v", mine[0])
	}
}

// TestMarketingExtraExperiments: only active experiments are exposed, with
// the contract key/variant/rollout shape.
func TestMarketingExtraExperiments(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	_, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	for _, exp := range []struct {
		name    string
		variant string
		rollout float64
		active  bool
	}{
		{"checkout.v2", "control", 0.5, true},
		{"home.feed", "b", 0.25, true},
		{"payments.new", "off", 0, false},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO experiments (name, variant, rollout, active) VALUES ($1, $2, $3, $4)`,
			exp.name, exp.variant, exp.rollout, exp.active); err != nil {
			t.Fatalf("seed experiment %s: %v", exp.name, err)
		}
	}

	rec := authedGET(t, h, "/experiments", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list experiments = %d (%s)", rec.Code, rec.Body)
	}
	var list []experimentItem
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode experiments: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("experiment count = %d, want 2 (inactive withheld)", len(list))
	}
	seen := map[string]experimentItem{}
	for _, item := range list {
		seen[item.Key] = item
	}
	if seen["checkout.v2"].Variant != "control" || seen["checkout.v2"].Rollout != 0.5 {
		t.Fatalf("checkout.v2 not round-tripped: %+v", seen["checkout.v2"])
	}
	if _, ok := seen["payments.new"]; ok {
		t.Fatalf("inactive experiment exposed: %+v", list)
	}
}

// TestMarketingExtraJourneyLifecycle covers create, list and the trigger and
// steps validations.
func TestMarketingExtraJourneyLifecycle(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	_, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/journeys",
		`{"name":"Winback","trigger":"order.completed","actions":[{"type":"push","delayHours":24,"template":"welcome"}]}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create journey = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.CustomerJourney
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created journey: %v", err)
	}
	if created.Id == nil || created.Trigger != "order.completed" || created.Name != "Winback" {
		t.Fatalf("unexpected created journey: %+v", created)
	}
	if created.Status == nil || *created.Status != gen.CustomerJourneyStatusActive {
		t.Fatalf("created status = %v, want active", created.Status)
	}
	if len(created.Actions) != 1 || created.Actions[0].Type != gen.CustomerJourneyActionsTypePush || created.Actions[0].DelayHours != 24 {
		t.Fatalf("actions not round-tripped: %+v", created.Actions)
	}

	// A paused status stores active=false and lists back as paused.
	rec = authedDo(t, h, http.MethodPost, "/journeys",
		`{"name":"Dormant","trigger":"cart.abandoned","status":"paused","actions":[{"type":"sms","delayHours":1}]}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create paused journey = %d (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/journeys", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list journeys = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.CustomerJourney
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode journey list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("journey count = %d, want 2", len(list))
	}
	if list[0].Status == nil || *list[0].Status != gen.CustomerJourneyStatusPaused {
		t.Fatalf("paused journey listed as %v, want paused", list[0].Status)
	}

	// Empty trigger -> 422 JOURNEY_TRIGGER_INVALID.
	rec = authedDo(t, h, http.MethodPost, "/journeys",
		`{"name":"NoTrigger","trigger":"","actions":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty trigger = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingExtraErr(t, rec); errBody.Code != "JOURNEY_TRIGGER_INVALID" {
		t.Fatalf("error code = %q, want JOURNEY_TRIGGER_INVALID", errBody.Code)
	}

	// Malformed steps -> 422 VALIDATION_FAILED.
	rec = authedDo(t, h, http.MethodPost, "/journeys",
		`{"name":"BadSteps","trigger":"order.completed","actions":[{"type":"carrier-pigeon","delayHours":1}]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad action type = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingExtraErr(t, rec); errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestMarketingExtraSegmentLifecycle covers create, list and the rules
// validation.
func TestMarketingExtraSegmentLifecycle(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	_, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/segments",
		`{"name":"High Value","rules":{"minOrders":5,"minSpendTZS":100000}}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create segment = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.CustomerSegment
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created segment: %v", err)
	}
	if created.Id == nil || created.Name != "High Value" {
		t.Fatalf("unexpected created segment: %+v", created)
	}
	if created.Rules["minOrders"] != float64(5) {
		t.Fatalf("rules not round-tripped: %+v", created.Rules)
	}

	rec = authedGET(t, h, "/segments", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list segments = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.CustomerSegment
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode segment list: %v", err)
	}
	if len(list) != 1 || list[0].Id.String() != created.Id.String() {
		t.Fatalf("segment list = %+v, want the created segment", list)
	}

	// Empty rules -> 422 SEGMENT_RULES_INVALID.
	rec = authedDo(t, h, http.MethodPost, "/segments", `{"name":"Empty","rules":{}}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty rules = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := marketingExtraErr(t, rec); errBody.Code != "SEGMENT_RULES_INVALID" {
		t.Fatalf("error code = %q, want SEGMENT_RULES_INVALID", errBody.Code)
	}
}

// TestMarketingExtraHelpArticles: the help feed shows published articles
// only, most recently updated first.
func TestMarketingExtraHelpArticles(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	_, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	for _, art := range []struct {
		title     string
		category  string
		published bool
		updated   time.Time
	}{
		{marketingExtraHelpTitlePrefix + "Older", "faq", true, time.Now().Add(-time.Hour)},
		{marketingExtraHelpTitlePrefix + "Newer", "faq", true, time.Now()},
		{marketingExtraHelpTitlePrefix + "Draft", "internal", false, time.Now()},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO help_articles (title, body, slug, category, published, updated_at)
			 VALUES ($1, 'how-to', $2, $3, $4, $5)`,
			art.title, "mktx9-"+art.title, art.category, art.published, art.updated); err != nil {
			t.Fatalf("seed help article %s: %v", art.title, err)
		}
	}

	rec := authedGET(t, h, "/help/articles", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list help articles = %d (%s)", rec.Code, rec.Body)
	}
	var list []helpArticleItem
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode help article list: %v", err)
	}
	// Other suites seed their own published articles into the shared
	// help_articles table; scope the assertions to this suite's prefix.
	var mine []helpArticleItem
	for _, art := range list {
		if strings.HasPrefix(art.Title, marketingExtraHelpTitlePrefix) {
			mine = append(mine, art)
		}
	}
	if len(mine) != 2 {
		t.Fatalf("help article count = %d, want 2 (draft withheld)", len(mine))
	}
	if mine[0].Title != marketingExtraHelpTitlePrefix+"Newer" || mine[0].Category != "faq" || mine[0].Body != "how-to" {
		t.Fatalf("unexpected first help article: %+v", mine[0])
	}

	// The q and category filters narrow the feed.
	rec = authedGET(t, h, "/help/articles?category=internal", token)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode filtered help articles: %v", err)
	}
	mine = mine[:0]
	for _, art := range list {
		if strings.HasPrefix(art.Title, marketingExtraHelpTitlePrefix) {
			mine = append(mine, art)
		}
	}
	if len(mine) != 0 {
		t.Fatalf("internal category count = %d, want 0 (draft hidden even when matching)", len(mine))
	}
	rec = authedGET(t, h, "/help/articles?q=Newer", token)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode q-filtered help articles: %v", err)
	}
	mine = mine[:0]
	for _, art := range list {
		if strings.HasPrefix(art.Title, marketingExtraHelpTitlePrefix) {
			mine = append(mine, art)
		}
	}
	if len(mine) != 1 || mine[0].Title != marketingExtraHelpTitlePrefix+"Newer" {
		t.Fatalf("q=Newer count = %d, want 1 (%+v)", len(mine), mine)
	}
}

// TestMarketingExtraSegmentsPagination: the no-pagination list surfaces cap at
// marketingExtraMaxListLimit; 25 seeded rows all come back (20 + 5).
func TestMarketingExtraSegmentsPagination(t *testing.T) {
	s, pool := marketingExtraSetup(t)
	_, phone := marketingExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	ctx := t.Context()

	for i := 0; i < 25; i++ {
		rules := fmt.Sprintf(`{"i":%d}`, i)
		if _, err := pool.Exec(ctx,
			`INSERT INTO segments (name, rules) VALUES ($1, $2)`,
			fmt.Sprintf("Paged Segment %02d", i), rules); err != nil {
			t.Fatalf("seed paged segment %d: %v", i, err)
		}
	}

	rec := authedGET(t, h, "/segments", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list 25 segments = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.CustomerSegment
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode segment list: %v", err)
	}
	if len(list) != 25 {
		t.Fatalf("segment list count = %d, want 25", len(list))
	}
}
