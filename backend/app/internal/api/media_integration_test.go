//go:build integration

// Media-catalogue integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Barcode|Combo|Menu|Video|Category|PrintJob' -count=1
//
// This suite owns the media tables (migration 00035): it truncates barcodes,
// combos, menus, videos and print_jobs at setup and clears its own users
// (phone prefix +255889...) plus the catalogue_items, product_categories and
// devices rows it seeds for those users — it never truncates shared tables.
package api

import (
	"context"
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

// mediaPhonePrefix identifies every users row this suite inserts.
const mediaPhonePrefix = "+255889"

// mediaTables are the tables owned by this suite (migration 00035).
var mediaTables = []string{"barcodes", "combos", "menus", "videos", "print_jobs"}

// mediaSetup wires a persistent server, truncates only this suite's tables
// and clears its own rows from the shared tables it seeds (catalogue_items,
// product_categories, devices — never truncated).
func mediaSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(mediaTables, ", ")); err != nil {
		t.Fatalf("truncate media tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM catalogue_items
		WHERE merchant_id IN (SELECT id FROM users WHERE phone LIKE '`+mediaPhonePrefix+`%')`); err != nil {
		t.Fatalf("clear media catalogue items: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM product_categories
		WHERE merchant_id IN (SELECT id FROM users WHERE phone LIKE '`+mediaPhonePrefix+`%')`); err != nil {
		t.Fatalf("clear media categories: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM devices
		WHERE merchant_id IN (SELECT id FROM users WHERE phone LIKE '`+mediaPhonePrefix+`%')`); err != nil {
		t.Fatalf("clear media devices: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+mediaPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear media users: %v", err)
	}
	return s, pool
}

// mediaMerchant inserts a users row with a per-run unique phone and returns
// the merchant id and the phone (the session subject).
func mediaMerchant(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", mediaPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert media merchant user: %v", err)
	}
	return userID, phone
}

// mediaItem inserts one owned catalogue_items row and returns its id.
func mediaItem(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string, priceTZS int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs) VALUES ($1, $2, $3) RETURNING id`,
		merchantID, name, priceTZS).Scan(&id); err != nil {
		t.Fatalf("insert media catalogue item: %v", err)
	}
	return id
}

// mediaItemInCategory inserts one owned catalogue_items row pinned to a
// category (used to block category deletes).
func mediaItemInCategory(t *testing.T, pool *pgxpool.Pool, merchantID, categoryID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name, category_id) VALUES ($1, $2, $3) RETURNING id`,
		merchantID, name, categoryID).Scan(&id); err != nil {
		t.Fatalf("insert media item in category: %v", err)
	}
	return id
}

// mediaCategory inserts one owned product_categories row and returns its id.
func mediaCategory(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string, sortOrder int) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO product_categories (merchant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
		merchantID, name, sortOrder).Scan(&id); err != nil {
		t.Fatalf("insert media category: %v", err)
	}
	return id
}

// mediaDevice inserts one owned printer device and returns its id.
func mediaDevice(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO devices (merchant_id, type, name, status) VALUES ($1, 'printer', $2, $3) RETURNING id`,
		merchantID, "Printer "+uuid.NewString()[:8], status).Scan(&id); err != nil {
		t.Fatalf("insert media device: %v", err)
	}
	return id
}

// mediaBarcode inserts one barcodes row.
func mediaBarcode(t *testing.T, pool *pgxpool.Pool, merchantID, itemID uuid.UUID, code string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO barcodes (merchant_id, code, catalogue_item_id) VALUES ($1, $2, $3)`,
		merchantID, code, itemID); err != nil {
		t.Fatalf("insert media barcode: %v", err)
	}
}

// mediaSeedJobs bulk-inserts print jobs (seeding for queue-limit and
// pagination tests).
func mediaSeedJobs(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, n int, status string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO print_jobs (merchant_id, job_type, content, status)
		 SELECT $1, 'receipt', 'seed', $3 FROM generate_series(1, $2)`,
		merchantID, n, status); err != nil {
		t.Fatalf("seed media print jobs: %v", err)
	}
}

// mediaErr decodes an error envelope and asserts its code.
func mediaErr(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return errBody
}

// TestMediaBarcodeFormats: the formats surface mirrors the contract enum
// exactly, in contract order.
func TestMediaBarcodeFormats(t *testing.T) {
	s, pool := mediaSetup(t)
	_, phone := mediaMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/barcodes/formats", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list formats = %d (%s)", rec.Code, rec.Body)
	}
	var formats []gen.BarcodeFormat
	if err := json.NewDecoder(rec.Body).Decode(&formats); err != nil {
		t.Fatalf("decode formats: %v", err)
	}
	if len(formats) != 6 {
		t.Fatalf("format count = %d, want 6", len(formats))
	}
	want := []gen.BarcodeFormatCode{
		gen.BarcodeFormatCodeEan13, gen.BarcodeFormatCodeEan8, gen.BarcodeFormatCodeUpca,
		gen.BarcodeFormatCodeCode128, gen.BarcodeFormatCodeCode39, gen.BarcodeFormatCodeQr,
	}
	for i, f := range formats {
		if f.Code != want[i] || f.Label == "" {
			t.Fatalf("format %d = %+v, want code %q with a label", i, f, want[i])
		}
	}
}

// TestMediaBarcodeLookupAndHistory: a seeded barcode resolves to its owned
// catalogue item; unknown codes surface BARCODE_NOT_FOUND on both the lookup
// and the history surface.
func TestMediaBarcodeLookupAndHistory(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantID, phone := mediaMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	itemID := mediaItem(t, pool, merchantID, "Chapati Special", 4500)
	mediaBarcode(t, pool, merchantID, itemID, "5901234123457")

	rec := authedGET(t, h, "/barcodes/5901234123457", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup = %d (%s)", rec.Code, rec.Body)
	}
	var lookup gen.BarcodeLookup
	if err := json.NewDecoder(rec.Body).Decode(&lookup); err != nil {
		t.Fatalf("decode lookup: %v", err)
	}
	if lookup.CatalogueItemId != itemID || lookup.Name != "Chapati Special" ||
		lookup.PriceTZS != 4500 || lookup.Available == nil || !*lookup.Available {
		t.Fatalf("unexpected lookup: %+v", lookup)
	}

	rec = authedGET(t, h, "/barcodes/9999999999999", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown lookup = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "BARCODE_NOT_FOUND" {
		t.Fatalf("error code = %q, want BARCODE_NOT_FOUND", errBody.Code)
	}

	rec = authedGET(t, h, "/barcodes/5901234123457/history", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("history = %d (%s)", rec.Code, rec.Body)
	}
	var history []struct {
		At     time.Time `json:"at"`
		Action string    `json:"action"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&history); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	if len(history) != 1 || history[0].Action != "generated" || history[0].At.IsZero() {
		t.Fatalf("unexpected history: %+v", history)
	}

	rec = authedGET(t, h, "/barcodes/9999999999999/history", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown history = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "BARCODE_NOT_FOUND" {
		t.Fatalf("error code = %q, want BARCODE_NOT_FOUND", errBody.Code)
	}
}

// TestMediaBarcodeBatchImport: valid entries import, per-entry failures are
// counted as rejected (foreign item, in-batch duplicate, empty code, code
// already taken by any merchant) and the 100-entry ceiling is enforced.
func TestMediaBarcodeBatchImport(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	merchantB, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	itemA1 := mediaItem(t, pool, merchantA, "Ugali", 1500)
	itemA2 := mediaItem(t, pool, merchantA, "Mchicha", 2500)
	itemB := mediaItem(t, pool, merchantB, "Foreign", 100)

	body := fmt.Sprintf(`{"entries":[
		{"catalogueItemId":%q,"code":"A1"},
		{"catalogueItemId":%q,"code":"A1"},
		{"catalogueItemId":%q,"code":"A2"},
		{"catalogueItemId":%q,"code":""},
		{"catalogueItemId":%q,"code":"B1"}
	]}`, itemA1, itemA1, itemB, itemA1, itemA2)
	rec := authedDo(t, h, http.MethodPost, "/barcodes/batch", body, tokenA)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("batch = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var result struct {
		JobID    string `json:"jobId"`
		Accepted int    `json:"accepted"`
		Rejected int    `json:"rejected"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode batch result: %v", err)
	}
	if result.JobID == "" || result.Accepted != 2 || result.Rejected != 3 {
		t.Fatalf("unexpected batch result: %+v", result)
	}
	rec = authedGET(t, h, "/barcodes/A1", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup A1 = %d (%s)", rec.Code, rec.Body)
	}
	var lookup gen.BarcodeLookup
	_ = json.NewDecoder(rec.Body).Decode(&lookup)
	if lookup.CatalogueItemId != itemA1 {
		t.Fatalf("A1 resolves to %s, want %s", lookup.CatalogueItemId, itemA1)
	}
	rec = authedGET(t, h, "/barcodes/B1", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup B1 = %d (%s)", rec.Code, rec.Body)
	}

	// 101 entries exceed the limit before any database work.
	entries := make([]string, 0, 101)
	for i := 0; i < 101; i++ {
		entries = append(entries, fmt.Sprintf(`{"catalogueItemId":%q,"code":"LIMIT%d"}`, itemA1, i))
	}
	rec = authedDo(t, h, http.MethodPost, "/barcodes/batch", `{"entries":[`+strings.Join(entries, ",")+`]}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("oversize batch = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "BARCODE_BATCH_EXCEEDS_LIMIT" {
		t.Fatalf("error code = %q, want BARCODE_BATCH_EXCEEDS_LIMIT", errBody.Code)
	}

	// Malformed body surfaces VALIDATION_FAILED.
	rec = authedDo(t, h, http.MethodPost, "/barcodes/batch", `{not json`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malformed batch = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}

	// Codes are unique across merchants: B's code blocks A's import.
	mediaBarcode(t, pool, merchantB, itemB, "C1")
	rec = authedDo(t, h, http.MethodPost, "/barcodes/batch",
		fmt.Sprintf(`{"entries":[{"catalogueItemId":%q,"code":"C1"}]}`, itemA1), tokenA)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("duplicate batch = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&result)
	if result.Accepted != 0 || result.Rejected != 1 {
		t.Fatalf("duplicate import = %+v, want accepted 0 rejected 1", result)
	}
	// And A's own code is invisible to B.
	rec = authedGET(t, h, "/barcodes/A1", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign lookup = %d, want 404", rec.Code)
	}
}

// TestMediaComboLifecycle: create validates every item against the
// merchant's own catalogue before inserting, then list/update/delete round-
// trip; unknown or foreign ids surface COMBO_NOT_FOUND.
func TestMediaComboLifecycle(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	merchantB, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	itemA := mediaItem(t, pool, merchantA, "Rice", 2000)
	itemB := mediaItem(t, pool, merchantB, "Beans", 1500)

	rec := authedDo(t, h, http.MethodPost, "/combos",
		fmt.Sprintf(`{"name":"Foreign Item Combo","items":[{"catalogueItemId":%q,"quantity":1}]}`, itemB), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("foreign item combo = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "COMBO_ITEM_INVALID" {
		t.Fatalf("error code = %q, want COMBO_ITEM_INVALID", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/combos", `{"name":"Empty Combo","items":[]}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty items combo = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "COMBO_ITEM_INVALID" {
		t.Fatalf("error code = %q, want COMBO_ITEM_INVALID", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/combos",
		fmt.Sprintf(`{"name":"","items":[{"catalogueItemId":%q,"quantity":1}]}`, itemA), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty name combo = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, "/combos",
		fmt.Sprintf(`{"name":"Meal Deal","priceTZS":-5,"items":[{"catalogueItemId":%q,"quantity":1}]}`, itemA), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("negative price combo = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/combos",
		fmt.Sprintf(`{"name":"Meal Deal","priceTZS":9000,"description":"Lunch","items":[{"catalogueItemId":%q,"quantity":2}]}`, itemA), tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create combo = %d (%s)", rec.Code, rec.Body)
	}
	var combo gen.Combo
	if err := json.NewDecoder(rec.Body).Decode(&combo); err != nil {
		t.Fatalf("decode combo: %v", err)
	}
	if combo.Id == nil || combo.Name != "Meal Deal" || combo.PriceTZS == nil || *combo.PriceTZS != 9000 ||
		combo.Description == nil || *combo.Description != "Lunch" || len(combo.Items) != 1 ||
		combo.Items[0].CatalogueItemId != itemA || combo.Items[0].Quantity != 2 ||
		combo.Available == nil || !*combo.Available || combo.CreatedAt == nil {
		t.Fatalf("unexpected created combo: %+v", combo)
	}

	rec = authedGET(t, h, "/combos", tokenA)
	var list []gen.Combo
	_ = json.NewDecoder(rec.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("combo count = %d, want 1", len(list))
	}

	// Update replaces name, price and items.
	rec = authedDo(t, h, http.MethodPatch, "/combos/"+combo.Id.String(),
		fmt.Sprintf(`{"name":"Family Deal","priceTZS":10000,"items":[{"catalogueItemId":%q,"quantity":3}]}`, itemA), tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("update combo = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&combo); err != nil {
		t.Fatalf("decode updated combo: %v", err)
	}
	if combo.Name != "Family Deal" || combo.PriceTZS == nil || *combo.PriceTZS != 10000 ||
		len(combo.Items) != 1 || combo.Items[0].Quantity != 3 {
		t.Fatalf("unexpected updated combo: %+v", combo)
	}
	// Update with a foreign item is rejected before the write.
	rec = authedDo(t, h, http.MethodPatch, "/combos/"+combo.Id.String(),
		fmt.Sprintf(`{"name":"Family Deal","items":[{"catalogueItemId":%q,"quantity":1}]}`, itemB), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update with foreign item = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "COMBO_ITEM_INVALID" {
		t.Fatalf("error code = %q, want COMBO_ITEM_INVALID", errBody.Code)
	}

	// Foreign merchant: update and delete both surface COMBO_NOT_FOUND.
	rec = authedDo(t, h, http.MethodPatch, "/combos/"+combo.Id.String(),
		fmt.Sprintf(`{"name":"Hijack","items":[{"catalogueItemId":%q,"quantity":1}]}`, itemB), tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign update = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "COMBO_NOT_FOUND" {
		t.Fatalf("error code = %q, want COMBO_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodDelete, "/combos/"+combo.Id.String(), "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign delete = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodDelete, "/combos/"+combo.Id.String(), "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete combo = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/combos/"+combo.Id.String(), "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing combo = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "COMBO_NOT_FOUND" {
		t.Fatalf("error code = %q, want COMBO_NOT_FOUND", errBody.Code)
	}
}

// TestMediaMenuCategoryRules: menus need at least one store, the optional
// category must belong to the merchant (foreign category and unknown
// category have distinct error codes) and unknown/foreign menu ids surface
// MENU_NOT_FOUND on update and delete.
func TestMediaMenuCategoryRules(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	merchantB, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	catA := mediaCategory(t, pool, merchantA, "Breakfast", 1)
	catB := mediaCategory(t, pool, merchantB, "Dinner", 1)
	itemA := mediaItem(t, pool, merchantA, "Mkate", 1000)
	store := uuid.NewString()

	rec := authedDo(t, h, http.MethodPost, "/menus", `{"name":"Lunch","storeIds":[]}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("no stores = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "MENU_STORE_INVALID" {
		t.Fatalf("error code = %q, want MENU_STORE_INVALID", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/menus",
		fmt.Sprintf(`{"name":"Lunch","storeIds":[%q],"categoryId":%q}`, store, catB), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("foreign category = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "MENU_STORE_INVALID" {
		t.Fatalf("error code = %q, want MENU_STORE_INVALID", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/menus",
		fmt.Sprintf(`{"name":"Lunch","storeIds":[%q],"categoryId":%q}`, store, uuid.NewString()), tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown category = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "CATEGORY_NOT_FOUND" {
		t.Fatalf("error code = %q, want CATEGORY_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/menus", `{"name":"","storeIds":["`+store+`"]}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty name = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/menus",
		fmt.Sprintf(`{"name":"Lunch","storeIds":[%q],"categoryId":%q,"active":true,
			"sections":[{"name":"Specials","itemIds":[%q]}]}`, store, catA, itemA), tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create menu = %d (%s)", rec.Code, rec.Body)
	}
	var menu gen.Menu
	if err := json.NewDecoder(rec.Body).Decode(&menu); err != nil {
		t.Fatalf("decode menu: %v", err)
	}
	if menu.Id == nil || menu.Name != "Lunch" || menu.Active == nil || !*menu.Active ||
		len(menu.StoreIds) != 1 || menu.StoreIds[0].String() != store ||
		menu.Sections == nil || len(*menu.Sections) != 1 ||
		(*menu.Sections)[0].Name != "Specials" || len((*menu.Sections)[0].ItemIds) != 1 ||
		(*menu.Sections)[0].ItemIds[0] != itemA {
		t.Fatalf("unexpected created menu: %+v", menu)
	}

	rec = authedGET(t, h, "/menus", tokenA)
	var menus []gen.Menu
	_ = json.NewDecoder(rec.Body).Decode(&menus)
	if len(menus) != 1 {
		t.Fatalf("menu count = %d, want 1", len(menus))
	}

	rec = authedDo(t, h, http.MethodPut, "/menus/"+menu.Id.String(),
		fmt.Sprintf(`{"name":"Lunch Plus","storeIds":[%q],"categoryId":%q}`, store, catA), tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("update menu = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&menu); err != nil {
		t.Fatalf("decode updated menu: %v", err)
	}
	if menu.Name != "Lunch Plus" {
		t.Fatalf("updated menu name = %q", menu.Name)
	}

	// Foreign merchant's menu: update and delete surface MENU_NOT_FOUND.
	rec = authedDo(t, h, http.MethodPut, "/menus/"+menu.Id.String(),
		fmt.Sprintf(`{"name":"Hijack","storeIds":[%q]}`, uuid.NewString()), tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign update = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "MENU_NOT_FOUND" {
		t.Fatalf("error code = %q, want MENU_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodDelete, "/menus/"+menu.Id.String(), "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign delete = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodDelete, "/menus/"+menu.Id.String(), "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete menu = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/menus/"+menu.Id.String(), "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing menu = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "MENU_NOT_FOUND" {
		t.Fatalf("error code = %q, want MENU_NOT_FOUND", errBody.Code)
	}
}

// TestMediaVideoRules: the url must be https and the title 1-120 characters;
// catalogueItemId is echoed without ownership validation (as implemented).
// Unknown or foreign video ids surface VIDEO_NOT_FOUND.
func TestMediaVideoRules(t *testing.T) {
	s, pool := mediaSetup(t)
	_, phoneA := mediaMerchant(t, pool)
	_, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/videos", `{"title":"Cooking","url":"http://insecure.example/v.mp4"}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("http url = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "VIDEO_URL_INVALID" {
		t.Fatalf("error code = %q, want VIDEO_URL_INVALID", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/videos", `{"title":"","url":"https://v.example/v.mp4"}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty title = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/videos",
		fmt.Sprintf(`{"title":"Cooking","url":"https://v.example/1.mp4","thumbnailUrl":"https://t.example/1.jpg",
			"catalogueItemId":%q}`, uuid.NewString()), tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create video = %d (%s)", rec.Code, rec.Body)
	}
	var video gen.ProductVideo
	if err := json.NewDecoder(rec.Body).Decode(&video); err != nil {
		t.Fatalf("decode video: %v", err)
	}
	if video.Id == nil || video.Title != "Cooking" || video.Url != "https://v.example/1.mp4" ||
		video.Status == nil || *video.Status != gen.ProductVideoStatusActive ||
		video.ThumbnailUrl == nil || *video.ThumbnailUrl != "https://t.example/1.jpg" ||
		video.CatalogueItemId == nil || video.CreatedAt == nil {
		t.Fatalf("unexpected created video: %+v", video)
	}

	rec = authedGET(t, h, "/videos", tokenA)
	var videos []gen.ProductVideo
	_ = json.NewDecoder(rec.Body).Decode(&videos)
	if len(videos) != 1 {
		t.Fatalf("video count = %d, want 1", len(videos))
	}

	rec = authedDo(t, h, http.MethodDelete, "/videos/"+video.Id.String(), "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign delete = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "VIDEO_NOT_FOUND" {
		t.Fatalf("error code = %q, want VIDEO_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodDelete, "/videos/"+video.Id.String(), "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete video = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/videos/"+video.Id.String(), "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing video = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "VIDEO_NOT_FOUND" {
		t.Fatalf("error code = %q, want VIDEO_NOT_FOUND", errBody.Code)
	}
}

// TestMediaCategoryRules: duplicate sort orders conflict, items pinning a
// category (live or soft-deleted) block its delete with CATEGORY_NOT_EMPTY,
// and unknown or foreign ids surface CATEGORY_NOT_FOUND.
func TestMediaCategoryRules(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	merchantB, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/categories", `{"name":"Drinks","sortOrder":2}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create category = %d (%s)", rec.Code, rec.Body)
	}
	var first gen.ProductCategory
	if err := json.NewDecoder(rec.Body).Decode(&first); err != nil {
		t.Fatalf("decode category: %v", err)
	}
	if first.Name != "Drinks" || first.SortOrder != 2 || first.Active == nil || !*first.Active {
		t.Fatalf("unexpected created category: %+v", first)
	}

	rec = authedDo(t, h, http.MethodPost, "/categories", `{"name":"Snacks","sortOrder":2}`, tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate sort = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "CATEGORY_SORT_CONFLICT" {
		t.Fatalf("error code = %q, want CATEGORY_SORT_CONFLICT", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/categories", `{"name":"","sortOrder":5}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty name = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	// A second category pins no items yet, so it can be patched freely.
	rec = authedDo(t, h, http.MethodPost, "/categories", `{"name":"Snacks","sortOrder":1}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create second category = %d (%s)", rec.Code, rec.Body)
	}
	var snacks gen.ProductCategory
	_ = json.NewDecoder(rec.Body).Decode(&snacks)

	rec = authedDo(t, h, http.MethodPatch, "/categories/"+snacks.Id.String(), `{"name":"Munchies","sortOrder":3}`, tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch category = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPatch, "/categories/"+snacks.Id.String(), `{"name":"Munchies","sortOrder":2}`, tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("patch to taken sort = %d, want 409 (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/categories", tokenA)
	var cats []gen.ProductCategory
	_ = json.NewDecoder(rec.Body).Decode(&cats)
	if len(cats) != 2 || cats[0].Name != "Drinks" || cats[1].Name != "Munchies" {
		t.Fatalf("unexpected category order: %+v", cats)
	}

	// A category referenced by any item (live or soft-deleted) is not empty.
	catB := mediaCategory(t, pool, merchantB, "Foreign", 1)
	item := mediaItemInCategory(t, pool, merchantA, first.Id, "Soda")
	rec = authedDo(t, h, http.MethodDelete, "/categories/"+first.Id.String(), "", tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete referenced = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "CATEGORY_NOT_EMPTY" {
		t.Fatalf("error code = %q, want CATEGORY_NOT_EMPTY", errBody.Code)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE catalogue_items SET deleted_at = now() WHERE id = $1`, item); err != nil {
		t.Fatalf("soft-delete item: %v", err)
	}
	rec = authedDo(t, h, http.MethodDelete, "/categories/"+first.Id.String(), "", tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete with soft-deleted item = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "CATEGORY_NOT_EMPTY" {
		t.Fatalf("error code = %q, want CATEGORY_NOT_EMPTY", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodDelete, "/categories/"+first.Id.String(), "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign delete = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "CATEGORY_NOT_FOUND" {
		t.Fatalf("error code = %q, want CATEGORY_NOT_FOUND", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodDelete, "/categories/"+catB.String(), "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete B's category = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	// Freeing the item unblocks the delete.
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM catalogue_items WHERE id = $1`, item); err != nil {
		t.Fatalf("remove item: %v", err)
	}
	rec = authedDo(t, h, http.MethodDelete, "/categories/"+first.Id.String(), "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete empty category = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/categories/"+first.Id.String(), "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing category = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "CATEGORY_NOT_FOUND" {
		t.Fatalf("error code = %q, want CATEGORY_NOT_FOUND", errBody.Code)
	}
}

// TestMediaPrintJobGates: content, deviceId, jobType and copies validate
// before the device gates; missing, foreign and offline devices each get
// their own error; the 50-job queue ceiling is enforced.
func TestMediaPrintJobGates(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	merchantB, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	online := mediaDevice(t, pool, merchantA, "online")
	offline := mediaDevice(t, pool, merchantA, "offline")
	foreignDevice := mediaDevice(t, pool, merchantB, "online")

	rec := authedDo(t, h, http.MethodPost, "/print-jobs", `{}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty content = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "PRINT_JOB_EMPTY" {
		t.Fatalf("error code = %q, want PRINT_JOB_EMPTY", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs", `{"content":"   "}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("blank content = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "PRINT_JOB_EMPTY" {
		t.Fatalf("error code = %q, want PRINT_JOB_EMPTY", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs", `{"content":"Hello"}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing deviceId = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hello","deviceId":%q,"jobType":"bad"}`, online), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad jobType = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hello","deviceId":%q,"jobType":"receipt","copies":0}`, online), tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("zero copies = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hello","deviceId":%q,"jobType":"receipt"}`, uuid.NewString()), tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing device = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "DEVICE_NOT_FOUND" {
		t.Fatalf("error code = %q, want DEVICE_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hello","deviceId":%q,"jobType":"receipt"}`, foreignDevice), tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign device = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "DEVICE_NOT_FOUND" {
		t.Fatalf("error code = %q, want DEVICE_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hello","deviceId":%q,"jobType":"receipt"}`, offline), tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("offline device = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "PRINT_DEVICE_OFFLINE" {
		t.Fatalf("error code = %q, want PRINT_DEVICE_OFFLINE", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hello Table 1","deviceId":%q,"jobType":"receipt","copies":2,"label":"Table 1"}`, online), tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create print job = %d (%s)", rec.Code, rec.Body)
	}
	var job gen.PrintJob
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode print job: %v", err)
	}
	if job.JobType != gen.PrintJobJobTypeReceipt || job.Status != gen.PrintJobStatusQueued ||
		job.DeviceId == nil || job.DeviceId.String() != online.String() ||
		job.Copies == nil || *job.Copies != 2 || job.Label == nil || *job.Label != "Table 1" ||
		job.CreatedAt.IsZero() {
		t.Fatalf("unexpected print job: %+v", job)
	}

	rec = authedGET(t, h, "/print-jobs/"+job.Id.String(), tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("get print job = %d (%s)", rec.Code, rec.Body)
	}
	// B's token cannot read A's job.
	rec = authedGET(t, h, "/print-jobs/"+job.Id.String(), tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign get = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "PRINT_JOB_NOT_FOUND" {
		t.Fatalf("error code = %q, want PRINT_JOB_NOT_FOUND", errBody.Code)
	}

	// 50 queued jobs fill the queue; the 51st is rejected.
	mediaSeedJobs(t, pool, merchantA, 50, "queued")
	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Too late","deviceId":%q,"jobType":"receipt"}`, online), tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("full queue = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "PRINT_QUEUE_FULL" {
		t.Fatalf("error code = %q, want PRINT_QUEUE_FULL", errBody.Code)
	}
}

// TestMediaPrintJobListPagination: the print-jobs list is limit-based
// (default 20, max 100) with an optional status filter. The handler does not
// emit cursor pagination, so no X-Next-Cursor header is expected.
func TestMediaPrintJobListPagination(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	h := s.Router()

	mediaSeedJobs(t, pool, merchantA, 22, "queued")
	mediaSeedJobs(t, pool, merchantA, 3, "failed")

	rec := authedGET(t, h, "/print-jobs", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("default list = %d (%s)", rec.Code, rec.Body)
	}
	var jobs []gen.PrintJob
	if err := json.NewDecoder(rec.Body).Decode(&jobs); err != nil {
		t.Fatalf("decode jobs: %v", err)
	}
	if len(jobs) != 20 {
		t.Fatalf("default page = %d, want 20", len(jobs))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatalf("unexpected X-Next-Cursor header: %q", rec.Header().Get("X-Next-Cursor"))
	}

	rec = authedGET(t, h, "/print-jobs?limit=100", tokenA)
	_ = json.NewDecoder(rec.Body).Decode(&jobs)
	if len(jobs) != 25 {
		t.Fatalf("limit=100 page = %d, want 25", len(jobs))
	}
	rec = authedGET(t, h, "/print-jobs?limit=999", tokenA)
	_ = json.NewDecoder(rec.Body).Decode(&jobs)
	if len(jobs) != 25 {
		t.Fatalf("clamped limit page = %d, want 25", len(jobs))
	}
	rec = authedGET(t, h, "/print-jobs?limit=0", tokenA)
	_ = json.NewDecoder(rec.Body).Decode(&jobs)
	if len(jobs) != 1 {
		t.Fatalf("limit=0 page = %d, want 1 (clamped)", len(jobs))
	}
	rec = authedGET(t, h, "/print-jobs?limit=10&status=failed", tokenA)
	_ = json.NewDecoder(rec.Body).Decode(&jobs)
	if len(jobs) != 3 {
		t.Fatalf("failed filter = %d, want 3", len(jobs))
	}
	for _, j := range jobs {
		if j.Status != gen.PrintJobStatusFailed {
			t.Fatalf("filter leaked non-failed job: %+v", j)
		}
	}
	rec = authedGET(t, h, "/print-jobs?status=queued", tokenA)
	_ = json.NewDecoder(rec.Body).Decode(&jobs)
	if len(jobs) != 20 {
		t.Fatalf("queued filter page = %d, want 20", len(jobs))
	}
}

// TestMediaBarcodeOwnershipIsolation: every media resource is scoped to the
// owning merchant; another merchant's reads and writes surface 404 rather
// than leaking existence.
func TestMediaBarcodeOwnershipIsolation(t *testing.T) {
	s, pool := mediaSetup(t)
	merchantA, phoneA := mediaMerchant(t, pool)
	_, phoneB := mediaMerchant(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	itemA := mediaItem(t, pool, merchantA, "Isolated", 3000)
	mediaBarcode(t, pool, merchantA, itemA, "OWN1")
	catA := mediaCategory(t, pool, merchantA, "Isolated Cat", 1)
	comboID := comboOf(t, h, tokenA, itemA, "Isolated Combo")
	menuID := menuOf(t, h, tokenA, catA, "Isolated Menu")
	videoID := videoOf(t, h, tokenA, "https://v.example/iso.mp4")
	deviceA := mediaDevice(t, pool, merchantA, "online")
	jobID := printJobOf(t, h, tokenA, deviceA)

	rec := authedGET(t, h, "/barcodes/OWN1", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign barcode lookup = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "BARCODE_NOT_FOUND" {
		t.Fatalf("error code = %q, want BARCODE_NOT_FOUND", errBody.Code)
	}
	rec = authedGET(t, h, "/print-jobs/"+jobID.String(), tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign print job get = %d, want 404", rec.Code)
	}
	if errBody := mediaErr(t, rec); errBody.Code != "PRINT_JOB_NOT_FOUND" {
		t.Fatalf("error code = %q, want PRINT_JOB_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Hijack","deviceId":%q,"jobType":"receipt"}`, deviceA), tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign device = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	for _, tc := range []struct {
		method string
		path   string
		body   string
		code   string
	}{
		{http.MethodDelete, "/combos/" + comboID.String(), "", "COMBO_NOT_FOUND"},
		{http.MethodDelete, "/menus/" + menuID.String(), "", "MENU_NOT_FOUND"},
		{http.MethodDelete, "/videos/" + videoID.String(), "", "VIDEO_NOT_FOUND"},
		{http.MethodDelete, "/categories/" + catA.String(), "", "CATEGORY_NOT_FOUND"},
	} {
		rec = authedDo(t, h, tc.method, tc.path, tc.body, tokenB)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s = %d, want 404 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
		if errBody := mediaErr(t, rec); errBody.Code != tc.code {
			t.Fatalf("%s %s: error code = %q, want %q", tc.method, tc.path, errBody.Code, tc.code)
		}
	}
}

// --- seeding helpers for the ownership test ---------------------------------

// comboOf creates one combo through the API and returns its id.
func comboOf(t *testing.T, h http.Handler, token string, itemID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	rec := authedDo(t, h, http.MethodPost, "/combos",
		fmt.Sprintf(`{"name":%q,"items":[{"catalogueItemId":%q,"quantity":1}]}`, name, itemID), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed combo = %d (%s)", rec.Code, rec.Body)
	}
	var combo gen.Combo
	_ = json.NewDecoder(rec.Body).Decode(&combo)
	if combo.Id == nil {
		t.Fatalf("seed combo missing id: %+v", combo)
	}
	return *combo.Id
}

// menuOf creates one menu through the API and returns its id.
func menuOf(t *testing.T, h http.Handler, token string, categoryID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	rec := authedDo(t, h, http.MethodPost, "/menus",
		fmt.Sprintf(`{"name":%q,"storeIds":[%q],"categoryId":%q}`, name, uuid.NewString(), categoryID), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed menu = %d (%s)", rec.Code, rec.Body)
	}
	var menu gen.Menu
	_ = json.NewDecoder(rec.Body).Decode(&menu)
	if menu.Id == nil {
		t.Fatalf("seed menu missing id: %+v", menu)
	}
	return *menu.Id
}

// videoOf creates one video through the API and returns its id.
func videoOf(t *testing.T, h http.Handler, token, url string) uuid.UUID {
	t.Helper()
	rec := authedDo(t, h, http.MethodPost, "/videos",
		fmt.Sprintf(`{"title":"Isolated","url":%q}`, url), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed video = %d (%s)", rec.Code, rec.Body)
	}
	var video gen.ProductVideo
	_ = json.NewDecoder(rec.Body).Decode(&video)
	if video.Id == nil {
		t.Fatalf("seed video missing id: %+v", video)
	}
	return *video.Id
}

// printJobOf creates one print job through the API and returns its id.
func printJobOf(t *testing.T, h http.Handler, token string, deviceID uuid.UUID) uuid.UUID {
	t.Helper()
	rec := authedDo(t, h, http.MethodPost, "/print-jobs",
		fmt.Sprintf(`{"content":"Isolated","deviceId":%q,"jobType":"receipt"}`, deviceID), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed print job = %d (%s)", rec.Code, rec.Body)
	}
	var job gen.PrintJob
	_ = json.NewDecoder(rec.Body).Decode(&job)
	return job.Id
}
