//go:build integration

// CATALOGUE BULK / PRODUCT TEMPLATES / SERVICE CATEGORIES / STORE LOGS
// integration tests against real PostgreSQL + Redis (product_templates and
// store_logs, migration 00048).
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration \
//	  ./internal/api/ -run 'BulkCatalogue|ProductTemplate|ServiceCategory|StoreLog' -count=1
//
// This suite truncates ONLY product_templates and store_logs (tables this
// milestone owns). catalogue_items/product_categories are truncated by the
// catalogues package in another process, so this suite uses unique merchant
// users (phone prefix +255869) and deletes only its own rows
// (catalogue_items / product_categories by merchant id, then the users
// rows). service_categories_config is shared config: only this suite's own
// rows (distinct name prefix) are removed.
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

// catalogueBulkPrefix identifies every users row this suite inserts.
const catalogueBulkPrefix = "+255869"

// catalogueBulkSetup wires a persistent server, truncates the tables this
// milestone owns, and clears this suite's residue from earlier runs.
func catalogueBulkSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `TRUNCATE product_templates, store_logs`); err != nil {
		t.Fatalf("truncate product_templates/store_logs: %v", err)
	}

	var ids []uuid.UUID
	rows, err := pool.Query(ctx, `SELECT id FROM users WHERE phone LIKE '`+catalogueBulkPrefix+`%'`)
	if err != nil {
		t.Fatalf("find residue users: %v", err)
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatalf("scan residue user: %v", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate residue users: %v", err)
	}
	for _, id := range ids {
		var merchantID uuid.UUID
		err := pool.QueryRow(ctx,
			`SELECT id FROM merchants WHERE owner_user_id = $1`, id).Scan(&merchantID)
		if err == nil {
			if _, err := pool.Exec(ctx, `DELETE FROM catalogue_items WHERE merchant_id = $1`, merchantID); err != nil {
				t.Fatalf("delete residue catalogue items: %v", err)
			}
			if _, err := pool.Exec(ctx, `DELETE FROM product_categories WHERE merchant_id = $1`, merchantID); err != nil {
				t.Fatalf("delete residue product categories: %v", err)
			}
			if _, err := pool.Exec(ctx, `DELETE FROM merchants WHERE id = $1`, merchantID); err != nil {
				t.Fatalf("delete residue merchants: %v", err)
			}
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+catalogueBulkPrefix+`%'`); err != nil {
		t.Fatalf("delete residue users: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM service_categories_config WHERE name LIKE 'BulkTestSC %'`); err != nil {
		t.Fatalf("delete residue service categories: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		var ids []uuid.UUID
		rows, err := pool.Query(ctx, `SELECT id FROM users WHERE phone LIKE '`+catalogueBulkPrefix+`%'`)
		if err == nil {
			for rows.Next() {
				var id uuid.UUID
				if err := rows.Scan(&id); err == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
		}
		for _, id := range ids {
			var merchantID uuid.UUID
			err := pool.QueryRow(ctx,
				`SELECT id FROM merchants WHERE owner_user_id = $1`, id).Scan(&merchantID)
			if err == nil {
				_, _ = pool.Exec(ctx, `DELETE FROM store_logs WHERE merchant_id = $1`, merchantID)
				_, _ = pool.Exec(ctx, `DELETE FROM product_templates WHERE merchant_id = $1`, merchantID)
				_, _ = pool.Exec(ctx, `DELETE FROM catalogue_items WHERE merchant_id = $1`, merchantID)
				_, _ = pool.Exec(ctx, `DELETE FROM product_categories WHERE merchant_id = $1`, merchantID)
				_, _ = pool.Exec(ctx, `DELETE FROM merchants WHERE id = $1`, merchantID)
			}
		}
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+catalogueBulkPrefix+`%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM service_categories_config WHERE name LIKE 'BulkTestSC %'`)
	})
	return s, pool
}

// catalogueBulkMerchant creates a unique merchant user (the merchant id is
// the REAL merchants row id, merchant_linkage.go) and returns the id and a
// merchant-role token for it.
func catalogueBulkMerchant(t *testing.T, pool *pgxpool.Pool, s *Server, tag string) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", catalogueBulkPrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert catalogue bulk merchant %s: %v", tag, err)
	}
	return seedMerchantRow(t, pool, userID), tokenFor(t, s, phone, RoleMerchant, false)
}

// bulkCategory seeds one product_categories row for the merchant and returns
// its id.
func bulkCategory(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO product_categories (id, merchant_id, name) VALUES ($1, $2, $3)`,
		id, merchantID, name); err != nil {
		t.Fatalf("insert bulk category %s: %v", name, err)
	}
	return id
}

// bulkWireResult is the wire shape of the 202 bulk response.
type bulkWireResult struct {
	JobId    string `json:"jobId"`
	Status   string `json:"status"`
	Accepted int    `json:"accepted"`
	Rejected int    `json:"rejected"`
	Created  int    `json:"created"`
	Updated  int    `json:"updated"`
	Skipped  int    `json:"skipped"`
	Errors   []struct {
		Field   string `json:"field"`
		Message string `json:"message"`
	} `json:"errors"`
}

func doBulkPOST(t *testing.T, h http.Handler, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	return authedPOSTJSON(t, h, "/catalogue-items/bulk", body, token)
}

func decodeBulkBody(t *testing.T, rec *httptest.ResponseRecorder) bulkWireResult {
	t.Helper()
	var out bulkWireResult
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode bulk response: %v", err)
	}
	return out
}

func bulkItemsJSON(items []map[string]any) string {
	rows := make([]string, 0, len(items))
	for _, it := range items {
		payload, err := json.Marshal(it)
		if err != nil {
			panic(err)
		}
		rows = append(rows, string(payload))
	}
	return `{"items":[` + strings.Join(rows, ",") + `]}`
}

// TestBulkCatalogueItemsUpsertCounts: a 5-item bulk creates 5 items; the
// same owned ids upsert them (updated=5, created=0); an in-request duplicate
// is skipped.
func TestBulkCatalogueItemsUpsertCounts(t *testing.T) {
	s, pool := catalogueBulkSetup(t)
	merchantID, token := catalogueBulkMerchant(t, pool, s, "upsert")
	bulkCategory(t, pool, merchantID, "Bulk Cat")

	items := make([]map[string]any, 5)
	for i := range items {
		items[i] = map[string]any{"name": fmt.Sprintf("Bulk Item %d", i), "priceTZS": 1000 + i, "category": "Bulk Cat"}
	}
	rec := doBulkPOST(t, s.Router(), bulkItemsJSON(items), token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	out := decodeBulkBody(t, rec)
	if out.JobId == "" || out.Status != "completed" {
		t.Fatalf("job envelope = %+v", out)
	}
	if out.Created != 5 || out.Updated != 0 || out.Skipped != 0 {
		t.Fatalf("created = %d, updated = %d, skipped = %d, want 5/0/0", out.Created, out.Updated, out.Skipped)
	}
	if out.Accepted != 5 || out.Rejected != 0 {
		t.Fatalf("accepted = %d, rejected = %d, want 5/0", out.Accepted, out.Rejected)
	}

	var catalogue gen.Catalogue
	catRec := authedGET(t, s.Router(), "/catalogues/me", token)
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(catalogue.Items) != 5 {
		t.Fatalf("catalogue items = %d, want 5", len(catalogue.Items))
	}
	for _, it := range catalogue.Items {
		if it.Category != "Bulk Cat" {
			t.Fatalf("item %q category = %q, want Bulk Cat", it.Name, it.Category)
		}
	}

	// Re-send with the owned ids: every row is updated, nothing created.
	withIDs := make([]map[string]any, 5)
	for i, it := range catalogue.Items {
		withIDs[i] = map[string]any{
			"id": it.Id.String(), "name": fmt.Sprintf("Bulk Item %d", i),
			"priceTZS": 2000 + i, "category": "Bulk Cat",
		}
	}
	rec = doBulkPOST(t, s.Router(), bulkItemsJSON(withIDs), token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("re-bulk status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	out = decodeBulkBody(t, rec)
	if out.Created != 0 || out.Updated != 5 || out.Skipped != 0 {
		t.Fatalf("created = %d, updated = %d, skipped = %d, want 0/5/0", out.Created, out.Updated, out.Skipped)
	}

	// A duplicate name inside one request is applied once, skipped once.
	dups := []map[string]any{
		{"name": "Dupe Item", "priceTZS": 300, "category": "Bulk Cat"},
		{"name": "Dupe Item", "priceTZS": 400, "category": "Bulk Cat"},
	}
	rec = doBulkPOST(t, s.Router(), bulkItemsJSON(dups), token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("dupe bulk status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	out = decodeBulkBody(t, rec)
	if out.Created != 1 || out.Skipped != 1 {
		t.Fatalf("created = %d, skipped = %d, want 1/1 (%+v)", out.Created, out.Skipped, out.Errors)
	}
}

// TestBulkCatalogueItemsValidationErrors: an unknown category, a blank name
// and a negative price are per-item errors on the 422
// BULK_OPERATION_INVALID envelope, and nothing is applied. Name/price bounds
// validate before the merchant gate, so the category error is asserted in
// its own request (categories resolve against the merchant after the gate).
func TestBulkCatalogueItemsValidationErrors(t *testing.T) {
	s, pool := catalogueBulkSetup(t)
	merchantID, token := catalogueBulkMerchant(t, pool, s, "validate")

	rec := doBulkPOST(t, s.Router(), `{"items":[
		{"name":"Good","priceTZS":100,"category":"No Such Category"}
	]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("category status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var validation gen.ValidationResponse
	if err := json.NewDecoder(rec.Body).Decode(&validation); err != nil {
		t.Fatalf("decode validation: %v", err)
	}
	if validation.Code != "BULK_OPERATION_INVALID" {
		t.Fatalf("code = %q, want BULK_OPERATION_INVALID", validation.Code)
	}
	if len(validation.Errors) != 1 || validation.Errors[0].Field != "items[0].category" {
		t.Fatalf("errors = %+v, want one items[0].category", validation.Errors)
	}

	rec = doBulkPOST(t, s.Router(), `{"items":[
		{"name":"","priceTZS":100,"category":""},
		{"name":"Bad Price","priceTZS":-5,"category":""}
	]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bounds status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	validation = gen.ValidationResponse{}
	if err := json.NewDecoder(rec.Body).Decode(&validation); err != nil {
		t.Fatalf("decode validation: %v", err)
	}
	if validation.Code != "BULK_OPERATION_INVALID" {
		t.Fatalf("code = %q, want BULK_OPERATION_INVALID", validation.Code)
	}
	if len(validation.Errors) != 2 {
		t.Fatalf("errors = %d, want 2 (%+v)", len(validation.Errors), validation.Errors)
	}
	want := map[string]bool{
		"items[0].name":     true,
		"items[1].priceTZS": true,
	}
	for _, e := range validation.Errors {
		if !want[e.Field] {
			t.Fatalf("unexpected error field %q (%s)", e.Field, e.Message)
		}
	}

	var live int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM catalogue_items WHERE merchant_id = $1`, merchantID).Scan(&live); err != nil {
		t.Fatalf("count items: %v", err)
	}
	if live != 0 {
		t.Fatalf("live items = %d, want 0 (nothing applied)", live)
	}
}

// TestProductTemplateCreateDuplicateConflict: creating a template validates
// name/price/category, answers 201 with the template, rejects a duplicate
// name with 409 TEMPLATE_KEY_EXISTS, an unknown category with 404
// CATEGORY_NOT_FOUND, and the list returns the created template.
func TestProductTemplateCreateDuplicateConflict(t *testing.T) {
	s, pool := catalogueBulkSetup(t)
	merchantID, token := catalogueBulkMerchant(t, pool, s, "template")

	unknownCat := authedPOSTJSON(t, s.Router(), "/product-templates",
		`{"name":"Breakfast Set","priceTZS":5000,"category":"No Such Category"}`, token)
	if unknownCat.Code != http.StatusNotFound {
		t.Fatalf("unknown category status = %d, want 404 (%s)", unknownCat.Code, unknownCat.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(unknownCat.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "CATEGORY_NOT_FOUND" {
		t.Fatalf("code = %q, want CATEGORY_NOT_FOUND", errBody.Code)
	}

	bulkCategory(t, pool, merchantID, "Sets")
	rec := authedPOSTJSON(t, s.Router(), "/product-templates",
		`{"name":"Breakfast Set","priceTZS":5000,"category":"Sets"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var template gen.ProductTemplate
	if err := json.NewDecoder(rec.Body).Decode(&template); err != nil {
		t.Fatalf("decode template: %v", err)
	}
	if template.Id == nil || template.Name != "Breakfast Set" || template.CreatedAt == nil {
		t.Fatalf("template = %+v", template)
	}

	rec = authedPOSTJSON(t, s.Router(), "/product-templates",
		`{"name":"Breakfast Set","priceTZS":6000,"category":"Sets"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	errBody = gen.ErrorResponse{}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode duplicate error: %v", err)
	}
	if errBody.Code != "TEMPLATE_KEY_EXISTS" {
		t.Fatalf("code = %q, want TEMPLATE_KEY_EXISTS", errBody.Code)
	}

	rec = authedGET(t, s.Router(), "/product-templates", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var templates []gen.ProductTemplate
	if err := json.NewDecoder(rec.Body).Decode(&templates); err != nil {
		t.Fatalf("decode templates: %v", err)
	}
	if len(templates) != 1 || templates[0].Name != "Breakfast Set" {
		t.Fatalf("templates = %+v, want one Breakfast Set", templates)
	}
}

// TestServiceCategoriesList: only active service_categories_config rows are
// returned, ordered by sort_order.
func TestServiceCategoriesList(t *testing.T) {
	s, pool := catalogueBulkSetup(t)
	_, token := catalogueBulkMerchant(t, pool, s, "service-cat")

	ctx := context.Background()
	insert := func(name string, sortOrder int, active bool) {
		t.Helper()
		if _, err := pool.Exec(ctx,
			`INSERT INTO service_categories_config (name, sort_order, active) VALUES ($1, $2, $3)`,
			name, sortOrder, active); err != nil {
			t.Fatalf("insert service category %s: %v", name, err)
		}
	}
	insert("BulkTestSC Last", 30, true)
	insert("BulkTestSC First", 10, true)
	insert("BulkTestSC Hidden", 20, false)

	rec := authedGET(t, s.Router(), "/service-categories", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var categories []gen.ServiceCategoryConfig
	if err := json.NewDecoder(rec.Body).Decode(&categories); err != nil {
		t.Fatalf("decode categories: %v", err)
	}

	var names []string
	for _, c := range categories {
		if c.Id == uuid.Nil || c.PricingModel == "" {
			t.Fatalf("category %+v misses required fields", c)
		}
		if strings.HasPrefix(c.Name, "BulkTestSC ") {
			names = append(names, c.Name)
		}
	}
	if len(names) != 2 || names[0] != "BulkTestSC First" || names[1] != "BulkTestSC Last" {
		t.Fatalf("own categories in order = %v, want [First Last]", names)
	}
	for _, c := range categories {
		if c.Name == "BulkTestSC Hidden" {
			t.Fatalf("inactive category surfaced: %+v", c)
		}
	}
}

// storeLogWire is the wire shape of one /store/logs entry.
type storeLogWire struct {
	At      string          `json:"at"`
	Action  string          `json:"action"`
	Actor   string          `json:"actor"`
	Details json.RawMessage `json:"details,omitempty"`
	Id      string          `json:"id,omitempty"`
	Entity  string          `json:"entity,omitempty"`
	Source  string          `json:"source,omitempty"`
}

// TestStoreLogListUnion: CreateProductTemplate writes a store_logs row (the
// handler write path) and a directly-inserted audit_logs row referencing the
// merchant surfaces in the same list under source audit.
func TestStoreLogListUnion(t *testing.T) {
	s, pool := catalogueBulkSetup(t)
	merchantID, token := catalogueBulkMerchant(t, pool, s, "store-log")

	bulkCategory(t, pool, merchantID, "Sets")
	rec := authedPOSTJSON(t, s.Router(), "/product-templates",
		`{"name":"Lunch Set","priceTZS":7000,"category":"Sets"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201 (%s)", rec.Code, rec.Body)
	}

	ctx := context.Background()
	auditID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO audit_logs
		(id, actor_id, action, entity_type, entity_id, details, created_at)
		VALUES ($1, $2, 'admin moderate merchant', 'merchants', $3, '{"note":"moderated"}', now())`,
		auditID, uuid.Nil, merchantID.String()); err != nil {
		t.Fatalf("insert audit log: %v", err)
	}

	rec = authedGET(t, s.Router(), "/store/logs", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var entries []storeLogWire
	if err := json.NewDecoder(rec.Body).Decode(&entries); err != nil {
		t.Fatalf("decode store logs: %v", err)
	}
	if len(entries) < 2 {
		t.Fatalf("entries = %d, want >= 2 (%+v)", len(entries), entries)
	}
	var sawStore, sawAudit bool
	for _, e := range entries {
		switch e.Source {
		case "store":
			if e.Action == "catalogue.template.create" && e.Entity == "product_templates" {
				sawStore = true
			}
		case "audit":
			if e.Action == "admin moderate merchant" && strings.HasPrefix(e.Id, auditID.String()) {
				sawAudit = true
			}
		default:
			t.Fatalf("unknown source %q in %+v", e.Source, e)
		}
	}
	if !sawStore {
		t.Fatalf("no store-source template.create entry in %+v", entries)
	}
	if !sawAudit {
		t.Fatalf("no audit-source entry in %+v", entries)
	}
	// Newest first: the store log and the audit row both land at ~now; the
	// template action happened before the audit insert, so the audit entry
	// must lead the page.
	if entries[0].Source != "audit" {
		t.Fatalf("first entry = %+v, want the audit entry first", entries[0])
	}
}

// TestStoreLogPagination: 25 store_logs rows page at 20 + 5 with the keyset
// cursor on X-Next-Cursor; the second page carries no next cursor.
func TestStoreLogPagination(t *testing.T) {
	s, pool := catalogueBulkSetup(t)
	merchantID, token := catalogueBulkMerchant(t, pool, s, "pagination")

	ctx := context.Background()
	for i := 0; i < 25; i++ {
		if _, err := pool.Exec(ctx, `INSERT INTO store_logs
			(merchant_id, action, entity) VALUES ($1, $2, $3)`,
			merchantID, fmt.Sprintf("seed.op.%d", i), "seed"); err != nil {
			t.Fatalf("insert store log %d: %v", i, err)
		}
	}

	rec := authedGET(t, s.Router(), "/store/logs?limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page1 []storeLogWire
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 = %d, want 20", len(page1))
	}
	next := rec.Header().Get("X-Next-Cursor")
	if next == "" {
		t.Fatal("page 1 missing X-Next-Cursor")
	}

	rec = authedGET(t, s.Router(), "/store/logs?limit=20&cursor="+next, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page2 []storeLogWire
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 = %d, want 5", len(page2))
	}
	if got := rec.Header().Get("X-Next-Cursor"); got != "" {
		t.Fatalf("page 2 carried X-Next-Cursor %q, want none", got)
	}
	// Pages never overlap.
	seen := make(map[string]bool, 25)
	for _, e := range append(append([]storeLogWire{}, page1...), page2...) {
		if seen[e.Id] {
			t.Fatalf("duplicate entry %s across pages", e.Id)
		}
		seen[e.Id] = true
	}

	// A malformed cursor is a validation failure.
	rec = authedGET(t, s.Router(), "/store/logs?cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode bad-cursor error: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("bad-cursor code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}
