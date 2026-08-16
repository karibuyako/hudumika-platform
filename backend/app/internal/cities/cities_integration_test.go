//go:build integration

// End-to-end tests for the public /cities and /services read paths against
// real PostgreSQL (docker compose / local dev). Run via
// `go test -tags integration ./internal/cities/ -count=1` after
// `go run ./cmd/migrate -up`. DATABASE_URL defaults to the dev database.
package cities

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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/api"
	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
	"github.com/hudumika/api-backend/internal/gen"
)

// setup boots a server over the real database and truncates ONLY the four
// discovery tables so runs are repeatable without touching other agents'
// data.
func setup(t *testing.T) (*api.Server, *pgxpool.Pool) {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://hudumika:hudumika@localhost:5432/hudumika"
	}
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  24 * time.Hour,
		CORSOrigins: []string{"*"},
		DatabaseURL: databaseURL,
	}
	s, err := api.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	d, err := db.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	s.SetDB(d)
	t.Cleanup(d.Close)

	pool := d.Pool()
	if _, err := pool.Exec(context.Background(),
		"TRUNCATE services, service_areas, service_categories_config, cities CASCADE"); err != nil {
		t.Fatalf("truncate discovery tables: %v", err)
	}
	return s, pool
}

func callListCities(t *testing.T, s *api.Server, country *string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/cities", nil)
	rec := httptest.NewRecorder()
	s.ListCities(rec, req, gen.ListCitiesParams{Country: country})
	return rec
}

func callListServices(t *testing.T, s *api.Server, params gen.ListServicesParams) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/services", nil)
	rec := httptest.NewRecorder()
	s.ListServices(rec, req, params)
	return rec
}

func decodeCities(t *testing.T, rec *httptest.ResponseRecorder) []gen.City {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("list cities status = %d (%s)", rec.Code, rec.Body)
	}
	var cities []gen.City
	if err := json.NewDecoder(rec.Body).Decode(&cities); err != nil {
		t.Fatalf("decode cities: %v", err)
	}
	return cities
}

func decodeServices(t *testing.T, rec *httptest.ResponseRecorder) []gen.Service {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("list services status = %d (%s)", rec.Code, rec.Body)
	}
	var services []gen.Service
	if err := json.NewDecoder(rec.Body).Decode(&services); err != nil {
		t.Fatalf("decode services: %v", err)
	}
	return services
}

// TestListCitiesReturnsCitiesWithAreas inserts two TZ cities (with areas)
// plus one KE city, then checks that both TZ cities come back with their
// service areas attached and the KE city stays out of the default view.
func TestListCitiesReturnsCitiesWithAreas(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()

	var darID, arID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO cities (name, country) VALUES ('Dar es Salaam', 'TZ') RETURNING id`).Scan(&darID); err != nil {
		t.Fatalf("insert dar: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO cities (name, country) VALUES ('Arusha', 'TZ') RETURNING id`).Scan(&arID); err != nil {
		t.Fatalf("insert arusha: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO cities (name, country) VALUES ('Nairobi', 'KE')`); err != nil {
		t.Fatalf("insert nairobi: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO service_areas (city_id, name) VALUES ($1, 'Masaki'), ($1, 'Mikocheni')`, darID); err != nil {
		t.Fatalf("insert dar areas: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO service_areas (city_id, name) VALUES ($1, 'Njiro')`, arID); err != nil {
		t.Fatalf("insert arusha areas: %v", err)
	}

	cities := decodeCities(t, callListCities(t, s, nil))
	if len(cities) != 2 {
		t.Fatalf("cities = %d, want 2 (%+v)", len(cities), cities)
	}
	for _, c := range cities {
		if c.Country != "TZ" {
			t.Fatalf("city %s country = %q, want TZ", c.Name, c.Country)
		}
		if c.ServiceAreas == nil {
			t.Fatalf("city %s has nil serviceAreas", c.Name)
		}
		if c.Name == "Dar es Salaam" && len(*c.ServiceAreas) != 2 {
			t.Fatalf("dar areas = %d, want 2", len(*c.ServiceAreas))
		}
		if c.Name == "Arusha" && len(*c.ServiceAreas) != 1 {
			t.Fatalf("arusha areas = %d, want 1", len(*c.ServiceAreas))
		}
		if c.Name == "Arusha" && (*c.ServiceAreas)[0].Name != "Njiro" {
			t.Fatalf("arusha area = %+v, want Njiro", (*c.ServiceAreas)[0])
		}
	}
}

// TestListCitiesCountryFilter: the country query parameter scopes results;
// the default is TZ.
func TestListCitiesCountryFilter(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()

	for _, c := range []string{"Dar es Salaam", "Arusha", "Mwanza"} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO cities (name, country) VALUES ($1, 'TZ')`, c); err != nil {
			t.Fatalf("insert %s: %v", c, err)
		}
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO cities (name, country) VALUES ('Nairobi', 'KE'), ('Kampala', 'UG')`); err != nil {
		t.Fatalf("insert foreign cities: %v", err)
	}

	if got := decodeCities(t, callListCities(t, s, nil)); len(got) != 3 {
		t.Fatalf("default (TZ) cities = %d, want 3", len(got))
	}
	ke := "KE"
	if got := decodeCities(t, callListCities(t, s, &ke)); len(got) != 1 || got[0].Name != "Nairobi" {
		t.Fatalf("KE cities = %+v, want [Nairobi]", got)
	}
}

// TestListServicesCategoryFilter: services are filtered by category name and
// the response carries the category name, not its id.
func TestListServicesCategoryFilter(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()

	var cleaningID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO service_categories_config (name, sort_order) VALUES ('cleaning', 1) RETURNING id`).Scan(&cleaningID); err != nil {
		t.Fatalf("insert cleaning category: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO service_categories_config (name, sort_order) VALUES ('repairs', 2)`); err != nil {
		t.Fatalf("insert repairs category: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO services (name, category_id) VALUES
		 ('Home Cleaning', $1), ('Office Cleaning', $1), ('Plumbing Repair', (SELECT id FROM service_categories_config WHERE name = 'repairs'))`,
		cleaningID); err != nil {
		t.Fatalf("insert services: %v", err)
	}
	// A disabled service must never surface on the public path.
	if _, err := pool.Exec(ctx,
		`INSERT INTO services (name, category_id, active) VALUES ('Hidden Service', $1, false)`, cleaningID); err != nil {
		t.Fatalf("insert inactive service: %v", err)
	}

	category := "cleaning"
	got := decodeServices(t, callListServices(t, s, gen.ListServicesParams{Category: &category}))
	if len(got) != 2 {
		t.Fatalf("cleaning services = %d, want 2 (%+v)", len(got), got)
	}
	for _, svc := range got {
		if svc.Category != "cleaning" {
			t.Fatalf("service %s category = %q, want cleaning", svc.Name, svc.Category)
		}
	}

	all := decodeServices(t, callListServices(t, s, gen.ListServicesParams{}))
	if len(all) != 3 {
		t.Fatalf("all services = %d, want 3 (%+v)", len(all), all)
	}
	for _, svc := range all {
		if svc.Name == "Hidden Service" {
			t.Fatalf("inactive service leaked into public catalogue")
		}
	}
}

// TestListServicesPagination walks 25 services in pages of 10 via the
// X-Next-Cursor header and asserts no row is skipped or duplicated.
func TestListServicesPagination(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()

	for i := 0; i < 25; i++ {
		createdAt := time.Date(2026, 1, 1, 0, 0, 0, i*1_000_000, time.UTC)
		if _, err := pool.Exec(ctx,
			`INSERT INTO services (name, created_at) VALUES ($1, $2)`,
			fmt.Sprintf("Service %02d", i), createdAt); err != nil {
			t.Fatalf("insert service %d: %v", i, err)
		}
	}

	seen := make(map[string]bool, 25)
	limit := 10
	var cursor *string
	lastPage := 0
	for page := 0; page < 5; page++ {
		rec := callListServices(t, s, gen.ListServicesParams{Limit: &limit, Cursor: cursor})
		got := decodeServices(t, rec)
		if len(got) == 0 {
			t.Fatalf("page %d empty before exhaustion", page)
		}
		for _, svc := range got {
			id := svc.Id.String()
			if seen[id] {
				t.Fatalf("duplicate service %s across pages", id)
			}
			seen[id] = true
		}
		next := rec.Header().Get("X-Next-Cursor")
		if next == "" {
			lastPage = len(got)
			break
		}
		if len(got) != limit {
			t.Fatalf("page %d has %d rows but still advertises a next cursor", page, len(got))
		}
		nextCopy := next
		cursor = &nextCopy
	}

	if len(seen) != 25 {
		t.Fatalf("distinct services seen = %d, want 25", len(seen))
	}
	if lastPage != 5 {
		t.Fatalf("final page = %d rows, want 5", lastPage)
	}
}

// TestEmptyListsAreJSONArrays: an empty catalogue responds with [] and
// never null, and no next cursor is advertised.
func TestEmptyListsAreJSONArrays(t *testing.T) {
	s, _ := setup(t)

	rec := callListCities(t, s, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty cities status = %d", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("empty cities body = %q, want []", got)
	}

	rec = callListServices(t, s, gen.ListServicesParams{})
	if rec.Code != http.StatusOK {
		t.Fatalf("empty services status = %d", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("empty services body = %q, want []", got)
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("empty services advertised a next cursor")
	}
}
