//go:build integration

// Unified search endpoints against real PostgreSQL + Redis
// (docker compose). Run via `make test-integration` after `make migrate`.
// Every test seeds only its own rows (unique names and phones) and deletes
// exactly those rows in cleanup; the shared users/merchants/catalogue_items/
// services tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// uniqueSearchSuffix builds a per-run unique suffix so repeated integration
// runs never collide with earlier runs or other packages.
func uniqueSearchSuffix() string {
	return fmt.Sprintf("%09d", time.Now().UnixNano()%1_000_000_000)
}

// seedSearchUser inserts a customer user row and registers cleanup that
// deletes exactly this user's history and user row.
func seedSearchUser(t *testing.T, pool *pgxpool.Pool, phone string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "Search Tester "+phone).Scan(&id); err != nil {
		t.Fatalf("seed search user %s: %v", phone, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM search_history WHERE user_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// seedSearchMerchant inserts a merchant row owned by the given users row and
// registers cleanup deleting exactly this merchant.
func seedSearchMerchant(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, name, businessType, verification string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, business_type, verification)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		ownerID, name, businessType, verification).Scan(&id); err != nil {
		t.Fatalf("seed search merchant %s: %v", name, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM merchants WHERE id = $1`, id)
	})
	return id
}

// seedSearchItem inserts a catalogue item for the merchant's owner user row
// (catalogue_items.merchant_id = users.id, see CATALOGUES notes) and
// registers cleanup deleting exactly this item.
func seedSearchItem(t *testing.T, pool *pgxpool.Pool, merchantOwnerID uuid.UUID, name string, available bool, deletedAt *time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name, available, deleted_at)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		merchantOwnerID, name, available, deletedAt).Scan(&id); err != nil {
		t.Fatalf("seed search item %s: %v", name, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM catalogue_items WHERE id = $1`, id)
	})
	return id
}

// seedSearchService inserts an active service row and registers cleanup
// deleting exactly this service.
func seedSearchService(t *testing.T, pool *pgxpool.Pool, name string, active bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO services (name, active) VALUES ($1, $2) RETURNING id`,
		name, active).Scan(&id); err != nil {
		t.Fatalf("seed search service %s: %v", name, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM services WHERE id = $1`, id)
	})
	return id
}

// searchResultIDs returns the (entityType, id) pairs of a SearchResults
// response for assertions.
func searchResultIDs(res gen.SearchResults) map[string]string {
	out := make(map[string]string, len(res.Results))
	for _, r := range res.Results {
		if r.Id != nil && r.Title != nil {
			out[*r.Title] = string(r.EntityType)
		}
	}
	return out
}

// authedDELETE performs an authenticated DELETE request.
func authedDELETE(t *testing.T, h http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestSearchAcrossEntityTypesIntegration: a keyword search with the default
// entityType=all surfaces approved merchants' catalogue items (dish),
// approved merchants (restaurant) and active services (service_package).
func TestSearchAcrossEntityTypesIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-search"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)

	merchantName := "Pizza Palace " + suffix
	itemName := "Pizza Margherita " + suffix
	serviceName := "Pizza Class " + suffix
	seedSearchMerchant(t, pool, userID, merchantName, "restaurant", "approved")
	seedSearchItem(t, pool, userID, itemName, true, nil)
	seedSearchService(t, pool, serviceName, true)

	rec := authedGET(t, s.Router(), "/search?q=pizza", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("search status = %d (%s)", rec.Code, rec.Body)
	}
	var res gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	if res.Query != "pizza" {
		t.Fatalf("query echo = %q, want pizza", res.Query)
	}
	byTitle := searchResultIDs(res)
	if got := byTitle[itemName]; got != "dish" {
		t.Fatalf("item %q entityType = %q, want dish (results: %v)", itemName, got, byTitle)
	}
	if got := byTitle[serviceName]; got != "service_package" {
		t.Fatalf("service %q entityType = %q, want service_package (results: %v)", serviceName, got, byTitle)
	}
	if got := byTitle[merchantName]; got != "restaurant" {
		t.Fatalf("merchant %q entityType = %q, want restaurant (results: %v)", merchantName, got, byTitle)
	}
}

// TestSearchEntityTypeDishIntegration: entityType=dish restricts results to
// catalogue items of approved merchants; services never appear.
func TestSearchEntityTypeDishIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-dish"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)

	itemName := "Pizza Margherita " + suffix
	serviceName := "Pizza Class " + suffix
	seedSearchMerchant(t, pool, userID, "Pizza Dish Place "+suffix, "restaurant", "approved")
	seedSearchItem(t, pool, userID, itemName, true, nil)
	seedSearchService(t, pool, serviceName, true)

	rec := authedGET(t, s.Router(), "/search?q=pizza&entityType=dish", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("search status = %d (%s)", rec.Code, rec.Body)
	}
	var res gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	byTitle := searchResultIDs(res)
	if got := byTitle[itemName]; got != "dish" {
		t.Fatalf("item %q entityType = %q, want dish (results: %v)", itemName, got, byTitle)
	}
	if _, ok := byTitle[serviceName]; ok {
		t.Fatalf("service %q leaked into entityType=dish results: %v", serviceName, byTitle)
	}
	for _, r := range res.Results {
		if string(r.EntityType) != "dish" {
			t.Fatalf("unexpected entityType %q in dish results", r.EntityType)
		}
	}
}

// TestSearchSuggestIntegration: /search/suggest returns matching names from
// catalogue items, merchants and services.
func TestSearchSuggestIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-sugg"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)

	itemName := "Pizza Margherita " + suffix
	serviceName := "Pizza Class " + suffix
	seedSearchMerchant(t, pool, userID, "Pizza Palace "+suffix, "restaurant", "approved")
	seedSearchItem(t, pool, userID, itemName, true, nil)
	seedSearchService(t, pool, serviceName, true)

	rec := authedGET(t, s.Router(), "/search/suggest?q=pizz", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("suggest status = %d (%s)", rec.Code, rec.Body)
	}
	var suggestions []string
	if err := json.NewDecoder(rec.Body).Decode(&suggestions); err != nil {
		t.Fatalf("decode suggestions: %v", err)
	}
	if len(suggestions) == 0 || len(suggestions) > 10 {
		t.Fatalf("suggestion count = %d, want 1-10", len(suggestions))
	}
	seen := make(map[string]bool, len(suggestions))
	for _, s := range suggestions {
		seen[s] = true
	}
	if !seen[itemName] {
		t.Fatalf("suggestions missing item %q: %v", itemName, suggestions)
	}
	if !seen[serviceName] {
		t.Fatalf("suggestions missing service %q: %v", serviceName, suggestions)
	}
}

// TestSearchHistoryIntegration: successful searches are recorded per user,
// listed by /search/history and cleared by DELETE /search/history.
func TestSearchHistoryIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-hist"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)
	merchantOwner := seedSearchUser(t, pool, "+2559"+uniqueSearchSuffix()+"-histowner")
	seedSearchMerchant(t, pool, merchantOwner, "Pizza History "+suffix, "restaurant", "approved")
	seedSearchItem(t, pool, merchantOwner, "Pizza History Slice "+suffix, true, nil)

	query := "pizza history " + suffix
	rec := authedGET(t, s.Router(), "/search?q="+url.QueryEscape(query), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("search status = %d (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, s.Router(), "/search/history", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("history status = %d (%s)", rec.Code, rec.Body)
	}
	var history []string
	if err := json.NewDecoder(rec.Body).Decode(&history); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	found := false
	for _, h := range history {
		if h == query {
			found = true
		}
	}
	if !found {
		t.Fatalf("history missing %q: %v", query, history)
	}

	rec = authedDELETE(t, s.Router(), "/search/history", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("clear history status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, s.Router(), "/search/history", token)
	var empty []string
	if err := json.NewDecoder(rec.Body).Decode(&empty); err != nil {
		t.Fatalf("decode cleared history: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("cleared history = %v, want []", empty)
	}
	_ = userID
}

// TestSearchPaginationIntegration: 25 matching items page as 20 + 5 via the
// nextCursor, with no duplicate rows across pages.
func TestSearchPaginationIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-page"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)

	seedSearchMerchant(t, pool, userID, "Pizza Paginator "+suffix, "restaurant", "approved")
	itemIDs := make([]string, 0, 25)
	for i := 0; i < 25; i++ {
		id := seedSearchItem(t, pool, userID, fmt.Sprintf("Pizza Slice %02d %s", i, suffix), true, nil)
		itemIDs = append(itemIDs, id.String())
	}

	rec := authedGET(t, s.Router(), "/search?q="+url.QueryEscape("Pizza Slice")+"&entityType=dish&limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d (%s)", rec.Code, rec.Body)
	}
	var page1 gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1.Results) != 20 {
		t.Fatalf("page 1 result count = %d, want 20", len(page1.Results))
	}
	if page1.NextCursor == nil || *page1.NextCursor == "" {
		t.Fatalf("page 1 nextCursor missing, want one")
	}
	page1Seen := make(map[string]bool, len(page1.Results))
	for _, r := range page1.Results {
		if r.Id != nil {
			page1Seen[r.Id.String()] = true
		}
	}

	rec = authedGET(t, s.Router(), "/search?q="+url.QueryEscape("Pizza Slice")+"&entityType=dish&limit=20&cursor="+url.QueryEscape(*page1.NextCursor), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d (%s)", rec.Code, rec.Body)
	}
	var page2 gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2.Results) != 5 {
		t.Fatalf("page 2 result count = %d, want 5", len(page2.Results))
	}
	if page2.NextCursor != nil && *page2.NextCursor != "" {
		t.Fatalf("page 2 has nextCursor %q, want none", *page2.NextCursor)
	}
	for _, r := range page2.Results {
		if r.Id != nil && page1Seen[r.Id.String()] {
			t.Fatalf("duplicate row %s across pages", r.Id.String())
		}
	}

	all := append(page1.Results, page2.Results...)
	if len(all) != 25 {
		t.Fatalf("total rows across pages = %d, want 25", len(all))
	}
}

// TestSearchExcludesUnavailableDeletedIntegration: unavailable or soft-
// deleted catalogue items never appear in results.
func TestSearchExcludesUnavailableDeletedIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-hides"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)

	seedSearchMerchant(t, pool, userID, "Pizza Hider "+suffix, "restaurant", "approved")
	liveName := "Pizza Live " + suffix
	hiddenName := "Pizza Unavailable " + suffix
	deletedName := "Pizza Deleted " + suffix
	now := time.Now()
	seedSearchItem(t, pool, userID, liveName, true, nil)
	seedSearchItem(t, pool, userID, hiddenName, false, nil)
	seedSearchItem(t, pool, userID, deletedName, true, &now)

	rec := authedGET(t, s.Router(), "/search?q=Pizza", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("search status = %d (%s)", rec.Code, rec.Body)
	}
	var res gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	byTitle := searchResultIDs(res)
	if _, ok := byTitle[hiddenName]; ok {
		t.Fatalf("unavailable item %q leaked into results: %v", hiddenName, byTitle)
	}
	if _, ok := byTitle[deletedName]; ok {
		t.Fatalf("deleted item %q leaked into results: %v", deletedName, byTitle)
	}
	if _, ok := byTitle[liveName]; !ok {
		t.Fatalf("live item %q missing from results: %v", liveName, byTitle)
	}
}

// TestSearchExcludesUnapprovedMerchantIntegration: catalogue items of
// merchants whose verification is not 'approved' never surface.
func TestSearchExcludesUnapprovedMerchantIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	suffix := uniqueSearchSuffix()
	phone := "+2559" + suffix + "-gate"
	userID := seedSearchUser(t, pool, phone)
	token := tokenFor(t, s, phone, RoleCustomer, false)

	pendingOwner := seedSearchUser(t, pool, "+2559"+uniqueSearchSuffix()+"-pendingowner")
	approvedName := "Pizza Approved " + suffix
	pendingName := "Pizza Pending " + suffix
	seedSearchMerchant(t, pool, userID, "Pizza Approved Place "+suffix, "restaurant", "approved")
	seedSearchMerchant(t, pool, pendingOwner, "Pizza Pending Place "+suffix, "restaurant", "pending")
	seedSearchItem(t, pool, userID, approvedName, true, nil)
	seedSearchItem(t, pool, pendingOwner, pendingName, true, nil)

	rec := authedGET(t, s.Router(), "/search?q=Pizza", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("search status = %d (%s)", rec.Code, rec.Body)
	}
	var res gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode search results: %v", err)
	}
	byTitle := searchResultIDs(res)
	if _, ok := byTitle[pendingName]; ok {
		t.Fatalf("pending merchant's item %q leaked into results: %v", pendingName, byTitle)
	}
	if _, ok := byTitle[approvedName]; !ok {
		t.Fatalf("approved merchant's item %q missing from results: %v", approvedName, byTitle)
	}
	if _, ok := byTitle["Pizza Pending Place "+suffix]; ok {
		t.Fatalf("pending merchant %q leaked into results: %v", "Pizza Pending Place "+suffix, byTitle)
	}
}
