package api

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// SEARCH bounded context (API-CONTRACT.yaml /search, /search/suggest,
// /search/history): unified keyword search over the public-facing rows of
// every marketplace entity, autocomplete suggestions, and per-user recent
// query history (migrations/00019_search.sql).
//
// Verification gate: only rows of APPROVED partners surface. catalogue_items
// and group_buy_deals reference the partner's users row (merchant_id =
// users.id, see CATALOGUES/group-buy notes), so the merchants join is on
// merchants.owner_user_id. services (00004) carry no provider link, so the
// approved gate applies to their name column alone: active services only.

// Search bounds (contract /search: q maxLength 200, limit default 20).
const (
	searchMaxQueryLen  = 200
	searchMaxSuggestQ  = 100
	defaultSearchLimit = 20
	maxSearchLimit     = 50
	searchHistoryCap   = 50 // newest queries kept per user (best-effort)
	searchHistoryLimit = 20 // rows returned by /search/history
	searchSuggestLimit = 10 // suggestions returned by /search/suggest
)

// searchUnitKind enumerates the per-entity SQL queries a UnifiedSearch
// request can select; entityType=all runs every unit except hotel.
type searchUnitKind int

const (
	unitCatalogue searchUnitKind = iota
	unitMerchants
	unitServices
	unitProviders
	unitDeals
)

// searchUnit is one per-entity query of a UnifiedSearch request. types lists
// the result entityType values its rows can map to; the cursor's entityType
// must belong to exactly one unit so pagination stays stable across the
// concatenated result stream (see UnifiedSearch).
type searchUnit struct {
	kind       searchUnitKind
	entityType string // fixed row type for typed requests
	types      []string
}

// searchResultItem is the handler-side projection of one SearchResults row;
// it mirrors the contract's inline item shape (SearchResults.results[]).
type searchResultItem struct {
	entityType gen.SearchResultsResultsEntityType
	id         uuid.UUID
	title      string
	subtitle   *string
	imageURL   *string
	priceTZS   *int
	rating     *float32
	createdAt  time.Time
}

// searchUnitsFor expands an entityType parameter into its search units in
// concatenation order. entityType=all runs every supported entity; hotel has
// no data model yet and honestly yields no units (empty results).
func searchUnitsFor(entityType string) []searchUnit {
	switch entityType {
	case "dish":
		return []searchUnit{{kind: unitCatalogue, entityType: "dish", types: []string{"dish"}}}
	case "product":
		return []searchUnit{{kind: unitCatalogue, entityType: "product", types: []string{"product"}}}
	case "restaurant":
		return []searchUnit{{kind: unitMerchants, entityType: "restaurant", types: []string{"restaurant"}}}
	case "store":
		return []searchUnit{{kind: unitMerchants, entityType: "store", types: []string{"store"}}}
	case "service_package":
		return []searchUnit{{kind: unitServices, entityType: "service_package", types: []string{"service_package"}}}
	case "provider":
		return []searchUnit{{kind: unitProviders, entityType: "provider", types: []string{"provider"}}}
	case "deal":
		return []searchUnit{{kind: unitDeals, entityType: "deal", types: []string{"deal"}}}
	default: // "all"
		return []searchUnit{
			{kind: unitCatalogue, types: []string{"dish", "product"}},
			{kind: unitMerchants, types: []string{"restaurant", "store"}},
			{kind: unitServices, types: []string{"service_package"}},
			{kind: unitProviders, types: []string{"provider"}},
			{kind: unitDeals, types: []string{"deal"}},
		}
	}
}

// UnifiedSearch runs a keyword search across the selected entity types and
// returns the concatenated results, keyset paginated by (created_at, id).
// The next cursor encodes the last returned row's (entityType, created_at,
// id); on the next page every unit before the cursor's unit is exhausted and
// skipped, the cursor's own unit resumes after the keyset, and later units
// restart from the beginning — so pages never duplicate or drop rows.
// entityType=all concatenates in fixed order: catalogue items, merchants,
// services, providers, deals. lat/lon and category are accepted but have no
// data-model columns to filter on yet; the contract marks total optional, so
// it is omitted rather than guessed.
func (s *Server) UnifiedSearch(w http.ResponseWriter, r *http.Request, params gen.UnifiedSearchParams) {
	q := strings.TrimSpace(params.Q)
	if q == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "q is required (1-200 characters)")
		return
	}
	if utf8.RuneCountInString(q) > searchMaxQueryLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "q must be 200 characters or fewer")
		return
	}

	entityType := "all"
	if params.EntityType != nil && *params.EntityType != "" {
		entityType = string(*params.EntityType)
		if !validSearchEntityType(entityType) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "entityType is invalid")
			return
		}
	}
	units := searchUnitsFor(entityType)

	limit := defaultSearchLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxSearchLimit {
			limit = maxSearchLimit
		}
	}

	// The cursor identifies the unit it came from; any other unit position
	// decides whether the unit is exhausted (before) or untouched (after).
	var (
		cursor     searchCursor
		hasCursor  bool
		cursorUnit = -1
	)
	if params.Cursor != nil && *params.Cursor != "" {
		parsed, err := parseSearchCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursor, hasCursor = parsed, true
		for i := range units {
			for _, t := range units[i].types {
				if t == cursor.entityType {
					cursorUnit = i
					break
				}
			}
			if cursorUnit >= 0 {
				break
			}
		}
		if cursorUnit < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
	}

	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	pattern := "%" + escapeLike(q) + "%"
	rows := make([]searchResultItem, 0, limit+1)
	for i, unit := range units {
		if hasCursor && i < cursorUnit {
			// Every unit before the cursor's was exhausted on the page that
			// produced the cursor; skipping it keeps pages duplicate-free.
			continue
		}
		applyCursor := hasCursor && i == cursorUnit
		unitRows, err := s.runSearchUnit(r.Context(), unit, pattern, limit+1, cursor, applyCursor)
		if err != nil {
			s.logger.Error("search unit query failed", "entityType", unit.entityType, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rows = append(rows, unitRows...)
	}

	// Keep the limit+1 sentinel row so a full page advertises a next cursor;
	// the cursor always points at the last row actually returned.
	var (
		nextCursor string
		sentinel   bool
	)
	if len(rows) > limit {
		sentinel = true
		rows = rows[:limit]
	}
	if sentinel {
		// The cursor always points at the last row actually returned.
		last := rows[len(rows)-1]
		nextCursor = encodeSearchCursor(string(last.entityType), last.createdAt, last.id)
	}

	// Best-effort history recording: failures never fail the search.
	s.recordSearchHistory(r.Context(), user.ID, q)

	out := gen.SearchResults{Query: q, Results: emptySearchResults()}
	for _, row := range rows {
		item := searchResultItemToContract(row)
		out.Results = append(out.Results, item)
	}
	if nextCursor != "" {
		out.NextCursor = &nextCursor
	}
	writeJSON(w, http.StatusOK, out)
}

// emptySearchResults is the contract's results array in its empty state; the
// field's type is anonymous (generated inline), so the empty literal lives
// here to keep hotel/no-match responses `"results": []` rather than null.
func emptySearchResults() []struct {
	Badges     *[]string                          `json:"badges,omitempty"`
	DistanceKm *float32                           `json:"distanceKm,omitempty"`
	EntityType gen.SearchResultsResultsEntityType `json:"entityType"`
	EtaMinutes *int                               `json:"etaMinutes,omitempty"`
	Id         *openapi_types.UUID                `json:"id,omitempty"`
	ImageUrl   *string                            `json:"imageUrl,omitempty"`
	PriceTZS   *int                               `json:"priceTZS,omitempty"`
	Rating     *float32                           `json:"rating,omitempty"`
	Subtitle   *string                            `json:"subtitle,omitempty"`
	Title      *string                            `json:"title,omitempty"`
} {
	return []struct {
		Badges     *[]string                          `json:"badges,omitempty"`
		DistanceKm *float32                           `json:"distanceKm,omitempty"`
		EntityType gen.SearchResultsResultsEntityType `json:"entityType"`
		EtaMinutes *int                               `json:"etaMinutes,omitempty"`
		Id         *openapi_types.UUID                `json:"id,omitempty"`
		ImageUrl   *string                            `json:"imageUrl,omitempty"`
		PriceTZS   *int                               `json:"priceTZS,omitempty"`
		Rating     *float32                           `json:"rating,omitempty"`
		Subtitle   *string                            `json:"subtitle,omitempty"`
		Title      *string                            `json:"title,omitempty"`
	}{}
}

// runSearchUnit executes one per-entity search query with the shared page
// args: the escaped ILIKE pattern as $1, the optional keyset cursor, and a
// limit+1 bound. Each unit returns at most limit+1 rows so the caller can
// detect the page sentinel.
func (s *Server) runSearchUnit(ctx context.Context, unit searchUnit, pattern string, limit int, cursor searchCursor, applyCursor bool) ([]searchResultItem, error) {
	args := make([]any, 0, 6)
	args = append(args, pattern)

	query := ""
	switch unit.kind {
	case unitCatalogue:
		query = `SELECT ci.id, ci.name, ci.image_url, ci.price_tzs, ci.created_at,
				m.business_name, m.business_type, m.rating
			FROM catalogue_items ci
			JOIN merchants m ON m.owner_user_id = ci.merchant_id AND m.verification = 'approved'
			WHERE ci.available = true AND ci.deleted_at IS NULL
				AND ci.name ILIKE $1 ESCAPE '\'`
		switch unit.entityType {
		case "dish":
			query += ` AND (m.business_type IS NULL OR m.business_type = 'restaurant')`
		case "product":
			query += ` AND m.business_type IS NOT NULL AND m.business_type <> 'restaurant'`
		}
	case unitMerchants:
		query = `SELECT m.id, m.business_name, m.logo_url, m.rating, m.business_type, m.created_at,
				COALESCE(c.name, '') AS city
			FROM merchants m
			LEFT JOIN cities c ON c.id = m.city_id
			WHERE m.verification = 'approved'
				AND m.business_name ILIKE $1 ESCAPE '\'`
		switch unit.entityType {
		case "restaurant":
			query += ` AND (m.business_type IS NULL OR m.business_type = 'restaurant')`
		case "store":
			query += ` AND m.business_type IS NOT NULL AND m.business_type <> 'restaurant'`
		}
	case unitServices:
		query = `SELECT s.id, s.name, s.description, s.created_at
			FROM services s
			WHERE s.active = true AND s.name ILIKE $1 ESCAPE '\'`
	case unitProviders:
		query = `SELECT p.id, p.name, p.trade, p.rating, p.created_at
			FROM providers p
			WHERE p.verification = 'approved' AND p.name ILIKE $1 ESCAPE '\'`
	case unitDeals:
		query = `SELECT d.id, d.title, d.description, d.deal_price_tzs, d.created_at
			FROM group_buy_deals d
			JOIN merchants m ON m.owner_user_id = d.merchant_id AND m.verification = 'approved'
			WHERE d.status = 'active' AND d.title ILIKE $1 ESCAPE '\'`
	default:
		return nil, fmt.Errorf("unknown search unit %d", unit.kind)
	}
	alias := ""
	switch unit.kind {
	case unitCatalogue:
		alias = "ci"
	case unitMerchants:
		alias = "m"
	case unitServices:
		alias = "s"
	case unitProviders:
		alias = "p"
	case unitDeals:
		alias = "d"
	}
	if applyCursor {
		args = append(args, cursor.createdAt, cursor.id)
		query += fmt.Sprintf(" AND (%s.created_at, %s.id) > ($%d, $%d)", alias, alias, len(args)-1, len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY %s.created_at, %s.id LIMIT $%d", alias, alias, len(args))

	rows, err := s.db.Pool().Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query %d search unit: %w", unit.kind, err)
	}
	defer rows.Close()

	out := make([]searchResultItem, 0, limit)
	for rows.Next() {
		item, err := scanSearchUnitRow(unit, rows)
		if err != nil {
			return nil, fmt.Errorf("scan %d search unit: %w", unit.kind, err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate %d search unit: %w", unit.kind, err)
	}
	return out, nil
}

// scanSearchUnitRow scans one row of a unit query. Typed units carry a fixed
// entityType; the all-stream rows type themselves from the merchant's
// business_type (restaurant/null = dish or restaurant, anything else =
// product or store).
func scanSearchUnitRow(unit searchUnit, rows pgx.Rows) (searchResultItem, error) {
	item := searchResultItem{}
	switch unit.kind {
	case unitCatalogue:
		var (
			id          uuid.UUID
			title       string
			imageURL    *string
			priceTZS    int64
			createdAt   time.Time
			business    string
			businessTpe *string
			rating      *float64
		)
		if err := rows.Scan(&id, &title, &imageURL, &priceTZS, &createdAt, &business, &businessTpe, &rating); err != nil {
			return item, err
		}
		item.id, item.title, item.createdAt = id, title, createdAt
		item.imageURL = imageURL
		if priceTZS > 0 {
			p := int(priceTZS)
			item.priceTZS = &p
		}
		subtitle := business
		item.subtitle = &subtitle
		item.rating = optionalRating(rating)
		if unit.entityType != "" {
			item.entityType = gen.SearchResultsResultsEntityType(unit.entityType)
		} else {
			item.entityType = catalogueResultType(businessTpe)
		}
	case unitMerchants:
		var (
			id          uuid.UUID
			title       string
			imageURL    *string
			rating      *float64
			businessTpe *string
			createdAt   time.Time
			city        string
		)
		if err := rows.Scan(&id, &title, &imageURL, &rating, &businessTpe, &createdAt, &city); err != nil {
			return item, err
		}
		item.id, item.title, item.createdAt = id, title, createdAt
		item.imageURL = imageURL
		item.rating = optionalRating(rating)
		subtitle := city
		item.subtitle = &subtitle
		if unit.entityType != "" {
			item.entityType = gen.SearchResultsResultsEntityType(unit.entityType)
		} else {
			item.entityType = merchantResultType(businessTpe)
		}
	case unitServices:
		var (
			id        uuid.UUID
			title     string
			subtitle  *string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &title, &subtitle, &createdAt); err != nil {
			return item, err
		}
		item.id, item.title, item.subtitle, item.createdAt = id, title, subtitle, createdAt
		item.entityType = "service_package"
	case unitProviders:
		var (
			id        uuid.UUID
			title     string
			subtitle  string
			rating    *float64
			createdAt time.Time
		)
		if err := rows.Scan(&id, &title, &subtitle, &rating, &createdAt); err != nil {
			return item, err
		}
		item.id, item.title, item.createdAt = id, title, createdAt
		if subtitle != "" {
			item.subtitle = &subtitle
		}
		item.rating = optionalRating(rating)
		item.entityType = "provider"
	case unitDeals:
		var (
			id        uuid.UUID
			title     string
			subtitle  *string
			priceTZS  int64
			createdAt time.Time
		)
		if err := rows.Scan(&id, &title, &subtitle, &priceTZS, &createdAt); err != nil {
			return item, err
		}
		item.id, item.title, item.subtitle, item.createdAt = id, title, subtitle, createdAt
		if priceTZS > 0 {
			p := int(priceTZS)
			item.priceTZS = &p
		}
		item.entityType = "deal"
	default:
		return item, fmt.Errorf("unknown search unit %d", unit.kind)
	}
	return item, nil
}

// catalogueResultType types a catalogue item as dish (restaurant/unspecified
// merchants) or product (every other merchant trade).
func catalogueResultType(businessType *string) gen.SearchResultsResultsEntityType {
	if businessType == nil || *businessType == "restaurant" {
		return "dish"
	}
	return "product"
}

// merchantResultType types a merchant as restaurant (restaurant/unspecified)
// or store (every other trade).
func merchantResultType(businessType *string) gen.SearchResultsResultsEntityType {
	if businessType == nil || *businessType == "restaurant" {
		return "restaurant"
	}
	return "store"
}

// optionalRating converts a nullable numeric rating column to the contract's
// *float32 (nil stays nil).
func optionalRating(rating *float64) *float32 {
	if rating == nil {
		return nil
	}
	r := float32(*rating)
	return &r
}

// validSearchEntityType reports whether entityType is a contract member.
func validSearchEntityType(entityType string) bool {
	switch entityType {
	case "restaurant", "dish", "product", "store", "provider", "service_package", "hotel", "deal", "all":
		return true
	}
	return false
}

// searchResultItemToContract maps the handler projection onto the contract's
// inline SearchResults.results[] item shape (the generated type is anonymous,
// so the literal lives here).
func searchResultItemToContract(row searchResultItem) struct {
	Badges     *[]string                          `json:"badges,omitempty"`
	DistanceKm *float32                           `json:"distanceKm,omitempty"`
	EntityType gen.SearchResultsResultsEntityType `json:"entityType"`
	EtaMinutes *int                               `json:"etaMinutes,omitempty"`
	Id         *openapi_types.UUID                `json:"id,omitempty"`
	ImageUrl   *string                            `json:"imageUrl,omitempty"`
	PriceTZS   *int                               `json:"priceTZS,omitempty"`
	Rating     *float32                           `json:"rating,omitempty"`
	Subtitle   *string                            `json:"subtitle,omitempty"`
	Title      *string                            `json:"title,omitempty"`
} {
	title := row.title
	id := newUUID(row.id.String())
	return struct {
		Badges     *[]string                          `json:"badges,omitempty"`
		DistanceKm *float32                           `json:"distanceKm,omitempty"`
		EntityType gen.SearchResultsResultsEntityType `json:"entityType"`
		EtaMinutes *int                               `json:"etaMinutes,omitempty"`
		Id         *openapi_types.UUID                `json:"id,omitempty"`
		ImageUrl   *string                            `json:"imageUrl,omitempty"`
		PriceTZS   *int                               `json:"priceTZS,omitempty"`
		Rating     *float32                           `json:"rating,omitempty"`
		Subtitle   *string                            `json:"subtitle,omitempty"`
		Title      *string                            `json:"title,omitempty"`
	}{
		EntityType: row.entityType,
		Id:         &id,
		Title:      &title,
		Subtitle:   row.subtitle,
		ImageUrl:   row.imageURL,
		PriceTZS:   row.priceTZS,
		Rating:     row.rating,
	}
}

// searchCursor is the (entityType, created_at, id) keyset of a UnifiedSearch
// page boundary; it is encoded into the nextCursor string.
type searchCursor struct {
	entityType string
	createdAt  time.Time
	id         uuid.UUID
}

// encodeSearchCursor packs a page boundary into a URL-safe base64 string;
// parseSearchCursor is its inverse.
func encodeSearchCursor(entityType string, createdAt time.Time, id uuid.UUID) string {
	raw := entityType + "|" + createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseSearchCursor(cursor string) (searchCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return searchCursor{}, fmt.Errorf("decode search cursor: %w", err)
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 3 {
		return searchCursor{}, fmt.Errorf("search cursor must encode entityType, timestamp and id")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[1])
	if err != nil {
		return searchCursor{}, fmt.Errorf("parse search cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(parts[2])
	if err != nil {
		return searchCursor{}, fmt.Errorf("parse search cursor id: %w", err)
	}
	return searchCursor{entityType: parts[0], createdAt: createdAt, id: id}, nil
}

// SearchSuggest returns up to 10 autocomplete matches across catalogue
// items, merchants and services, ordered by name (the contract /search/
// suggest response is a plain array of strings).
func (s *Server) SearchSuggest(w http.ResponseWriter, r *http.Request, params gen.SearchSuggestParams) {
	q := strings.TrimSpace(params.Q)
	if q == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "q is required (1-100 characters)")
		return
	}
	if utf8.RuneCountInString(q) > searchMaxSuggestQ {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "q must be 100 characters or fewer")
		return
	}
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	pattern := "%" + escapeLike(q) + "%"
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT name FROM (
			SELECT ci.name, ci.created_at
			FROM catalogue_items ci
			JOIN merchants m ON m.owner_user_id = ci.merchant_id AND m.verification = 'approved'
			WHERE ci.available = true AND ci.deleted_at IS NULL
				AND ci.name ILIKE $1 ESCAPE '\'
			UNION ALL
			SELECT m.business_name, m.created_at
			FROM merchants m
			WHERE m.verification = 'approved' AND m.business_name ILIKE $1 ESCAPE '\'
			UNION ALL
			SELECT s.name, s.created_at
			FROM services s
			WHERE s.active = true AND s.name ILIKE $1 ESCAPE '\'
		) suggestions
		ORDER BY lower(name), created_at
		LIMIT $2`, pattern, searchSuggestLimit)
	if err != nil {
		s.logger.Error("search suggest query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]string, 0, searchSuggestLimit)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			s.logger.Error("scan search suggest row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate search suggest rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetSearchHistory returns the caller's 20 most recent search queries,
// newest first (the contract /search/history GET response is a plain array
// of strings).
func (s *Server) GetSearchHistory(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT query FROM search_history
		WHERE user_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2`, user.ID, searchHistoryLimit)
	if err != nil {
		s.logger.Error("list search history failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]string, 0, searchHistoryLimit)
	for rows.Next() {
		var query string
		if err := rows.Scan(&query); err != nil {
			s.logger.Error("scan search history row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, query)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate search history rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ClearSearchHistory deletes the caller's entire search history.
func (s *Server) ClearSearchHistory(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM search_history WHERE user_id = $1`, user.ID); err != nil {
		s.logger.Error("clear search history failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// recordSearchHistory upserts the query into the caller's history and prunes
// it to the newest searchHistoryCap rows. The whole write is best-effort:
// failures are logged, never surfaced to the search caller.
func (s *Server) recordSearchHistory(ctx context.Context, userID uuid.UUID, query string) {
	// Upsert style: a repeated query replaces its earlier row.
	if _, err := s.db.Pool().Exec(ctx,
		`DELETE FROM search_history WHERE user_id = $1 AND query = $2`, userID, query); err != nil {
		s.logger.Error("search history dedupe failed", "error", err)
		return
	}
	if _, err := s.db.Pool().Exec(ctx,
		`INSERT INTO search_history (user_id, query) VALUES ($1, $2)`, userID, query); err != nil {
		s.logger.Error("search history insert failed", "error", err)
		return
	}
	if _, err := s.db.Pool().Exec(ctx,
		`DELETE FROM search_history WHERE user_id = $1 AND id NOT IN (
			SELECT id FROM search_history WHERE user_id = $1
			ORDER BY created_at DESC, id DESC LIMIT $2)`, userID, searchHistoryCap); err != nil {
		s.logger.Error("search history prune failed", "error", err)
	}
}
