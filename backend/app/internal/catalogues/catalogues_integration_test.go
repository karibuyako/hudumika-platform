//go:build integration

// End-to-end catalogue handlers tests against real PostgreSQL + Redis (docker
// compose / local dev). Run via `go test -tags integration ./internal/catalogues/
// -count=1` with DATABASE_URL and REDIS_URL set (e.g.
// postgres://hudumika:hudumika@localhost:5432/hudumika, redis://localhost:6379/0).
// Setup truncates ONLY catalogue_items and product_categories and deletes the
// users it creates, so other contexts' data is untouched.
//
// The tests drive the public API handlers through the real chi router with
// hand-signed JWTs (same secret as the server), because the router holds the
// auth middleware that the handlers rely on.
package catalogues

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/api"
	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
)

// catalogueEnv bundles the pool, the wired server and the merchant identity
// for one integration test run.
type catalogueEnv struct {
	pool          *pgxpool.Pool
	h             http.Handler
	secret        []byte
	merchantPhone string
	merchantID    uuid.UUID
}

// itemResp is the contract CatalogueItem projection the tests assert on.
type itemResp struct {
	Id        *string `json:"id"`
	Name      string  `json:"name"`
	PriceTZS  int     `json:"priceTZS"`
	Category  string  `json:"category"`
	Available *bool   `json:"available"`
	Options   []struct {
		Name    string `json:"name"`
		Choices []struct {
			Label    string `json:"label"`
			PriceTZS int    `json:"priceTZS"`
		} `json:"choices"`
	} `json:"options"`
}

// catalogueResp is the contract Catalogue the tests assert on.
type catalogueResp struct {
	MerchantId string     `json:"merchantId"`
	Items      []itemResp `json:"items"`
}

// setup connects to the real dependencies (skipping when either URL is
// unset), resets ONLY the catalogue tables, and wires a router with a real
// database plus a merchant users row.
func setup(t *testing.T) *catalogueEnv {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("REDIS_URL not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "TRUNCATE catalogue_items, product_categories, product_templates, store_logs CASCADE"); err != nil {
		t.Fatalf("truncate catalogue tables: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "TRUNCATE catalogue_items, product_categories, product_templates, store_logs CASCADE"); err != nil {
			t.Errorf("cleanup truncate: %v", err)
		}
	})

	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  24 * time.Hour,
		DatabaseURL: databaseURL,
		RedisURL:    redisURL,
	}
	s, err := api.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	d, err := db.New(ctx, cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	s.SetDB(d)
	t.Cleanup(d.Close)

	phone := fmt.Sprintf("+255760%06d", time.Now().UnixNano()%1_000_000)
	var merchantID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant user: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, merchantID); err != nil {
			t.Errorf("cleanup merchant user: %v", err)
		}
	})

	return &catalogueEnv{
		pool:          pool,
		h:             s.Router(),
		secret:        cfg.JWTSecret,
		merchantPhone: phone,
		merchantID:    merchantID,
	}
}

// mintToken signs a role session for subject with the server's own secret.
func mintToken(t *testing.T, env *catalogueEnv, subject, role string) string {
	t.Helper()
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"role": role,
		"sub":  subject,
		"iat":  now.Unix(),
		"exp":  now.Add(30 * time.Minute).Unix(),
	}).SignedString(env.secret)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}
	return tok
}

// doJSON performs a JSON request against the router with an optional bearer
// token.
func doJSON(t *testing.T, h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// decodeBody decodes the response body into dst, failing the test on error.
func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(dst); err != nil {
		t.Fatalf("decode response body: %v (%s)", err, rec.Body)
	}
}

// createItem posts a single item and returns the created projection.
func createItem(t *testing.T, env *catalogueEnv, token, name string, priceTZS int, category string, available *bool) itemResp {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"priceTZS":%d,"category":%q}`, name, priceTZS, category)
	if available != nil {
		body = strings.TrimSuffix(body, "}") + fmt.Sprintf(`,"available":%t}`, *available)
	}
	rec := doJSON(t, env.h, http.MethodPost, "/catalogue-items", body, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create item %q status = %d, want 201 (%s)", name, rec.Code, rec.Body)
	}
	var item itemResp
	decodeBody(t, rec, &item)
	if item.Id == nil || *item.Id == "" {
		t.Fatalf("created item %q has no id", name)
	}
	return item
}

// myCatalogue fetches the merchant's own catalogue.
func myCatalogue(t *testing.T, env *catalogueEnv, token string) catalogueResp {
	t.Helper()
	rec := doJSON(t, env.h, http.MethodGet, "/catalogues/me", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get my catalogue status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out catalogueResp
	decodeBody(t, rec, &out)
	return out
}

// TestCreateItemAppearsInMyCatalogue: a created item is immediately visible
// in the merchant's own catalogue with price, availability and an id.
func TestCreateItemAppearsInMyCatalogue(t *testing.T) {
	env := setup(t)
	tok := mintToken(t, env, env.merchantPhone, "merchant")

	created := createItem(t, env, tok, "Chapati", 500, "", nil)
	if created.PriceTZS != 500 || created.Category != "" {
		t.Fatalf("created item = %+v", created)
	}
	if created.Available == nil || !*created.Available {
		t.Fatalf("created item available = %v, want true", created.Available)
	}

	cat := myCatalogue(t, env, tok)
	if len(cat.Items) != 1 {
		t.Fatalf("catalogue items = %d, want 1", len(cat.Items))
	}
	if cat.MerchantId != env.merchantID.String() {
		t.Fatalf("catalogue merchantId = %s, want %s", cat.MerchantId, env.merchantID)
	}
	if cat.Items[0].Id == nil || *cat.Items[0].Id != *created.Id ||
		cat.Items[0].Name != "Chapati" || cat.Items[0].PriceTZS != 500 {
		t.Fatalf("catalogue item = %+v", cat.Items[0])
	}
}

// TestReplaceRemovesOldAndAddsNew: a full replace soft-deletes everything not
// in the incoming set, restores rows referenced by owned id, and inserts the
// new items.
func TestReplaceRemovesOldAndAddsNew(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	tok := mintToken(t, env, env.merchantPhone, "merchant")

	a := createItem(t, env, tok, "A", 100, "", nil)
	b := createItem(t, env, tok, "B", 200, "", nil)
	c := createItem(t, env, tok, "C", 300, "", nil)

	putBody := fmt.Sprintf(`{"merchantId":%q,"items":[
		{"id":%q,"name":"A v2","priceTZS":1200,"category":"Snacks"},
		{"name":"D","priceTZS":3000,"category":"Snacks"}
	]}`, env.merchantID.String(), *a.Id)
	rec := doJSON(t, env.h, http.MethodPut, "/catalogues/me", putBody, tok)
	if rec.Code != http.StatusOK {
		t.Fatalf("replace status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var replaced catalogueResp
	decodeBody(t, rec, &replaced)
	if len(replaced.Items) != 2 {
		t.Fatalf("replaced items = %d, want 2 (%s)", len(replaced.Items), rec.Body)
	}

	cat := myCatalogue(t, env, tok)
	if len(cat.Items) != 2 {
		t.Fatalf("catalogue items = %d, want 2", len(cat.Items))
	}
	var gotA, gotD *itemResp
	for i := range cat.Items {
		switch cat.Items[i].Name {
		case "A v2":
			gotA = &cat.Items[i]
		case "D":
			gotD = &cat.Items[i]
		}
	}
	if gotA == nil || gotD == nil {
		t.Fatalf("catalogue after replace = %+v", cat.Items)
	}
	if gotA.Id == nil || *gotA.Id != *a.Id || gotA.PriceTZS != 1200 || gotA.Category != "Snacks" {
		t.Fatalf("restored item A = %+v", *gotA)
	}
	if gotD.PriceTZS != 3000 || gotD.Category != "Snacks" {
		t.Fatalf("new item D = %+v", *gotD)
	}

	// Rows B and C are soft-deleted; the "Snacks" category was auto-created.
	var deletedB, deletedC *time.Time
	if err := ctx.Err(); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(ctx,
		`SELECT deleted_at FROM catalogue_items WHERE id = $1`, *b.Id).Scan(&deletedB); err != nil {
		t.Fatalf("select B: %v", err)
	}
	if err := env.pool.QueryRow(ctx,
		`SELECT deleted_at FROM catalogue_items WHERE id = $1`, *c.Id).Scan(&deletedC); err != nil {
		t.Fatalf("select C: %v", err)
	}
	if deletedB == nil || deletedC == nil {
		t.Fatalf("B/C deleted_at = %v/%v, want set", deletedB, deletedC)
	}
	var n int64
	if err := env.pool.QueryRow(ctx,
		`SELECT count(*) FROM catalogue_items WHERE merchant_id = $1 AND deleted_at IS NULL`,
		env.merchantID).Scan(&n); err != nil {
		t.Fatalf("count live: %v", err)
	}
	if n != 2 {
		t.Fatalf("live items = %d, want 2", n)
	}
	var catN int64
	if err := env.pool.QueryRow(ctx,
		`SELECT count(*) FROM product_categories WHERE merchant_id = $1`, env.merchantID).Scan(&catN); err != nil {
		t.Fatalf("count categories: %v", err)
	}
	if catN != 1 {
		t.Fatalf("categories = %d, want 1", catN)
	}
}

// TestUpdateItemPriceAndAvailability: PATCH applies only the present fields;
// untouched fields keep their value.
func TestUpdateItemPriceAndAvailability(t *testing.T) {
	env := setup(t)
	tok := mintToken(t, env, env.merchantPhone, "merchant")
	item := createItem(t, env, tok, "Juice", 2000, "", nil)

	rec := doJSON(t, env.h, http.MethodPatch, "/catalogue-items/"+*item.Id,
		`{"priceTZS":999,"available":false}`, tok)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var updated itemResp
	decodeBody(t, rec, &updated)
	if updated.PriceTZS != 999 || updated.Available == nil || *updated.Available {
		t.Fatalf("updated item = %+v", updated)
	}
	if updated.Name != "Juice" {
		t.Fatalf("name changed to %q, want Juice", updated.Name)
	}

	// A later price-only patch keeps availability=false.
	rec = doJSON(t, env.h, http.MethodPatch, "/catalogue-items/"+*item.Id,
		`{"priceTZS":1500}`, tok)
	decodeBody(t, rec, &updated)
	if updated.PriceTZS != 1500 || updated.Available == nil || *updated.Available {
		t.Fatalf("item after price-only patch = %+v", updated)
	}

	cat := myCatalogue(t, env, tok)
	if len(cat.Items) != 1 || cat.Items[0].PriceTZS != 1500 || cat.Items[0].Available == nil || *cat.Items[0].Available {
		t.Fatalf("catalogue after update = %+v", cat.Items)
	}
}

// TestDeleteSoftDeletes: DELETE stamps deleted_at (204), the item vanishes
// from the owner catalogue but the row remains, and a second delete is
// ITEM_NOT_FOUND.
func TestDeleteSoftDeletes(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	tok := mintToken(t, env, env.merchantPhone, "merchant")
	item := createItem(t, env, tok, "Doomed", 700, "", nil)

	rec := doJSON(t, env.h, http.MethodDelete, "/catalogue-items/"+*item.Id, "", tok)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	cat := myCatalogue(t, env, tok)
	if len(cat.Items) != 0 {
		t.Fatalf("catalogue items after delete = %d, want 0 (%+v)", len(cat.Items), cat.Items)
	}
	var deletedAt *time.Time
	if err := env.pool.QueryRow(ctx,
		`SELECT deleted_at FROM catalogue_items WHERE id = $1`, *item.Id).Scan(&deletedAt); err != nil {
		t.Fatalf("select deleted row: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at not set on soft-deleted row")
	}

	rec = doJSON(t, env.h, http.MethodDelete, "/catalogue-items/"+*item.Id, "", tok)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("second delete status = %d, want 404", rec.Code)
	}
	var errBody struct {
		Code string `json:"code"`
	}
	decodeBody(t, rec, &errBody)
	if errBody.Code != "ITEM_NOT_FOUND" {
		t.Fatalf("second delete code = %q, want ITEM_NOT_FOUND", errBody.Code)
	}
}

// TestPublicCatalogueReturnsOnlyAvailable: the public view exposes only
// available, non-deleted items and works for non-merchant sessions (the
// handler never inspects the caller).
func TestPublicCatalogueReturnsOnlyAvailable(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	merchantTok := mintToken(t, env, env.merchantPhone, "merchant")
	customerTok := mintToken(t, env, "+255788000001", "customer")

	var catID uuid.UUID
	if err := env.pool.QueryRow(ctx,
		`INSERT INTO product_categories (merchant_id, name) VALUES ($1, $2) RETURNING id`,
		env.merchantID, "Snacks").Scan(&catID); err != nil {
		t.Fatalf("insert category: %v", err)
	}

	on := true
	off := false
	createItem(t, env, merchantTok, "Salted", 1000, "Snacks", &on)
	createItem(t, env, merchantTok, "Hidden", 500, "", &off)

	rec := doJSON(t, env.h, http.MethodGet, "/catalogues/"+env.merchantID.String(), "", customerTok)
	if rec.Code != http.StatusOK {
		t.Fatalf("public catalogue status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var pub catalogueResp
	decodeBody(t, rec, &pub)
	if pub.MerchantId != env.merchantID.String() {
		t.Fatalf("public merchantId = %s", pub.MerchantId)
	}
	if len(pub.Items) != 1 {
		t.Fatalf("public items = %d, want 1 (%+v)", len(pub.Items), pub.Items)
	}
	if pub.Items[0].Name != "Salted" || pub.Items[0].PriceTZS != 1000 || pub.Items[0].Category != "Snacks" {
		t.Fatalf("public item = %+v", pub.Items[0])
	}
	if pub.Items[0].Available == nil || !*pub.Items[0].Available {
		t.Fatalf("public item available = %v, want true", pub.Items[0].Available)
	}
}

// TestCreateItemUnknownCategoryFails: a category that does not belong to the
// merchant is CATEGORY_NOT_FOUND and nothing is inserted.
func TestCreateItemUnknownCategoryFails(t *testing.T) {
	env := setup(t)
	tok := mintToken(t, env, env.merchantPhone, "merchant")

	rec := doJSON(t, env.h, http.MethodPost, "/catalogue-items",
		`{"name":"Mystery","priceTZS":900,"category":"Nope"}`, tok)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody struct {
		Code string `json:"code"`
	}
	decodeBody(t, rec, &errBody)
	if errBody.Code != "CATEGORY_NOT_FOUND" {
		t.Fatalf("error code = %q, want CATEGORY_NOT_FOUND", errBody.Code)
	}
	if cat := myCatalogue(t, env, tok); len(cat.Items) != 0 {
		t.Fatalf("items after failed create = %d, want 0", len(cat.Items))
	}
}

// TestCreateItemNegativePriceFails: a negative priceTZS is rejected with
// VALIDATION_FAILED before any write.
func TestCreateItemNegativePriceFails(t *testing.T) {
	env := setup(t)
	tok := mintToken(t, env, env.merchantPhone, "merchant")

	rec := doJSON(t, env.h, http.MethodPost, "/catalogue-items",
		`{"name":"Freebie","priceTZS":-1,"category":""}`, tok)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody struct {
		Code string `json:"code"`
	}
	decodeBody(t, rec, &errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
	if cat := myCatalogue(t, env, tok); len(cat.Items) != 0 {
		t.Fatalf("items after failed create = %d, want 0", len(cat.Items))
	}
}

// TestOptionsRoundtrip: options land in the jsonb column and come back
// unchanged on create and update.
func TestOptionsRoundtrip(t *testing.T) {
	env := setup(t)
	tok := mintToken(t, env, env.merchantPhone, "merchant")

	createBody := `{"name":"Combo","priceTZS":8000,"category":"",
		"options":[{"name":"Size","choices":[{"label":"S","priceTZS":500},{"label":"L","priceTZS":1000}]}]}`
	rec := doJSON(t, env.h, http.MethodPost, "/catalogue-items", createBody, tok)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var created itemResp
	decodeBody(t, rec, &created)
	if created.Id == nil || len(created.Options) != 1 || created.Options[0].Name != "Size" ||
		len(created.Options[0].Choices) != 2 ||
		created.Options[0].Choices[0].Label != "S" || created.Options[0].Choices[0].PriceTZS != 500 ||
		created.Options[0].Choices[1].Label != "L" || created.Options[0].Choices[1].PriceTZS != 1000 {
		t.Fatalf("created options = %+v", created.Options)
	}

	cat := myCatalogue(t, env, tok)
	if len(cat.Items) != 1 || len(cat.Items[0].Options) != 1 ||
		cat.Items[0].Options[0].Choices[0].PriceTZS != 500 {
		t.Fatalf("catalogue options = %+v", cat.Items)
	}

	rec = doJSON(t, env.h, http.MethodPatch, "/catalogue-items/"+*created.Id,
		`{"options":[{"name":"Flavour","choices":[{"label":"Beef","priceTZS":0}]}]}`, tok)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch options status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var updated itemResp
	decodeBody(t, rec, &updated)
	if len(updated.Options) != 1 || updated.Options[0].Name != "Flavour" ||
		len(updated.Options[0].Choices) != 1 || updated.Options[0].Choices[0].Label != "Beef" {
		t.Fatalf("updated options = %+v", updated.Options)
	}

	cat = myCatalogue(t, env, tok)
	if len(cat.Items) != 1 || len(cat.Items[0].Options) != 1 || cat.Items[0].Options[0].Name != "Flavour" {
		t.Fatalf("catalogue options after patch = %+v", cat.Items)
	}
}
