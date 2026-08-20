package api

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

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// MEDIA-CATALOGUE bounded context (migration 00035, backend/DATA-MODEL.md
// §barcode, combo, menu, video; backend/ERROR-CODES.md §print jobs and
// categories and §barcodes, combos, menus, videos): barcodes, combos, menus,
// videos, categories and print jobs. Like the catalogues context, barcode
// merchant identity uses the authenticated merchant's real merchants row id
// (merchants.owner_user_id links the row to the session's users row; see
// merchant_linkage.go / catalogueMerchantID) so generation and lookup share
// the same resolver. Other media entities (combos, menus, videos,
// categories, print jobs) remain on the legacy users-row merchant id via
// mediaMerchantID.

// Limits enforced by the media handlers (contract + ERROR-CODES.md).
const (
	maxBarcodeBatchEntries = 100
	maxPrintJobsQueued     = 50
	printJobsDefaultLimit  = 20
	printJobsMaxLimit      = 100
	maxComboNameLen        = 160
	maxMenuNameLen         = 160
	maxVideoTitleLen       = 120
	maxCategoryNameLen     = 80
)

// mediaMerchantID resolves the authenticated session to the media-catalogue
// merchant id: only merchant-role sessions may pass (403 FORBIDDEN for any
// other role) and the merchant id is the caller's users row id, resolved
// from the session subject (same milestone simplification as the catalogues
// context).
func (s *Server) mediaMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
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
		s.logger.Error("media merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("media merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// --- barcode formats -------------------------------------------------------

// barcodeFormats is the static supported-format list (contract
// BarcodeFormat.code enum: ean13, ean8, upca, code128, code39, qr). The
// barcodes table only stores ean13/code128/qr rows, but the formats surface
// mirrors the contract exactly.
var barcodeFormats = []gen.BarcodeFormat{
	{Code: gen.BarcodeFormatCodeEan13, Label: "EAN-13"},
	{Code: gen.BarcodeFormatCodeEan8, Label: "EAN-8"},
	{Code: gen.BarcodeFormatCodeUpca, Label: "UPC-A"},
	{Code: gen.BarcodeFormatCodeCode128, Label: "Code 128"},
	{Code: gen.BarcodeFormatCodeCode39, Label: "Code 39"},
	{Code: gen.BarcodeFormatCodeQr, Label: "QR Code"},
}

// ListBarcodeFormats returns the supported barcode formats (GET
// /barcodes/formats). The route sits behind RequireAuth in the router, so a
// merchant session is expected; the static list is returned unchanged.
func (s *Server) ListBarcodeFormats(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.mediaMerchantID(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, barcodeFormats)
}

// --- barcode lookup and history -------------------------------------------

// LookupBarcode resolves one barcode to a catalogue item (GET
// /barcodes/{code}). Only the caller's own barcodes resolve; an unknown,
// foreign or item-less code surfaces BARCODE_NOT_FOUND.
func (s *Server) LookupBarcode(w http.ResponseWriter, r *http.Request, code string) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var (
		itemID    uuid.UUID
		name      string
		priceTZS  int64
		available bool
	)
	err := s.db.Pool().QueryRow(r.Context(), `
		SELECT i.id, i.name, i.price_tzs, i.available
		FROM barcodes b
		JOIN catalogue_items i ON i.id = b.catalogue_item_id AND i.deleted_at IS NULL
		WHERE b.code = $1 AND b.merchant_id = $2`, code, merchantID).
		Scan(&itemID, &name, &priceTZS, &available)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "BARCODE_NOT_FOUND", "No catalogue item resolves from this barcode")
		return
	}
	if err != nil {
		s.logger.Error("barcode lookup failed", "merchant", merchantID, "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, gen.BarcodeLookup{
		CatalogueItemId: newUUID(itemID.String()),
		Name:            name,
		PriceTZS:        int(priceTZS),
		Available:       &available,
	})
}

// barcodeHistoryEntry is the history item shape from the contract
// (at + action enum).
type barcodeHistoryEntry struct {
	At     time.Time `json:"at"`
	Action string    `json:"action"`
}

// GetBarcodeHistory returns the scan history for a barcode (GET
// /barcodes/{code}/history). No scan events are recorded yet, so the honest
// history is the barcode row's own created_at as a single "generated" entry;
// an unknown code surfaces BARCODE_NOT_FOUND.
func (s *Server) GetBarcodeHistory(w http.ResponseWriter, r *http.Request, code string) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var createdAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT created_at FROM barcodes WHERE code = $1 AND merchant_id = $2`, code, merchantID).
		Scan(&createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "BARCODE_NOT_FOUND", "No barcode exists for this code")
		return
	}
	if err != nil {
		s.logger.Error("barcode history failed", "merchant", merchantID, "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, []barcodeHistoryEntry{{At: createdAt, Action: "generated"}})
}

// --- barcode batch import --------------------------------------------------

// batchImportResult is the contract batch response {jobId, accepted,
// rejected}. The jobId is a generated id; batch imports run synchronously and
// no job row is persisted at this milestone.
type batchImportResult struct {
	JobID    string `json:"jobId"`
	Accepted int    `json:"accepted"`
	Rejected int    `json:"rejected"`
}

// BatchImportBarcodes bulk-imports barcodes (POST /barcodes/batch). More
// than 100 entries surface BARCODE_BATCH_EXCEEDS_LIMIT; per-entry failures
// (unknown item, code already taken, in-batch duplicates) are counted as
// rejected rather than failing the whole batch.
func (s *Server) BatchImportBarcodes(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.BatchImportBarcodesJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Entries) > maxBarcodeBatchEntries {
		writeError(w, http.StatusUnprocessableEntity, "BARCODE_BATCH_EXCEEDS_LIMIT",
			fmt.Sprintf("Batch exceeds the %d entry limit", maxBarcodeBatchEntries))
		return
	}

	ctx := r.Context()
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("barcode batch begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	// Validate every catalogue item in one shot.
	itemIDs := make([]uuid.UUID, 0, len(body.Entries))
	for _, e := range body.Entries {
		itemIDs = append(itemIDs, e.CatalogueItemId)
	}
	owned := make(map[uuid.UUID]bool, len(itemIDs))
	rows, err := tx.Query(ctx,
		`SELECT id FROM catalogue_items WHERE id = ANY($1) AND merchant_id = $2 AND deleted_at IS NULL`,
		itemIDs, merchantID)
	if err != nil {
		s.logger.Error("barcode batch item validation failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			s.logger.Error("barcode batch item scan failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		owned[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Error("barcode batch item iterate failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	accepted, rejected := 0, 0
	seen := make(map[string]bool, len(body.Entries))
	for _, e := range body.Entries {
		code := strings.TrimSpace(e.Code)
		switch {
		case !owned[e.CatalogueItemId], seen[code], code == "":
			rejected++
			continue
		}
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM barcodes WHERE code = $1)`, code).Scan(&exists); err != nil {
			s.logger.Error("barcode batch duplicate check failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if exists {
			rejected++
			continue
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO barcodes (merchant_id, code, catalogue_item_id) VALUES ($1, $2, $3)`,
			merchantID, code, e.CatalogueItemId); err != nil {
			s.logger.Error("barcode batch insert failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		seen[code] = true
		accepted++
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("barcode batch commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, batchImportResult{
		JobID:    uuid.New().String(),
		Accepted: accepted,
		Rejected: rejected,
	})
}

// --- combos -----------------------------------------------------------------

// comboItem is one combos.items entry (contract Combo.items element).
type comboItem struct {
	CatalogueItemID uuid.UUID `json:"catalogueItemId"`
	Quantity        int       `json:"quantity"`
}

// comboContractItem aliases the contract Combo.items element shape so the
// stored rows round-trip onto gen.Combo.Items exactly.
type comboContractItem = struct {
	CatalogueItemId openapi_types.UUID `json:"catalogueItemId"`
	Quantity        int                `json:"quantity"`
}

// comboItemsValid verifies the combo item list: non-empty, positive
// quantities, and every catalogue item belongs to the merchant.
func (s *Server) comboItemsValid(ctx context.Context, merchantID uuid.UUID, items []comboItem) (bool, error) {
	if len(items) == 0 {
		return false, nil
	}
	ids := make([]uuid.UUID, 0, len(items))
	for _, it := range items {
		if it.Quantity < 1 {
			return false, nil
		}
		ids = append(ids, it.CatalogueItemID)
	}
	var owned int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM catalogue_items
		 WHERE id = ANY($1) AND merchant_id = $2 AND deleted_at IS NULL`, ids, merchantID).
		Scan(&owned); err != nil {
		return false, fmt.Errorf("validate combo items: %w", err)
	}
	return owned == len(ids), nil
}

// comboColumns is the shared SELECT list for combo rows.
const comboColumns = `id, name, description, price_tzs, original_price_tzs, items, image_url, active, created_at`

// comboRow is a combos row projection; items stays raw jsonb.
type comboRow struct {
	id               uuid.UUID
	name             string
	description      *string
	priceTZS         int64
	originalPriceTZS int64
	items            []byte
	imageURL         *string
	active           bool
	createdAt        time.Time
}

// toCombo maps a combos row onto the contract Combo. Item ids are echoed
// with their stored quantity; a corrupt items blob degrades to an empty
// item list rather than failing the response.
func toCombo(r comboRow) gen.Combo {
	id := newUUID(r.id.String())
	price := int(r.priceTZS)
	out := gen.Combo{
		Id:        &id,
		Name:      r.name,
		Items:     []comboContractItem{},
		PriceTZS:  &price,
		Available: &r.active,
	}
	if r.description != nil {
		out.Description = r.description
	}
	if r.imageURL != nil {
		out.ImageUrl = r.imageURL
	}
	at := r.createdAt
	out.CreatedAt = &at
	if len(r.items) > 0 {
		var items []comboItem
		if err := json.Unmarshal(r.items, &items); err == nil {
			out.Items = out.Items[:0]
			for _, it := range items {
				out.Items = append(out.Items, comboContractItem{CatalogueItemId: newUUID(it.CatalogueItemID.String()), Quantity: it.Quantity})
			}
		}
	}
	return out
}

// ListCombos returns the merchant's combos (GET /combos), newest first.
func (s *Server) ListCombos(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+comboColumns+` FROM combos WHERE merchant_id = $1 ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list combos failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.Combo, 0, 8)
	for rows.Next() {
		var r comboRow
		if err := rows.Scan(&r.id, &r.name, &r.description, &r.priceTZS, &r.originalPriceTZS,
			&r.items, &r.imageURL, &r.active, &r.createdAt); err != nil {
			s.logger.Error("scan combo failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toCombo(r))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate combos failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// createCombo inserts one combo and returns its contract view. Shared by
// CreateCombo and UpdateCombo.
func (s *Server) createCombo(ctx context.Context, merchantID uuid.UUID, body gen.Combo) (gen.Combo, error) {
	items, err := json.Marshal(body.Items)
	if err != nil {
		return gen.Combo{}, fmt.Errorf("marshal combo items: %w", err)
	}
	price := int64(0)
	if body.PriceTZS != nil {
		price = int64(*body.PriceTZS)
	}
	available := true
	if body.Available != nil {
		available = *body.Available
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx, `
		INSERT INTO combos (merchant_id, name, description, price_tzs, items, image_url, active)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		merchantID, body.Name, body.Description, price, items, body.ImageUrl, available).Scan(&id); err != nil {
		return gen.Combo{}, fmt.Errorf("insert combo: %w", err)
	}
	row, err := s.loadCombo(ctx, id)
	if err != nil {
		return gen.Combo{}, err
	}
	return toCombo(*row), nil
}

// loadCombo reads one combo row by id.
func (s *Server) loadCombo(ctx context.Context, id uuid.UUID) (*comboRow, error) {
	var r comboRow
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT `+comboColumns+` FROM combos WHERE id = $1`, id).
		Scan(&r.id, &r.name, &r.description, &r.priceTZS, &r.originalPriceTZS,
			&r.items, &r.imageURL, &r.active, &r.createdAt); err != nil {
		return nil, fmt.Errorf("load combo: %w", err)
	}
	return &r, nil
}

// writeComboMiss distinguishes a missing combo from a foreign merchant's
// combo after an owned update/delete missed: both surface COMBO_NOT_FOUND so
// existence is never leaked.
func (s *Server) writeComboMiss(w http.ResponseWriter, r *http.Request, comboID, merchantID uuid.UUID) {
	var owner uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM combos WHERE id = $1`, comboID).Scan(&owner)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "COMBO_NOT_FOUND", "Combo not found")
	case err != nil:
		s.logger.Error("combo ownership lookup failed", "combo", comboID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeError(w, http.StatusNotFound, "COMBO_NOT_FOUND", "Combo not found")
	}
}

// CreateCombo adds one combo meal (POST /combos). The item list must be
// non-empty and every item must reference the merchant's own catalogue item
// (COMBO_ITEM_INVALID otherwise); priceTZS must be >= 0.
func (s *Server) CreateCombo(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateComboJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > maxComboNameLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	if body.PriceTZS != nil && *body.PriceTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceTZS must be >= 0")
		return
	}
	items := make([]comboItem, 0, len(body.Items))
	for _, it := range body.Items {
		items = append(items, comboItem{CatalogueItemID: it.CatalogueItemId, Quantity: it.Quantity})
	}
	valid, err := s.comboItemsValid(r.Context(), merchantID, items)
	if err != nil {
		s.logger.Error("combo item validation failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !valid {
		writeError(w, http.StatusUnprocessableEntity, "COMBO_ITEM_INVALID", "Items must reference this merchant's catalogue items with quantity >= 1")
		return
	}
	combo, err := s.createCombo(r.Context(), merchantID, body)
	if err != nil {
		s.logger.Error("create combo failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, combo)
}

// UpdateCombo replaces one combo (PATCH /combos/{comboId}); the same item
// and price rules as create apply. Unknown or foreign ids surface
// COMBO_NOT_FOUND.
func (s *Server) UpdateCombo(w http.ResponseWriter, r *http.Request, comboId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateComboJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > maxComboNameLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-160 characters")
		return
	}
	if body.PriceTZS != nil && *body.PriceTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "priceTZS must be >= 0")
		return
	}
	items := make([]comboItem, 0, len(body.Items))
	for _, it := range body.Items {
		items = append(items, comboItem{CatalogueItemID: it.CatalogueItemId, Quantity: it.Quantity})
	}
	valid, err := s.comboItemsValid(r.Context(), merchantID, items)
	if err != nil {
		s.logger.Error("combo item validation failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !valid {
		writeError(w, http.StatusUnprocessableEntity, "COMBO_ITEM_INVALID", "Items must reference this merchant's catalogue items with quantity >= 1")
		return
	}
	marshaled, err := json.Marshal(body.Items)
	if err != nil {
		s.logger.Error("marshal combo items failed", "combo", comboId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	price := int64(0)
	if body.PriceTZS != nil {
		price = int64(*body.PriceTZS)
	}
	available := true
	if body.Available != nil {
		available = *body.Available
	}
	tag, err := s.db.Pool().Exec(r.Context(), `
		UPDATE combos SET name = $2, description = $3, price_tzs = $4, items = $5,
		                  image_url = $6, active = $7, updated_at = now()
		WHERE id = $1 AND merchant_id = $8`,
		comboId, body.Name, body.Description, price, marshaled, body.ImageUrl, available, merchantID)
	if err != nil {
		s.logger.Error("update combo failed", "combo", comboId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeComboMiss(w, r, comboId, merchantID)
		return
	}
	row, err := s.loadCombo(r.Context(), comboId)
	if err != nil {
		s.logger.Error("reload combo failed", "combo", comboId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toCombo(*row))
}

// DeleteCombo removes one combo (DELETE /combos/{comboId}); unknown or
// foreign ids surface COMBO_NOT_FOUND.
func (s *Server) DeleteCombo(w http.ResponseWriter, r *http.Request, comboId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM combos WHERE id = $1 AND merchant_id = $2`, comboId, merchantID)
	if err != nil {
		s.logger.Error("delete combo failed", "combo", comboId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeComboMiss(w, r, comboId, merchantID)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- menus ------------------------------------------------------------------

// menuBody is the menu write body: the contract Menu shape (name, storeIds,
// sections, active) plus the categoryId linkage this milestone persists in
// menus.category_id (the contract wire format has no category field).
type menuBody struct {
	gen.Menu
	CategoryId *uuid.UUID `json:"categoryId"`
}

// menuRow is a menus row projection; items stays raw jsonb.
type menuRow struct {
	id         uuid.UUID
	name       string
	categoryID *uuid.UUID
	items      []byte
	active     bool
	createdAt  time.Time
}

// menuItemStorage is the menus.items jsonb shape: the contract storeIds and
// sections arrays are persisted together as one object.
type menuItemStorage struct {
	StoreIds []uuid.UUID `json:"storeIds"`
	Sections []struct {
		ItemIds []uuid.UUID `json:"itemIds"`
		Name    string      `json:"name"`
	} `json:"sections"`
}

// toMenu maps a menus row onto the contract Menu.
func toMenu(r menuRow) gen.Menu {
	id := newUUID(r.id.String())
	out := gen.Menu{
		Id:        &id,
		Name:      r.name,
		StoreIds:  []openapi_types.UUID{},
		Active:    &r.active,
		CreatedAt: &r.createdAt,
	}
	var storage menuItemStorage
	if len(r.items) > 0 && json.Unmarshal(r.items, &storage) == nil {
		out.StoreIds = out.StoreIds[:0]
		for _, sid := range storage.StoreIds {
			out.StoreIds = append(out.StoreIds, newUUID(sid.String()))
		}
		if len(storage.Sections) > 0 {
			sections := make([]struct {
				ItemIds []openapi_types.UUID `json:"itemIds"`
				Name    string               `json:"name"`
			}, 0, len(storage.Sections))
			for _, sec := range storage.Sections {
				itemIDs := make([]openapi_types.UUID, 0, len(sec.ItemIds))
				for _, iid := range sec.ItemIds {
					itemIDs = append(itemIDs, newUUID(iid.String()))
				}
				sections = append(sections, struct {
					ItemIds []openapi_types.UUID `json:"itemIds"`
					Name    string               `json:"name"`
				}{ItemIds: itemIDs, Name: sec.Name})
			}
			out.Sections = &sections
		}
	}
	return out
}

const menuColumns = `id, name, category_id, items, active, created_at`

// loadMenu reads one menu row by id.
func (s *Server) loadMenu(ctx context.Context, id uuid.UUID) (*menuRow, error) {
	var r menuRow
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT `+menuColumns+` FROM menus WHERE id = $1`, id).
		Scan(&r.id, &r.name, &r.categoryID, &r.items, &r.active, &r.createdAt); err != nil {
		return nil, fmt.Errorf("load menu: %w", err)
	}
	return &r, nil
}

// validateMenuBody checks the menu write rules: name present, storeIds
// non-empty (MENU_STORE_INVALID) and the category — when provided — owned by
// the merchant (CATEGORY_NOT_FOUND when no such category exists).
func (s *Server) validateMenuBody(ctx context.Context, merchantID uuid.UUID, body menuBody) (bool, string, string) {
	if strings.TrimSpace(body.Name) == "" || len(body.Name) > maxMenuNameLen {
		return false, "VALIDATION_FAILED", "name must be 1-160 characters"
	}
	if len(body.StoreIds) == 0 {
		return false, "MENU_STORE_INVALID", "A menu must reference at least one store"
	}
	if body.CategoryId != nil {
		var owner uuid.UUID
		err := s.db.Pool().QueryRow(ctx,
			`SELECT merchant_id FROM product_categories WHERE id = $1`, *body.CategoryId).Scan(&owner)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return false, "CATEGORY_NOT_FOUND", "Category does not exist"
		case err != nil:
			return false, "", fmt.Sprintf("lookup menu category: %v", err)
		case owner != merchantID:
			return false, "MENU_STORE_INVALID", "Category does not belong to this merchant"
		}
	}
	return true, "", ""
}

// menuStorage builds the menus.items jsonb payload from the body.
func menuStorage(body menuBody) ([]byte, error) {
	storage := menuItemStorage{StoreIds: make([]uuid.UUID, 0, len(body.StoreIds))}
	for _, sid := range body.StoreIds {
		storage.StoreIds = append(storage.StoreIds, sid)
	}
	if body.Sections != nil {
		for _, sec := range *body.Sections {
			storage.Sections = append(storage.Sections, struct {
				ItemIds []uuid.UUID `json:"itemIds"`
				Name    string      `json:"name"`
			}{Name: sec.Name})
			for _, iid := range sec.ItemIds {
				storage.Sections[len(storage.Sections)-1].ItemIds = append(storage.Sections[len(storage.Sections)-1].ItemIds, iid)
			}
		}
	}
	return json.Marshal(storage)
}

// writeMenuMiss surfaces MENU_NOT_FOUND for unknown or foreign menu ids.
func (s *Server) writeMenuMiss(w http.ResponseWriter, r *http.Request, menuID, merchantID uuid.UUID) {
	var owner uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM menus WHERE id = $1`, menuID).Scan(&owner)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "MENU_NOT_FOUND", "Menu not found")
	case err != nil:
		s.logger.Error("menu ownership lookup failed", "menu", menuID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeError(w, http.StatusNotFound, "MENU_NOT_FOUND", "Menu not found")
	}
}

// ListMenus returns the merchant's menus (GET /menus), newest first.
func (s *Server) ListMenus(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+menuColumns+` FROM menus WHERE merchant_id = $1 ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list menus failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.Menu, 0, 8)
	for rows.Next() {
		var r menuRow
		if err := rows.Scan(&r.id, &r.name, &r.categoryID, &r.items, &r.active, &r.createdAt); err != nil {
			s.logger.Error("scan menu failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toMenu(r))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate menus failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateMenu adds one menu (POST /menus). The store list must be non-empty
// and the category — when provided — must belong to the merchant.
func (s *Server) CreateMenu(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body menuBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	valid, code, msg := s.validateMenuBody(r.Context(), merchantID, body)
	if !valid && code != "" {
		status := http.StatusUnprocessableEntity
		if code == "CATEGORY_NOT_FOUND" {
			status = http.StatusNotFound
		}
		writeError(w, status, code, msg)
		return
	}
	if !valid {
		s.logger.Error("menu category lookup failed", "merchant", merchantID, "error", msg)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	items, err := menuStorage(body)
	if err != nil {
		s.logger.Error("marshal menu items failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(), `
		INSERT INTO menus (merchant_id, name, category_id, items, active)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		merchantID, strings.TrimSpace(body.Name), body.CategoryId, items, active).Scan(&id); err != nil {
		s.logger.Error("create menu failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := s.loadMenu(r.Context(), id)
	if err != nil {
		s.logger.Error("reload menu failed", "menu", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toMenu(*row))
}

// UpdateMenu replaces one menu (PUT /menus/{menuId}); the same rules as
// create apply. Unknown or foreign ids surface MENU_NOT_FOUND.
func (s *Server) UpdateMenu(w http.ResponseWriter, r *http.Request, menuId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body menuBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	valid, code, msg := s.validateMenuBody(r.Context(), merchantID, body)
	if !valid && code != "" {
		status := http.StatusUnprocessableEntity
		if code == "CATEGORY_NOT_FOUND" {
			status = http.StatusNotFound
		}
		writeError(w, status, code, msg)
		return
	}
	if !valid {
		s.logger.Error("menu category lookup failed", "merchant", merchantID, "error", msg)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	items, err := menuStorage(body)
	if err != nil {
		s.logger.Error("marshal menu items failed", "menu", menuId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	tag, err := s.db.Pool().Exec(r.Context(), `
		UPDATE menus SET name = $2, category_id = $3, items = $4, active = $5, updated_at = now()
		WHERE id = $1 AND merchant_id = $6`,
		menuId, strings.TrimSpace(body.Name), body.CategoryId, items, active, merchantID)
	if err != nil {
		s.logger.Error("update menu failed", "menu", menuId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeMenuMiss(w, r, menuId, merchantID)
		return
	}
	row, err := s.loadMenu(r.Context(), menuId)
	if err != nil {
		s.logger.Error("reload menu failed", "menu", menuId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toMenu(*row))
}

// DeleteMenu removes one menu (DELETE /menus/{menuId}); unknown or foreign
// ids surface MENU_NOT_FOUND.
func (s *Server) DeleteMenu(w http.ResponseWriter, r *http.Request, menuId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM menus WHERE id = $1 AND merchant_id = $2`, menuId, merchantID)
	if err != nil {
		s.logger.Error("delete menu failed", "menu", menuId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeMenuMiss(w, r, menuId, merchantID)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- videos -----------------------------------------------------------------

// videoRow is a videos row projection.
type videoRow struct {
	id        uuid.UUID
	title     string
	url       string
	thumbnail *string
	itemID    *uuid.UUID
	active    bool
	createdAt time.Time
}

const videoColumns = `id, title, url, thumbnail_url, catalogue_item_id, active, created_at`

// toProductVideo maps a videos row onto the contract ProductVideo. The
// status is derived from the row: active rows are "active".
func toProductVideo(r videoRow) gen.ProductVideo {
	id := newUUID(r.id.String())
	status := gen.ProductVideoStatusActive
	out := gen.ProductVideo{
		Id:        &id,
		Title:     r.title,
		Url:       r.url,
		Status:    &status,
		CreatedAt: &r.createdAt,
	}
	if r.thumbnail != nil {
		out.ThumbnailUrl = r.thumbnail
	}
	if r.itemID != nil {
		id := newUUID(r.itemID.String())
		out.CatalogueItemId = &id
	}
	return out
}

// ListProductVideos returns the merchant's product videos (GET /videos),
// newest first.
func (s *Server) ListProductVideos(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+videoColumns+` FROM videos WHERE merchant_id = $1 ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list videos failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.ProductVideo, 0, 8)
	for rows.Next() {
		var r videoRow
		if err := rows.Scan(&r.id, &r.title, &r.url, &r.thumbnail, &r.itemID, &r.active, &r.createdAt); err != nil {
			s.logger.Error("scan video failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toProductVideo(r))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate videos failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateProductVideo adds one product video (POST /videos). The url must be
// an https URL (VIDEO_URL_INVALID otherwise).
func (s *Server) CreateProductVideo(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateProductVideoJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Title = strings.TrimSpace(body.Title)
	if body.Title == "" || len(body.Title) > maxVideoTitleLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title must be 1-120 characters")
		return
	}
	if !strings.HasPrefix(body.Url, "https://") {
		writeError(w, http.StatusUnprocessableEntity, "VIDEO_URL_INVALID", "url must start with https://")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(), `
		INSERT INTO videos (merchant_id, title, url, thumbnail_url, catalogue_item_id)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		merchantID, body.Title, body.Url, body.ThumbnailUrl, body.CatalogueItemId).Scan(&id); err != nil {
		s.logger.Error("create video failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var row videoRow
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT `+videoColumns+` FROM videos WHERE id = $1`, id).
		Scan(&row.id, &row.title, &row.url, &row.thumbnail, &row.itemID, &row.active, &row.createdAt); err != nil {
		s.logger.Error("reload video failed", "video", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toProductVideo(row))
}

// DeleteProductVideo removes one video (DELETE /videos/{videoId}); unknown
// or foreign ids surface VIDEO_NOT_FOUND.
func (s *Server) DeleteProductVideo(w http.ResponseWriter, r *http.Request, videoId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM videos WHERE id = $1 AND merchant_id = $2`, videoId, merchantID)
	if err != nil {
		s.logger.Error("delete video failed", "video", videoId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "VIDEO_NOT_FOUND", "Video not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- categories -------------------------------------------------------------

// categoryRow is a product_categories row projection.
type categoryRow struct {
	id        uuid.UUID
	name      string
	sortOrder int
	imageURL  *string
	active    bool
}

// categoryColumns is the shared SELECT list for category rows.
const categoryColumns = `id, name, sort_order, image_url, active`

// toProductCategory maps a product_categories row onto the contract
// ProductCategory.
func toProductCategory(r categoryRow) gen.ProductCategory {
	return gen.ProductCategory{
		Id:        newUUID(r.id.String()),
		Name:      r.name,
		SortOrder: r.sortOrder,
		ImageUrl:  r.imageURL,
		Active:    &r.active,
	}
}

// ListCategories returns the merchant's product categories (GET
// /categories), ordered by sort order.
func (s *Server) ListCategories(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+categoryColumns+` FROM product_categories
		 WHERE merchant_id = $1 ORDER BY sort_order, name`, merchantID)
	if err != nil {
		s.logger.Error("list categories failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.ProductCategory, 0, 8)
	for rows.Next() {
		var r categoryRow
		if err := rows.Scan(&r.id, &r.name, &r.sortOrder, &r.imageURL, &r.active); err != nil {
			s.logger.Error("scan category failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toProductCategory(r))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate categories failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// categorySortTaken reports whether another category of the merchant already
// holds the sort order.
func (s *Server) categorySortTaken(ctx context.Context, merchantID, excludeID uuid.UUID, sortOrder int) (bool, error) {
	var taken bool
	err := s.db.Pool().QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM product_categories
		 WHERE merchant_id = $1 AND sort_order = $2 AND id != $3)`,
		merchantID, sortOrder, excludeID).Scan(&taken)
	if err != nil {
		return false, fmt.Errorf("check category sort order: %w", err)
	}
	return taken, nil
}

// CreateCategory adds one product category (POST /categories). The name is
// required (1-80 characters) and a duplicate sort order for the same
// merchant surfaces CATEGORY_SORT_CONFLICT.
func (s *Server) CreateCategory(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateCategoryJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > maxCategoryNameLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-80 characters")
		return
	}
	taken, err := s.categorySortTaken(r.Context(), merchantID, uuid.Nil, body.SortOrder)
	if err != nil {
		s.logger.Error("create category sort check failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if taken {
		writeError(w, http.StatusConflict, "CATEGORY_SORT_CONFLICT", "Another category already uses this sort order")
		return
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(), `
		INSERT INTO product_categories (merchant_id, name, sort_order, image_url, active)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		merchantID, body.Name, body.SortOrder, body.ImageUrl, active).Scan(&id); err != nil {
		s.logger.Error("create category failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var row categoryRow
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT `+categoryColumns+` FROM product_categories WHERE id = $1`, id).
		Scan(&row.id, &row.name, &row.sortOrder, &row.imageURL, &row.active); err != nil {
		s.logger.Error("reload category failed", "category", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toProductCategory(row))
}

// writeCategoryMiss surfaces CATEGORY_NOT_FOUND for unknown or foreign
// category ids.
func (s *Server) writeCategoryMiss(w http.ResponseWriter, r *http.Request, categoryID, merchantID uuid.UUID) {
	var owner uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM product_categories WHERE id = $1`, categoryID).Scan(&owner)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category not found")
	case err != nil:
		s.logger.Error("category ownership lookup failed", "category", categoryID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	default:
		writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category not found")
	}
}

// UpdateCategory patches one category (PATCH /categories/{categoryId}):
// rename, sort order, image and active flag. A sort order already used by
// another category of the merchant surfaces CATEGORY_SORT_CONFLICT; unknown
// or foreign ids surface CATEGORY_NOT_FOUND.
func (s *Server) UpdateCategory(w http.ResponseWriter, r *http.Request, categoryId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateCategoryJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > maxCategoryNameLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be 1-80 characters")
		return
	}
	taken, err := s.categorySortTaken(r.Context(), merchantID, categoryId, body.SortOrder)
	if err != nil {
		s.logger.Error("update category sort check failed", "category", categoryId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if taken {
		writeError(w, http.StatusConflict, "CATEGORY_SORT_CONFLICT", "Another category already uses this sort order")
		return
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	tag, err := s.db.Pool().Exec(r.Context(), `
		UPDATE product_categories
		SET name = $2, sort_order = $3, image_url = $4, active = $5, updated_at = now()
		WHERE id = $1 AND merchant_id = $6`,
		categoryId, name, body.SortOrder, body.ImageUrl, active, merchantID)
	if err != nil {
		s.logger.Error("update category failed", "category", categoryId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		s.writeCategoryMiss(w, r, categoryId, merchantID)
		return
	}
	var row categoryRow
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT `+categoryColumns+` FROM product_categories WHERE id = $1`, categoryId).
		Scan(&row.id, &row.name, &row.sortOrder, &row.imageURL, &row.active); err != nil {
		s.logger.Error("reload category failed", "category", categoryId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toProductCategory(row))
}

// DeleteCategory removes one category (DELETE /categories/{categoryId}).
// Any catalogue item — live or soft-deleted — still referencing the category
// blocks the delete with CATEGORY_NOT_EMPTY (the FK is not cascading);
// unknown or foreign ids surface CATEGORY_NOT_FOUND.
func (s *Server) DeleteCategory(w http.ResponseWriter, r *http.Request, categoryId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var owner uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM product_categories WHERE id = $1`, categoryId).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category not found")
		return
	}
	if err != nil {
		s.logger.Error("delete category ownership lookup failed", "category", categoryId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if owner != merchantID {
		writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category not found")
		return
	}
	var referenced bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM catalogue_items WHERE category_id = $1)`, categoryId).
		Scan(&referenced); err != nil {
		s.logger.Error("delete category reference check failed", "category", categoryId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if referenced {
		writeError(w, http.StatusConflict, "CATEGORY_NOT_EMPTY", "Category still has catalogue items")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM product_categories WHERE id = $1`, categoryId); err != nil {
		s.logger.Error("delete category failed", "category", categoryId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- print jobs -------------------------------------------------------------

// printJobBody is the print job write body: the contract PrintJob shape
// plus the content text this milestone persists in print_jobs.content (the
// contract has no content field).
type printJobBody struct {
	gen.PrintJob
	Content *string `json:"content"`
}

// printJobRow is a print_jobs row projection.
type printJobRow struct {
	id        uuid.UUID
	deviceID  *uuid.UUID
	jobType   string
	content   string
	label     *string
	copies    int
	orderIDs  []byte
	tableID   *uuid.UUID
	status    string
	errorMsg  *string
	createdAt time.Time
	printedAt *time.Time
}

const printJobColumns = `id, device_id, job_type, content, label, copies, order_ids, table_id, status, error, created_at, printed_at`

// toPrintJob maps a print_jobs row onto the contract PrintJob.
func toPrintJob(r printJobRow) gen.PrintJob {
	out := gen.PrintJob{
		Id:        newUUID(r.id.String()),
		JobType:   gen.PrintJobJobType(r.jobType),
		Status:    gen.PrintJobStatus(r.status),
		CreatedAt: r.createdAt,
	}
	if r.deviceID != nil {
		id := newUUID(r.deviceID.String())
		out.DeviceId = &id
	}
	if r.label != nil {
		out.Label = r.label
	}
	if r.copies > 1 {
		out.Copies = &r.copies
	}
	if r.tableID != nil {
		id := newUUID(r.tableID.String())
		out.TableId = &id
	}
	if r.errorMsg != nil {
		out.Error = r.errorMsg
	}
	if r.printedAt != nil {
		out.CompletedAt = r.printedAt
	}
	if len(r.orderIDs) > 0 {
		var ids []uuid.UUID
		if json.Unmarshal(r.orderIDs, &ids) == nil {
			orderIDs := make([]openapi_types.UUID, 0, len(ids))
			for _, id := range ids {
				orderIDs = append(orderIDs, newUUID(id.String()))
			}
			out.OrderIds = &orderIDs
		}
	}
	return out
}

// CreatePrintJob enqueues one print job (POST /print-jobs). The content must
// be non-empty (PRINT_JOB_EMPTY), the target device must exist
// (DEVICE_NOT_FOUND) and be online (PRINT_DEVICE_OFFLINE), and the merchant
// may not queue more than 50 jobs (PRINT_QUEUE_FULL).
func (s *Server) CreatePrintJob(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var body printJobBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	content := strings.TrimSpace("")
	if body.Content != nil {
		content = strings.TrimSpace(*body.Content)
	}
	if content == "" {
		writeError(w, http.StatusUnprocessableEntity, "PRINT_JOB_EMPTY", "Print job content is required")
		return
	}
	if body.DeviceId == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "deviceId is required")
		return
	}
	if !body.JobType.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "jobType must be receipt, kitchen_ticket, label or voucher")
		return
	}
	copies := 1
	if body.Copies != nil {
		copies = *body.Copies
		if copies < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "copies must be >= 1")
			return
		}
	}

	ctx := r.Context()
	var deviceStatus string
	err := s.db.Pool().QueryRow(ctx,
		`SELECT status FROM devices WHERE id = $1 AND merchant_id = $2`, *body.DeviceId, merchantID).
		Scan(&deviceStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND", "Print device not found")
		return
	}
	if err != nil {
		s.logger.Error("print job device lookup failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if deviceStatus != "online" {
		writeError(w, http.StatusConflict, "PRINT_DEVICE_OFFLINE", "Print device is offline")
		return
	}

	var queued int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM print_jobs WHERE merchant_id = $1 AND status = 'queued'`, merchantID).
		Scan(&queued); err != nil {
		s.logger.Error("print job queue count failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if queued >= maxPrintJobsQueued {
		writeError(w, http.StatusConflict, "PRINT_QUEUE_FULL", "The print queue is full")
		return
	}

	var orderIDs []byte
	if body.OrderIds != nil {
		ids := make([]uuid.UUID, 0, len(*body.OrderIds))
		for _, id := range *body.OrderIds {
			ids = append(ids, id)
		}
		if orderIDs, err = json.Marshal(ids); err != nil {
			s.logger.Error("print job order ids marshal failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	var row printJobRow
	err = s.db.Pool().QueryRow(ctx, `
		INSERT INTO print_jobs (merchant_id, device_id, job_type, content, label, copies, order_ids, table_id, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
		RETURNING `+printJobColumns,
		merchantID, body.DeviceId, string(body.JobType), content, body.Label, copies, orderIDs, body.TableId).
		Scan(&row.id, &row.deviceID, &row.jobType, &row.content, &row.label, &row.copies,
			&row.orderIDs, &row.tableID, &row.status, &row.errorMsg, &row.createdAt, &row.printedAt)
	if err != nil {
		s.logger.Error("create print job failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toPrintJob(row))
}

// ListPrintJobs returns the merchant's print jobs (GET /print-jobs), newest
// first, with an optional status filter and a default page of 20 (max 100).
func (s *Server) ListPrintJobs(w http.ResponseWriter, r *http.Request, params gen.ListPrintJobsParams) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	limit := printJobsDefaultLimit
	if params.Limit != nil {
		limit = *params.Limit
		if limit < 1 {
			limit = 1
		}
		if limit > printJobsMaxLimit {
			limit = printJobsMaxLimit
		}
	}
	query := `SELECT ` + printJobColumns + ` FROM print_jobs WHERE merchant_id = $1`
	args := []any{merchantID}
	if params.Status != nil {
		args = append(args, string(*params.Status))
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + fmt.Sprintf("%d", len(args)+1)
	args = append(args, limit)

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list print jobs failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.PrintJob, 0, limit)
	for rows.Next() {
		var r printJobRow
		if err := rows.Scan(&r.id, &r.deviceID, &r.jobType, &r.content, &r.label, &r.copies,
			&r.orderIDs, &r.tableID, &r.status, &r.errorMsg, &r.createdAt, &r.printedAt); err != nil {
			s.logger.Error("scan print job failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toPrintJob(r))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate print jobs failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetPrintJob returns one print job (GET /print-jobs/{printJobId}); unknown
// or foreign ids surface PRINT_JOB_NOT_FOUND.
func (s *Server) GetPrintJob(w http.ResponseWriter, r *http.Request, printJobId openapi_types.UUID) {
	merchantID, ok := s.mediaMerchantID(w, r)
	if !ok {
		return
	}
	var row printJobRow
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT `+printJobColumns+` FROM print_jobs WHERE id = $1 AND merchant_id = $2`, printJobId, merchantID).
		Scan(&row.id, &row.deviceID, &row.jobType, &row.content, &row.label, &row.copies,
			&row.orderIDs, &row.tableID, &row.status, &row.errorMsg, &row.createdAt, &row.printedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "PRINT_JOB_NOT_FOUND", "Print job not found")
		return
	}
	if err != nil {
		s.logger.Error("get print job failed", "job", printJobId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toPrintJob(row))
}
