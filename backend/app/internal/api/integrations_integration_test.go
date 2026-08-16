//go:build integration

// Integrations and webhooks integration tests against real PostgreSQL +
// Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Integration|Webhook' -count=1
//
// This suite owns the migration-00026 tables: it truncates ONLY
// webhook_deliveries, webhook_subscriptions and integrations at setup, and
// clears its own users (phone prefix +255888...) — it never truncates shared
// tables.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// integPhonePrefix identifies every users row this suite inserts.
const integPhonePrefix = "+255888"

// integTables are the migration-00026 tables owned by this suite, in
// foreign-key order.
var integTables = []string{"webhook_deliveries", "webhook_subscriptions", "integrations"}

// integSetup wires a persistent server and truncates only this suite's
// tables plus its own users.
func integSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(integTables, ", ")); err != nil {
		t.Fatalf("truncate integration tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+integPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear integration users: %v", err)
	}
	return s, pool
}

// integMerchant inserts a users row with a per-run unique phone and returns
// the merchant id and a merchant-role token for it.
func integMerchant(t *testing.T, s *Server, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%09d", integPhonePrefix, time.Now().UnixNano()%1_000_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert integration merchant user: %v", err)
	}
	return userID, phone
}

// integSeedIntegration inserts an integrations row directly (the contract has
// no create-integration route).
func integSeedIntegration(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, provider, name string, scopes []byte) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO integrations (merchant_id, provider, name, scope, status)
		 VALUES ($1, $2, $3, $4::jsonb, 'connected') RETURNING id`,
		merchantID, provider, name, string(scopes)).Scan(&id); err != nil {
		t.Fatalf("insert integration: %v", err)
	}
	return id
}

// integCreateWebhook registers a subscription through the API and returns the
// created subscription and the one-time secret.
func integCreateWebhook(t *testing.T, h http.Handler, token, url string, events ...string) (gen.WebhookSubscription, string) {
	t.Helper()
	eventsJSON, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal events: %v", err)
	}
	rec := authedDo(t, h, http.MethodPost, "/webhooks",
		fmt.Sprintf(`{"url":%q,"events":%s}`, url, eventsJSON), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create webhook = %d (%s)", rec.Code, rec.Body)
	}
	var sub gen.WebhookSubscription
	if err := json.NewDecoder(rec.Body).Decode(&sub); err != nil {
		t.Fatalf("decode created webhook: %v", err)
	}
	if sub.Id == nil || sub.Secret == nil {
		t.Fatalf("created webhook missing id/secret: %+v", sub)
	}
	return sub, *sub.Secret
}

// integSeedDelivery inserts one webhook_deliveries row directly (the
// dispatcher owns writes in production; API handlers only read).
func integSeedDelivery(t *testing.T, pool *pgxpool.Pool, subscriptionID uuid.UUID, i int, base time.Time, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	payload := fmt.Sprintf(`{"sequence":%d}`, i)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_deliveries
		 (subscription_id, event, payload, status, attempts, last_status_code, next_attempt_at, created_at, delivered_at)
		 VALUES ($1, 'order.created', $2::jsonb, $3, 2, 200,
		         now() + interval '1 hour', $4, now())
		 RETURNING id`,
		subscriptionID, payload, status, base.Add(time.Duration(i)*time.Second)).Scan(&id); err != nil {
		t.Fatalf("insert webhook delivery %d: %v", i, err)
	}
	return id
}

var secretHexPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// TestIntegrationsLifecycle covers list, disconnect, the
// INTEGRATION_DISCONNECTED conflict, INTEGRATION_NOT_FOUND and the
// storage-level provider uniqueness that backs INTEGRATION_ALREADY_CONNECTED.
func TestIntegrationsLifecycle(t *testing.T) {
	s, pool := integSetup(t)
	merchantID, phone := integMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	id := integSeedIntegration(t, pool, merchantID, "pos", "Loyverse POS", []byte(`["orders:read","inventory:read"]`))

	rec := authedGET(t, h, "/integrations", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list integrations = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.IntegrationInfo
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode integration list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("integration count = %d, want 1", len(list))
	}
	info := list[0]
	if info.Id.String() != id.String() || info.Provider != "pos" || info.Status != "connected" {
		t.Fatalf("unexpected integration: %+v", info)
	}
	if info.Label == nil || *info.Label != "Loyverse POS" {
		t.Fatalf("integration label = %v, want Loyverse POS", info.Label)
	}
	if info.Scopes == nil || len(*info.Scopes) != 2 || (*info.Scopes)[0] != "orders:read" {
		t.Fatalf("integration scopes = %v, want [orders:read inventory:read]", info.Scopes)
	}

	rec = authedDo(t, h, http.MethodPost, "/integrations/"+id.String()+"/disconnect",
		`{"reason":"migrating to a new POS"}`, token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("disconnect = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/integrations", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list after disconnect = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode post-disconnect list: %v", err)
	}
	if len(list) != 1 || list[0].Status != "disconnected" {
		t.Fatalf("integration not disconnected: %+v", list)
	}

	// Disconnecting again conflicts.
	rec = authedDo(t, h, http.MethodPost, "/integrations/"+id.String()+"/disconnect",
		`{"reason":"again"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("double disconnect = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode double-disconnect error: %v", err)
	}
	if errBody.Code != "INTEGRATION_DISCONNECTED" {
		t.Fatalf("double-disconnect code = %q, want INTEGRATION_DISCONNECTED", errBody.Code)
	}

	// Unknown integration.
	rec = authedDo(t, h, http.MethodPost, "/integrations/"+uuid.NewString()+"/disconnect",
		`{"reason":"gone"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("disconnect missing = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode missing integration error: %v", err)
	}
	if errBody.Code != "INTEGRATION_NOT_FOUND" {
		t.Fatalf("missing code = %q, want INTEGRATION_NOT_FOUND", errBody.Code)
	}

	// Another merchant's integration is invisible: disconnect of a foreign id
	// surfaces INTEGRATION_NOT_FOUND, never existence.
	otherID, _ := integMerchant(t, s, pool)
	_ = integSeedIntegration(t, pool, otherID, "erp", "Odoo", []byte(`["orders:read"]`))
	rec = authedDo(t, h, http.MethodPost, "/integrations/"+otherID.String()+"/disconnect",
		`{"reason":"nope"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("disconnect foreign integration = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	// Storage-level guarantee backing INTEGRATION_ALREADY_CONNECTED: the
	// unique (merchant_id, provider) constraint rejects a second row for the
	// same provider. The create endpoint (absent from the contract) would
	// translate this into the 409 catalog code.
	_, err := pool.Exec(context.Background(),
		`INSERT INTO integrations (merchant_id, provider, name) VALUES ($1, 'pos', 'Second POS')`,
		merchantID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("duplicate provider insert err = %v, want unique violation 23505", err)
	}
}

// TestWebhookSubscriptionLifecycle covers create (one-time secret), list,
// update, delete, validation rules and the 404 NOT_FOUND code for unknown
// ids.
func TestWebhookSubscriptionLifecycle(t *testing.T) {
	s, pool := integSetup(t)
	_, phone := integMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	// Create: the secret is 32 random bytes hex (64 chars) and is mirrored on
	// the X-Webhook-Secret header.
	rec := authedDo(t, h, http.MethodPost, "/webhooks",
		`{"url":"https://hooks.example.com/hudumika","events":["order.created","order.updated"]}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create webhook = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.WebhookSubscription
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created webhook: %v", err)
	}
	if created.Id == nil || created.Secret == nil || !secretHexPattern.MatchString(*created.Secret) {
		t.Fatalf("created webhook secret invalid: %+v", created)
	}
	if header := rec.Header().Get("X-Webhook-Secret"); header != *created.Secret {
		t.Fatalf("X-Webhook-Secret header = %q, want %q", header, *created.Secret)
	}
	if created.Status == nil || *created.Status != "active" {
		t.Fatalf("created webhook status = %v, want active", created.Status)
	}
	if len(created.Events) != 2 || created.Events[0] != "order.created" {
		t.Fatalf("created webhook events = %v", created.Events)
	}
	secret := *created.Secret
	id := *created.Id

	// The raw secret is stored (only the hash of refresh tokens is stored;
	// webhook secrets must be reproducible for signature verification).
	var storedSecret string
	var storedActive bool
	if err := pool.QueryRow(context.Background(),
		`SELECT secret, active FROM webhook_subscriptions WHERE id = $1`, id.String()).
		Scan(&storedSecret, &storedActive); err != nil {
		t.Fatalf("load stored webhook: %v", err)
	}
	if storedSecret != secret || !storedActive {
		t.Fatalf("stored secret/active = %q/%v, want %q/true", storedSecret, storedActive, secret)
	}

	// List: the secret is never returned again.
	rec = authedGET(t, h, "/webhooks", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list webhooks = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.WebhookSubscription
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode webhook list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("webhook count = %d, want 1", len(list))
	}
	if list[0].Secret != nil {
		t.Fatalf("list leaked the webhook secret: %+v", list[0])
	}
	if list[0].Id == nil || *list[0].Id != id {
		t.Fatalf("listed webhook id mismatch: %+v", list[0])
	}

	// Update: url, events and the active toggle.
	rec = authedDo(t, h, http.MethodPatch, "/webhooks/"+id.String(),
		`{"url":"http://localhost:8080/hook","events":["order.created"],"status":"disabled"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update webhook = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.WebhookSubscription
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated webhook: %v", err)
	}
	if updated.Url != "http://localhost:8080/hook" || len(updated.Events) != 1 ||
		updated.Status == nil || *updated.Status != "disabled" {
		t.Fatalf("unexpected updated webhook: %+v", updated)
	}
	if updated.Secret != nil {
		t.Fatalf("update leaked the webhook secret: %+v", updated)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT active FROM webhook_subscriptions WHERE id = $1`, id.String()).Scan(&storedActive); err != nil {
		t.Fatalf("load updated active: %v", err)
	}
	if storedActive {
		t.Fatalf("webhook still active after disable")
	}

	// Invalid url and empty events on create.
	rec = authedDo(t, h, http.MethodPost, "/webhooks",
		`{"url":"http://example.com/hook","events":["order.created"]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid url = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode invalid-url error: %v", err)
	}
	if errBody.Code != "WEBHOOK_URL_INVALID" {
		t.Fatalf("invalid-url code = %q, want WEBHOOK_URL_INVALID", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/webhooks",
		`{"url":"https://hooks.example.com/hook","events":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty events = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode empty-events error: %v", err)
	}
	if errBody.Code != "WEBHOOK_EVENT_INVALID" {
		t.Fatalf("empty-events code = %q, want WEBHOOK_EVENT_INVALID", errBody.Code)
	}

	// Update of an unknown id surfaces the generic NOT_FOUND code (no
	// webhook-specific not-found code exists in ERROR-CODES.md).
	rec = authedDo(t, h, http.MethodPatch, "/webhooks/"+uuid.NewString(),
		`{"status":"active"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update missing webhook = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode missing-update error: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("missing-update code = %q, want NOT_FOUND", errBody.Code)
	}

	// Delete, then delete again.
	// Seed deliveries first so the cascade is exercised: DELETE removes the
	// subscription AND its delivery log (ON DELETE CASCADE).
	subUUID, _ := uuid.Parse(id.String())
	for i := 0; i < 3; i++ {
		integSeedDelivery(t, pool, subUUID, i, time.Now().UTC().Add(-time.Hour), "delivered")
	}
	rec = authedDo(t, h, http.MethodDelete, "/webhooks/"+id.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete webhook = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/webhooks/"+id.String(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing webhook = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode missing-delete error: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("missing-delete code = %q, want NOT_FOUND", errBody.Code)
	}

	var deliveryCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM webhook_deliveries WHERE subscription_id = $1`, id.String()).
		Scan(&deliveryCount); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if deliveryCount != 0 {
		t.Fatalf("delivery rows survived subscription delete: %d", deliveryCount)
	}

	// Another merchant cannot list, update or delete this subscription: the
	// merchant gate is the subject user id.
	otherID, otherPhone := integMerchant(t, s, pool)
	otherSub, _ := integCreateWebhook(t, h, tokenFor(t, s, otherPhone, RoleMerchant, false),
		"https://hooks.example.com/other", "order.created")
	rec = authedGET(t, h, "/webhooks", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list own webhooks = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode own webhook list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("foreign webhook leaked into list: %+v", list)
	}
	rec = authedDo(t, h, http.MethodDelete, "/webhooks/"+otherSub.Id.String(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete foreign webhook = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPatch, "/webhooks/"+otherSub.Id.String(),
		`{"status":"disabled"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("update foreign webhook = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	_ = otherID
}

// TestWebhookDeliveriesPagination verifies the default 20-row page, the
// keyset cursor extension over 25 seeded rows (20+5) and the webhookId
// filter, plus the storage→contract status mapping.
func TestWebhookDeliveriesPagination(t *testing.T) {
	s, pool := integSetup(t)
	_, phone := integMerchant(t, s, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	first, _ := integCreateWebhook(t, h, token, "https://hooks.example.com/one", "order.created")
	second, _ := integCreateWebhook(t, h, token, "https://hooks.example.com/two", "order.completed")
	firstID, _ := uuid.Parse(first.Id.String())
	secondID, _ := uuid.Parse(second.Id.String())

	base := time.Now().UTC().Add(-2 * time.Hour)
	deliveryIDs := make([]uuid.UUID, 25)
	for i := 0; i < 25; i++ {
		status := "pending"
		if i%3 == 1 {
			status = "delivered"
		}
		if i%3 == 2 {
			status = "failed"
		}
		deliveryIDs[i] = integSeedDelivery(t, pool, firstID, i, base, status)
	}
	// A second subscription's deliveries must be excluded by the webhookId
	// filter.
	for i := 0; i < 3; i++ {
		integSeedDelivery(t, pool, secondID, i, base.Add(time.Minute), "pending")
	}

	// Default page: 20 rows across both subscriptions, newest first.
	rec := authedGET(t, h, "/webhooks/deliveries", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list deliveries = %d (%s)", rec.Code, rec.Body)
	}
	var page []gen.WebhookDelivery
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode delivery page: %v", err)
	}
	if len(page) != 20 {
		t.Fatalf("default page = %d, want 20", len(page))
	}

	// Filtered page: 20 of the first subscription's 25, newest first
	// (i=24..5), with the attempt fields and timestamps populated.
	rec = authedGET(t, h, "/webhooks/deliveries?webhookId="+firstID.String(), token)
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode filtered page: %v", err)
	}
	if len(page) != 20 {
		t.Fatalf("filtered first page = %d, want 20", len(page))
	}
	if page[0].Id.String() != deliveryIDs[24].String() || page[0].WebhookId.String() != firstID.String() {
		t.Fatalf("newest delivery first mismatch: %+v", page[0])
	}
	for _, d := range page {
		if d.WebhookId.String() != firstID.String() {
			t.Fatalf("filter leaked foreign delivery: %+v", d)
		}
	}
	if page[0].Attempts != 2 || page[0].StatusCode == nil || *page[0].StatusCode != 200 {
		t.Fatalf("delivery attempt fields missing: %+v", page[0])
	}
	if page[0].NextRetryAt == nil || page[0].DeliveredAt == nil {
		t.Fatalf("delivery timestamps missing: %+v", page[0])
	}
	// Storage→contract status mapping: i=24 (24%3=0 → pending → retrying).
	if page[0].Status != "retrying" {
		t.Fatalf("delivery status = %q, want retrying for pending", page[0].Status)
	}

	// Keyset cursor: continue after the boundary row (i=5) and get the
	// remaining 5.
	cursor := encodeDeliveriesCursor(base.Add(5*time.Second), deliveryIDs[5])
	rec = authedGET(t, h, "/webhooks/deliveries?webhookId="+firstID.String()+"&cursor="+cursor, token)
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode cursor page: %v", err)
	}
	if len(page) != 5 {
		t.Fatalf("cursor page = %d, want 5 (%s)", len(page), rec.Body)
	}
	if page[0].Id.String() != deliveryIDs[4].String() || page[4].Id.String() != deliveryIDs[0].String() {
		t.Fatalf("cursor page ordering mismatch: %+v", page)
	}

	// limit lifts the cap beyond the default page.
	rec = authedGET(t, h, "/webhooks/deliveries?limit=30", token)
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode limit page: %v", err)
	}
	if len(page) != 28 {
		t.Fatalf("limit page = %d, want 28 (25+3 across both subscriptions)", len(page))
	}

	// A malformed cursor is a validation failure.
	rec = authedGET(t, h, "/webhooks/deliveries?cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode bad-cursor error: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("bad-cursor code = %q, want VALIDATION_FAILED", errBody.Code)
	}

	// Status mapping across statuses: scan the filtered page for every
	// contract enum value.
	seen := map[gen.WebhookDeliveryStatus]bool{}
	rec = authedGET(t, h, "/webhooks/deliveries?webhookId="+firstID.String()+"&limit=25", token)
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode mapping page: %v", err)
	}
	for _, d := range page {
		seen[d.Status] = true
	}
	if !seen["success"] || !seen["failed"] || !seen["retrying"] {
		t.Fatalf("status mapping incomplete: %v", seen)
	}
}
