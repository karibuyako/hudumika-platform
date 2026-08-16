package api

// CATALOGUE BULK surfaces: /catalogue-items/bulk (bulk upsert), the
// /product-templates CRUD pair, /service-categories (public discovery) and
// /store/logs (the merchant's store activity). All but the service category
// discovery are merchant-owned: the merchant id is the REAL merchants row id
// (merchant_linkage.go) and the merchant gate is catalogueMerchantID, shared
// with the CRUD handlers.
//
// Bulk is SYNCHRONOUS like /catalogues/import: the contract's 202 body is
// {jobId, accepted, rejected}, presupposing an async job; the import
// milestone established the convention of executing inline and reporting
// status 'completed', so this surface does the same and keeps the additive
// created/updated/skipped counters + errors list. The contract caps items at
// 500; this milestone caps at 200 (BULK_EXCEEDS_LIMIT) to keep the
// synchronous transaction bounded, and — unlike /catalogues/import — there
// is no replace/overwrite semantics here: incoming items are upserted by
// owned id or inserted, existing items never leave the catalogue.
//
// Product templates are stored per merchant with their name unique within
// the merchant. The contract ProductTemplate schema carries only
// id/name/items/appliedStoreIds/createdAt; priceTZS/category/options are
// additive create-body extensions persisted on the row but not exposed
// (there is no schema field for them yet).
//
// Store logs are the merchant's own store_logs rows (written best-effort by
// this package's mutating handlers) unioned with audit_logs entries that
// reference the merchant: entity_type 'merchants' with the merchant's id, or
// the merchant as actor. /merchants/me/* audit rows are ambiguous (entity_id
// 'me' is not resolvable to a merchant id and merchant actors record as the
// nil UUID because their subject is the phone, see internal/audit) and are
// excluded; when a future merchants context lands the union predicate can be
// tightened. The generated GetStoreLogsParams binds only limit/cursor (no
// from/to/action filters in the current contract).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/gen"
)

const (
	// maxBulkItems bounds one bulk request; the contract allows 500 but the
	// synchronous transaction stays bounded at 200 (see package comment).
	maxBulkItems = 200
	// storeLogDefaultLimit is the /store/logs page size when limit is
	// absent (the contract's default is 50; this milestone pages at 20 like
	// the admin audit log).
	storeLogDefaultLimit = 20
	// storeLogMaxLimit caps a /store/logs page size.
	storeLogMaxLimit = 100
)

// catalogueBulkResult is the synchronous 202 body: the contract's
// {jobId, accepted, rejected} plus the created/updated/skipped counters and
// the errors list (additive extensions in the /catalogues/import style).
type catalogueBulkResult struct {
	JobId    string                 `json:"jobId"`
	Status   string                 `json:"status"`
	Accepted int                    `json:"accepted"`
	Rejected int                    `json:"rejected"`
	Created  int                    `json:"created"`
	Updated  int                    `json:"updated"`
	Skipped  int                    `json:"skipped"`
	Errors   []catalogueImportError `json:"errors,omitempty"`
}

// bulkItemIdentity is the duplicate-detection key inside one bulk request:
// an id when present, otherwise the exact name+category pair (the same
// identity an export → re-import round trip would collide on). Later items
// with an already-seen key are skipped, not applied twice.
func bulkItemIdentity(item gen.CatalogueItem) string {
	if item.Id != nil {
		return "id:" + item.Id.String()
	}
	return "name:" + strings.TrimSpace(item.Name) + "|" + strings.TrimSpace(item.Category)
}

// bulkItemToRow adapts a contract CatalogueItem onto the shared import row
// shape so the upsert transaction can reuse importUpsertItem. The options
// list is marshalled separately (the contract options type is an anonymous
// struct that cannot feed marshalCatalogueOptions directly).
func bulkItemToRow(item gen.CatalogueItem) (catalogueImportRow, []byte, error) {
	row := catalogueImportRow{
		Id:          item.Id,
		Name:        item.Name,
		Description: item.Description,
		PriceTZS:    item.PriceTZS,
		Category:    item.Category,
		Available:   item.Available,
	}
	var options []byte
	if item.Options != nil {
		var err error
		if options, err = json.Marshal(item.Options); err != nil {
			return row, nil, fmt.Errorf("bulk options marshal: %w", err)
		}
	}
	return row, options, nil
}

// BulkCatalogueItems applies the merchant's items atomically (POST
// /catalogue-items/bulk, 202 catalogueBulkResult). Validation order: body
// shape (422 VALIDATION_FAILED), item count bound (422 BULK_EXCEEDS_LIMIT —
// before the merchant gate), per-item bounds name/priceTZS (422
// BULK_OPERATION_INVALID with errors[]), then the merchant gate, then
// category ownership per item (unknown category names are per-item errors,
// not auto-created — this surface has no replace semantics), then one
// transaction: items are upserted by owned id or inserted. In-request
// duplicate items are skipped and reported in the errors list.
func (s *Server) BulkCatalogueItems(w http.ResponseWriter, r *http.Request) {
	var body gen.BulkCatalogueItemsJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 || len(body.Items) > maxBulkItems {
		writeError(w, http.StatusUnprocessableEntity, "BULK_EXCEEDS_LIMIT",
			fmt.Sprintf("items must contain between 1 and %d entries", maxBulkItems))
		return
	}

	var errs []catalogueImportError
	for i, item := range body.Items {
		if !validateCatalogueItemName(item.Name) {
			errs = append(errs, catalogueImportError{
				Field:   fmt.Sprintf("items[%d].name", i),
				Message: "name must be 1-160 characters",
			})
		}
		if item.PriceTZS < 0 {
			errs = append(errs, catalogueImportError{
				Field:   fmt.Sprintf("items[%d].priceTZS", i),
				Message: "priceTZS must be >= 0",
			})
		}
	}
	if len(errs) > 0 {
		s.writeBulkValidation(w, errs)
		return
	}

	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	// Category ownership pre-pass: each non-blank category name must resolve
	// to a category of this merchant (matched by name, never auto-created).
	categoryIDs := make([]*uuid.UUID, len(body.Items))
	errs = nil
	for i, item := range body.Items {
		if strings.TrimSpace(item.Category) == "" {
			continue
		}
		categoryID, err := resolveCategoryID(ctx, s.db.Pool(), merchantID, item.Category, false)
		if err != nil {
			if errors.Is(err, errCategoryNotFound) {
				errs = append(errs, catalogueImportError{
					Field:   fmt.Sprintf("items[%d].category", i),
					Message: "category not found",
				})
				continue
			}
			s.logger.Error("bulk catalogue category lookup failed", "merchant", merchantID, "category", item.Category, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		categoryIDs[i] = categoryID
	}
	if len(errs) > 0 {
		s.writeBulkValidation(w, errs)
		return
	}

	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("bulk catalogue begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	result := catalogueBulkResult{JobId: uuid.NewString(), Status: "completed"}
	seen := make(map[string]bool, len(body.Items))
	for i, item := range body.Items {
		key := bulkItemIdentity(item)
		if seen[key] {
			result.Skipped++
			result.Errors = append(result.Errors, catalogueImportError{
				Field:   fmt.Sprintf("items[%d]", i),
				Message: "duplicate item already processed in this request",
			})
			continue
		}
		seen[key] = true

		row, options, err := bulkItemToRow(item)
		if err != nil {
			s.logger.Error("bulk catalogue item marshal failed", "merchant", merchantID, "row", i, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if _, updated, err := importUpsertItem(ctx, tx, merchantID, row, categoryIDs[i], options); err != nil {
			s.logger.Error("bulk catalogue item failed", "merchant", merchantID, "row", i, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		} else if updated {
			result.Updated++
		} else {
			result.Created++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("bulk catalogue commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	result.Accepted = result.Created + result.Updated + result.Skipped
	s.recordStoreLog(ctx, merchantID, merchantID, "catalogue.bulk", "catalogue_items", map[string]any{
		"accepted": result.Accepted, "created": result.Created, "updated": result.Updated, "skipped": result.Skipped,
	})
	writeJSON(w, http.StatusAccepted, result)
}

// writeBulkValidation answers the 422 BULK_OPERATION_INVALID envelope with
// the per-item errors[] list.
func (s *Server) writeBulkValidation(w http.ResponseWriter, errs []catalogueImportError) {
	writeJSON(w, http.StatusUnprocessableEntity, gen.ValidationResponse{
		Code:      "BULK_OPERATION_INVALID",
		Message:   "Some catalogue items failed validation",
		RequestId: newUUID(newRequestID()),
		Errors:    errs,
	})
}

// createProductTemplateBody is the create body: the contract ProductTemplate
// name plus the priceTZS/category/options extensions this milestone persists
// (the generated CreateProductTemplateJSONRequestBody alias of ProductTemplate
// cannot carry them; same local-struct pattern as catalogueItemUpdateBody).
type createProductTemplateBody struct {
	Name     string               `json:"name"`
	PriceTZS *int                 `json:"priceTZS,omitempty"`
	Category string               `json:"category,omitempty"`
	Options  *catalogueOptionList `json:"options,omitempty"`
}

// CreateProductTemplate adds one template to the merchant's set (POST
// /product-templates, 201 ProductTemplate). The name must be unique per
// merchant (409 TEMPLATE_KEY_EXISTS), priceTZS must be >= 0, and a non-blank
// category must belong to the merchant (404 CATEGORY_NOT_FOUND).
func (s *Server) CreateProductTemplate(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body createProductTemplateBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if !validateCatalogueItemName(name) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	price := 0
	if body.PriceTZS != nil {
		if *body.PriceTZS < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceTZS must be >= 0")
			return
		}
		price = *body.PriceTZS
	}

	ctx := r.Context()
	categoryID, err := resolveCategoryID(ctx, s.db.Pool(), merchantID, body.Category, false)
	if err != nil {
		if errors.Is(err, errCategoryNotFound) {
			writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category does not belong to this merchant")
			return
		}
		s.logger.Error("create product template category lookup failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	options, err := marshalCatalogueOptions(body.Options)
	if err != nil {
		s.logger.Error("create product template options marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		id        uuid.UUID
		createdAt time.Time
	)
	if err := s.db.Pool().QueryRow(ctx, `INSERT INTO product_templates
		(merchant_id, name, price_tzs, category_id, options)
		VALUES ($1, $2, $3, $4, COALESCE($5, '[]'::jsonb)) RETURNING id, created_at`,
		merchantID, name, price, categoryID, options).Scan(&id, &createdAt); err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "TEMPLATE_KEY_EXISTS", "A template with this name already exists")
			return
		}
		s.logger.Error("create product template failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.recordStoreLog(ctx, merchantID, merchantID, "catalogue.template.create", "product_templates", map[string]any{
		"templateId": id.String(), "name": name,
	})
	writeJSON(w, http.StatusCreated, gen.ProductTemplate{
		Id:        newUUIDPtr(id),
		Name:      name,
		CreatedAt: &createdAt,
	})
}

// ListProductTemplates returns the merchant's templates (GET
// /product-templates, 200 []ProductTemplate), newest first. items and
// appliedStoreIds are not persisted in this milestone, so the rows serialize
// without them; an empty set serializes as [] (never null).
func (s *Server) ListProductTemplates(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, created_at FROM product_templates
		 WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC`, merchantID)
	if err != nil {
		s.logger.Error("list product templates failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	templates := make([]gen.ProductTemplate, 0, 8)
	for rows.Next() {
		var (
			id        uuid.UUID
			name      string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &name, &createdAt); err != nil {
			s.logger.Error("scan product template failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		templates = append(templates, gen.ProductTemplate{
			Id:        newUUIDPtr(id),
			Name:      name,
			CreatedAt: &createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate product templates failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, templates)
}

// ListServiceCategories returns the active public service categories from
// service_categories_config (GET /service-categories, 200
// []ServiceCategoryConfig), ordered by sort_order. pricingModel is a
// contract-required field that the config table does not persist; this
// milestone reports the default "fixed" until the pricing engine lands.
func (s *Server) ListServiceCategories(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list service categories failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name FROM service_categories_config
		 WHERE active = true ORDER BY sort_order, name`)
	if err != nil {
		s.logger.Error("list service categories failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	categories := make([]gen.ServiceCategoryConfig, 0, 8)
	for rows.Next() {
		var (
			id   uuid.UUID
			name string
		)
		if err := rows.Scan(&id, &name); err != nil {
			s.logger.Error("scan service category failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		categories = append(categories, gen.ServiceCategoryConfig{
			Id:           newUUID(id.String()),
			Name:         name,
			PricingModel: gen.ServiceCategoryConfigPricingModelFixed,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate service categories failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, categories)
}

// storeLogEntry is one row of the /store/logs response: the contract's
// {at, action, actor, details} plus id/entity/source extensions so the
// union's provenance is visible.
type storeLogEntry struct {
	At      time.Time       `json:"at"`
	Action  string          `json:"action"`
	Actor   string          `json:"actor"`
	Details json.RawMessage `json:"details,omitempty"`
	Id      string          `json:"id,omitempty"`
	Entity  string          `json:"entity,omitempty"`
	Source  string          `json:"source,omitempty"`
}

// GetStoreLogs returns the merchant's store activity (GET /store/logs, 200
// []), newest first, cursor-paginated with the next cursor on
// X-Next-Cursor. The generated params bind only limit/cursor — the contract
// exposes no from/to/action filters yet. Rows come from the merchant's
// store_logs entries (written best-effort by this package's mutating
// handlers) unioned with audit_logs rows that reference the merchant;
// see the package comment for the union's honest limits.
func (s *Server) GetStoreLogs(w http.ResponseWriter, r *http.Request, params gen.GetStoreLogsParams) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	limit := storeLogDefaultLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > storeLogMaxLimit {
			limit = storeLogMaxLimit
		}
	}

	args := []any{merchantID, merchantID.String(), merchantID}
	where := ""
	if params.Cursor != nil && *params.Cursor != "" {
		at, id, err := audit.ParseCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		args = append(args, at, id)
		where = fmt.Sprintf(" WHERE (u.created_at, u.id) < ($%d, $%d)", len(args)-1, len(args))
	}
	// One extra row acts as a sentinel so a full-but-final page does not
	// advertise a next cursor.
	args = append(args, limit+1)
	query := fmt.Sprintf(`
		SELECT u.id, u.created_at, u.action, u.entity, u.detail, u.actor, u.source
		FROM (
			SELECT id, created_at, action, COALESCE(entity, '') AS entity, detail,
			       actor_uuid AS actor, 'store' AS source
			FROM store_logs WHERE merchant_id = $1
			UNION ALL
			SELECT id, created_at, action, COALESCE(entity_type, '') AS entity, details AS detail,
			       actor_id AS actor, 'audit' AS source
			FROM audit_logs
			WHERE (entity_type = 'merchants' AND entity_id = $2) OR actor_id = $3
		) u%s
		ORDER BY u.created_at DESC, u.id DESC
		LIMIT $%d`, where, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list store logs failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	entries := make([]storeLogEntry, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id        uuid.UUID
			createdAt time.Time
			action    string
			entity    string
			detail    *[]byte
			actor     *uuid.UUID
			source    string
		)
		if err := rows.Scan(&id, &createdAt, &action, &entity, &detail, &actor, &source); err != nil {
			s.logger.Error("scan store log failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(entries) == limit {
			sentinel = true
			continue
		}
		e := storeLogEntry{
			At:     createdAt,
			Action: action,
			Entity: entity,
			Id:     id.String(),
			Source: source,
		}
		if actor != nil {
			e.Actor = actor.String()
		}
		if detail != nil && len(*detail) > 0 {
			e.Details = json.RawMessage(*detail)
		}
		entries = append(entries, e)
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate store logs failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", audit.EncodeCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, entries)
}

// recordStoreLog appends one store_logs row for the merchant's own activity
// (GET /store/logs). Best-effort, like the audit middleware: a failed insert
// is logged and never fails the request. actor is the acting session's user
// id (the merchant id in this milestone, see catalogues.go).
func (s *Server) recordStoreLog(ctx context.Context, merchantID, actor uuid.UUID, action, entity string, detail any) {
	if s.db == nil {
		return
	}
	var payload []byte
	if detail != nil {
		var err error
		if payload, err = json.Marshal(detail); err != nil {
			s.logger.Warn("store log detail marshal failed", "action", action, "error", err)
			return
		}
	}
	if _, err := s.db.Pool().Exec(ctx, `INSERT INTO store_logs
		(merchant_id, action, entity, detail, actor_uuid) VALUES ($1, $2, $3, $4, $5)`,
		merchantID, action, entity, payload, actor); err != nil {
		s.logger.Warn("store log write failed", "merchant", merchantID, "action", action, "error", err)
	}
}
