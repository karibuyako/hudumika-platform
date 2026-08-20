package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// CATALOGUES bounded context (backend/DATA-MODEL.md): catalogue_items and
// product_categories. Money is int64 TZS only (price_tzs bigint).
//
// Merchant identity: the catalogue-scoped merchant id is the REAL merchants
// row id (merchants.owner_user_id links the row to the session's users
// row; see merchant_linkage.go).

// maxCatalogueItemNameLen mirrors the contract CatalogueItem.name maxLength.
const maxCatalogueItemNameLen = 160

// errCategoryNotFound marks a category name that has no row for the merchant;
// surfaced as CATEGORY_NOT_FOUND by the create handler.
var errCategoryNotFound = errors.New("category not found")

// catalogueOptionList is an alias of the contract options shape
// {name, choices[{label, priceTZS}]} so the stored jsonb round-trips onto
// gen.CatalogueItem.Options exactly.
type catalogueOptionList = []struct {
	Choices []struct {
		Label    string `json:"label"`
		PriceTZS int    `json:"priceTZS"`
	} `json:"choices"`
	Name string `json:"name"`
}

// catalogueItemUpdateBody is the PATCH body. The generated
// UpdateCatalogueItemJSONRequestBody reuses CatalogueItem for its options
// items, which cannot carry the contract's {name, choices[{label, priceTZS}]}
// shape — the "choices" key decodes nowhere, so the payloads would be
// lossy. A local struct with the inline options type (the same shape the
// create endpoint accepts) keeps create/update payloads identical.
type catalogueItemUpdateBody struct {
	Name        *string              `json:"name"`
	Description *string              `json:"description"`
	PriceTZS    *int                 `json:"priceTZS"`
	Available   *bool                `json:"available"`
	VideoUrl    *string              `json:"videoUrl"`
	Options     *catalogueOptionList `json:"options"`
}

// catalogueItemRow is a live catalogue_items row projection; options stays
// raw jsonb so it round-trips byte-for-byte.
type catalogueItemRow struct {
	id          uuid.UUID
	name        string
	description *string
	priceTZS    int64
	categoryID  *uuid.UUID
	imageURL    *string
	videoURL    *string
	available   bool
	options     []byte
}

// catalogueItemColumns is the shared SELECT list for catalogue items.
const catalogueItemColumns = `id, name, description, price_tzs, category_id, image_url, video_url, available, options`

// catalogueQueryer abstracts the pool and a transaction so catalogue reads
// work inside replace's transaction too.
type catalogueQueryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// catalogueMerchantID resolves the authenticated session to the catalogue
// merchant id (the REAL merchants row id, merchant_linkage.go). Only
// merchant-role sessions may pass: any other role is rejected with 403
// FORBIDDEN. The subject (phone) resolves to the users row, whose merchant
// row id is the catalogue owner for this milestone.
func (s *Server) catalogueMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage catalogues")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("catalogue merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("catalogue merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	merchantID, err := s.merchantIDForUser(r.Context(), user.ID)
	if errors.Is(err, errNoMerchant) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant account for this session")
		return uuid.Nil, false
	}
	if err != nil {
		s.logger.Error("catalogue merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	return merchantID, true
}

// validateCatalogueItemName enforces the contract 1-160 character bound.
func validateCatalogueItemName(name string) bool {
	name = strings.TrimSpace(name)
	return name != "" && len(name) <= maxCatalogueItemNameLen
}

// resolveCategoryID maps a category name to the merchant's category id.
// A blank name yields nil (uncategorised). When createMissing is set a
// missing name is inserted (replace semantics); otherwise it is reported as
// errCategoryNotFound (create semantics).
func resolveCategoryID(ctx context.Context, q catalogueQueryer, merchantID uuid.UUID, name string, createMissing bool) (*uuid.UUID, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	var id uuid.UUID
	err := q.QueryRow(ctx,
		`SELECT id FROM product_categories WHERE merchant_id = $1 AND name = $2`, merchantID, name).Scan(&id)
	if err == nil {
		return &id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("lookup category %q: %w", name, err)
	}
	if !createMissing {
		return nil, errCategoryNotFound
	}
	if err := q.QueryRow(ctx,
		`INSERT INTO product_categories (merchant_id, name) VALUES ($1, $2) RETURNING id`,
		merchantID, name).Scan(&id); err != nil {
		return nil, fmt.Errorf("create category %q: %w", name, err)
	}
	return &id, nil
}

// marshalCatalogueOptions renders a create-body options list to jsonb; nil
// options stay NULL.
func marshalCatalogueOptions(opts *catalogueOptionList) ([]byte, error) {
	if opts == nil {
		return nil, nil
	}
	return json.Marshal(opts)
}

// loadCatalogue loads the merchant's catalogue with two batched queries and
// maps it onto the contract Catalogue. availableOnly gates the public view;
// the owner view includes unavailable items. Items always serialize as []
// (never null) when the catalogue is empty.
func (s *Server) loadCatalogue(ctx context.Context, q catalogueQueryer, merchantID uuid.UUID, availableOnly bool) (gen.Catalogue, error) {
	catNames := make(map[uuid.UUID]string, 8)
	catRows, err := q.Query(ctx,
		`SELECT id, name FROM product_categories WHERE merchant_id = $1`, merchantID)
	if err != nil {
		return gen.Catalogue{}, fmt.Errorf("load categories: %w", err)
	}
	for catRows.Next() {
		var (
			id   uuid.UUID
			name string
		)
		if err := catRows.Scan(&id, &name); err != nil {
			catRows.Close()
			return gen.Catalogue{}, fmt.Errorf("scan category: %w", err)
		}
		catNames[id] = name
	}
	catRows.Close()
	if err := catRows.Err(); err != nil {
		return gen.Catalogue{}, fmt.Errorf("iterate categories: %w", err)
	}

	query := `SELECT ` + catalogueItemColumns + `
		FROM catalogue_items
		WHERE merchant_id = $1 AND deleted_at IS NULL`
	args := []any{merchantID}
	if availableOnly {
		query += ` AND available = true`
	}
	query += ` ORDER BY created_at, id`
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return gen.Catalogue{}, fmt.Errorf("load catalogue items: %w", err)
	}
	defer rows.Close()

	items := make([]gen.CatalogueItem, 0, 8)
	for rows.Next() {
		var r catalogueItemRow
		if err := rows.Scan(&r.id, &r.name, &r.description, &r.priceTZS, &r.categoryID,
			&r.imageURL, &r.videoURL, &r.available, &r.options); err != nil {
			return gen.Catalogue{}, fmt.Errorf("scan catalogue item: %w", err)
		}
		items = append(items, toCatalogueItem(r, catNames))
	}
	if err := rows.Err(); err != nil {
		return gen.Catalogue{}, fmt.Errorf("iterate catalogue items: %w", err)
	}
	return gen.Catalogue{MerchantId: newUUID(merchantID.String()), Items: items}, nil
}

// loadCatalogueItem loads a single live item with its category name resolved.
func (s *Server) loadCatalogueItem(ctx context.Context, q catalogueQueryer, itemID uuid.UUID) (*gen.CatalogueItem, error) {
	var r catalogueItemRow
	if err := q.QueryRow(ctx, `SELECT `+catalogueItemColumns+`
		FROM catalogue_items WHERE id = $1 AND deleted_at IS NULL`, itemID).
		Scan(&r.id, &r.name, &r.description, &r.priceTZS, &r.categoryID,
			&r.imageURL, &r.videoURL, &r.available, &r.options); err != nil {
		return nil, fmt.Errorf("load catalogue item: %w", err)
	}
	catNames := make(map[uuid.UUID]string, 1)
	if r.categoryID != nil {
		var name string
		if err := q.QueryRow(ctx,
			`SELECT name FROM product_categories WHERE id = $1`, *r.categoryID).Scan(&name); err == nil {
			catNames[*r.categoryID] = name
		}
	}
	out := toCatalogueItem(r, catNames)
	return &out, nil
}

// toCatalogueItem maps a catalogue_items row onto the contract CatalogueItem
// with the category name resolved; unknown/absent categories map to "".
func toCatalogueItem(r catalogueItemRow, catNames map[uuid.UUID]string) gen.CatalogueItem {
	id := newUUID(r.id.String())
	out := gen.CatalogueItem{
		Id:        &id,
		Name:      r.name,
		PriceTZS:  int(r.priceTZS),
		Category:  "",
		Available: &r.available,
	}
	if r.categoryID != nil {
		out.Category = catNames[*r.categoryID]
	}
	if r.description != nil {
		out.Description = r.description
	}
	if r.imageURL != nil {
		out.ImageUrl = r.imageURL
	}
	if r.videoURL != nil {
		out.VideoUrl = r.videoURL
	}
	if len(r.options) > 0 {
		var opts catalogueOptionList
		if err := json.Unmarshal(r.options, &opts); err == nil {
			out.Options = &opts
		}
	}
	return out
}

// upsertCatalogueItem restores or inserts one incoming replace item. A client
// id is honoured (deleted_at cleared, values overwritten) only when the row
// is already owned by this merchant; any other id inserts a fresh row.
func upsertCatalogueItem(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID, item gen.CatalogueItem, categoryID *uuid.UUID, options []byte) (uuid.UUID, error) {
	available := true
	if item.Available != nil {
		available = *item.Available
	}
	if item.Id != nil {
		tag, err := tx.Exec(ctx, `UPDATE catalogue_items
			SET name = $2, description = $3, price_tzs = $4, category_id = $5,
			    image_url = $6, video_url = $7, available = $8, options = $9,
			    deleted_at = NULL, updated_at = now()
			WHERE id = $1 AND merchant_id = $10`,
			*item.Id, item.Name, item.Description, item.PriceTZS, categoryID,
			item.ImageUrl, item.VideoUrl, available, options, merchantID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("upsert catalogue item %s: %w", *item.Id, err)
		}
		if tag.RowsAffected() > 0 {
			return *item.Id, nil
		}
	}
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO catalogue_items
		(merchant_id, name, description, price_tzs, category_id, image_url, video_url, available, options)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		merchantID, item.Name, item.Description, item.PriceTZS, categoryID,
		item.ImageUrl, item.VideoUrl, available, options).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("insert catalogue item %q: %w", item.Name, err)
	}
	return id, nil
}

// catalogueActorID returns the actor user id for catalogue_item_logs.
// Ledger invariant: the log is append-only and records who made the change.
func (s *Server) catalogueActorID(r *http.Request) *uuid.UUID {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil || user == nil {
		return nil
	}
	id := user.ID
	return &id
}

// appendCatalogueItemLog inserts one catalogue_item_logs row best-effort.
// The ledger invariant: logs are append-only and never updated or deleted.
func (s *Server) appendCatalogueItemLog(ctx context.Context, itemID uuid.UUID, action string, actor *uuid.UUID, detail any) {
	var payload []byte
	if detail != nil {
		var err error
		if payload, err = json.Marshal(detail); err != nil {
			s.logger.Warn("catalogue item log marshal failed", "item", itemID, "error", err)
			return
		}
	}
	if _, err := s.db.Pool().Exec(ctx,
		`INSERT INTO catalogue_item_logs (catalogue_item_id, action, actor_uuid, detail) VALUES ($1, $2, $3, $4)`,
		itemID, action, actor, payload); err != nil {
		s.logger.Warn("catalogue item log write failed", "item", itemID, "action", action, "error", err)
	}
}

// appendCatalogueItemLogTx is the transactional variant used inside ReplaceMyCatalogue.
func appendCatalogueItemLogTx(ctx context.Context, tx pgx.Tx, itemID uuid.UUID, action string, actor *uuid.UUID, detail any) error {
	var payload []byte
	if detail != nil {
		var err error
		if payload, err = json.Marshal(detail); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO catalogue_item_logs (catalogue_item_id, action, actor_uuid, detail) VALUES ($1, $2, $3, $4)`,
		itemID, action, actor, payload)
	return err
}

// writeCatalogueItemMiss distinguishes the ITEM_NOT_FOUND and
// CATALOGUE_MERCHANT_MISMATCH envelopes after an owned update/delete missed.
// A row owned by another merchant is the mismatch; an unknown or already
// soft-deleted id is ITEM_NOT_FOUND so existence is never leaked.
func (s *Server) writeCatalogueItemMiss(w http.ResponseWriter, r *http.Request, itemID, merchantID uuid.UUID) {
	var owner uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM catalogue_items WHERE id = $1`, itemID).Scan(&owner)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "ITEM_NOT_FOUND", "Catalogue item not found")
	case err != nil:
		s.logger.Error("catalogue item ownership lookup failed", "item", itemID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	case owner != merchantID:
		writeError(w, http.StatusNotFound, "CATALOGUE_MERCHANT_MISMATCH", "Catalogue item belongs to a different merchant")
	default:
		writeError(w, http.StatusNotFound, "ITEM_NOT_FOUND", "Catalogue item not found")
	}
}

// GetMyCatalogue returns the merchant's own full catalogue including
// unavailable items (GET /catalogues/me). Only merchant-role sessions may
// read it; the merchant id is the caller's real merchants row id (see
// merchant_linkage.go).
func (s *Server) GetMyCatalogue(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	catalogue, err := s.loadCatalogue(r.Context(), s.db.Pool(), merchantID, false)
	if err != nil {
		s.logger.Error("get my catalogue failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, catalogue)
}

// ReplaceMyCatalogue is the full-catalogue replace (PUT /catalogues/me):
// every existing item is soft-deleted and the incoming set is restored (by
// owned id) or inserted. Categories referenced by name are created on
// demand. The resulting catalogue is returned after commit.
func (s *Server) ReplaceMyCatalogue(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.ReplaceMyCatalogueJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	for _, item := range body.Items {
		if !validateCatalogueItemName(item.Name) || item.PriceTZS < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters and priceTZS must be >= 0")
			return
		}
	}

	ctx := r.Context()
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("replace catalogue begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`UPDATE catalogue_items SET deleted_at = now(), updated_at = now()
		 WHERE merchant_id = $1 AND deleted_at IS NULL`, merchantID); err != nil {
		s.logger.Error("replace catalogue soft delete failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor := s.catalogueActorID(r)
	for _, item := range body.Items {
		categoryID, err := resolveCategoryID(ctx, tx, merchantID, item.Category, true)
		if err != nil {
			s.logger.Error("replace catalogue category failed", "merchant", merchantID, "category", item.Category, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		options, err := marshalCatalogueOptions(item.Options)
		if err != nil {
			s.logger.Error("replace catalogue options marshal failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		id, err := upsertCatalogueItem(ctx, tx, merchantID, item, categoryID, options)
		if err != nil {
			s.logger.Error("replace catalogue item failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if err := appendCatalogueItemLogTx(ctx, tx, id, "updated", actor, map[string]any{"after": item}); err != nil {
			s.logger.Warn("replace catalogue item log failed", "item", id, "error", err)
		}
	}
	catalogue, err := s.loadCatalogue(ctx, tx, merchantID, false)
	if err != nil {
		s.logger.Error("replace catalogue reload failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("replace catalogue commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, catalogue)
}

// GetMerchantCatalogue returns the PUBLIC catalogue for a merchant (GET
// /catalogues/{merchantId}): available, non-deleted items only. The contract
// marks this route open (no bearerAuth) and the handler never inspects the
// caller, even though the router may still route it behind RequireAuth.
func (s *Server) GetMerchantCatalogue(w http.ResponseWriter, r *http.Request, merchantId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get merchant catalogue failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	catalogue, err := s.loadCatalogue(r.Context(), s.db.Pool(), merchantId, true)
	if err != nil {
		s.logger.Error("get merchant catalogue failed", "merchant", merchantId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, catalogue)
}

// CreateCatalogueItem adds one item to the merchant's catalogue (POST
// /catalogue-items). The category must already belong to the merchant
// (CATEGORY_NOT_FOUND) or be blank; it is never auto-created here.
func (s *Server) CreateCatalogueItem(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateCatalogueItemJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if !validateCatalogueItemName(body.Name) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	if body.PriceTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceTZS must be >= 0")
		return
	}

	ctx := r.Context()
	categoryID, err := resolveCategoryID(ctx, s.db.Pool(), merchantID, body.Category, false)
	if err != nil {
		if errors.Is(err, errCategoryNotFound) {
			writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category does not belong to this merchant")
			return
		}
		s.logger.Error("create catalogue item category lookup failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	options, err := marshalCatalogueOptions(body.Options)
	if err != nil {
		s.logger.Error("create catalogue item options marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	available := true
	if body.Available != nil {
		available = *body.Available
	}

	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx, `INSERT INTO catalogue_items
		(merchant_id, name, description, price_tzs, category_id, image_url, video_url, available, options)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		merchantID, body.Name, body.Description, body.PriceTZS, categoryID,
		body.ImageUrl, body.VideoUrl, available, options).Scan(&id); err != nil {
		s.logger.Error("create catalogue item failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	item, err := s.loadCatalogueItem(ctx, s.db.Pool(), id)
	if err != nil {
		s.logger.Error("reload catalogue item failed", "item", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor := s.catalogueActorID(r)
	s.appendCatalogueItemLog(ctx, id, "created", actor, map[string]any{"after": item})
	writeJSON(w, http.StatusCreated, item)
}

// UpdateCatalogueItem patches one catalogue item (PATCH
// /catalogue-items/{itemId}); only fields present in the body are applied.
// Unknown or soft-deleted ids surface ITEM_NOT_FOUND and another merchant's
// item surfaces CATALOGUE_MERCHANT_MISMATCH.
func (s *Server) UpdateCatalogueItem(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body catalogueItemUpdateBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name != nil && !validateCatalogueItemName(*body.Name) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	if body.PriceTZS != nil && *body.PriceTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceTZS must be >= 0")
		return
	}
	var options []byte
	if body.Options != nil {
		var err error
		if options, err = marshalCatalogueOptions(body.Options); err != nil {
			s.logger.Error("update catalogue item options marshal failed", "item", itemId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	sets := []string{"updated_at = now()"}
	args := make([]any, 0, 6)
	if body.Name != nil {
		args = append(args, strings.TrimSpace(*body.Name))
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if body.Description != nil {
		args = append(args, *body.Description)
		sets = append(sets, fmt.Sprintf("description = $%d", len(args)))
	}
	if body.PriceTZS != nil {
		args = append(args, *body.PriceTZS)
		sets = append(sets, fmt.Sprintf("price_tzs = $%d", len(args)))
	}
	if body.Available != nil {
		args = append(args, *body.Available)
		sets = append(sets, fmt.Sprintf("available = $%d", len(args)))
	}
	if body.VideoUrl != nil {
		args = append(args, *body.VideoUrl)
		sets = append(sets, fmt.Sprintf("video_url = $%d", len(args)))
	}
	if body.Options != nil {
		args = append(args, options)
		sets = append(sets, fmt.Sprintf("options = $%d", len(args)))
	}
	args = append(args, itemId, merchantID)
	query := fmt.Sprintf(`UPDATE catalogue_items SET %s WHERE id = $%d AND merchant_id = $%d AND deleted_at IS NULL`,
		strings.Join(sets, ", "), len(args)-1, len(args))

	tag, err := s.db.Pool().Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update catalogue item failed", "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeCatalogueItemMiss(w, r, itemId, merchantID)
		return
	}
	item, err := s.loadCatalogueItem(r.Context(), s.db.Pool(), itemId)
	if err != nil {
		s.logger.Error("reload catalogue item failed", "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor := s.catalogueActorID(r)
	action := "updated"
	onlyPrice := body.PriceTZS != nil && body.Available == nil && body.Name == nil && body.Description == nil && body.VideoUrl == nil && body.Options == nil
	onlyAvail := body.Available != nil && body.PriceTZS == nil && body.Name == nil && body.Description == nil && body.VideoUrl == nil && body.Options == nil
	if onlyPrice {
		action = "price_changed"
	} else if onlyAvail {
		action = "availability_changed"
	}
	s.appendCatalogueItemLog(r.Context(), uuid.UUID(itemId), action, actor, map[string]any{"after": item})
	writeJSON(w, http.StatusOK, item)
}

// DeleteCatalogueItem soft-deletes one catalogue item (DELETE
// /catalogue-items/{itemId}): deleted_at is stamped, the row is retained and
// excluded from every catalogue view. Unknown or soft-deleted ids surface
// ITEM_NOT_FOUND; another merchant's item surfaces
// CATALOGUE_MERCHANT_MISMATCH.
func (s *Server) DeleteCatalogueItem(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE catalogue_items SET deleted_at = now(), updated_at = now()
		 WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL`, itemId, merchantID)
	if err != nil {
		s.logger.Error("delete catalogue item failed", "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeCatalogueItemMiss(w, r, itemId, merchantID)
		return
	}
	actor := s.catalogueActorID(r)
	s.appendCatalogueItemLog(r.Context(), uuid.UUID(itemId), "deleted", actor, map[string]any{"after": map[string]any{"deleted": true}})
	w.WriteHeader(http.StatusNoContent)
}
