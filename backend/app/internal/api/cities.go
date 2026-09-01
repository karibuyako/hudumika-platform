package api

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// Public discovery bounds for /cities and /services. Both endpoints are
// PUBLIC (no bearerAuth in the contract): they never look at the caller.
const (
	// Deprecated: defaultCountry is now served from GetSettings().DefaultCountry.
	maxCountryLength    = 10
	defaultServiceLimit = 20
	maxServiceLimit     = 50
)

// ListCities returns the cities of a country (default TZ) ordered by name,
// each with its service areas attached. A country longer than 10 characters
// is rejected before any database access; without a wired database (dev,
// no DATABASE_URL) the request fails with the INTERNAL_ERROR envelope.
func (s *Server) ListCities(w http.ResponseWriter, r *http.Request, params gen.ListCitiesParams) {
	country := GetSettings().DefaultCountry
	if params.Country != nil {
		country = *params.Country
		if len(country) == 0 || len(country) > maxCountryLength {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "country must be 1-10 characters")
			return
		}
	}
	if s.db == nil {
		s.logger.Error("list cities failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, country FROM cities WHERE country = $1 ORDER BY name`, country)
	if err != nil {
		s.logger.Error("list cities query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	cities := make([]gen.City, 0, 16)
	cityIDs := make([]uuid.UUID, 0, 16)
	index := make(map[uuid.UUID]int, 16)
	for rows.Next() {
		var (
			id      uuid.UUID
			name    string
			country string
		)
		if err := rows.Scan(&id, &name, &country); err != nil {
			s.logger.Error("scan city row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		areas := make([]gen.ServiceArea, 0, 4)
		cities = append(cities, gen.City{
			Id:           newUUID(id.String()),
			Name:         name,
			Country:      country,
			ServiceAreas: &areas,
		})
		cityIDs = append(cityIDs, id)
		index[id] = len(cities) - 1
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate city rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Service areas load in a single query for every city at once; rows for
	// cities that disappeared mid-request are skipped.
	if len(cityIDs) > 0 {
		areaRows, err := s.db.Pool().Query(r.Context(),
			`SELECT id, city_id, name FROM service_areas WHERE city_id = ANY($1) ORDER BY name`, cityIDs)
		if err != nil {
			s.logger.Error("list service areas query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		defer areaRows.Close()
		for areaRows.Next() {
			var (
				id     uuid.UUID
				cityID uuid.UUID
				name   string
			)
			if err := areaRows.Scan(&id, &cityID, &name); err != nil {
				s.logger.Error("scan service area row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			ci, ok := index[cityID]
			if !ok {
				continue
			}
			*cities[ci].ServiceAreas = append(*cities[ci].ServiceAreas, gen.ServiceArea{
				Id:   newUUID(id.String()),
				Name: name,
			})
		}
		if err := areaRows.Err(); err != nil {
			s.logger.Error("iterate service area rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	writeJSON(w, http.StatusOK, cities)
}

// ListServices returns the active public service catalogue, optionally
// filtered by city and category name, cursor-paginated by (created_at, id).
// The page's next cursor is exposed via the X-Next-Cursor header; when the
// header is absent the client has reached the last page.
func (s *Server) ListServices(w http.ResponseWriter, r *http.Request, params gen.ListServicesParams) {
	limit := defaultServiceLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxServiceLimit {
			limit = maxServiceLimit
		}
	}

	var (
		cursorAt  time.Time
		cursorID  uuid.UUID
		hasCursor bool
	)
	if params.Cursor != nil && *params.Cursor != "" {
		parsedAt, parsedID, err := parseServiceCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursorAt, cursorID, hasCursor = parsedAt, parsedID, true
	}

	if s.db == nil {
		s.logger.Error("list services failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT s.id, s.name, s.description, COALESCE(c.name, '') AS category, s.created_at
		FROM services s
		LEFT JOIN service_categories_config c ON c.id = s.category_id
		WHERE s.active = true`
	args := make([]any, 0, 6)
	if params.CityId != nil {
		args = append(args, *params.CityId)
		query += fmt.Sprintf(" AND s.city_id = $%d", len(args))
	}
	if params.Category != nil && *params.Category != "" {
		args = append(args, *params.Category)
		query += fmt.Sprintf(" AND c.name = $%d", len(args))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		query += fmt.Sprintf(" AND (s.created_at, s.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	// One extra row acts as a sentinel so a full-but-final page does not
	// advertise a next cursor.
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY s.created_at, s.id LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list services query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	services := make([]gen.Service, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id        uuid.UUID
			name      string
			desc      *string
			category  string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &name, &desc, &category, &createdAt); err != nil {
			s.logger.Error("scan service row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(services) == limit {
			// The sentinel row: the page is full and another row exists.
			sentinel = true
			continue
		}
		services = append(services, gen.Service{
			Id:          newUUID(id.String()),
			Name:        name,
			Category:    category,
			Description: desc,
		})
		lastAt, lastID = createdAt, id
	}
	if sentinel {
		// Resume after the last row actually returned on this page.
		w.Header().Set("X-Next-Cursor", encodeServiceCursor(lastAt, lastID))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate service rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, services)
}

// encodeServiceCursor packs a row's (created_at, id) keyset into a
// URL-safe base64 string; parseServiceCursor is its inverse.
func encodeServiceCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseServiceCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor id: %w", err)
	}
	return createdAt, id, nil
}
