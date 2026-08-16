//go:build integration

// PRODUCT TEMPLATE apply/update/delete integration tests against real
// PostgreSQL + Redis (product_templates migration 00048, chain_stores 00022,
// catalogue_items 00005).
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration \
//	  ./internal/api/ -run 'ProductTemplate' -count=1
//
// This suite never truncates shared tables: product_templates/store_logs are
// owned by the catalogue-bulk suite (truncated in its own process) and
// chain_stores by the chain suite, so this suite keeps strictly to its own
// rows — unique merchant users (phone prefix +255868) with their merchants,
// chain_stores (cascade), templates, categories and catalogue items — and
// removes exactly those before and after the run.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// ptplPhonePrefix identifies every users row this suite inserts.
const ptplPhonePrefix = "+255868"

// ptplResidueUsers lists the users rows this suite created in earlier runs
// (their merchants and chain_stores cascade away on delete).
func ptplResidueUsers(pool *pgxpool.Pool, ctx context.Context) []uuid.UUID {
	var ids []uuid.UUID
	rows, err := pool.Query(ctx, `SELECT id FROM users WHERE phone LIKE '`+ptplPhonePrefix+`%'`)
	if err != nil {
		return nil
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	return ids
}

// ptplDeleteOwn removes every row this suite's users own: the catalogue
// rows keyed by the users id (no FK, so manual) and then the users rows
// (cascade to merchants and chain_stores).
func ptplDeleteOwn(pool *pgxpool.Pool, ctx context.Context) {
	for _, id := range ptplResidueUsers(pool, ctx) {
		_, _ = pool.Exec(ctx, `DELETE FROM store_logs WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM product_templates WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM catalogue_items WHERE merchant_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM product_categories WHERE merchant_id = $1`, id)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+ptplPhonePrefix+`%'`)
}

// ptplSetup wires a persistent server and clears this suite's residue from
// earlier runs.
func ptplSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	ptplDeleteOwn(pool, ctx)
	t.Cleanup(func() { ptplDeleteOwn(pool, context.Background()) })
	return s, pool
}

// ptplMerchant inserts a unique merchant user + merchants row pair and
// returns the user id (the catalogue merchant id), the merchants row id and
// a merchant-role token.
func ptplMerchant(t *testing.T, pool *pgxpool.Pool, s *Server, tag string) (uuid.UUID, uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", ptplPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	merchantID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert product template merchant user %s: %v", tag, err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO merchants (id, owner_user_id, business_name, verification)
		 VALUES ($1, $2, $3, 'approved')`,
		merchantID, userID, "PTpl "+tag); err != nil {
		t.Fatalf("insert product template merchant %s: %v", tag, err)
	}
	return userID, merchantID, tokenFor(t, s, phone, RoleMerchant, false)
}

// ptplCategory inserts one product_categories row for the catalogue merchant
// and returns its id.
func ptplCategory(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO product_categories (id, merchant_id, name) VALUES ($1, $2, $3)`,
		id, merchantID, name); err != nil {
		t.Fatalf("insert product template category %s: %v", name, err)
	}
	return id
}

// ptplTemplate inserts one product_templates row and returns its id.
func ptplTemplate(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string, price int64, categoryID *uuid.UUID, options string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO product_templates (id, merchant_id, name, price_tzs, category_id, options)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
		id, merchantID, name, price, categoryID, options); err != nil {
		t.Fatalf("insert product template %s: %v", name, err)
	}
	return id
}

// ptplStore inserts one chain_stores row for the merchant and returns its id.
func ptplStore(t *testing.T, pool *pgxpool.Pool, ownerID, merchantID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO chain_stores (id, owner_user_id, merchant_id, name, active)
		 VALUES ($1, $2, $3, $4, true)`,
		id, ownerID, merchantID, name); err != nil {
		t.Fatalf("insert chain store %s: %v", name, err)
	}
	return id
}

// ptplItemCount counts the catalogue_items rows of one catalogue merchant.
func ptplItemCount(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM catalogue_items WHERE merchant_id = $1`, merchantID).Scan(&n); err != nil {
		t.Fatalf("count catalogue items: %v", err)
	}
	return n
}

// assertJSONEqual compares a jsonb scan against the expected JSON document,
// ignoring the whitespace normalisation jsonb applies to its output.
func assertJSONEqual(t *testing.T, got []byte, want string) {
	t.Helper()
	var gotV, wantV any
	if err := json.Unmarshal(got, &gotV); err != nil {
		t.Fatalf("decode got json %s: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &wantV); err != nil {
		t.Fatalf("decode want json %s: %v", want, err)
	}
	if !reflect.DeepEqual(gotV, wantV) {
		t.Fatalf("options = %s, want %s", got, want)
	}
}

// TestProductTemplateUpdateFlow: a partial PATCH rewrites only the given
// fields; name collisions 409, negative prices 422, foreign categories 404
// and unknown or foreign templates 404.
func TestProductTemplateUpdateFlow(t *testing.T) {
	s, pool := ptplSetup(t)
	_, merchantID, token := ptplMerchant(t, pool, s, "update")
	categoryID := ptplCategory(t, pool, merchantID, "PTpl Cat A")
	templateID := ptplTemplate(t, pool, merchantID, "Pasta", 5000, &categoryID, `[{"name":"Size","choices":[{"label":"Small","priceTZS":0}]}]`)

	patch := func(t *testing.T, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		return authedDo(t, s.Router(), http.MethodPatch, path, body, token)
	}

	// Full rewrite: name, price, category and options all land on the row.
	rec := patch(t, "/product-templates/"+templateID.String(),
		`{"name":"Pasta Nuevo","priceTZS":6000,"category":"PTpl Cat A","options":[{"name":"Spicy","choices":[]}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("full update status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var updated struct {
		Id        string `json:"id"`
		Name      string `json:"name"`
		CreatedAt string `json:"createdAt"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if updated.Id != templateID.String() || updated.Name != "Pasta Nuevo" || updated.CreatedAt == "" {
		t.Fatalf("update response = %+v", updated)
	}
	var (
		name    string
		price   int64
		catID   *uuid.UUID
		options []byte
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT name, price_tzs, category_id, options FROM product_templates WHERE id = $1`,
		templateID).Scan(&name, &price, &catID, &options); err != nil {
		t.Fatalf("read updated template: %v", err)
	}
	if name != "Pasta Nuevo" || price != 6000 || catID == nil || *catID != categoryID {
		t.Fatalf("updated row = %q/%d/%v", name, price, catID)
	}
	assertJSONEqual(t, options, `[{"name":"Spicy","choices":[]}]`)

	// A partial PATCH touches only price.
	rec = patch(t, "/product-templates/"+templateID.String(), `{"priceTZS":7000}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("price-only update status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	rec = patch(t, "/product-templates/"+templateID.String(), `{"name":"Pasta Nuevo"}`)
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode partial update response: %v", err)
	}
	if updated.Name != "Pasta Nuevo" {
		t.Fatalf("partial update name = %q", updated.Name)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT price_tzs FROM product_templates WHERE id = $1`, templateID).Scan(&price); err != nil {
		t.Fatalf("read price: %v", err)
	}
	if price != 7000 {
		t.Fatalf("price = %d, want 7000", price)
	}

	// A blank category clears the link.
	rec = patch(t, "/product-templates/"+templateID.String(), `{"category":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear category status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT category_id FROM product_templates WHERE id = $1`, templateID).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	if catID != nil {
		t.Fatalf("category = %v, want NULL", catID)
	}

	// Validation: negative price.
	rec = patch(t, "/product-templates/"+templateID.String(), `{"priceTZS":-1}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("negative price status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	// Validation: blank name.
	rec = patch(t, "/product-templates/"+templateID.String(), `{"name":"  "}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("blank name status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	// Category must belong to the merchant.
	rec = patch(t, "/product-templates/"+templateID.String(), `{"category":"Foreign Cat"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign category status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode category error: %v", err)
	}
	if errBody.Code != "CATEGORY_NOT_FOUND" {
		t.Fatalf("category error code = %q, want CATEGORY_NOT_FOUND", errBody.Code)
	}

	// Name must stay unique per merchant.
	secondID := ptplTemplate(t, pool, merchantID, "Pizza", 4000, nil, `[]`)
	rec = patch(t, "/product-templates/"+templateID.String(), `{"name":"Pizza"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate name status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	errBody = gen.ErrorResponse{}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode conflict error: %v", err)
	}
	if errBody.Code != "TEMPLATE_KEY_EXISTS" {
		t.Fatalf("conflict code = %q, want TEMPLATE_KEY_EXISTS", errBody.Code)
	}
	_ = secondID

	// Unknown template.
	rec = patch(t, "/product-templates/"+uuid.NewString(), `{"name":"Nope"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown template status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	// A template of another merchant is invisible.
	_, otherMerchant, otherToken := ptplMerchant(t, pool, s, "foreign-update")
	otherID := ptplTemplate(t, pool, otherMerchant, "Foreign", 100, nil, `[]`)
	rec = authedDo(t, s.Router(), http.MethodPatch, "/product-templates/"+otherID.String(), `{"name":"Hijack"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign template update status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	// And the owner still sees it untouched.
	rec = authedDo(t, s.Router(), http.MethodPatch, "/product-templates/"+otherID.String(), `{"name":"Owned"}`, otherToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner update status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
}

// TestProductTemplateDeleteFlow: DELETE removes the merchant's template
// (204), and unknown or foreign ids are TEMPLATE_NOT_FOUND.
func TestProductTemplateDeleteFlow(t *testing.T) {
	s, pool := ptplSetup(t)
	_, merchantID, token := ptplMerchant(t, pool, s, "delete")
	templateID := ptplTemplate(t, pool, merchantID, "Obsolete", 100, nil, `[]`)

	rec := authedDo(t, s.Router(), http.MethodDelete, "/product-templates/"+templateID.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM product_templates WHERE id = $1`, templateID).Scan(&n); err != nil {
		t.Fatalf("count template: %v", err)
	}
	if n != 0 {
		t.Fatalf("templates left = %d, want 0", n)
	}

	// Deleting again answers TEMPLATE_NOT_FOUND.
	rec = authedDo(t, s.Router(), http.MethodDelete, "/product-templates/"+templateID.String(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("re-delete status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode delete error: %v", err)
	}
	if errBody.Code != "TEMPLATE_NOT_FOUND" {
		t.Fatalf("delete error code = %q, want TEMPLATE_NOT_FOUND", errBody.Code)
	}

	// A foreign merchant's template is invisible.
	_, otherMerchant, otherToken := ptplMerchant(t, pool, s, "foreign-delete")
	otherID := ptplTemplate(t, pool, otherMerchant, "Foreign", 100, nil, `[]`)
	rec = authedDo(t, s.Router(), http.MethodDelete, "/product-templates/"+otherID.String(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign delete status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, s.Router(), http.MethodDelete, "/product-templates/"+otherID.String(), "", otherToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("owner delete status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
}

// TestProductTemplateApplyFlow: applying a template inserts one
// catalogue_items row per owned store in one transaction (204); foreign
// stores 404 and nothing is inserted; an unknown template is
// TEMPLATE_NOT_FOUND.
func TestProductTemplateApplyFlow(t *testing.T) {
	s, pool := ptplSetup(t)
	userID, merchantID, token := ptplMerchant(t, pool, s, "apply")
	categoryID := ptplCategory(t, pool, merchantID, "PTpl Cat B")
	templateID := ptplTemplate(t, pool, merchantID, "Chapati Platter", 2500, &categoryID,
		`[{"name":"Size","choices":[{"label":"Small","priceTZS":0},{"label":"Large","priceTZS":1500}]}]`)
	// chain_stores is unique per (owner_user_id, merchant_id) and a user owns
	// at most one merchants row, so the owner's two stores span two merchants
	// rows owned by other users (the chain-suite model: an owner runs stores
	// across merchants).
	_, merchantB, _ := ptplMerchant(t, pool, s, "apply-b")
	_, merchantC, _ := ptplMerchant(t, pool, s, "apply-c")
	storeA := ptplStore(t, pool, userID, merchantID, "PTpl Store A")
	storeB := ptplStore(t, pool, userID, merchantB, "PTpl Store B")
	_ = merchantC

	rec := authedPOSTJSON(t, s.Router(), "/product-templates/"+templateID.String()+"/apply",
		`{"storeIds":["`+storeA.String()+`","`+storeB.String()+`"]}`, token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("apply status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	if n := ptplItemCount(t, pool, merchantID); n != 2 {
		t.Fatalf("catalogue items = %d, want 2", n)
	}

	var (
		name    string
		price   int64
		catID   *uuid.UUID
		options []byte
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT name, price_tzs, category_id, options FROM catalogue_items
		 WHERE merchant_id = $1 ORDER BY created_at LIMIT 1`, merchantID).
		Scan(&name, &price, &catID, &options); err != nil {
		t.Fatalf("read applied item: %v", err)
	}
	if name != "Chapati Platter" || price != 2500 || catID == nil || *catID != categoryID {
		t.Fatalf("applied item = %q/%d/%v", name, price, catID)
	}
	assertJSONEqual(t, options, `[{"name":"Size","choices":[{"label":"Small","priceTZS":0},{"label":"Large","priceTZS":1500}]}]`)

	// A foreign store id blocks the whole apply: 404 and nothing inserted.
	otherUser, otherMerchant, _ := ptplMerchant(t, pool, s, "foreign-store")
	foreignStore := ptplStore(t, pool, otherUser, otherMerchant, "PTpl Foreign Store")
	rec = authedPOSTJSON(t, s.Router(), "/product-templates/"+templateID.String()+"/apply",
		`{"storeIds":["`+storeA.String()+`","`+foreignStore.String()+`"]}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign store status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode foreign store error: %v", err)
	}
	if errBody.Code != "NOT_FOUND" {
		t.Fatalf("foreign store code = %q, want NOT_FOUND", errBody.Code)
	}
	if n := ptplItemCount(t, pool, merchantID); n != 2 {
		t.Fatalf("items after blocked apply = %d, want 2", n)
	}

	// An unknown or foreign template is TEMPLATE_NOT_FOUND.
	rec = authedPOSTJSON(t, s.Router(), "/product-templates/"+uuid.NewString()+"/apply",
		`{"storeIds":["`+storeA.String()+`"]}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown template apply status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	otherTemplate := ptplTemplate(t, pool, otherMerchant, "Foreign Tpl", 100, nil, `[]`)
	rec = authedPOSTJSON(t, s.Router(), "/product-templates/"+otherTemplate.String()+"/apply",
		`{"storeIds":["`+storeA.String()+`"]}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign template apply status = %d, want 404 (%s)", rec.Code, rec.Body)
	}

	// An empty storeIds list is VALIDATION_FAILED.
	rec = authedPOSTJSON(t, s.Router(), "/product-templates/"+templateID.String()+"/apply", `{"storeIds":[]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty storeIds status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if n := ptplItemCount(t, pool, merchantID); n != 2 {
		t.Fatalf("items after empty apply = %d, want 2", n)
	}

	// A merchant without chain stores cannot apply at all (404 NOT_FOUND for
	// any requested store) and never for another merchant's template.
	lonerUser, _, lonerToken := ptplMerchant(t, pool, s, "storeless")
	_ = lonerUser
	rec = authedPOSTJSON(t, s.Router(), "/product-templates/"+templateID.String()+"/apply",
		`{"storeIds":["`+storeA.String()+`"]}`, lonerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("storeless apply status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}
