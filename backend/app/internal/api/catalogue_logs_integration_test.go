//go:build integration

// CATALOGUE CHANGE-LOGS + CHAIN-STORE SETTINGS integration tests against
// real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'CatalogueItemLog|ChainStoreSetting|UpdateMyStore|ItemLog' -count=1
//
// This suite owns the 00055 tables (catalogue_item_logs,
// chain_store_settings): it truncates only those at setup and deletes its
// own users (phone prefix +2558731...), whose merchants and chain_stores
// rows cascade away; catalogue_items rows are deleted explicitly (their
// merchant_id has no FK in 00005).
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

// catlogPhonePrefix identifies every users row this suite inserts.
const catlogPhonePrefix = "+2558731"

// catlogSetup wires a persistent server, truncates only this suite's 00055
// tables and clears leftover users (plus their cascaded merchants/chain
// stores and this suite's catalogue_items rows) from earlier runs.
func catlogSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE catalogue_item_logs, chain_store_settings"); err != nil {
		t.Fatalf("truncate catlog tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM catalogue_items WHERE merchant_id IN (
		SELECT m.id FROM merchants m JOIN users u ON u.id = m.owner_user_id
		 WHERE u.phone LIKE '`+catlogPhonePrefix+`%')`); err != nil {
		t.Fatalf("clear catlog catalogue items: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+catlogPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear catlog users: %v", err)
	}
	return s, pool
}

// catlogUser inserts a users row with a per-run unique phone.
func catlogUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%05d", catlogPhonePrefix, time.Now().UnixNano()%100_000)
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, phone
}

// catlogFixture creates a unique city, an approved merchant (is_open=false
// so the isOpen toggle is observable through chain_stores.active), one chain
// store and one catalogue item, and returns ids plus a merchant-role token
// for the owner. The catalogue item is keyed by the REAL merchants row id
// (merchant_linkage.go), so the item-logs owner gate matches it.
func catlogFixture(t *testing.T, s *Server, pool *pgxpool.Pool) (merchantID, storeID, itemID uuid.UUID, token string) {
	t.Helper()
	ctx := context.Background()
	userID, phone := catlogUser(t, pool)
	var cityID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO cities (name) VALUES ($1) RETURNING id`,
		"CatLog "+uuid.NewString()[:8]).Scan(&cityID); err != nil {
		t.Fatalf("insert city: %v", err)
	}
	t.Cleanup(func() {
		// Deleting the user cascades its merchants and chain_stores rows
		// (00017/00022), releasing the city FK before the city delete.
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup user %s: %v", userID, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM cities WHERE id = $1`, cityID); err != nil {
			t.Errorf("cleanup city %s: %v", cityID, err)
		}
	})
	if err := pool.QueryRow(ctx,
		`INSERT INTO merchants (owner_user_id, business_name, city_id, verification, is_open)
		 VALUES ($1, $2, $3, 'approved', false) RETURNING id`,
		userID, "CatLog "+uuid.NewString()[:8], cityID).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO chain_stores (owner_user_id, merchant_id, name, city_id)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		userID, merchantID, "Store "+uuid.NewString()[:8], cityID).Scan(&storeID); err != nil {
		t.Fatalf("insert chain store: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs)
		 VALUES ($1, $2, 500) RETURNING id`,
		merchantID, "Item "+uuid.NewString()[:8]).Scan(&itemID); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	return merchantID, storeID, itemID, tokenFor(t, s, phone, RoleMerchant, false)
}

// catlogSeedLog inserts one log row for the item at a fixed offset from now.
func catlogSeedLog(t *testing.T, pool *pgxpool.Pool, itemID, actor uuid.UUID, action, detail string, secondsBack int) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO catalogue_item_logs (catalogue_item_id, action, actor_uuid, detail, created_at)
		 VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5::double precision))`,
		itemID, action, actor, detail, secondsBack); err != nil {
		t.Fatalf("seed catalogue item log: %v", err)
	}
}

// TestCatalogueItemLogsList: seeded log rows round-trip onto the contract
// objects (newest first, actor/action/before/after mapped from
// actor_uuid/detail); an item without logs answers `[]`.
func TestCatalogueItemLogsList(t *testing.T) {
	s, pool := catlogSetup(t)
	_, _, itemID, token := catlogFixture(t, s, pool)
	owner, _ := catlogUser(t, pool)
	catlogSeedLog(t, pool, itemID, owner, "updated", `{"after":{"name":"Chapati"}}`, 2)
	catlogSeedLog(t, pool, itemID, owner, "price_changed", `{"before":{"priceTZS":4500},"after":{"priceTZS":5000}}`, 1)

	rec := authedGET(t, s.Router(), "/catalogue-items/"+itemID.String()+"/logs", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatalf("unexpected X-Next-Cursor on a 2-row page")
	}
	var entries []catalogueLogEntry
	if err := json.NewDecoder(rec.Body).Decode(&entries); err != nil {
		t.Fatalf("decode logs: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2 (%+v)", len(entries), entries)
	}
	if entries[0].Action != "price_changed" || entries[1].Action != "updated" {
		t.Fatalf("actions = %q/%q, want newest-first price_changed then updated", entries[0].Action, entries[1].Action)
	}
	if entries[0].Actor != owner.String() {
		t.Fatalf("actor = %q, want %q", entries[0].Actor, owner)
	}
	var before, after map[string]any
	if err := json.Unmarshal(entries[0].Before, &before); err != nil {
		t.Fatalf("decode before: %v", err)
	}
	if err := json.Unmarshal(entries[0].After, &after); err != nil {
		t.Fatalf("decode after: %v", err)
	}
	if int(after["priceTZS"].(float64)) != 5000 || int(before["priceTZS"].(float64)) != 4500 {
		t.Fatalf("before/after = %+v/%+v, want priceTZS 4500/5000", before, after)
	}
	if entries[1].Before != nil {
		t.Fatalf("detail without before key must map to after only, got before %s", entries[1].Before)
	}

	// An item with no logs answers `[]`.
	_, _, otherItem, otherToken := catlogFixture(t, s, pool)
	rec = authedGET(t, s.Router(), "/catalogue-items/"+otherItem.String()+"/logs", otherToken)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty log status = %d body = %q, want 200 []", rec.Code, rec.Body)
	}
}

// TestCatalogueItemLogsForeignMerchant404: another merchant's item and an
// unknown item both answer 404 ITEM_NOT_FOUND — no existence leak.
func TestCatalogueItemLogsForeignMerchant404(t *testing.T) {
	s, pool := catlogSetup(t)
	_, _, _, tokenA := catlogFixture(t, s, pool)
	_, _, itemB, _ := catlogFixture(t, s, pool)

	rec := authedGET(t, s.Router(), "/catalogue-items/"+itemB.String()+"/logs", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign item status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "ITEM_NOT_FOUND" {
		t.Fatalf("error code = %q, want ITEM_NOT_FOUND", errBody.Code)
	}

	rec = authedGET(t, s.Router(), "/catalogue-items/"+uuid.New().String()+"/logs", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown item status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

// TestCatalogueItemLogsPagination: 25 log rows page at 20 + 5 with the
// keyset cursor on X-Next-Cursor; the second page carries no next cursor.
func TestCatalogueItemLogsPagination(t *testing.T) {
	s, pool := catlogSetup(t)
	_, _, itemID, token := catlogFixture(t, s, pool)
	for i := 0; i < 25; i++ {
		catlogSeedLog(t, pool, itemID, uuid.Nil, "updated", fmt.Sprintf(`{"after":{"n":%d}}`, i), 25-i)
	}
	h := s.Router()

	rec := authedGET(t, h, "/catalogue-items/"+itemID.String()+"/logs?limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("first page status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page1 []catalogueLogEntry
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode first page: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("first page = %d entries, want 20", len(page1))
	}
	cursor := rec.Header().Get("X-Next-Cursor")
	if cursor == "" {
		t.Fatal("first page missing X-Next-Cursor")
	}

	rec = authedGET(t, h, "/catalogue-items/"+itemID.String()+"/logs?limit=20&cursor="+cursor, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("second page status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page2 []catalogueLogEntry
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode second page: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("second page = %d entries, want 5", len(page2))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("final page must not advertise a next cursor")
	}
	if page1[19].At.Before(page2[0].At) {
		t.Fatal("pages out of order: page2 starts before page1 ends")
	}
}

// TestChainStoreSettingsUpsertRoundtrip: PATCH writes the per-store settings
// row (created on first call, updated on the second with untouched fields
// preserved) and answers the ChainStore shape with the toggled isOpen.
func TestChainStoreSettingsUpsertRoundtrip(t *testing.T) {
	s, pool := catlogSetup(t)
	_, storeID, _, token := catlogFixture(t, s, pool)
	ctx := context.Background()

	rec := authedDo(t, s.Router(), http.MethodPatch, "/merchants/me/stores/"+storeID.String(),
		`{"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"08:00","close":"17:00"}]}],
		  "deliverySettings":{"minimumOrderTZS":5000},
		  "acceptWhileClosed":true,
		  "isOpen":true}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("first PATCH status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var store gen.ChainStore
	if err := json.NewDecoder(rec.Body).Decode(&store); err != nil {
		t.Fatalf("decode chain store: %v", err)
	}
	if store.Id.String() != storeID.String() || store.BusinessName == "" || store.City == "" {
		t.Fatalf("chain store response = %+v, want id %s with businessName/city", store, storeID)
	}
	if !store.IsOpen {
		t.Fatal("isOpen = false, want true after the toggle (merchant is_open is false, store active true)")
	}

	var hours []byte
	var minOrder int64
	var accept bool
	if err := pool.QueryRow(ctx,
		`SELECT opening_hours, min_order_tzs, accept_while_closed
		 FROM chain_store_settings WHERE store_id = $1`, storeID).
		Scan(&hours, &minOrder, &accept); err != nil {
		t.Fatalf("read chain_store_settings: %v", err)
	}
	if !strings.Contains(string(hours), `"dayOfWeek"`) || !strings.Contains(string(hours), `"08:00"`) || minOrder != 5000 || !accept {
		t.Fatalf("settings row = hours %s, minOrder %d, accept %v", hours, minOrder, accept)
	}

	// Second PATCH only changes the minimum: hours and acceptWhileClosed are
	// preserved (PATCH semantics).
	rec = authedDo(t, s.Router(), http.MethodPatch, "/merchants/me/stores/"+storeID.String(),
		`{"deliverySettings":{"minimumOrderTZS":7500},"isOpen":false}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("second PATCH status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	store = gen.ChainStore{}
	if err := json.NewDecoder(rec.Body).Decode(&store); err != nil {
		t.Fatalf("decode second chain store: %v", err)
	}
	if store.IsOpen {
		t.Fatal("isOpen = true, want false after the second toggle")
	}
	hours = nil
	minOrder = 0
	accept = false
	if err := pool.QueryRow(ctx,
		`SELECT opening_hours, min_order_tzs, accept_while_closed
		 FROM chain_store_settings WHERE store_id = $1`, storeID).
		Scan(&hours, &minOrder, &accept); err != nil {
		t.Fatalf("re-read chain_store_settings: %v", err)
	}
	if !strings.Contains(string(hours), `"dayOfWeek"`) || !strings.Contains(string(hours), `"08:00"`) || minOrder != 7500 || !accept {
		t.Fatalf("settings row after second PATCH = hours %s, minOrder %d, accept %v", hours, minOrder, accept)
	}
}

// TestChainStoreSettingsInvalidHours422: malformed day ranges (equal or
// inverted open/close) answer 422 HOURS_INVALID before any write.
func TestChainStoreSettingsInvalidHours422(t *testing.T) {
	s, pool := catlogSetup(t)
	_, storeID, _, token := catlogFixture(t, s, pool)
	h := s.Router()

	bodies := []string{
		`{"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"09:00","close":"09:00"}]}]}`,
		`{"businessHours":[{"businessHours":[{"dayOfWeek":1,"open":"17:00","close":"08:00"}]}]}`,
		`{"businessHours":[{"businessHours":[{"dayOfWeek":8,"open":"09:00","close":"17:00"}]}]}`,
	}
	for _, body := range bodies {
		rec := authedDo(t, h, http.MethodPatch, "/merchants/me/stores/"+storeID.String(), body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "HOURS_INVALID" {
			t.Fatalf("error code = %q, want HOURS_INVALID", errBody.Code)
		}
	}
}

// TestChainStoreNotOwned404: another owner's store and an unknown store both
// answer 404 NOT_FOUND.
func TestChainStoreNotOwned404(t *testing.T) {
	s, pool := catlogSetup(t)
	_, _, _, tokenA := catlogFixture(t, s, pool)
	_, storeB, _, _ := catlogFixture(t, s, pool)

	rec := authedDo(t, s.Router(), http.MethodPatch, "/merchants/me/stores/"+storeB.String(),
		`{"deliverySettings":{"minimumOrderTZS":1000}}`, tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign store status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", errBody.Code)
	}

	rec = authedDo(t, s.Router(), http.MethodPatch, "/merchants/me/stores/"+uuid.New().String(),
		`{"deliverySettings":{"minimumOrderTZS":1000}}`, tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown store status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}
