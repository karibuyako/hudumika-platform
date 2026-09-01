package api

// ADMIN-EXTRA bounded context (API-CONTRACT.yaml /admin/*): banners, feature
// flags, help articles, notification broadcast, data-export queue, group-buy
// moderation, conversation oversight, the integration health registry and
// global search.
//
// Gating: /admin/* route policy restricts every route to MFA-verified staff
// before the handler runs; the handlers still fail hard (500 INTERNAL_ERROR)
// when no database is wired (dev, unit-test server). The audit middleware
// records every /admin/* mutation, so no handler writes audit rows itself.
//
// Honest mapping notes:
//   - banner clicks/impressions have no tracking columns yet: honest zeros
//     (the contract defaults them to 0).
//   - feature flag rollout is stored as a 0..1 numeric and exposed as a
//     0..100 rolloutPct; the API validates the fraction stays within [0,1].
//   - help article category/published are stored (contract requires them in
//     the bodies and responses); slug is derived from the title.
//   - broadcast audience segments/cityIds have no user linkage columns yet
//     (no segments table, no city column on users): only the roles filter
//     narrows recipients, and the campaign is capped at 1000 inserted
//     in-app notifications.
//   - data_exports may not exist in parallel milestone builds: guarded with
//     to_regclass, contributes [] until it lands.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/groupbuy"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Read bounds for the admin-extra list surfaces. The contract defines no
// pagination params for banners/features/group-buys/data-exports, so those
// lists cap at adminExtraMaxListLimit newest-first like AdminListOrders.
const (
	adminExtraMaxListLimit = 100

	// broadcastRecipientCap is the hard cap on how many recipients a single
	// broadcast may notify (notifications rows). The audience COUNT may be
	// larger; only the first cap users by created_at receive rows.
	broadcastRecipientCap = 1000
	// broadcastBatchSize chunks recipient inserts so no single INSERT
	// statement grows unbounded.
	broadcastBatchSize = 100

	// globalSearchPerEntity caps the rows contributed by one entity query.
	globalSearchPerEntity = 20
)

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

// adminBannerRow is one row of the banners table.
type adminBannerRow struct {
	id        uuid.UUID
	title     string
	imageURL  *string
	placement string
	startsAt  *time.Time
	endsAt    *time.Time
	active    bool
	createdAt time.Time
	updatedAt time.Time
}

const bannerColumns = `id, title, image_url, placement, starts_at, ends_at, active, created_at, updated_at`

func scanBannerRow(sc pgx.Row) (adminBannerRow, error) {
	var row adminBannerRow
	err := sc.Scan(&row.id, &row.title, &row.imageURL, &row.placement,
		&row.startsAt, &row.endsAt, &row.active, &row.createdAt, &row.updatedAt)
	return row, err
}

// toGenBanner maps a banner row onto the contract AdminBanner. clicks and
// impressions have no tracking columns yet: the honest zeros the contract
// defaults them to. description/link have no columns either and are omitted.
func toGenBanner(row adminBannerRow) gen.AdminBanner {
	clicks, impressions := 0, 0
	return gen.AdminBanner{
		Id:            newUUID(row.id.String()),
		Title:         row.title,
		ImageUrl:      row.imageURL,
		Placement:     gen.AdminBannerPlacement(row.placement),
		Active:        &row.active,
		ScheduledFrom: row.startsAt,
		ScheduledTo:   row.endsAt,
		Clicks:        &clicks,
		Impressions:   &impressions,
		CreatedAt:     &row.createdAt,
	}
}

// AdminListBanners returns every banner, newest first, capped at
// adminExtraMaxListLimit (GET /admin/banners).
func (s *Server) AdminListBanners(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("list banners failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+bannerColumns+` FROM banners ORDER BY created_at DESC, id DESC LIMIT $1`,
		adminExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list banners query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminBanner, 0, adminExtraMaxListLimit)
	for rows.Next() {
		row, err := scanBannerRow(rows)
		if err != nil {
			s.logger.Error("scan banner row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenBanner(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate banner rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminCreateBanner inserts a banner (POST /admin/banners, 201). A window
// whose end is not after its start answers 422 BANNER_SCHEDULE_INVALID; an
// unknown placement answers 422 VALIDATION_FAILED. The contract marks id
// required on the body; a nil-id body gets a fresh server id.
func (s *Server) AdminCreateBanner(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	var body gen.AdminCreateBannerJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title is required")
		return
	}
	if !body.Placement.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "placement must be one of home_top, home_middle, category, checkout, activity")
		return
	}
	if !bannerScheduleValid(body.ScheduledFrom, body.ScheduledTo) {
		writeError(w, http.StatusUnprocessableEntity, "BANNER_SCHEDULE_INVALID", "scheduledTo must be after scheduledFrom")
		return
	}
	if s.db == nil {
		s.logger.Error("create banner failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	id := uuid.UUID(body.Id)
	if id == uuid.Nil {
		id = uuid.New()
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	row, err := scanBannerRow(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO banners (id, title, image_url, placement, starts_at, ends_at, active)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+bannerColumns,
		id, body.Title, body.ImageUrl, string(body.Placement), body.ScheduledFrom, body.ScheduledTo, active))
	if err != nil {
		s.logger.Error("create banner failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"title": body.Title, "placement": string(body.Placement)})
	_ = s.AuditLog(r.Context(), r, "banner.created", "banner", nil, nil, newJSON)
	writeJSON(w, http.StatusCreated, toGenBanner(row))
}

// AdminUpdateBanner patches a banner (PATCH /admin/banners/{bannerId}, 200).
// PATCH semantics: only fields present in the body are written. A missing
// banner answers 404 BANNER_NOT_FOUND; an invalid schedule 422
// BANNER_SCHEDULE_INVALID.
func (s *Server) AdminUpdateBanner(w http.ResponseWriter, r *http.Request, bannerId openapi_types.UUID) {
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	id, err := uuid.Parse(bannerId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "bannerId is not a valid UUID")
		return
	}
	var body gen.AdminUpdateBannerJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Placement != "" && !body.Placement.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "placement must be one of home_top, home_middle, category, checkout, activity")
		return
	}
	if !bannerScheduleValid(body.ScheduledFrom, body.ScheduledTo) {
		writeError(w, http.StatusUnprocessableEntity, "BANNER_SCHEDULE_INVALID", "scheduledTo must be after scheduledFrom")
		return
	}
	if s.db == nil {
		s.logger.Error("update banner failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Dynamic SET list keeps PATCH partial-friendly while every branch stays
	// parameterized. One or more fields is guaranteed by the contract shape.
	sets := []string{}
	args := []any{id}
	addSet := func(col string, v any) {
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Title != "" {
		addSet("title", body.Title)
	}
	if body.ImageUrl != nil {
		addSet("image_url", *body.ImageUrl)
	}
	if body.Placement != "" {
		addSet("placement", string(body.Placement))
	}
	if body.Active != nil {
		addSet("active", *body.Active)
	}
	if body.ScheduledFrom != nil {
		addSet("starts_at", *body.ScheduledFrom)
	}
	if body.ScheduledTo != nil {
		addSet("ends_at", *body.ScheduledTo)
	}
	if len(sets) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "no banner fields to update")
		return
	}
	sets = append(sets, "updated_at = now()")
	row, err := scanBannerRow(s.db.Pool().QueryRow(r.Context(),
		`UPDATE banners SET `+strings.Join(sets, ", ")+` WHERE id = $1 RETURNING `+bannerColumns,
		args...))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "BANNER_NOT_FOUND", "Banner not found")
		return
	}
	if err != nil {
		s.logger.Error("update banner failed", "banner", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bannerID := id
	_ = s.AuditLog(r.Context(), r, "banner.updated", "banner", &bannerID, nil, nil)
	writeJSON(w, http.StatusOK, toGenBanner(row))
}

// AdminDeleteBanner deletes a banner (DELETE /admin/banners/{bannerId}).
// The contract only declares 204/403, so deletion is idempotent: deleting a
// banner that is already gone still answers 204.
func (s *Server) AdminDeleteBanner(w http.ResponseWriter, r *http.Request, bannerId openapi_types.UUID) {
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	id, err := uuid.Parse(bannerId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "bannerId is not a valid UUID")
		return
	}
	if s.db == nil {
		s.logger.Error("delete banner failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(), `DELETE FROM banners WHERE id = $1`, id); err != nil {
		s.logger.Error("delete banner failed", "banner", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bannerID := id
	_ = s.AuditLog(r.Context(), r, "banner.deleted", "banner", &bannerID, nil, nil)
	writeJSON(w, http.StatusNoContent, nil)
}

// bannerScheduleValid reports whether a scheduling window is usable: a
// window with both bounds must satisfy ends > starts; a window missing a
// bound (unbounded start or end) is allowed.
func bannerScheduleValid(startsAt, endsAt *time.Time) bool {
	if startsAt == nil || endsAt == nil {
		return true
	}
	return endsAt.After(*startsAt)
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

// adminFeatureRow is one row of the feature_flags table.
type adminFeatureRow struct {
	key         string
	description string
	enabled     bool
	rollout     float64
	updatedAt   time.Time
}

// toGenFeature maps a feature flag row onto the contract AdminFeatureFlag:
// rollout is the stored 0..1 fraction exposed as a 0..100 rolloutPct.
// description/betaOnly/updatedBy have no contract field (or column) and are
// omitted; targeting has no columns and stays nil.
func toGenFeature(row adminFeatureRow) gen.AdminFeatureFlag {
	rolloutPct := float32(row.rollout) * 100
	updatedAt := row.updatedAt
	return gen.AdminFeatureFlag{
		Key:        row.key,
		Enabled:    row.enabled,
		RolloutPct: &rolloutPct,
		UpdatedAt:  &updatedAt,
	}
}

// AdminListFeatures returns every feature flag, key-sorted, capped at
// adminExtraMaxListLimit (GET /admin/features).
func (s *Server) AdminListFeatures(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list feature flags failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT key, description, enabled, rollout, updated_at FROM feature_flags
		 ORDER BY key LIMIT $1`, adminExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list feature flags query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminFeatureFlag, 0, adminExtraMaxListLimit)
	for rows.Next() {
		var row adminFeatureRow
		if err := rows.Scan(&row.key, &row.description, &row.enabled, &row.rollout, &row.updatedAt); err != nil {
			s.logger.Error("scan feature flag row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenFeature(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate feature flag rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminUpdateFeature upserts a feature flag by key (PATCH /admin/features,
// 200). The contract route is an upsert (no 404 state exists), so
// FEATURE_KEY_EXISTS — defined for a create path that would collide on a
// live key — never fires here and is not raised. rolloutPct must map to a
// 0..1 fraction (i.e. 0..100); anything outside answers 422 VALIDATION_FAILED.
func (s *Server) AdminUpdateFeature(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminUpdateFeatureJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Key) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "key is required")
		return
	}
	rollout := 1.0
	if body.RolloutPct != nil {
		if *body.RolloutPct < 0 || *body.RolloutPct > 100 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "rolloutPct must be between 0 and 100")
			return
		}
		rollout = float64(*body.RolloutPct) / 100
	}
	if s.db == nil {
		s.logger.Error("update feature flag failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var row adminFeatureRow
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO feature_flags (key, enabled, rollout, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (key) DO UPDATE
		 SET enabled = EXCLUDED.enabled, rollout = EXCLUDED.rollout, updated_at = now()
		 RETURNING key, description, enabled, rollout, updated_at`,
		body.Key, body.Enabled, rollout).Scan(&row.key, &row.description, &row.enabled, &row.rollout, &row.updatedAt)
	if err != nil {
		s.logger.Error("update feature flag failed", "key", body.Key, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"key": body.Key, "enabled": body.Enabled})
	_ = s.AuditLog(r.Context(), r, "feature.updated", "feature_flag", nil, nil, newJSON)
	writeJSON(w, http.StatusOK, toGenFeature(row))
}

// ---------------------------------------------------------------------------
// Help articles
// ---------------------------------------------------------------------------

// AdminCreateHelpArticle inserts a help article (POST /admin/help/articles,
// 201) answering the contract {id,title,category} shape. The slug is derived
// from the title; a slug collision answers 409 HELP_ARTICLE_SLUG_EXISTS
// (ERROR-CODES.md allows adding codes — no help-article code existed).
func (s *Server) AdminCreateHelpArticle(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	var body gen.AdminCreateHelpArticleJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Title) == "" || strings.TrimSpace(body.Category) == "" || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title, category and body are required")
		return
	}
	if s.db == nil {
		s.logger.Error("create help article failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	published := true
	if body.Published != nil {
		published = *body.Published
	}
	var (
		id       uuid.UUID
		title    string
		category string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO help_articles (title, body, slug, category, published)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, title, category`,
		body.Title, body.Body, slugify(body.Title), body.Category, published).Scan(&id, &title, &category)
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, "HELP_ARTICLE_SLUG_EXISTS", "A help article with this title already exists")
		return
	}
	if err != nil {
		s.logger.Error("create help article failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"title": body.Title, "category": body.Category})
	_ = s.AuditLog(r.Context(), r, "help_article.created", "help_article", nil, nil, newJSON)
	writeJSON(w, http.StatusCreated, struct {
		Id       openapi_types.UUID `json:"id"`
		Title    string             `json:"title"`
		Category string             `json:"category"`
	}{
		Id:       newUUID(id.String()),
		Title:    title,
		Category: category,
	})
}

// AdminUpdateHelpArticle patches a help article (PUT /admin/help/articles,
// 200). The slug is stable across edits so published links never break; a
// missing article answers 404 TEMPLATE_NOT_FOUND per ERROR-CODES.md.
func (s *Server) AdminUpdateHelpArticle(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	var body gen.AdminUpdateHelpArticleJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	id := uuid.UUID(body.Id)
	if id == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	if s.db == nil {
		s.logger.Error("update help article failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	sets := []string{"updated_at = now()"}
	args := []any{id}
	addSet := func(col string, v any) {
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Title != nil && strings.TrimSpace(*body.Title) != "" {
		addSet("title", *body.Title)
	}
	if body.Body != nil {
		addSet("body", *body.Body)
	}
	if body.Category != nil {
		addSet("category", *body.Category)
	}
	if body.Published != nil {
		addSet("published", *body.Published)
	}
	if len(sets) == 1 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "no help article fields to update")
		return
	}
	var (
		title    string
		category string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`UPDATE help_articles SET `+strings.Join(sets, ", ")+` WHERE id = $1 RETURNING title, category`,
		args...).Scan(&title, &category)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "TEMPLATE_NOT_FOUND", "Help article not found")
		return
	}
	if err != nil {
		s.logger.Error("update help article failed", "article", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	_ = s.AuditLog(r.Context(), r, "help_article.updated", "help_article", &id, nil, nil)
	writeJSON(w, http.StatusOK, struct {
		Id       openapi_types.UUID `json:"id"`
		Title    string             `json:"title"`
		Category string             `json:"category"`
	}{
		Id:       newUUID(id.String()),
		Title:    title,
		Category: category,
	})
}

// ---------------------------------------------------------------------------
// Broadcast notification
// ---------------------------------------------------------------------------

// AdminBroadcastNotification targets an audience with an in-app
// notification (POST /admin/notifications/send, 202). The audience is
// filtered by roles only — segments and cityIds have no user-linkage
// columns yet (no segments table, no city column on users), so they are
// accepted but do not narrow the recipient set. The recipient count is
// computed first; a filter matching nobody answers 422
// BROADCAST_AUDIENCE_EMPTY. Recipients are capped at broadcastRecipientCap
// (first users by created_at), inserted in broadcastBatchSize batches;
// estimatedRecipients is the number actually inserted, so the campaign id
// and count stay truthful even beyond the cap.
func (s *Server) AdminBroadcastNotification(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}
	var body gen.AdminBroadcastNotificationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Title) == "" || strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title and body are required")
		return
	}
	if s.db == nil {
		s.logger.Error("broadcast notification failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	roles := make([]string, 0, 4)
	if body.Audience != nil && body.Audience.Roles != nil {
		for _, role := range *body.Audience.Roles {
			if role != "" {
				roles = append(roles, string(role))
			}
		}
	}

	// Compute the audience size first: BROADCAST_AUDIENCE_EMPTY is answered
	// before any row is written.
	countArgs := []any{}
	countQuery := `SELECT count(*) FROM users u`
	if len(roles) > 0 {
		countArgs = append(countArgs, roles)
		countQuery += ` WHERE EXISTS (
			SELECT 1 FROM roles r
			WHERE r.user_id = u.id AND r.active AND r.role = ANY($1)
		)`
	}
	var audienceCount int
	if err := s.db.Pool().QueryRow(r.Context(), countQuery, countArgs...).Scan(&audienceCount); err != nil {
		s.logger.Error("broadcast audience count failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if audienceCount == 0 {
		writeError(w, http.StatusUnprocessableEntity, "BROADCAST_AUDIENCE_EMPTY", "The audience filter matches no users")
		return
	}

	// Pick recipients (deterministic: oldest users first) and cap.
	recipientQuery := `SELECT id FROM users u`
	recipientArgs := []any{broadcastRecipientCap}
	if len(roles) > 0 {
		recipientArgs = append(recipientArgs, roles)
		recipientQuery += ` WHERE EXISTS (
			SELECT 1 FROM roles r
			WHERE r.user_id = u.id AND r.active AND r.role = ANY($2)
		)`
	}
	recipientQuery += ` ORDER BY created_at, id LIMIT $1`
	rows, err := s.db.Pool().Query(r.Context(), recipientQuery, recipientArgs...)
	if err != nil {
		s.logger.Error("broadcast recipient query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	recipientIDs := make([]uuid.UUID, 0, broadcastRecipientCap)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			s.logger.Error("scan broadcast recipient failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		recipientIDs = append(recipientIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate broadcast recipients failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	if err := insertNotificationsBatched(r.Context(), s, recipientIDs, body.Title, body.Body, body.DeepLink); err != nil {
		s.logger.Error("broadcast notification insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	newJSON, _ := json.Marshal(map[string]any{"title": body.Title, "estimatedRecipients": len(recipientIDs)})
	_ = s.AuditLog(r.Context(), r, "notification.broadcast", "notification", nil, nil, newJSON)
	writeJSON(w, http.StatusAccepted, struct {
		CampaignId          openapi_types.UUID `json:"campaignId"`
		EstimatedRecipients int                `json:"estimatedRecipients"`
	}{
		CampaignId:          newUUID(uuid.NewString()),
		EstimatedRecipients: len(recipientIDs),
	})
}

// insertNotificationsBatched writes one notifications row per recipient in
// broadcastBatchSize multi-row INSERTs (type 'broadcast').
func insertNotificationsBatched(ctx context.Context, s *Server, recipientIDs []uuid.UUID, title, body string, deepLink *string) error {
	for start := 0; start < len(recipientIDs); start += broadcastBatchSize {
		end := start + broadcastBatchSize
		if end > len(recipientIDs) {
			end = len(recipientIDs)
		}
		batch := recipientIDs[start:end]
		placeholders := make([]string, 0, len(batch))
		args := make([]any, 0, 4*len(batch))
		for i, id := range batch {
			placeholders = append(placeholders, fmt.Sprintf("($%d, 'broadcast', $%d, $%d, $%d)",
				4*i+1, 4*i+2, 4*i+3, 4*i+4))
			args = append(args, id, title, body, deepLink)
		}
		if _, err := s.db.Pool().Exec(ctx,
			`INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES `+
				strings.Join(placeholders, ", "), args...); err != nil {
			return fmt.Errorf("insert broadcast batch: %w", err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Data export queue
// ---------------------------------------------------------------------------

// AdminListDataExports returns the data export job queue, newest first,
// capped at adminExtraMaxListLimit (GET /admin/data-exports). The
// data_exports table arrives with migration 00032 (parallel milestone); a
// deployment without it answers an honest empty list, guarded by
// to_regclass. The contract 'ready' status maps from the stored
// 'completed' value.
func (s *Server) AdminListDataExports(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermExportManage)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("list data exports failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var reg *string
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT to_regclass('public.data_exports')::text`).Scan(&reg); err != nil {
		s.logger.Error("data exports table check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if reg == nil {
		writeJSON(w, http.StatusOK, []gen.DataExportJob{})
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, scope, format, status, file_url, expires_at, created_at, completed_at
		 FROM data_exports ORDER BY created_at DESC, id DESC LIMIT $1`, adminExtraMaxListLimit)
	if err != nil {
		s.logger.Error("list data exports query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.DataExportJob, 0, adminExtraMaxListLimit)
	for rows.Next() {
		var (
			id          uuid.UUID
			scope       string
			format      string
			status      string
			fileURL     *string
			expiresAt   *time.Time
			createdAt   time.Time
			completedAt *time.Time
		)
		if err := rows.Scan(&id, &scope, &format, &status, &fileURL, &expiresAt, &createdAt, &completedAt); err != nil {
			s.logger.Error("scan data export row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.DataExportJob{
			Id:          newUUID(id.String()),
			Scope:       gen.DataExportJobScope(scope),
			Format:      gen.DataExportJobFormat(format),
			Status:      toGenDataExportStatus(status),
			DownloadUrl: fileURL,
			// expiresInSeconds is omitted: the row carries expires_at, but
			// the intended download window is not derivable from it.
			CreatedAt:   createdAt,
			CompletedAt: completedAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate data export rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// toGenDataExportStatus maps the stored status onto the contract enum: the
// DB uses 'completed', the contract 'ready'.
func toGenDataExportStatus(status string) gen.DataExportJobStatus {
	if status == "completed" {
		return gen.DataExportJobStatusReady
	}
	return gen.DataExportJobStatus(status)
}

// ---------------------------------------------------------------------------
// Group buy moderation
// ---------------------------------------------------------------------------

// adminGroupBuyDBStatus maps the contract GroupBuyStatus values onto the
// stored statuses. 'live' is the contract name for the stored 'active'
// state (the groupbuy store writes 'active'); pending_review/rejected/
// extended are stored states admitted by the 00034 constraint extension.
var adminGroupBuyDBStatus = map[gen.GroupBuyStatus]string{
	gen.GroupBuyStatusDelisted:      "delisted",
	gen.GroupBuyStatusDraft:         "draft",
	gen.GroupBuyStatusEnded:         "ended",
	gen.GroupBuyStatusExtended:      "extended",
	gen.GroupBuyStatusLive:          "active",
	gen.GroupBuyStatusPendingReview: "pending_review",
	gen.GroupBuyStatusRejected:      "rejected",
}

// adminGroupBuyContractStatus maps a stored status back onto the contract
// enum; the inverse of adminGroupBuyDBStatus. The shared toGenGroupBuyDeal
// maps rows verbatim, so the admin surfaces override the status with this.
func adminGroupBuyContractStatus(dbStatus string) gen.GroupBuyStatus {
	switch dbStatus {
	case "active":
		return gen.GroupBuyStatusLive
	default:
		return gen.GroupBuyStatus(dbStatus)
	}
}

// toGenAdminGroupBuyDeal maps a deal row onto the contract GroupBuyDeal with
// the contract status (DB 'active' surfaces as 'live').
func toGenAdminGroupBuyDeal(deal groupbuy.DealRow) gen.GroupBuyDeal {
	out := toGenGroupBuyDeal(deal)
	out.Status = adminGroupBuyContractStatus(deal.Status)
	return out
}

// AdminListGroupBuys returns the moderation queue (GET /admin/group-buys),
// newest first, capped at adminExtraMaxListLimit. The optional state filter
// maps the contract statuses onto the stored ones; an unknown value answers
// 422 VALIDATION_FAILED. The contract defines no pagination params, so the
// list is a bounded snapshot rather than cursor-paginated.
func (s *Server) AdminListGroupBuys(w http.ResponseWriter, r *http.Request, params gen.AdminListGroupBuysParams) {
	if s.db == nil {
		s.logger.Error("list admin group buys failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	query := `SELECT id, merchant_id, title, description, original_price_tzs, deal_price_tzs,
			quantity_total, quantity_sold, start_at, end_at, status, created_at, updated_at
		FROM group_buy_deals`
	args := []any{adminExtraMaxListLimit}
	limitParam := "$1"
	if params.State != nil && *params.State != "" {
		dbStatus, ok := adminGroupBuyDBStatus[*params.State]
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "state is not a valid group buy status")
			return
		}
		args = []any{dbStatus, adminExtraMaxListLimit}
		query += ` WHERE status = $1`
		limitParam = "$2"
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ` + limitParam + `::int`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin group buys query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.GroupBuyDeal, 0, adminExtraMaxListLimit)
	for rows.Next() {
		deal, err := scanGroupBuyDeal(rows)
		if err != nil {
			s.logger.Error("scan admin group buy row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenAdminGroupBuyDeal(deal))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin group buy rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// scanGroupBuyDeal reuses the groupbuy package's DealRow shape so the
// existing toGenGroupBuyDeal mapping applies.
func scanGroupBuyDeal(sc interface{ Scan(dest ...any) error }) (groupbuy.DealRow, error) {
	var deal groupbuy.DealRow
	err := sc.Scan(&deal.ID, &deal.MerchantID, &deal.Title, &deal.Description,
		&deal.OriginalPriceTZS, &deal.DealPriceTZS, &deal.QuantityTotal, &deal.QuantitySold,
		&deal.StartAt, &deal.EndAt, &deal.Status, &deal.CreatedAt, &deal.UpdatedAt)
	return deal, err
}

// AdminGroupBuyDecision applies a staff moderation decision (POST
// /admin/group-buys/{groupId}/decision, 200). Approved promotes a draft
// deal to live (active); rejected moves a draft to rejected; delisted
// pauses an active deal. Each transition is idempotent in its target state
// (re-deciding an already-approved deal is a 200 no-op, mirroring review
// moderation) and 409 GROUP_BUY_STATUS_CONFLICT from any other state; a
// missing deal answers 404 GROUP_BUY_NOT_FOUND.
func (s *Server) AdminGroupBuyDecision(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	dealID, err := uuid.Parse(groupId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "groupId is not a valid UUID")
		return
	}
	var body gen.AdminGroupBuyDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	target, ok := adminGroupBuyDecisionTargets[body.Decision]
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of approved, rejected, delisted")
		return
	}
	if body.Reason != nil && len(*body.Reason) > 1000 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason must be at most 1000 characters")
		return
	}
	if s.db == nil {
		s.logger.Error("group buy decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("group buy decision begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	var current string
	err = tx.QueryRow(r.Context(),
		`SELECT status FROM group_buy_deals WHERE id = $1 FOR UPDATE`, dealID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "GROUP_BUY_NOT_FOUND", "Group buy deal not found")
		return
	}
	if err != nil {
		s.logger.Error("lock group buy deal failed", "deal", dealID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	targetState, validFrom, idempotent := target(current)
	if !validFrom {
		writeError(w, http.StatusConflict, "GROUP_BUY_STATUS_CONFLICT", "Deal cannot be transitioned to this state from its current status")
		return
	}
	if idempotent {
		// Already in the target state: re-fetch and answer 200, never a
		// conflict.
		deal, err := scanGroupBuyDeal(tx.QueryRow(r.Context(),
			`SELECT id, merchant_id, title, description, original_price_tzs, deal_price_tzs,
				quantity_total, quantity_sold, start_at, end_at, status, created_at, updated_at
			 FROM group_buy_deals WHERE id = $1`, dealID))
		if err != nil {
			s.logger.Error("reload group buy deal failed", "deal", dealID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			s.logger.Error("group buy decision commit failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeJSON(w, http.StatusOK, toGenAdminGroupBuyDeal(deal))
		return
	}

	deal, err := scanGroupBuyDeal(tx.QueryRow(r.Context(),
		`UPDATE group_buy_deals SET status = $2, updated_at = now()
		 WHERE id = $1
		 RETURNING id, merchant_id, title, description, original_price_tzs, deal_price_tzs,
			quantity_total, quantity_sold, start_at, end_at, status, created_at, updated_at`,
		dealID, targetState))
	if err != nil {
		s.logger.Error("transition group buy deal failed", "deal", dealID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("group buy decision commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenAdminGroupBuyDeal(deal))
}

// adminGroupBuyDecisionTargets maps each contract decision to a transition
// function: given the stored status it returns the target state, whether
// the transition is allowed from that state, and whether the deal is
// already in the target state (idempotent no-op).
var adminGroupBuyDecisionTargets = map[gen.AdminGroupBuyDecisionJSONBodyDecision]func(current string) (target string, allowed, idempotent bool){
	gen.AdminGroupBuyDecisionJSONBodyDecisionApproved: func(current string) (string, bool, bool) {
		switch current {
		case "draft":
			return "active", true, false
		case "active":
			return "active", true, true
		default:
			return "", false, false
		}
	},
	gen.AdminGroupBuyDecisionJSONBodyDecisionRejected: func(current string) (string, bool, bool) {
		switch current {
		case "draft":
			return "rejected", true, false
		case "rejected":
			return "rejected", true, true
		default:
			return "", false, false
		}
	},
	gen.AdminGroupBuyDecisionJSONBodyDecisionDelisted: func(current string) (string, bool, bool) {
		switch current {
		case "active":
			return "delisted", true, false
		case "delisted":
			return "delisted", true, true
		default:
			return "", false, false
		}
	},
}

// ---------------------------------------------------------------------------
// Conversation oversight
// ---------------------------------------------------------------------------

// AdminListConversations returns every conversation for staff oversight
// (GET /admin/conversations, ConversationDetail items), newest activity
// first, keyset-paginated with the next cursor on X-Next-Cursor. Optional
// merchantId and status params narrow the set. Participant display names and
// phones come from one users join for the whole page (never N+1); phones
// ride the maskedPhone field because the schema exposes no unmasked phone —
// staff phone exposure matches /admin/customers (phones are never masked on
// admin surfaces, masking.go).
func (s *Server) AdminListConversations(w http.ResponseWriter, r *http.Request, params gen.AdminListConversationsParams) {
	if s.db == nil {
		s.logger.Error("list admin conversations failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := adminListLimit(params.Limit)
	var (
		cursorAt  time.Time
		cursorID  uuid.UUID
		hasCursor bool
	)
	if params.Cursor != nil && *params.Cursor != "" {
		parsedAt, parsedID, err := parseChatCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursorAt, cursorID, hasCursor = parsedAt, parsedID, true
	}

	query := `SELECT c.id, c.customer_user_id, c.merchant_id, c.subject, c.status,
	       c.unread_customer, c.unread_merchant,
	       c.last_message_at, c.created_at, c.updated_at,
	       (SELECT m.body FROM conversation_messages m
	         WHERE m.conversation_id = c.id
	         ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
	FROM conversations c`
	args := make([]any, 0, 5)
	clauses := []string{}
	if params.MerchantId != nil {
		args = append(args, uuid.UUID(*params.MerchantId))
		clauses = append(clauses, fmt.Sprintf("c.merchant_id = $%d", len(args)))
	}
	if params.Status != nil && *params.Status != "" {
		args = append(args, string(*params.Status))
		clauses = append(clauses, fmt.Sprintf("c.status = $%d", len(args)))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		clauses = append(clauses, fmt.Sprintf("(COALESCE(c.last_message_at, c.created_at), c.id) < ($%d, $%d)",
			len(args)-1, len(args)))
	}
	if len(clauses) > 0 {
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list admin conversations query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	type conversationRow = chatConversationRow
	convs := make([]chatConversationRow, 0, limit)
	userIDs := map[uuid.UUID]bool{}
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		c, err := scanChatConversation(rows)
		if err != nil {
			rows.Close()
			s.logger.Error("scan admin conversation row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(convs) == limit {
			sentinel = true
			continue
		}
		userIDs[c.customerUserID] = true
		userIDs[c.merchantID] = true
		convs = append(convs, c)
		lastAt, lastID = conversationListKey(&c), c.id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate admin conversation rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", encodeChatCursor(lastAt, lastID))
	}

	// One users join resolves display names and phones for the whole page.
	names := map[uuid.UUID]string{}
	phones := map[uuid.UUID]string{}
	if len(userIDs) > 0 {
		ids := make([]uuid.UUID, 0, len(userIDs))
		for id := range userIDs {
			ids = append(ids, id)
		}
		userRows, err := s.db.Pool().Query(r.Context(),
			`SELECT id, COALESCE(NULLIF(full_name, ''), phone), phone FROM users WHERE id = ANY($1::uuid[])`,
			ids)
		if err != nil {
			s.logger.Error("load conversation participants failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for userRows.Next() {
			var (
				id    uuid.UUID
				name  string
				phone string
			)
			if err := userRows.Scan(&id, &name, &phone); err != nil {
				userRows.Close()
				s.logger.Error("scan participant row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			names[id] = name
			phones[id] = phone
		}
		userRows.Close()
		if err := userRows.Err(); err != nil {
			s.logger.Error("iterate participant rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	out := make([]gen.ConversationDetail, 0, len(convs))
	for _, c := range convs {
		subject := c.subject
		participants := []struct {
			DisplayName string                                 `json:"displayName"`
			MaskedPhone *string                                `json:"maskedPhone,omitempty"`
			Role        gen.ConversationDetailParticipantsRole `json:"role"`
		}{
			{DisplayName: names[c.customerUserID], MaskedPhone: phonePtr(phones[c.customerUserID]), Role: gen.ConversationDetailParticipantsRoleCustomer},
			{DisplayName: names[c.merchantID], MaskedPhone: phonePtr(phones[c.merchantID]), Role: gen.ConversationDetailParticipantsRoleMerchantStaff},
		}
		unread := c.unreadCustomer + c.unreadMerchant
		out = append(out, gen.ConversationDetail{
			Id:                 newUUID(c.id.String()),
			CustomerUserId:     chatUUIDPtr(c.customerUserID),
			MerchantId:         newUUID(c.merchantID.String()),
			Subject:            &subject,
			Status:             gen.ConversationStatus(c.status),
			UnreadCount:        unread,
			LastMessagePreview: c.lastMessageBody,
			CreatedAt:          &c.createdAt,
			UpdatedAt:          c.updatedAt,
			Participants:       participants,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func phonePtr(phone string) *string {
	if phone == "" {
		return nil
	}
	return &phone
}

// ---------------------------------------------------------------------------
// Integration health registry
// ---------------------------------------------------------------------------

// adminIntegrationHealthItem is the /admin/integrations item shape; the
// contract declares it inline, so this struct mirrors it exactly.
type adminIntegrationHealthItem struct {
	Provider      string                                                `json:"provider"`
	Category      gen.AdminIntegrationHealth200JSONResponseBodyCategory `json:"category"`
	Health        gen.AdminIntegrationHealth200JSONResponseBodyHealth   `json:"health"`
	LastCheckedAt time.Time                                             `json:"lastCheckedAt"`
	Error         *string                                               `json:"error,omitempty"`
}

// adminIntegrationCategories declares every contract category and the
// integrations.provider values that configure it. The integrations table
// only stores provider keys (pos/erp/accounting/payroll/crm), never vendor
// names, so provider reports the category key for unconfigured categories
// and the stored provider keys for configured ones — honest given the data.
var adminIntegrationCategories = []struct {
	provider    string
	category    gen.AdminIntegrationHealth200JSONResponseBodyCategory
	dbProviders []string
}{
	{provider: "payment", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryPayment},
	{provider: "maps", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryMaps},
	{provider: "sms", category: gen.AdminIntegrationHealth200JSONResponseBodyCategorySms},
	{provider: "email", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryEmail},
	{provider: "pos", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryPos, dbProviders: []string{"pos"}},
	{provider: "logistics", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryLogistics},
	{provider: "erp", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryErp, dbProviders: []string{"erp", "accounting", "payroll"}},
	{provider: "crm", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryCrm, dbProviders: []string{"crm"}},
	{provider: "webhooks", category: gen.AdminIntegrationHealth200JSONResponseBodyCategoryWebhooks},
}

// AdminIntegrationHealth reports the platform integration registry (GET
// /admin/integrations). Counts come from the integrations table grouped by
// provider (webhooks from webhook_subscriptions); the health verdict is
// static configuration health: healthy when at least one connector is
// configured, degraded with an honest "not configured" error otherwise. No
// liveness probe is wired, so no integration can be reported down.
func (s *Server) AdminIntegrationHealth(w http.ResponseWriter, r *http.Request) {
	_, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("integration health failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	now := time.Now()

	connectorCounts := map[string]int{}
	var reg *string
	if err := s.db.Pool().QueryRow(ctx, `SELECT to_regclass('public.integrations')::text`).Scan(&reg); err == nil && reg != nil {
		rows, err := s.db.Pool().Query(ctx, `SELECT provider, count(*) FROM integrations GROUP BY provider`)
		if err != nil {
			s.logger.Error("integration counts query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var (
				provider string
				count    int
			)
			if err := rows.Scan(&provider, &count); err != nil {
				rows.Close()
				s.logger.Error("scan integration count failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			connectorCounts[provider] = count
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			s.logger.Error("iterate integration counts failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	webhookCount := 0
	if err := s.db.Pool().QueryRow(ctx, `SELECT to_regclass('public.webhook_subscriptions')::text`).Scan(&reg); err == nil && reg != nil {
		if err := s.db.Pool().QueryRow(ctx, `SELECT count(*) FROM webhook_subscriptions WHERE active`).Scan(&webhookCount); err != nil {
			s.logger.Error("webhook count query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	out := make([]adminIntegrationHealthItem, 0, len(adminIntegrationCategories))
	for _, cat := range adminIntegrationCategories {
		count := webhookCount
		if cat.category != gen.AdminIntegrationHealth200JSONResponseBodyCategoryWebhooks {
			count = 0
			for _, provider := range cat.dbProviders {
				count += connectorCounts[provider]
			}
		}
		item := adminIntegrationHealthItem{
			Provider:      cat.provider,
			Category:      cat.category,
			LastCheckedAt: now,
		}
		if count > 0 {
			item.Health = gen.Healthy
		} else {
			item.Health = gen.Degraded
			notConfigured := "not configured"
			item.Error = &notConfigured
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

// adminSearchItem is the /admin/search item shape; the contract declares it
// inline, so this struct mirrors it exactly.
type adminSearchItem struct {
	EntityType gen.AdminGlobalSearch200JSONResponseBodyEntityType `json:"entityType"`
	Id         string                                             `json:"id"`
	Label      string                                             `json:"label"`
	Status     *string                                            `json:"status,omitempty"`
	Region     *string                                            `json:"region,omitempty"`
	UpdatedAt  *time.Time                                         `json:"updatedAt,omitempty"`
}

// AdminGlobalSearch searches users (phone), orders (number), merchants
// (business_name), riders (name) and group buys (title) with one
// parameterized ILIKE query per entity, each capped at globalSearchPerEntity
// (GET /admin/search). A missing or overlong q answers 422
// ADMIN_SEARCH_INVALID before any database access. entityTypes narrows the
// searched set; the contract enum has no group-buy type, so a provided
// filter cannot select group buys (they still search when the filter is
// absent — documented deviation). Optional-context tables (merchants,
// riders, group_buy_deals) are guarded with to_regclass and contribute [].
func (s *Server) AdminGlobalSearch(w http.ResponseWriter, r *http.Request, params gen.AdminGlobalSearchParams) {
	q := strings.TrimSpace(params.Q)
	if q == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_SEARCH_INVALID", "q is required")
		return
	}
	if len(q) > 200 {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_SEARCH_INVALID", "q must be at most 200 characters")
		return
	}
	if s.db == nil {
		s.logger.Error("global search failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	want := map[string]bool{}
	if params.EntityTypes != nil {
		for _, t := range *params.EntityTypes {
			want[string(t)] = true
		}
	}
	wantAll := len(want) == 0

	like := "%" + escapeLike(q) + "%"
	out := make([]adminSearchItem, 0, 5*globalSearchPerEntity)

	search := func(entityType, table, labelCol, statusCol string) {
		if !wantAll && !want[entityType] {
			return
		}
		if entityType != "customer" && entityType != "order" {
			if !s.adminTableExists(r.Context(), table) {
				return
			}
		}
		query := fmt.Sprintf(
			`SELECT id, %s, %s, updated_at FROM %s WHERE %s ILIKE $1 ESCAPE '\' ORDER BY updated_at DESC, id DESC LIMIT $2`,
			labelCol, statusCol, table, labelCol)
		rows, err := s.db.Pool().Query(r.Context(), query, like, globalSearchPerEntity)
		if err != nil {
			s.logger.Error("global search query failed", "entity", entityType, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var (
				id        uuid.UUID
				label     string
				status    *string
				updatedAt *time.Time
			)
			if err := rows.Scan(&id, &label, &status, &updatedAt); err != nil {
				rows.Close()
				s.logger.Error("scan global search row failed", "entity", entityType, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			out = append(out, adminSearchItem{
				EntityType: gen.AdminGlobalSearch200JSONResponseBodyEntityType(entityType),
				Id:         id.String(),
				Label:      label,
				Status:     status,
				UpdatedAt:  updatedAt,
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			s.logger.Error("iterate global search rows failed", "entity", entityType, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	search("customer", "users", "phone", "NULL::text")
	search("order", "orders", "no", "status")
	search("merchant", "merchants", "business_name", "verification")
	search("rider", "riders", "name", "verification")
	search("group_buy", "group_buy_deals", "title", "status")

	writeJSON(w, http.StatusOK, out)
}

// adminTableExists reports whether a public-schema table is present in this
// deployment (analytics.go convention).
func (s *Server) adminTableExists(ctx context.Context, name string) bool {
	var reg *string
	if err := s.db.Pool().QueryRow(ctx, `SELECT to_regclass($1)::text`, "public."+name).Scan(&reg); err != nil {
		return false
	}
	return reg != nil
}

// slugify derives a URL-safe slug from a title: lowercased, runs of
// non-alphanumeric characters collapsed to single hyphens, trimmed. A title
// with no alphanumerics falls back to "article-<short uuid>" so the unique
// constraint still has a stable input.
func slugify(title string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(title) {
		alnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if alnum {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash {
			b.WriteByte('-')
			prevDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = "article-" + uuid.NewString()[:8]
	}
	return slug
}

// isUniqueViolation reports whether err is a PostgreSQL unique_violation
// (SQLSTATE 23505).
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
