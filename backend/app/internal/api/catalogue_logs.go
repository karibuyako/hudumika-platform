package api

// CATALOGUE CHANGE-LOGS + CHAIN-STORE SETTINGS (API-CONTRACT.yaml
// GET /catalogue-items/{itemId}/logs and PATCH /merchants/me/stores/{storeId};
// migration 00055). catalogue_item_logs is the append-only per-item change
// log read by the item logs endpoint; chain_store_settings carries the
// per-store settings the contract wants (store_settings, 00045, stays
// merchant-scoped — a different surface).
//
// Deviations from the contract (documented):
//   - GetCatalogueItemLogs: the contract response objects have no ids and no
//     pagination params, so the `limit`/`cursor` query parameters are
//     unofficial extensions (default 20, max 100, keyset cursor on
//     X-Next-Cursor, mirroring GET /store/logs) and the row id is not
//     echoed. A soft-deleted item keeps its logs readable (its change log is
//     the point of the endpoint); an unknown or foreign item answers 404
//     ITEM_NOT_FOUND without leaking existence.
//   - UpdateMyStore: the contract StoreSettingsUpdate fields with a 00055
//     column round-trip (businessHours -> opening_hours,
//     deliverySettings.minimumOrderTZS -> min_order_tzs); acceptWhileClosed
//     has no contract field on StoreSettingsUpdate, so it rides the body as
//     an optional extension (same pattern as merchant_extra.go) and is
//     persisted to accept_while_closed. Every other field is accepted but
//     not persisted (no column, consistent with merchant_extra.go). isOpen
//     has no 00055 column either, so it maps to chain_stores.active and the
//     response echoes that per-store flag (the field the PATCH controls;
//     ListMyStores keeps its own merchant-level COALESCE precedence). A
//     store the session user does not own answers 404 NOT_FOUND (the generic
//     resource code; the catalogues ITEM_NOT_FOUND / MENU_NOT_FOUND codes
//     are for items/menus, not chain stores).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

const (
	catalogueLogDefaultLimit = 20
	catalogueLogMaxLimit     = 100
)

// catalogueLogEntry maps one catalogue_item_logs row onto the contract
// response object {at, actor, action, before, after}. The detail jsonb is
// written as {"before":..., "after":...} by log writers; a detail without
// those keys is treated as the after state.
type catalogueLogEntry struct {
	At     time.Time       `json:"at"`
	Actor  string          `json:"actor,omitempty"`
	Action string          `json:"action"`
	Before json.RawMessage `json:"before,omitempty"`
	After  json.RawMessage `json:"after,omitempty"`
}

// splitCatalogueLogDetail splits a stored detail jsonb into the contract
// before/after pair. An object carrying a before or after key is split;
// anything else is the after state.
func splitCatalogueLogDetail(detail []byte) (before, after json.RawMessage) {
	if len(detail) == 0 {
		return nil, nil
	}
	var envelope struct {
		Before json.RawMessage `json:"before"`
		After  json.RawMessage `json:"after"`
	}
	if err := json.Unmarshal(detail, &envelope); err == nil &&
		(len(envelope.Before) > 0 || len(envelope.After) > 0) {
		return envelope.Before, envelope.After
	}
	return nil, json.RawMessage(detail)
}

// GetCatalogueItemLogs returns the change log of one catalogue item (GET
// /catalogue-items/{itemId}/logs). Only the owning merchant may read it;
// unknown or foreign items answer 404 ITEM_NOT_FOUND. The list is newest
// first, keyset-paginated on (created_at, id) with the next cursor on
// X-Next-Cursor; an empty log is `[]`.
func (s *Server) GetCatalogueItemLogs(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	limit := catalogueLogDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "limit must be a positive integer")
			return
		}
		limit = n
		if limit > catalogueLogMaxLimit {
			limit = catalogueLogMaxLimit
		}
	}
	var owner uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM catalogue_items WHERE id = $1`, itemId).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "ITEM_NOT_FOUND", "Catalogue item not found")
		return
	}
	if err != nil {
		s.logger.Error("catalogue item log ownership lookup failed", "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if owner != merchantID {
		writeError(w, http.StatusNotFound, "ITEM_NOT_FOUND", "Catalogue item not found")
		return
	}

	args := []any{itemId}
	where := ""
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		at, id, err := audit.ParseCursor(cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		args = append(args, at, id)
		where = fmt.Sprintf(" AND (created_at, id) < ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query := fmt.Sprintf(`SELECT id, created_at, action, actor_uuid, detail
		FROM catalogue_item_logs WHERE catalogue_item_id = $1%s
		ORDER BY created_at DESC, id DESC
		LIMIT $%d`, where, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list catalogue item logs failed", "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	entries := make([]catalogueLogEntry, 0, limit)
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
			actor     *uuid.UUID
			detail    []byte
		)
		if err := rows.Scan(&id, &createdAt, &action, &actor, &detail); err != nil {
			s.logger.Error("scan catalogue item log failed", "item", itemId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(entries) == limit {
			sentinel = true
			continue
		}
		entry := catalogueLogEntry{At: createdAt, Action: action}
		if actor != nil {
			entry.Actor = actor.String()
		}
		entry.Before, entry.After = splitCatalogueLogDetail(detail)
		entries = append(entries, entry)
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate catalogue item logs failed", "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", audit.EncodeCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, entries)
}

// defaultChainStoreSettingsRow is the lazy chain_store_settings projection
// the PATCH overlays its body onto, mirroring defaultStoreSettings.
type chainStoreSettingsRow struct {
	openingHours      json.RawMessage
	minOrderTZS       int64
	acceptWhileClosed bool
}

func defaultChainStoreSettings() chainStoreSettingsRow {
	return chainStoreSettingsRow{
		openingHours: json.RawMessage("{}"),
	}
}

// chainStoreSettingsPayload is the update body: the contract
// StoreSettingsUpdate plus the optional acceptWhileClosed extension (the
// contract body has no field for it, so it rides the update body like the
// currency/timezone extensions in merchant_extra.go).
type chainStoreSettingsPayload struct {
	gen.StoreSettingsUpdate
	AcceptWhileClosed *bool `json:"acceptWhileClosed,omitempty"`
}

// UpdateMyStore updates one chain store's settings (PATCH
// /merchants/me/stores/{storeId}) and returns the ChainStore shape. The
// store must exist and be owned by the session user (404 NOT_FOUND
// otherwise). Opening hours are validated like the merchant settings (422
// HOURS_INVALID on malformed days/ranges); minimumOrderTZS must be >= 0
// (422 VALIDATION_FAILED). Only the present fields are applied.
func (s *Server) UpdateMyStore(w http.ResponseWriter, r *http.Request, storeId openapi_types.UUID) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	var body chainStoreSettingsPayload
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	row := defaultChainStoreSettings()
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT opening_hours, min_order_tzs, accept_while_closed
		 FROM chain_store_settings WHERE store_id = $1`,
		storeId).Scan(&row.openingHours, &row.minOrderTZS, &row.acceptWhileClosed)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("chain store settings read failed", "store", storeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if body.BusinessHours != nil {
		entries, err := validateMerchantHours(*body.BusinessHours)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "HOURS_INVALID", err.Error())
			return
		}
		b, err := json.Marshal(entries)
		if err != nil {
			s.logger.Error("opening hours marshal failed", "store", storeId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		row.openingHours = b
	}
	if body.DeliverySettings != nil && body.DeliverySettings.MinimumOrderTZS != nil {
		if *body.DeliverySettings.MinimumOrderTZS < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "minimumOrderTZS must be >= 0")
			return
		}
		row.minOrderTZS = int64(*body.DeliverySettings.MinimumOrderTZS)
	}
	if body.AcceptWhileClosed != nil {
		row.acceptWhileClosed = *body.AcceptWhileClosed
	}
	if len(row.openingHours) == 0 {
		row.openingHours = json.RawMessage("{}")
	}

	ctx := r.Context()
	var exists bool
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM chain_stores WHERE id = $1 AND owner_user_id = $2)`,
		storeId, ownerID).Scan(&exists); err != nil {
		s.logger.Error("chain store lookup failed", "store", storeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Chain store not found for this account")
		return
	}
	if body.IsOpen != nil {
		if _, err := s.db.Pool().Exec(ctx,
			`UPDATE chain_stores SET active = $2, updated_at = now() WHERE id = $1`,
			storeId, *body.IsOpen); err != nil {
			s.logger.Error("chain store open state update failed", "store", storeId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	_, err = s.db.Pool().Exec(ctx,
		`INSERT INTO chain_store_settings (store_id, opening_hours, min_order_tzs, accept_while_closed, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (store_id) DO UPDATE SET
			opening_hours = EXCLUDED.opening_hours,
			min_order_tzs = EXCLUDED.min_order_tzs,
			accept_while_closed = EXCLUDED.accept_while_closed,
			updated_at = now()`,
		storeId, row.openingHours, row.minOrderTZS, row.acceptWhileClosed)
	if err != nil {
		s.logger.Error("chain store settings upsert failed", "store", storeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	store, err := loadChainStore(ctx, s.db.Pool(), storeId, ownerID)
	if err != nil {
		s.logger.Error("chain store reload failed", "store", storeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, store)
}

// loadChainStore maps one owned chain_stores row onto the contract
// ChainStore (businessName/city/isOpen per the contract; the settings
// themselves live in chain_store_settings and are not part of the shape).
// isOpen is the store's own chain_stores.active flag — the field this PATCH
// controls — not the merchant-level is_open fallback ListMyStores uses.
func loadChainStore(ctx context.Context, q catalogueQueryer, storeID, ownerID uuid.UUID) (gen.ChainStore, error) {
	var (
		name         string
		city         *string
		isOpen       bool
		verification *string
	)
	err := q.QueryRow(ctx,
		`SELECT cs.name, c.name, cs.active, m.verification
		 FROM chain_stores cs
		 LEFT JOIN cities c ON c.id = cs.city_id
		 LEFT JOIN merchants m ON m.id = cs.merchant_id
		 WHERE cs.id = $1 AND cs.owner_user_id = $2`,
		storeID, ownerID).Scan(&name, &city, &isOpen, &verification)
	if err != nil {
		return gen.ChainStore{}, fmt.Errorf("load chain store: %w", err)
	}
	out := gen.ChainStore{
		Id:           newUUID(storeID.String()),
		BusinessName: name,
		City:         strValue(city),
		IsOpen:       isOpen,
	}
	if verification != nil {
		v := gen.VerificationState(*verification)
		out.Verification = &v
	}
	return out, nil
}
