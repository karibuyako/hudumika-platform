//go:build integration

// PRODUCT ASSISTANT integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Assistant' -count=1
//
// Every row seeded here is deleted at cleanup; no table is truncated (the
// suite only ever touches its own ids).
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// assistantSetup wires a persistent server and waits for the orders table
// (migration 00005, written by a sibling agent).
func assistantSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	waitForOrdersTable(t, pool)
	return s, pool
}

// assistantSeedUser inserts a users row with a per-run unique phone and
// registers cleanup that deletes ONLY this suite's row.
func assistantSeedUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	userID := uuid.New()
	phone := "+2557" + strings.ReplaceAll(uuid.NewString(), "-", "")[:9]
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert assistant user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })
	return userID, phone
}

// assistantSeedMerchant inserts a users row plus a real merchants row
// (entity-linkage convention: catalogue/order rows carry the merchants row
// id) and returns (merchantsID, ownerUserID, ownerPhone).
func assistantSeedMerchant(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	ownerID := uuid.New()
	phone := "+2557" + strings.ReplaceAll(uuid.NewString(), "-", "")[:9]
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, ownerID, phone); err != nil {
		t.Fatalf("insert assistant merchant user: %v", err)
	}
	merchantRowID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO merchants (id, owner_user_id, business_name, verification)
		 VALUES ($1, $2, 'Assistant Test', 'approved')`, merchantRowID, ownerID); err != nil {
		t.Fatalf("insert assistant merchant row: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM merchants WHERE id = $1`, merchantRowID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, ownerID)
	})
	return merchantRowID, ownerID, phone
}

// assistantSeedItem inserts a catalogue item for the merchant with a per-run
// unique name and registers cleanup.
func assistantSeedItem(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string, priceTZS int64) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	itemID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO catalogue_items (id, merchant_id, name, price_tzs)
		 VALUES ($1, $2, $3, $4)`, itemID, merchantID, name, priceTZS); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM catalogue_items WHERE id = $1`, itemID) })
	return itemID
}

// assistantSeedOrder inserts a paid-status order owned by the customer for
// the merchant and registers cleanup (order_items cascade on delete).
func assistantSeedOrder(t *testing.T, pool *pgxpool.Pool, customerID, merchantID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	orderID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO orders (id, customer_user_id, merchant_id, status, total_tzs)
		 VALUES ($1, $2, $3, $4, 1000)`, orderID, customerID, merchantID, status); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, orderID) })
	return orderID
}

// assistantSeedOrderItem inserts one order_items line and registers cleanup.
func assistantSeedOrderItem(t *testing.T, pool *pgxpool.Pool, orderID, itemID uuid.UUID, name string, qty int) {
	t.Helper()
	ctx := context.Background()
	lineID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO order_items (id, order_id, catalogue_item_id, name_snapshot, quantity, unit_price_tzs)
		 VALUES ($1, $2, $3, $4, $5, 1000)`, lineID, orderID, itemID, name, qty); err != nil {
		t.Fatalf("insert order item: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM order_items WHERE id = $1`, lineID) })
}

// TestAssistantDescribeIntegration: the rule-based describe is deterministic
// and echoes the keywords for an authenticated session (no database rows
// needed).
func TestAssistantDescribeIntegration(t *testing.T) {
	s, _ := assistantSetup(t)
	token := tokenFor(t, s, "+255700000101", RoleMerchant, false)

	rec := assistantAuthedJSON(s.Router(), http.MethodPost, "/products/assistant/describe",
		`{"keywords":["pilau","beef"]}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var body struct {
		Description string `json:"description"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(strings.ToLower(body.Description), "pilau") ||
		!strings.Contains(strings.ToLower(body.Description), "beef") {
		t.Fatalf("description %q does not echo the keywords", body.Description)
	}
	rec2 := assistantAuthedJSON(s.Router(), http.MethodPost, "/products/assistant/describe",
		`{"keywords":["pilau","beef"]}`, token)
	var body2 struct {
		Description string `json:"description"`
	}
	_ = json.NewDecoder(rec2.Body).Decode(&body2)
	if body.Description != body2.Description {
		t.Fatalf("not deterministic: %q vs %q", body.Description, body2.Description)
	}
}

// TestAssistantSuggestionsIntegration: seeded paid orders make the seeded
// item the top seller; the merchant sees a description suggestion carrying
// the item id.
func TestAssistantSuggestionsIntegration(t *testing.T) {
	s, pool := assistantSetup(t)
	merchantID, _, merchantPhone := assistantSeedMerchant(t, pool)
	itemID := assistantSeedItem(t, pool, merchantID, "Pilau Special", 5000)
	customerID, _ := assistantSeedUser(t, pool)
	orderID := assistantSeedOrder(t, pool, customerID, merchantID, "paid")
	assistantSeedOrderItem(t, pool, orderID, itemID, "Pilau Special", 2)

	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/products/assistant/suggestions", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []productAssistantSuggestion
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) == 0 {
		t.Fatalf("no suggestions for a seeded top seller (%s)", rec.Body)
	}
	matched := false
	for _, g := range got {
		if g.ItemId == nil {
			t.Fatalf("suggestion without itemId: %+v", g)
		}
		if uuid.UUID(*g.ItemId) == itemID && g.Type == "description" {
			matched = true
		}
	}
	if !matched {
		t.Fatalf("no description suggestion for the seeded item: %+v", got)
	}
}

// TestAssistantSuggestionsEmpty: a merchant with an empty catalogue gets [].
func TestAssistantSuggestionsEmpty(t *testing.T) {
	s, pool := assistantSetup(t)
	merchantID, _, merchantPhone := assistantSeedMerchant(t, pool)
	_ = merchantID
	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/products/assistant/suggestions", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []productAssistantSuggestion
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected [] for an empty catalogue, got %+v", got)
	}
}

// TestAssistantApplyIntegration: applying a price suggestion updates the
// item and returns the refreshed CatalogueItem.
func TestAssistantApplyIntegration(t *testing.T) {
	s, pool := assistantSetup(t)
	merchantID, _, merchantPhone := assistantSeedMerchant(t, pool)
	itemID := assistantSeedItem(t, pool, merchantID, "Pilau Special", 5000)

	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	rec := authedPOSTJSON(t, s.Router(), "/products/assistant/apply",
		`{"itemId":"`+itemID.String()+`","type":"price","value":"6500"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var item gen.CatalogueItem
	if err := json.NewDecoder(rec.Body).Decode(&item); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if item.Id == nil || uuid.UUID(*item.Id) != itemID || item.PriceTZS != 6500 {
		t.Fatalf("unexpected item: %+v", item)
	}
	var stored int64
	if err := pool.QueryRow(context.Background(),
		`SELECT price_tzs FROM catalogue_items WHERE id = $1`, itemID).Scan(&stored); err != nil {
		t.Fatalf("read stored price: %v", err)
	}
	if stored != 6500 {
		t.Fatalf("stored price = %d, want 6500", stored)
	}
}

// TestAssistantApplyForeignItem: another merchant's item surfaces
// ITEM_NOT_FOUND (ownership never revealed).
func TestAssistantApplyForeignItem(t *testing.T) {
	s, pool := assistantSetup(t)
	_, _, merchantPhone := assistantSeedMerchant(t, pool)
	_, foreignOwner, _ := assistantSeedMerchant(t, pool)
	foreignID := foreignOwner
	itemID := assistantSeedItem(t, pool, foreignID, "Foreign Dish", 1000)

	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	rec := authedPOSTJSON(t, s.Router(), "/products/assistant/apply",
		`{"itemId":"`+itemID.String()+`","type":"title","value":"Renamed"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "ITEM_NOT_FOUND" {
		t.Fatalf("error code = %q, want ITEM_NOT_FOUND", errBody.Code)
	}
}

// TestAssistantApplyRejectsStock: the stock type is owned by the inventory
// context and rejected before any write.
func TestAssistantApplyRejectsStock(t *testing.T) {
	s, pool := assistantSetup(t)
	merchantID, _, merchantPhone := assistantSeedMerchant(t, pool)
	itemID := assistantSeedItem(t, pool, merchantID, "Pilau", 5000)

	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	rec := authedPOSTJSON(t, s.Router(), "/products/assistant/apply",
		`{"itemId":"`+itemID.String()+`","type":"stock","value":"50"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}
