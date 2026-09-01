//go:build integration

// CATALOGUE IMPORT / EXPORT integration tests against real PostgreSQL +
// Redis (catalogue_items + product_categories, migration 00005).
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration \
//	  ./internal/api/ -run 'CatalogueImport|CatalogueExport|ImportCatalogue|ExportCatalogue' -count=1
//
// This suite never truncates shared tables: the catalogues package truncates
// catalogue_items and product_categories in its own process, so this suite
// uses unique merchant users (phone prefix +255867) and deletes only its own
// rows (catalogue_items / product_categories by merchant id, then the users
// rows).
package api

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// catalogueIOPrefix identifies every users row this suite inserts.
const catalogueIOPrefix = "+255867"

// catalogueIOSetup wires a persistent server and clears this suite's residue
// from earlier runs. It only touches rows it owns.
func catalogueIOSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()

	var ids []uuid.UUID
	rows, err := pool.Query(ctx, `SELECT id FROM users WHERE phone LIKE '`+catalogueIOPrefix+`%'`)
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
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+catalogueIOPrefix+`%'`); err != nil {
		t.Fatalf("delete residue users: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		var ids []uuid.UUID
		rows, err := pool.Query(ctx, `SELECT id FROM users WHERE phone LIKE '`+catalogueIOPrefix+`%'`)
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
				_, _ = pool.Exec(ctx, `DELETE FROM catalogue_items WHERE merchant_id = $1`, merchantID)
				_, _ = pool.Exec(ctx, `DELETE FROM product_categories WHERE merchant_id = $1`, merchantID)
				_, _ = pool.Exec(ctx, `DELETE FROM merchants WHERE id = $1`, merchantID)
			}
		}
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+catalogueIOPrefix+`%'`)
	})
	return s, pool
}

// catalogueIOMerchant creates a unique merchant user (the catalogue-scoped
// merchant id is the REAL merchants row id, merchant_linkage.go) and returns
// the merchant id and a merchant-role token for it.
func catalogueIOMerchant(t *testing.T, pool *pgxpool.Pool, s *Server, tag string) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", catalogueIOPrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert catalogue merchant %s: %v", tag, err)
	}
	return seedMerchantRow(t, pool, userID), tokenFor(t, s, phone, RoleMerchant, false)
}

// catalogueImportWireResult is the wire shape of the 202 import response.
type catalogueImportWireResult struct {
	JobId   string `json:"jobId"`
	Status  string `json:"status"`
	Created int    `json:"created"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
	Errors  []struct {
		Field   string `json:"field"`
		Message string `json:"message"`
	} `json:"errors"`
}

// doImportPOST sends an authenticated import request and returns the
// recorder.
func doImportPOST(t *testing.T, h http.Handler, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	return authedPOSTJSON(t, h, "/catalogues/import", body, token)
}

// importRowsJSON builds the rows array for a batch of names at the given
// price/category.
func importRowsJSON(names []string, price int, category string) string {
	rows := make([]string, 0, len(names))
	for _, n := range names {
		rows = append(rows, fmt.Sprintf(`{"name":%q,"priceTZS":%d,"category":%q}`,
			n, price, category))
	}
	return `{"rows":[` + strings.Join(rows, ",") + `]}`
}

// decodeImportBody decodes the 202 import response and fails the test on
// error.
func decodeImportBody(t *testing.T, rec *httptest.ResponseRecorder) catalogueImportWireResult {
	t.Helper()
	var out catalogueImportWireResult
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode import response: %v", err)
	}
	return out
}

// TestCatalogueImportCreatesItems: a 10-item import is applied atomically
// and reports created=10 with the job envelope.
func TestCatalogueImportCreatesItems(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	merchantID, token := catalogueIOMerchant(t, pool, s, "create")
	names := make([]string, 10)
	for i := range names {
		names[i] = fmt.Sprintf("Import Item %d", i)
	}

	rec := doImportPOST(t, s.Router(), importRowsJSON(names, 1000, "Imported"), token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	out := decodeImportBody(t, rec)
	if out.Status != "completed" {
		t.Fatalf("status = %q, want completed", out.Status)
	}
	if out.JobId == "" {
		t.Fatal("missing jobId")
	}
	if out.Created != 10 {
		t.Fatalf("created = %d, want 10", out.Created)
	}
	if out.Updated != 0 || out.Skipped != 0 {
		t.Fatalf("updated = %d, skipped = %d, want 0/0", out.Updated, out.Skipped)
	}

	catRec := authedGET(t, s.Router(), "/catalogues/me", token)
	if catRec.Code != http.StatusOK {
		t.Fatalf("get catalogue status = %d (%s)", catRec.Code, catRec.Body)
	}
	var catalogue gen.Catalogue
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(catalogue.Items) != 10 {
		t.Fatalf("catalogue items = %d, want 10", len(catalogue.Items))
	}
	var live int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM catalogue_items WHERE merchant_id = $1 AND deleted_at IS NULL`,
		merchantID).Scan(&live); err != nil {
		t.Fatalf("count live items: %v", err)
	}
	if live != 10 {
		t.Fatalf("live items = %d, want 10", live)
	}
}

// TestCatalogueImportUpdatesById: re-importing with the same ids updates the
// existing rows (updated=10, created=0) and the new values are visible.
func TestCatalogueImportUpdatesById(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	_, token := catalogueIOMerchant(t, pool, s, "update")

	rec := doImportPOST(t, s.Router(), importRowsJSON([]string{"A", "B"}, 100, "Cat"), token)
	if out := decodeImportBody(t, rec); out.Created != 2 {
		t.Fatalf("created = %d, want 2", out.Created)
	}

	var catalogue gen.Catalogue
	catRec := authedGET(t, s.Router(), "/catalogues/me", token)
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	ids := make([]string, 0, 2)
	for _, it := range catalogue.Items {
		if it.Id != nil {
			ids = append(ids, it.Id.String())
		}
	}
	if len(ids) != 2 {
		t.Fatalf("ids = %d, want 2", len(ids))
	}

	rows := make([]string, 0, 2)
	for i, id := range ids {
		rows = append(rows, fmt.Sprintf(`{"id":%q,"name":"Updated %d","priceTZS":%d,"category":"Cat"}`,
			id, i, 500+i))
	}
	rec = doImportPOST(t, s.Router(), `{"rows":[`+strings.Join(rows, ",")+`]}`, token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("re-import status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	out := decodeImportBody(t, rec)
	if out.Created != 0 || out.Updated != 2 {
		t.Fatalf("created = %d, updated = %d, want 0/2", out.Created, out.Updated)
	}

	var catalogue2 gen.Catalogue
	catRec = authedGET(t, s.Router(), "/catalogues/me", token)
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue2); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(catalogue2.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(catalogue2.Items))
	}
	for _, it := range catalogue2.Items {
		if it.PriceTZS < 500 {
			t.Fatalf("item %q price = %d, want >= 500", it.Name, it.PriceTZS)
		}
	}
}

// TestCatalogueImportReplaceSoftDeletes: replace=true removes (soft-deletes)
// items not in the incoming set; rows are retained and excluded from views.
func TestCatalogueImportReplaceSoftDeletes(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	merchantID, token := catalogueIOMerchant(t, pool, s, "replace")

	rec := doImportPOST(t, s.Router(), importRowsJSON([]string{"Keep", "Drop 1", "Drop 2"}, 100, ""), token)
	if out := decodeImportBody(t, rec); out.Created != 3 {
		t.Fatalf("created = %d, want 3", out.Created)
	}

	// Re-import by id with replace=true: "Keep" is restored (updated) and
	// the other two stay soft-deleted.
	var catalogue gen.Catalogue
	catRec := authedGET(t, s.Router(), "/catalogues/me", token)
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	var keepID string
	for _, it := range catalogue.Items {
		if it.Name == "Keep" && it.Id != nil {
			keepID = it.Id.String()
		}
	}
	if keepID == "" {
		t.Fatalf("no id for Keep in %+v", catalogue.Items)
	}

	rec = doImportPOST(t, s.Router(), fmt.Sprintf(
		`{"replace":true,"rows":[{"id":%q,"name":"Keep","priceTZS":150,"category":""}]}`, keepID), token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("replace status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	out := decodeImportBody(t, rec)
	if out.Created != 0 || out.Updated != 1 {
		t.Fatalf("created = %d, updated = %d, want 0/1", out.Created, out.Updated)
	}

	catalogue = gen.Catalogue{}
	catRec = authedGET(t, s.Router(), "/catalogues/me", token)
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(catalogue.Items) != 1 || catalogue.Items[0].Name != "Keep" {
		t.Fatalf("items = %+v, want just Keep", catalogue.Items)
	}
	if catalogue.Items[0].PriceTZS != 150 {
		t.Fatalf("price = %d, want 150", catalogue.Items[0].PriceTZS)
	}

	var total, deleted int
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM catalogue_items WHERE merchant_id = $1`, merchantID).Scan(&total); err != nil {
		t.Fatalf("count items: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM catalogue_items WHERE merchant_id = $1 AND deleted_at IS NOT NULL`,
		merchantID).Scan(&deleted); err != nil {
		t.Fatalf("count deleted items: %v", err)
	}
	if total != 3 || deleted != 2 {
		t.Fatalf("total = %d, deleted = %d, want 3/2", total, deleted)
	}
}

// TestCatalogueImportPerItemValidation: rows violating the per-item bounds
// are rejected 422 VALIDATION_FAILED with one errors[] entry per problem,
// and nothing is applied.
func TestCatalogueImportPerItemValidation(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	_, token := catalogueIOMerchant(t, pool, s, "validate")

	longName := strings.Repeat("x", 161)
	rec := doImportPOST(t, s.Router(), `{"rows":[
		{"name":"","priceTZS":100,"category":""},
		{"name":"Bad Price","priceTZS":-5,"category":""},
		{"name":`+strconv.Quote(longName)+`,"priceTZS":100,"category":""}
	]}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var validation gen.ValidationResponse
	if err := json.NewDecoder(rec.Body).Decode(&validation); err != nil {
		t.Fatalf("decode validation: %v", err)
	}
	if validation.Code != "VALIDATION_FAILED" {
		t.Fatalf("code = %q, want VALIDATION_FAILED", validation.Code)
	}
	if len(validation.Errors) != 3 {
		t.Fatalf("errors = %d, want 3 (%+v)", len(validation.Errors), validation.Errors)
	}
	want := map[string]bool{
		"rows[0].name":     true,
		"rows[1].priceTZS": true,
		"rows[2].name":     true,
	}
	for _, e := range validation.Errors {
		if !want[e.Field] {
			t.Fatalf("unexpected error field %q (%s)", e.Field, e.Message)
		}
	}
}

// TestCatalogueImportCategoryAutoCreate: an unknown category name is created
// on demand and the item surfaces with that category.
func TestCatalogueImportCategoryAutoCreate(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	merchantID, token := catalogueIOMerchant(t, pool, s, "category")

	rec := doImportPOST(t, s.Router(), importRowsJSON([]string{"Chai"}, 300, "Hot Drinks"), token)
	if out := decodeImportBody(t, rec); out.Created != 1 {
		t.Fatalf("created = %d, want 1", out.Created)
	}

	var categoryCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM product_categories WHERE merchant_id = $1 AND name = 'Hot Drinks'`,
		merchantID).Scan(&categoryCount); err != nil {
		t.Fatalf("count category: %v", err)
	}
	if categoryCount != 1 {
		t.Fatalf("categories named 'Hot Drinks' = %d, want 1", categoryCount)
	}

	var catalogue gen.Catalogue
	catRec := authedGET(t, s.Router(), "/catalogues/me", token)
	if err := json.NewDecoder(catRec.Body).Decode(&catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(catalogue.Items) != 1 || catalogue.Items[0].Category != "Hot Drinks" {
		t.Fatalf("items = %+v, want one item in Hot Drinks", catalogue.Items)
	}
}

// TestCatalogueImportOverCap: 501 rows exceeds the 500-row cap and is
// rejected 422 BULK_OPERATION_INVALID.
func TestCatalogueImportOverCap(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	_, token := catalogueIOMerchant(t, pool, s, "cap")

	names := make([]string, GetSettings().MaxImportRows+1)
	for i := range names {
		names[i] = fmt.Sprintf("Row %d", i)
	}
	rec := doImportPOST(t, s.Router(), importRowsJSON(names, 100, ""), token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "BULK_OPERATION_INVALID" {
		t.Fatalf("code = %q, want BULK_OPERATION_INVALID", errBody.Code)
	}
}

// catalogueExport is the wire shape of the 200 export response.
type catalogueExport struct {
	DownloadUrl      string `json:"downloadUrl"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

// decodeExportPayload decodes the data-URL downloadUrl back to raw bytes.
func decodeExportPayload(t *testing.T, downloadURL string) []byte {
	t.Helper()
	marker := "base64,"
	idx := strings.Index(downloadURL, marker)
	if idx < 0 {
		t.Fatalf("downloadUrl %q is not a base64 data URL", downloadURL)
	}
	payload, err := base64.StdEncoding.DecodeString(downloadURL[idx+len(marker):])
	if err != nil {
		t.Fatalf("decode export payload: %v", err)
	}
	return payload
}

// TestCatalogueExportJSON: the JSON export carries every item of the
// catalogue (extensions included), in the contract CatalogueItem shape.
func TestCatalogueExportJSON(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	_, token := catalogueIOMerchant(t, pool, s, "export-json")

	names := make([]string, 10)
	for i := range names {
		names[i] = fmt.Sprintf("Export Item %d", i)
	}
	rec := doImportPOST(t, s.Router(), importRowsJSON(names, 750, "Exported"), token)
	if out := decodeImportBody(t, rec); out.Created != 10 {
		t.Fatalf("created = %d, want 10", out.Created)
	}

	rec = authedGET(t, s.Router(), "/catalogues/export?format=json", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var exp catalogueExport
	if err := json.NewDecoder(rec.Body).Decode(&exp); err != nil {
		t.Fatalf("decode export: %v", err)
	}
	if exp.ExpiresInSeconds != 900 {
		t.Fatalf("expiresInSeconds = %d, want 900", exp.ExpiresInSeconds)
	}
	var items []gen.CatalogueItem
	if err := json.Unmarshal(decodeExportPayload(t, exp.DownloadUrl), &items); err != nil {
		t.Fatalf("unmarshal exported items: %v", err)
	}
	if len(items) != 10 {
		t.Fatalf("exported items = %d, want 10", len(items))
	}
	for _, it := range items {
		if it.Name == "" || it.PriceTZS != 750 || it.Category != "Exported" {
			t.Fatalf("unexpected item %+v", it)
		}
	}
}

// TestCatalogueExportCSV: the CSV export parses back with encoding/csv and
// preserves escaping-sensitive fields (commas, quotes, newlines).
func TestCatalogueExportCSV(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	_, token := catalogueIOMerchant(t, pool, s, "export-csv")

	multiLine := "Multi\nline"
	available := false
	rows := []map[string]any{
		{"name": "Chapati, Plain", "priceTZS": 500, "category": "Food", "description": `With "beef" filling`},
		{"name": multiLine, "priceTZS": 800, "category": "Food", "available": &available},
		{"name": "Uji", "priceTZS": 300, "category": "Drinks"},
	}
	body, err := json.Marshal(map[string]any{"rows": rows})
	if err != nil {
		t.Fatalf("marshal import body: %v", err)
	}
	rec := doImportPOST(t, s.Router(), string(body), token)
	if out := decodeImportBody(t, rec); out.Created != 3 {
		t.Fatalf("created = %d, want 3", out.Created)
	}

	rec = authedGET(t, s.Router(), "/catalogues/export", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var exp catalogueExport
	if err := json.NewDecoder(rec.Body).Decode(&exp); err != nil {
		t.Fatalf("decode export: %v", err)
	}

	parsed, err := csv.NewReader(strings.NewReader(string(decodeExportPayload(t, exp.DownloadUrl)))).ReadAll()
	if err != nil {
		t.Fatalf("parse exported csv: %v", err)
	}
	if len(parsed) != 4 {
		t.Fatalf("csv rows = %d, want 4 (header + 3)", len(parsed))
	}
	if got := strings.Join(parsed[0], ","); got != "id,name,description,priceTZS,category,available" {
		t.Fatalf("header = %q", got)
	}
	// Rows within one import share a created_at, so the catalogue orders by
	// id (random) — locate rows by name instead of relying on order.
	byName := make(map[string][]string, 3)
	for _, row := range parsed[1:] {
		byName[row[1]] = row
	}
	if got := byName["Chapati, Plain"]; len(got) == 0 {
		t.Fatalf("missing Chapati, Plain row: %+v", byName)
	} else {
		if got[2] != `With "beef" filling` {
			t.Fatalf("Chapati description = %q", got[2])
		}
		if got[3] != "500" {
			t.Fatalf("Chapati price = %q, want 500", got[3])
		}
	}
	if got := byName["Multi\nline"]; len(got) == 0 {
		t.Fatalf("missing Multi\\nline row: %+v", byName)
	} else {
		if got[5] != "false" {
			t.Fatalf("Multi\\nline available = %q, want false", got[5])
		}
		if got[3] != "800" {
			t.Fatalf("Multi\\nline price = %q, want 800", got[3])
		}
	}
	if got := byName["Uji"]; len(got) == 0 {
		t.Fatalf("missing Uji row: %+v", byName)
	} else if got[3] != "300" {
		t.Fatalf("Uji price = %q, want 300", got[3])
	}
}

// TestCatalogueExportJobCreatesQueuedRow: ?job=true skips the inline data
// URL and persists a queued data_exports row (scope 'catalogue', file_url
// NULL) owned by the merchant user; the 202 body is the DataExportJob shape.
func TestCatalogueExportJobCreatesQueuedRow(t *testing.T) {
	s, pool := catalogueIOSetup(t)
	merchantID, token := catalogueIOMerchant(t, pool, s, "export-job")

	rec := doImportPOST(t, s.Router(), importRowsJSON([]string{"Job Item"}, 500, "Jobbed"), token)
	if out := decodeImportBody(t, rec); out.Created != 1 {
		t.Fatalf("created = %d, want 1", out.Created)
	}

	rec = authedGET(t, s.Router(), "/catalogues/export?format=json&job=true", token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("export status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var job gen.DataExportJob
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode export job: %v", err)
	}
	if job.Status != gen.DataExportJobStatusQueued {
		t.Fatalf("job status = %q, want queued", job.Status)
	}
	if job.Scope != gen.DataExportJobScopeCatalogue {
		t.Fatalf("job scope = %q, want catalogue", job.Scope)
	}
	if job.Format != gen.DataExportJobFormatJson {
		t.Fatalf("job format = %q, want json", job.Format)
	}
	if job.DownloadUrl != nil {
		t.Fatalf("job downloadUrl = %v, want nil", job.DownloadUrl)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM data_exports WHERE id = $1`, uuid.UUID(job.Id))
	})

	var (
		ownerID uuid.UUID
		userID  uuid.UUID
		scope   string
		format  string
		status  string
		fileURL *string
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT owner_user_id FROM merchants WHERE id = $1`, merchantID).Scan(&ownerID); err != nil {
		t.Fatalf("merchant owner: %v", err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT user_id, scope, format, status, file_url FROM data_exports WHERE id = $1`,
		uuid.UUID(job.Id)).Scan(&userID, &scope, &format, &status, &fileURL); err != nil {
		t.Fatalf("export row: %v", err)
	}
	if userID != ownerID {
		t.Fatalf("job user_id = %s, want the merchant user %s", userID, ownerID)
	}
	if scope != "catalogue" || format != "json" || status != "queued" || fileURL != nil {
		t.Fatalf("job row = scope %q format %q status %q file_url %v", scope, format, status, fileURL)
	}

	// The inline path is untouched: the same catalogue without ?job=true
	// still answers 200 with the data URL.
	inline := authedGET(t, s.Router(), "/catalogues/export?format=json", token)
	if inline.Code != http.StatusOK {
		t.Fatalf("inline export status = %d, want 200 (%s)", inline.Code, inline.Body)
	}
	var exp catalogueExport
	if err := json.NewDecoder(inline.Body).Decode(&exp); err != nil {
		t.Fatalf("decode inline export: %v", err)
	}
	if exp.DownloadUrl == "" || !strings.HasPrefix(exp.DownloadUrl, "data:") {
		t.Fatalf("inline downloadUrl = %q, want a data URL", exp.DownloadUrl)
	}
}
