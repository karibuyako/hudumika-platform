//go:build integration

// Admin-extra surfaces against real PostgreSQL + Redis (docker compose):
// banners, feature flags, help articles, notification broadcast, group-buy
// moderation, conversation oversight, global search and the data-export
// queue. Run via `make test-integration` after `make migrate`.
//
// Table hygiene: banners, feature_flags and help_articles are owned by this
// milestone alone, so each test truncates exactly those three tables at
// setup. Shared tables (users, roles, orders, conversations, notifications,
// group_buy_deals, data_exports) are never truncated: every test seeds only
// its own rows with a per-run unique phone and deletes exactly those rows
// in cleanup (FK-safe order: conversations and deals before their users,
// orders before users).
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// uniqueAdminExtraPhone builds a per-run unique phone (+2556 prefix for this
// suite) so repeated runs and parallel milestones never collide.
func uniqueAdminExtraPhone(t *testing.T, suffix string) string {
	t.Helper()
	return fmt.Sprintf("+2556%09d-%s", time.Now().UnixNano()%1_000_000_000, suffix)
}

// waitForAdminExtraTables polls to_regclass for the tables this suite reads:
// banners/feature_flags/help_articles arrive with migration 00034,
// data_exports with 00032 (parallel milestone). Up to 240s.
func waitForAdminExtraTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(240 * time.Second)
	for {
		var reg *string
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass('public.banners')::text || ':' ||
				to_regclass('public.feature_flags')::text || ':' ||
				to_regclass('public.help_articles')::text || ':' ||
				coalesce(to_regclass('public.data_exports')::text, 'missing')`).Scan(&reg); err != nil {
			t.Fatalf("admin-extra table poll query: %v", err)
		}
		if reg != nil && !containsMissing(*reg) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("banners/feature_flags/help_articles/data_exports did not appear within 240s (migrations 00032/00034 missing?)")
		}
		time.Sleep(5 * time.Second)
	}
}

func containsMissing(s string) bool {
	return len(s) < 4 || s[len(s)-7:] == ":missing"
}

// resetAdminExtraTables truncates only the three tables owned by this
// milestone (banners, feature_flags, help_articles).
func resetAdminExtraTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE banners, feature_flags, help_articles`); err != nil {
		t.Fatalf("truncate admin-extra tables: %v", err)
	}
}

// seedAdminExtraUser inserts a user with the given role and registers
// cleanup that deletes exactly this user's rows in FK-safe order.
func seedAdminExtraUser(t *testing.T, pool *pgxpool.Pool, phone, fullName, role string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, fullName).Scan(&id); err != nil {
		t.Fatalf("seed user %s: %v", phone, err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO roles (user_id, role) VALUES ($1, $2)`, id, role); err != nil {
		t.Fatalf("seed role %s: %v", phone, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM conversations WHERE customer_user_id = $1 OR merchant_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM group_buy_deals WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE customer_user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM roles WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func adminExtraStaffToken(t *testing.T, s *Server) string {
	t.Helper()
	return tokenFor(t, s, "u-admin-extra-integration", RoleAdmin, true)
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

func TestAdminBannersIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	resetAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	// List starts empty (honest []).
	rec := authedGET(t, h, "/admin/banners", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("banners list status = %d (%s)", rec.Code, rec.Body)
	}
	var banners []gen.AdminBanner
	if err := json.NewDecoder(rec.Body).Decode(&banners); err != nil {
		t.Fatalf("decode banners: %v", err)
	}
	if len(banners) != 0 {
		t.Fatalf("banners list = %+v, want empty", banners)
	}

	// Create with an invalid schedule answers 422 BANNER_SCHEDULE_INVALID.
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/banners",
		`{"title":"Winter Sale","placement":"home_top","scheduledFrom":"2026-02-01T00:00:00Z","scheduledTo":"2026-01-01T00:00:00Z"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("create banner (bad schedule) status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "BANNER_SCHEDULE_INVALID" {
		t.Fatalf("error code = %q, want BANNER_SCHEDULE_INVALID", errBody.Code)
	}

	// Create a valid banner.
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/banners",
		`{"title":"Winter Sale","placement":"home_top","imageUrl":"https://cdn.example/sale.png","active":true}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create banner status = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.AdminBanner
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created banner: %v", err)
	}
	if created.Id == openapi_types.UUID(uuid.Nil) || created.Title != "Winter Sale" || created.Placement != "home_top" {
		t.Fatalf("created banner = %+v", created)
	}

	// Update the banner (PATCH) and verify the new state.
	rec = authedExtraJSON(t, h, http.MethodPatch, "/admin/banners/"+created.Id.String(),
		`{"title":"Winter Sale Extended","active":false}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update banner status = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.AdminBanner
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated banner: %v", err)
	}
	if updated.Title != "Winter Sale Extended" || updated.Active == nil || *updated.Active {
		t.Fatalf("updated banner = %+v", updated)
	}

	// Update of a missing banner answers 404 BANNER_NOT_FOUND.
	rec = authedExtraJSON(t, h, http.MethodPatch, "/admin/banners/00000000-0000-0000-0000-0000000000aa",
		`{"title":"Ghost"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update missing banner status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "BANNER_NOT_FOUND" {
		t.Fatalf("error code = %q, want BANNER_NOT_FOUND", errBody.Code)
	}

	// List shows the updated banner.
	rec = authedGET(t, h, "/admin/banners", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("banners list status = %d (%s)", rec.Code, rec.Body)
	}
	banners = nil
	if err := json.NewDecoder(rec.Body).Decode(&banners); err != nil {
		t.Fatalf("decode banners: %v", err)
	}
	if len(banners) != 1 || banners[0].Id != created.Id {
		t.Fatalf("banners list = %+v, want exactly the created banner", banners)
	}

	// Delete answers 204 and the list is empty again.
	rec = authedExtraJSON(t, h, http.MethodDelete, "/admin/banners/"+created.Id.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete banner status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, h, "/admin/banners", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("banners list status = %d (%s)", rec.Code, rec.Body)
	}
	banners = nil
	if err := json.NewDecoder(rec.Body).Decode(&banners); err != nil {
		t.Fatalf("decode banners: %v", err)
	}
	if len(banners) != 0 {
		t.Fatalf("banners list after delete = %+v, want empty", banners)
	}
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

func TestAdminFeatureFlagsIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	resetAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	// Upsert creates the flag (100% rollout default).
	rec := authedExtraJSON(t, h, http.MethodPatch, "/admin/features",
		`{"key":"checkout.v2","enabled":true}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update feature status = %d (%s)", rec.Code, rec.Body)
	}
	var flag gen.AdminFeatureFlag
	if err := json.NewDecoder(rec.Body).Decode(&flag); err != nil {
		t.Fatalf("decode feature: %v", err)
	}
	if flag.Key != "checkout.v2" || !flag.Enabled || flag.RolloutPct == nil || *flag.RolloutPct != 100 {
		t.Fatalf("created feature = %+v", flag)
	}

	// Upsert again updates in place (rollout 50%).
	rec = authedExtraJSON(t, h, http.MethodPatch, "/admin/features",
		`{"key":"checkout.v2","enabled":false,"rolloutPct":50}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update feature status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&flag); err != nil {
		t.Fatalf("decode feature: %v", err)
	}
	if flag.Enabled || flag.RolloutPct == nil || *flag.RolloutPct != 50 {
		t.Fatalf("updated feature = %+v", flag)
	}

	// A rollout outside 0..100 answers 422 VALIDATION_FAILED.
	rec = authedExtraJSON(t, h, http.MethodPatch, "/admin/features",
		`{"key":"checkout.v2","enabled":true,"rolloutPct":150}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update feature (bad rollout) status = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	// List contains the flag once.
	rec = authedGET(t, h, "/admin/features", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("features list status = %d (%s)", rec.Code, rec.Body)
	}
	var flags []gen.AdminFeatureFlag
	if err := json.NewDecoder(rec.Body).Decode(&flags); err != nil {
		t.Fatalf("decode features: %v", err)
	}
	found := 0
	for _, f := range flags {
		if f.Key == "checkout.v2" {
			found++
		}
	}
	if found != 1 {
		t.Fatalf("feature checkout.v2 found %d times, want 1 (%+v)", found, flags)
	}
}

// ---------------------------------------------------------------------------
// Help articles
// ---------------------------------------------------------------------------

func TestAdminHelpArticlesIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	resetAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	// Create answers the contract {id,title,category} shape.
	rec := authedExtraJSON(t, h, http.MethodPost, "/admin/help/articles",
		`{"title":"How to Track an Order","category":"orders","body":"Open the app and tap Track.","published":true}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create help article status = %d (%s)", rec.Code, rec.Body)
	}
	var created struct {
		Id       openapi_types.UUID `json:"id"`
		Title    string             `json:"title"`
		Category string             `json:"category"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created article: %v", err)
	}
	if created.Id == openapi_types.UUID(uuid.Nil) || created.Title != "How to Track an Order" || created.Category != "orders" {
		t.Fatalf("created article = %+v", created)
	}

	// A second article with the same slug (same title) answers 409
	// HELP_ARTICLE_SLUG_EXISTS.
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/help/articles",
		`{"title":"How to Track an Order","category":"orders","body":"Different body."}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate slug status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "HELP_ARTICLE_SLUG_EXISTS" {
		t.Fatalf("error code = %q, want HELP_ARTICLE_SLUG_EXISTS", errBody.Code)
	}

	// Update (PUT) changes title/category.
	rec = authedExtraJSON(t, h, http.MethodPut, "/admin/help/articles",
		`{"id":"`+created.Id.String()+`","title":"How to Track Any Order","category":"support"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update help article status = %d (%s)", rec.Code, rec.Body)
	}
	var updated struct {
		Id       openapi_types.UUID `json:"id"`
		Title    string             `json:"title"`
		Category string             `json:"category"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated article: %v", err)
	}
	if updated.Title != "How to Track Any Order" || updated.Category != "support" {
		t.Fatalf("updated article = %+v", updated)
	}

	// Updating a missing article answers 404 TEMPLATE_NOT_FOUND.
	rec = authedExtraJSON(t, h, http.MethodPut, "/admin/help/articles",
		`{"id":"00000000-0000-0000-0000-0000000000bb","title":"Ghost"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update missing article status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "TEMPLATE_NOT_FOUND" {
		t.Fatalf("error code = %q, want TEMPLATE_NOT_FOUND", errBody.Code)
	}
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

func TestAdminBroadcastIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	base := uniqueAdminExtraPhone(t, "bc")
	customerIDs := make([]uuid.UUID, 0, 3)
	for i := 0; i < 3; i++ {
		customerIDs = append(customerIDs, seedAdminExtraUser(t, pool, fmt.Sprintf("%s-c%d", base, i), "Broadcast Customer", "customer"))
	}
	seedAdminExtraUser(t, pool, base+"-m", "Broadcast Merchant", "merchant")

	title := "Flash Sale " + base
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM notifications WHERE title = $1`, title)
	})
	rec := authedExtraJSON(t, h, http.MethodPost, "/admin/notifications/send",
		`{"title":"`+title+`","body":"50% off everything today","audience":{"roles":["customer"]},"deepLink":"/promotions"}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("broadcast status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var ack struct {
		CampaignId          openapi_types.UUID `json:"campaignId"`
		EstimatedRecipients int                `json:"estimatedRecipients"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&ack); err != nil {
		t.Fatalf("decode broadcast ack: %v", err)
	}
	if ack.CampaignId == openapi_types.UUID(uuid.Nil) {
		t.Fatal("broadcast campaignId is nil")
	}
	// Other milestones may seed customer rows too (the roles filter is
	// global), so the estimate must cover at least our three and never
	// exceed the cap.
	if ack.EstimatedRecipients < len(customerIDs) || ack.EstimatedRecipients > 1000 {
		t.Fatalf("estimatedRecipients = %d, want in [%d, 1000]", ack.EstimatedRecipients, len(customerIDs))
	}

	// Exactly one notifications row per seeded customer carries the title.
	var delivered int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM notifications WHERE title = $1 AND type = 'broadcast' AND user_id = ANY($2::uuid[])`,
		title, customerIDs).Scan(&delivered); err != nil {
		t.Fatalf("count broadcast notifications: %v", err)
	}
	if delivered != len(customerIDs) {
		t.Fatalf("broadcast notifications = %d, want %d", delivered, len(customerIDs))
	}

	// An audience matching nobody answers 422 BROADCAST_AUDIENCE_EMPTY. The
	// provider role is seeded by no milestone test by convention; if another
	// milestone left provider rows, skip rather than flake.
	var providerCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM roles WHERE role = 'provider' AND active`).Scan(&providerCount); err != nil {
		t.Fatalf("count provider roles: %v", err)
	}
	if providerCount > 0 {
		t.Skipf("provider-role users exist (%d); cannot assert an empty audience", providerCount)
	}
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/notifications/send",
		`{"title":"Nobody Sees This","body":"...","audience":{"roles":["provider"]}}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty-audience broadcast status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "BROADCAST_AUDIENCE_EMPTY" {
		t.Fatalf("error code = %q, want BROADCAST_AUDIENCE_EMPTY", errBody.Code)
	}
}

// ---------------------------------------------------------------------------
// Group buy moderation
// ---------------------------------------------------------------------------

func TestAdminGroupBuysIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	base := uniqueAdminExtraPhone(t, "gb")
	merchantID := seedAdminExtraUser(t, pool, base, "Deal Merchant "+base, "merchant")

	// Seed a pending (draft) deal directly.
	var dealID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO group_buy_deals (merchant_id, title, description, original_price_tzs, deal_price_tzs,
			quantity_total, start_at, end_at, status)
		 VALUES ($1, $2, 'admin moderation seed', 20000, 15000, 50,
			now() - interval '1 hour', now() + interval '7 days', 'draft') RETURNING id`,
		merchantID, "Moderated Deal "+base).Scan(&dealID); err != nil {
		t.Fatalf("seed group buy deal: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM group_buy_deals WHERE id = $1`, dealID)
	})

	// The state filter surfaces the draft deal.
	rec := authedGET(t, h, "/admin/group-buys?state=draft", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("group buys list status = %d (%s)", rec.Code, rec.Body)
	}
	var deals []gen.GroupBuyDeal
	if err := json.NewDecoder(rec.Body).Decode(&deals); err != nil {
		t.Fatalf("decode group buys: %v", err)
	}
	found := false
	for _, d := range deals {
		if d.Id != nil && *d.Id == openapi_types.UUID(dealID) {
			found = true
			if d.Status != gen.GroupBuyStatusDraft {
				t.Fatalf("seeded deal status = %q, want draft", d.Status)
			}
		}
	}
	if !found {
		t.Fatalf("seeded draft deal %s missing from ?state=draft list", dealID)
	}

	// Approve promotes the draft to live (active).
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/group-buys/"+dealID.String()+"/decision",
		`{"decision":"approved","reason":"looks good"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("approve decision status = %d (%s)", rec.Code, rec.Body)
	}
	var decided gen.GroupBuyDeal
	if err := json.NewDecoder(rec.Body).Decode(&decided); err != nil {
		t.Fatalf("decode decision: %v", err)
	}
	if decided.Status != gen.GroupBuyStatusLive {
		t.Fatalf("approved deal status = %q, want live", decided.Status)
	}

	// Re-approving an already live deal is an idempotent 200.
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/group-buys/"+dealID.String()+"/decision",
		`{"decision":"approved"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-approve status = %d, want 200 (%s)", rec.Code, rec.Body)
	}

	// Delist pauses the live deal.
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/group-buys/"+dealID.String()+"/decision",
		`{"decision":"delisted","reason":"complaint"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("delist decision status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&decided); err != nil {
		t.Fatalf("decode decision: %v", err)
	}
	if decided.Status != gen.GroupBuyStatusDelisted {
		t.Fatalf("delisted deal status = %q, want delisted", decided.Status)
	}

	// Rejecting a delisted deal is a state conflict (409).
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/group-buys/"+dealID.String()+"/decision",
		`{"decision":"rejected"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("reject-after-delist status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "GROUP_BUY_STATUS_CONFLICT" {
		t.Fatalf("error code = %q, want GROUP_BUY_STATUS_CONFLICT", errBody.Code)
	}

	// A missing deal answers 404 GROUP_BUY_NOT_FOUND.
	rec = authedExtraJSON(t, h, http.MethodPost, "/admin/group-buys/00000000-0000-0000-0000-0000000000cc/decision",
		`{"decision":"approved"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("decision on missing deal status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "GROUP_BUY_NOT_FOUND" {
		t.Fatalf("error code = %q, want GROUP_BUY_NOT_FOUND", errBody.Code)
	}
}

// ---------------------------------------------------------------------------
// Conversation oversight
// ---------------------------------------------------------------------------

func TestAdminConversationsOversightIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	base := uniqueAdminExtraPhone(t, "conv")
	customerID := seedAdminExtraUser(t, pool, base, "Conversation Customer "+base, "customer")
	merchantID := seedAdminExtraUser(t, pool, base+"-m", "Conversation Merchant "+base, "merchant")

	var convID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO conversations (customer_user_id, merchant_id, subject, status, unread_customer, unread_merchant, last_message_at)
		 VALUES ($1, $2, 'Order problem', 'open', 1, 2, now()) RETURNING id`,
		customerID, merchantID).Scan(&convID); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM conversations WHERE id = $1`, convID)
	})
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO conversation_messages (conversation_id, author_user_id, author_role, body)
		 VALUES ($1, $2, 'customer', 'My order never arrived')`, convID, customerID); err != nil {
		t.Fatalf("seed conversation message: %v", err)
	}

	rec := authedGET(t, h, "/admin/conversations?merchantId="+merchantID.String(), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("conversations oversight status = %d (%s)", rec.Code, rec.Body)
	}
	var convs []gen.ConversationDetail
	if err := json.NewDecoder(rec.Body).Decode(&convs); err != nil {
		t.Fatalf("decode conversations: %v", err)
	}
	var found *gen.ConversationDetail
	for i := range convs {
		if convs[i].Id == openapi_types.UUID(convID) {
			found = &convs[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded conversation %s missing from oversight list", convID)
	}
	if found.Status != gen.ConversationStatus("open") {
		t.Fatalf("conversation status = %q, want open", found.Status)
	}
	if found.UnreadCount != 3 {
		t.Fatalf("conversation unreadCount = %d, want 3 (customer 1 + merchant 2)", found.UnreadCount)
	}
	if found.LastMessagePreview != "My order never arrived" {
		t.Fatalf("lastMessagePreview = %q", found.LastMessagePreview)
	}
	if len(found.Participants) != 2 {
		t.Fatalf("participants = %+v, want both sides", found.Participants)
	}
	if found.Participants[0].DisplayName != "Conversation Customer "+base ||
		found.Participants[1].DisplayName != "Conversation Merchant "+base {
		t.Fatalf("participant display names = %+v", found.Participants)
	}
	if found.Participants[0].MaskedPhone == nil || *found.Participants[0].MaskedPhone != base {
		t.Fatalf("customer maskedPhone = %v, want %s", found.Participants[0].MaskedPhone, base)
	}

	// The status filter narrows the list.
	rec = authedGET(t, h, "/admin/conversations?status=blocked", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("conversations status filter status = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&convs); err != nil {
		t.Fatalf("decode conversations: %v", err)
	}
	for i := range convs {
		if convs[i].Id == openapi_types.UUID(convID) {
			t.Fatalf("open conversation leaked into status=blocked filter")
		}
	}
}

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

func TestAdminGlobalSearchIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	base := uniqueAdminExtraPhone(t, "search")
	customerID := seedAdminExtraUser(t, pool, base, "Searchable Customer "+base, "customer")
	var orderID uuid.UUID
	var orderNo string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs)
		 VALUES ($1, $2, 'paid', 12000) RETURNING id, no`,
		customerID, uuid.New()).Scan(&orderID, &orderNo); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, orderID)
	})

	// q = unique phone finds the customer entity.
	rec := authedGET(t, h, "/admin/search?q="+url.QueryEscape(base), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("global search status = %d (%s)", rec.Code, rec.Body)
	}
	var results []adminSearchItem
	if err := json.NewDecoder(rec.Body).Decode(&results); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	var customerHit *adminSearchItem
	for i := range results {
		if results[i].Id == customerID.String() && results[i].EntityType == "customer" {
			customerHit = &results[i]
			break
		}
	}
	if customerHit == nil {
		t.Fatalf("seeded customer %s missing from search results: %+v", customerID, results)
	}
	if customerHit.Label != base {
		t.Fatalf("customer search label = %q, want phone %s", customerHit.Label, base)
	}

	// q = the order number finds the order entity with its status.
	rec = authedGET(t, h, "/admin/search?q="+url.QueryEscape(orderNo), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("global search status = %d (%s)", rec.Code, rec.Body)
	}
	results = nil
	if err := json.NewDecoder(rec.Body).Decode(&results); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	var orderHit *adminSearchItem
	for i := range results {
		if results[i].Id == orderID.String() && results[i].EntityType == "order" {
			orderHit = &results[i]
			break
		}
	}
	if orderHit == nil {
		t.Fatalf("seeded order %s missing from search results: %+v", orderID, results)
	}
	if orderHit.Label != orderNo || orderHit.Status == nil || *orderHit.Status != "paid" {
		t.Fatalf("order search hit = %+v, want no %s status paid", orderHit, orderNo)
	}

	// The entityTypes filter narrows the search.
	rec = authedGET(t, h, "/admin/search?q="+url.QueryEscape(base)+"&entityTypes=customer", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("global search filtered status = %d (%s)", rec.Code, rec.Body)
	}
	results = nil
	if err := json.NewDecoder(rec.Body).Decode(&results); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	for i := range results {
		if results[i].Id == customerID.String() && results[i].EntityType == "order" {
			t.Fatalf("entityTypes=customer filter leaked an order hit")
		}
	}
}

// ---------------------------------------------------------------------------
// Data export queue
// ---------------------------------------------------------------------------

func TestAdminDataExportsIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminExtraTables(t, pool)
	token := adminExtraStaffToken(t, s)
	h := s.Router()

	base := uniqueAdminExtraPhone(t, "exp")
	userID := seedAdminExtraUser(t, pool, base, "Export Requester "+base, "customer")

	var exportID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO data_exports (user_id, scope, format, status) VALUES ($1, 'orders', 'csv', 'queued') RETURNING id`,
		userID).Scan(&exportID); err != nil {
		t.Fatalf("seed data export: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM data_exports WHERE id = $1`, exportID)
	})

	rec := authedGET(t, h, "/admin/data-exports", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("data exports status = %d (%s)", rec.Code, rec.Body)
	}
	var jobs []gen.DataExportJob
	if err := json.NewDecoder(rec.Body).Decode(&jobs); err != nil {
		t.Fatalf("decode data exports: %v", err)
	}
	var found *gen.DataExportJob
	for i := range jobs {
		if jobs[i].Id == openapi_types.UUID(exportID) {
			found = &jobs[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded export %s missing from queue: %+v", exportID, jobs)
	}
	if found.Scope != gen.DataExportJobScope("orders") || found.Format != gen.DataExportJobFormatCsv ||
		found.Status != gen.DataExportJobStatus("queued") {
		t.Fatalf("export job = %+v, want scope orders / format csv / status queued", found)
	}
	if found.CreatedAt.IsZero() {
		t.Fatal("export createdAt is zero")
	}
}
