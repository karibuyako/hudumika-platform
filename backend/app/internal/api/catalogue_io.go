package api

// CATALOGUE IMPORT / EXPORT surfaces (API-CONTRACT.yaml /catalogues/import
// and /catalogues/export). Both are merchant-owned: the merchant id is the
// REAL merchants row id (merchant_linkage.go), and the merchant gate is
// catalogueMerchantID, shared with the CRUD handlers.
//
// Import is SYNCHRONOUS in this milestone: the contract's 202 body is
// {jobId, status} with a queued/processing/completed/failed enum that
// presupposes a worker, but there is no worker here (same simplification as
// reports.go data exports). The import executes inline and reports status
// 'completed'; the created/updated/skipped counters and the errors list are
// additive extensions clients can rely on. The contract caps rows at 5000;
// this milestone caps at 500 (BULK_OPERATION_INVALID) to keep the
// synchronous transaction bounded.
//
// The contract row schema is {name, priceTZS, category, description?,
// quantity?}. id/available/options are additive extensions so a catalogue
// export (which carries ids) round-trips back through the same surface;
// quantity is accepted per the contract but stock levels are owned by the
// inventory bounded context, so it is validated nowhere and not persisted.
// replace (also an extension) mirrors PUT /catalogues/me replace semantics:
// every current item not part of the incoming set is soft-deleted.
//
// Export is serialized inline for small payloads: the contract response is
// {downloadUrl, expiresInSeconds} but there is no object store in this
// milestone, so the payload is embedded as a data URL (CSV or JSON, format
// query param, csv default) that clients can persist before the
// contract-default expiry window. JSON is the contract CatalogueItem array;
// CSV is a header row plus one row per item via encoding/csv (RFC 4180
// quoting). Large payloads (over 100 KB) or an explicit ?job=true create a
// durable data_exports job row instead (scope 'catalogue', status 'queued')
// and answer 202 with the DataExportJob shape — the same job pattern as
// reports.go RequestDataExport, so big exports never block the request.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

const (
	// maxImportRows bounds a single import request; the contract allows 5000
	// but the synchronous transaction stays bounded at 500 (see package
	// comment).
	maxImportRows = 500
	// exportExpiresInSeconds is the contract's expiresInSeconds default.
	exportExpiresInSeconds = 900
	// exportInlineMaxBytes is the largest export payload still embedded
	// inline as a data URL. Anything larger (or an explicit ?job=true) is
	// deferred to a data_exports job row so the request never blocks on a
	// huge serialization (see ExportCatalogue).
	exportInlineMaxBytes = 100 * 1024
)

// catalogueImportRow is one import row: the contract's
// {name, priceTZS, category, description?, quantity?} plus the
// id/available/options extensions (see package comment).
type catalogueImportRow struct {
	Id          *openapi_types.UUID  `json:"id,omitempty"`
	Name        string               `json:"name"`
	Description *string              `json:"description,omitempty"`
	PriceTZS    int                  `json:"priceTZS"`
	Quantity    *int                 `json:"quantity,omitempty"`
	Category    string               `json:"category"`
	Available   *bool                `json:"available,omitempty"`
	Options     *catalogueOptionList `json:"options,omitempty"`
}

// catalogueImportBody is the import payload: the contract's rows array plus
// the replace extension (see package comment).
type catalogueImportBody struct {
	Rows    []catalogueImportRow `json:"rows"`
	Replace bool                 `json:"replace,omitempty"`
}

// catalogueImportError is one per-row problem in the {field, message} shape
// of the contract ValidationResponse.errors. It is an alias of the generated
// anonymous struct so slices assign onto gen.ValidationResponse.Errors
// directly (slice assignability needs identical element types).
type catalogueImportError = struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// catalogueImportResult is the synchronous 202 body: the contract's
// {jobId, status} plus created/updated/skipped counters and the errors list.
type catalogueImportResult struct {
	JobId   string                 `json:"jobId"`
	Status  string                 `json:"status"`
	Created int                    `json:"created"`
	Updated int                    `json:"updated"`
	Skipped int                    `json:"skipped"`
	Errors  []catalogueImportError `json:"errors,omitempty"`
}

// validateCatalogueImportRows enforces the per-row contract bounds (name
// 1-160 characters, priceTZS >= 0) and reports each failure as a
// rows[i].field problem for the ValidationResponse.errors list.
func validateCatalogueImportRows(rows []catalogueImportRow) []catalogueImportError {
	var errs []catalogueImportError
	for i, row := range rows {
		if !validateCatalogueItemName(row.Name) {
			errs = append(errs, catalogueImportError{
				Field:   fmt.Sprintf("rows[%d].name", i),
				Message: "name must be 1-160 characters",
			})
		}
		if row.PriceTZS < 0 {
			errs = append(errs, catalogueImportError{
				Field:   fmt.Sprintf("rows[%d].priceTZS", i),
				Message: "priceTZS must be >= 0",
			})
		}
	}
	return errs
}

// importRowIdentity is the duplicate-detection key inside one import: an id
// when present, otherwise the exact name+category pair (the same identity an
// export → re-import round trip would collide on). Later rows with an
// already-seen key are skipped, not applied twice.
func importRowIdentity(row catalogueImportRow) string {
	if row.Id != nil {
		return "id:" + row.Id.String()
	}
	return "name:" + strings.TrimSpace(row.Name) + "|" + strings.TrimSpace(row.Category)
}

// importUpsertItem applies one import row inside the transaction: an id
// owned by this merchant updates the row (restoring it when soft-deleted,
// matching upsertCatalogueItem), anything else inserts a fresh row. It
// reports whether an existing row was updated.
func importUpsertItem(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID, row catalogueImportRow, categoryID *uuid.UUID, options []byte) (uuid.UUID, bool, error) {
	available := true
	if row.Available != nil {
		available = *row.Available
	}
	name := strings.TrimSpace(row.Name)
	if row.Id != nil {
		tag, err := tx.Exec(ctx, `UPDATE catalogue_items
			SET name = $2, description = $3, price_tzs = $4, category_id = $5,
			    available = $6, options = $7, deleted_at = NULL, updated_at = now()
			WHERE id = $1 AND merchant_id = $8`,
			*row.Id, name, row.Description, row.PriceTZS, categoryID,
			available, options, merchantID)
		if err != nil {
			return uuid.Nil, false, fmt.Errorf("import upsert item %s: %w", *row.Id, err)
		}
		if tag.RowsAffected() > 0 {
			return *row.Id, true, nil
		}
	}
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO catalogue_items
		(merchant_id, name, description, price_tzs, category_id, available, options)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		merchantID, name, row.Description, row.PriceTZS, categoryID,
		available, options).Scan(&id); err != nil {
		return uuid.Nil, false, fmt.Errorf("import insert item %q: %w", name, err)
	}
	return id, false, nil
}

// ImportCatalogue applies the merchant's import rows atomically (POST
// /catalogues/import, 202 catalogueImportResult). Validation order: body
// shape (422 VALIDATION_FAILED), row count bound (422 BULK_OPERATION_INVALID
// — before the merchant gate), per-row bounds (422 VALIDATION_FAILED with
// errors[]), then the merchant gate, then one transaction: categories are
// matched by name and auto-created when missing (resolveCategoryID with
// createMissing), items are upserted by owned id or inserted, and when
// replace is set every current item outside the incoming set is
// soft-deleted. In-import duplicate rows are skipped and reported in the
// result's errors list.
func (s *Server) ImportCatalogue(w http.ResponseWriter, r *http.Request) {
	var body catalogueImportBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Rows) == 0 || len(body.Rows) > maxImportRows {
		writeError(w, http.StatusUnprocessableEntity, "BULK_OPERATION_INVALID",
			fmt.Sprintf("rows must contain between 1 and %d items", maxImportRows))
		return
	}
	if errs := validateCatalogueImportRows(body.Rows); len(errs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, gen.ValidationResponse{
			Code:      "VALIDATION_FAILED",
			Message:   "Some catalogue rows failed validation",
			RequestId: newUUID(newRequestID()),
			Errors:    errs,
		})
		return
	}

	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}

	ctx := r.Context()
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("import catalogue begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	if body.Replace {
		if _, err := tx.Exec(ctx,
			`UPDATE catalogue_items SET deleted_at = now(), updated_at = now()
			 WHERE merchant_id = $1 AND deleted_at IS NULL`, merchantID); err != nil {
			s.logger.Error("import catalogue replace soft delete failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	result := catalogueImportResult{JobId: uuid.NewString(), Status: "completed"}
	seen := make(map[string]bool, len(body.Rows))
	for i, row := range body.Rows {
		key := importRowIdentity(row)
		if seen[key] {
			result.Skipped++
			result.Errors = append(result.Errors, catalogueImportError{
				Field:   fmt.Sprintf("rows[%d]", i),
				Message: "duplicate row already imported in this request",
			})
			continue
		}
		seen[key] = true

		categoryID, err := resolveCategoryID(ctx, tx, merchantID, row.Category, true)
		if err != nil {
			s.logger.Error("import catalogue category failed", "merchant", merchantID, "category", row.Category, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		options, err := marshalCatalogueOptions(row.Options)
		if err != nil {
			s.logger.Error("import catalogue options marshal failed", "merchant", merchantID, "row", i, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if _, updated, err := importUpsertItem(ctx, tx, merchantID, row, categoryID, options); err != nil {
			s.logger.Error("import catalogue item failed", "merchant", merchantID, "row", i, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		} else if updated {
			result.Updated++
		} else {
			result.Created++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("import catalogue commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// exportMerchantID resolves the user and merchant for ExportCatalogue. It is
// catalogueMerchantID plus a self-authentication fallback: the router's
// isPublicPath treats any GET /catalogues/{x} (including /catalogues/export)
// as public and therefore never injects claims, so without the fallback an
// authenticated merchant could never export. When claims are absent the
// handler parses the Authorization header itself, preserving the contract's
// bearerAuth requirement end-to-end. The user id is returned alongside the
// merchant id because a job-mode export persists a data_exports row owned by
// the user.
func (s *Server) exportMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		tok := bearerToken(r)
		if tok == "" {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
			return uuid.Nil, uuid.Nil, false
		}
		var err error
		if claims, err = s.parseToken(tok); err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
			return uuid.Nil, uuid.Nil, false
		}
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage catalogues")
		return uuid.Nil, uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("catalogue merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("catalogue merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, uuid.Nil, false
	}
	merchantID, err := s.merchantIDForUser(r.Context(), user.ID)
	if errors.Is(err, errNoMerchant) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No merchant account for this session")
		return uuid.Nil, uuid.Nil, false
	}
	if err != nil {
		s.logger.Error("catalogue merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, uuid.Nil, false
	}
	return user.ID, merchantID, true
}

// marshalCatalogueCSV renders items as a CSV document with a header row.
// encoding/csv applies RFC 4180 quoting, so commas, quotes and newlines in
// names and descriptions round-trip byte-for-byte.
func marshalCatalogueCSV(items []gen.CatalogueItem) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	if err := w.Write([]string{"id", "name", "description", "priceTZS", "category", "available"}); err != nil {
		return nil, fmt.Errorf("csv header: %w", err)
	}
	for _, it := range items {
		desc := ""
		if it.Description != nil {
			desc = *it.Description
		}
		available := "false"
		if it.Available == nil || *it.Available {
			available = "true"
		}
		id := ""
		if it.Id != nil {
			id = it.Id.String()
		}
		if err := w.Write([]string{id, it.Name, desc, strconv.Itoa(it.PriceTZS), it.Category, available}); err != nil {
			return nil, fmt.Errorf("csv row %q: %w", it.Name, err)
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, fmt.Errorf("csv flush: %w", err)
	}
	return buf.Bytes(), nil
}

// ExportCatalogue serializes the merchant's live catalogue (GET
// /catalogues/export). format comes from the query string (csv or json,
// csv default — an extension; the contract binds no params). The payload is
// embedded inline as a data URL under the contract's downloadUrl field, with
// one exception: when the payload exceeds exportInlineMaxBytes (100 KB) or
// the caller passes ?job=true, the export is deferred to a data_exports job
// row (scope 'catalogue', status 'queued', file_url NULL — the same durable
// job record as reports.go RequestDataExport) and the handler answers 202
// with the DataExportJob shape instead. The job row IS the queue in this
// milestone: no worker flips it to completed, so large exports do not block
// the request and stay honest about their status.
func (s *Server) ExportCatalogue(w http.ResponseWriter, r *http.Request) {
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "csv"
	}
	if format != "csv" && format != "json" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "format must be csv or json")
		return
	}

	userID, merchantID, ok := s.exportMerchantID(w, r)
	if !ok {
		return
	}

	catalogue, err := s.loadCatalogue(r.Context(), s.db.Pool(), merchantID, false)
	if err != nil {
		s.logger.Error("export catalogue failed", "merchant", merchantID, "format", format, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		payload []byte
		mime    string
	)
	switch format {
	case "json":
		if catalogue.Items == nil {
			catalogue.Items = []gen.CatalogueItem{}
		}
		if payload, err = json.Marshal(catalogue.Items); err != nil {
			s.logger.Error("export catalogue json marshal failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		mime = "application/json"
	default:
		if payload, err = marshalCatalogueCSV(catalogue.Items); err != nil {
			s.logger.Error("export catalogue csv marshal failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		mime = "text/csv"
	}

	if r.URL.Query().Get("job") == "true" || len(payload) > exportInlineMaxBytes {
		job := exportJobRow{}
		err = s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO data_exports (user_id, scope, format, status, expires_at)
			 VALUES ($1, $2, $3, 'queued', $4)
			 RETURNING `+exportJobColumns,
			userID, "catalogue", format, time.Now().Add(exportTTL)).
			Scan(&job.id, &job.scope, &job.format, &job.status, &job.fileURL, &job.rows,
				&job.errorMsg, &job.expiresAt, &job.createdAt, &job.completedAt)
		if err != nil {
			s.logger.Error("export catalogue job insert failed", "merchant", merchantID, "format", format, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeJSON(w, http.StatusAccepted, job.toDataExportJob())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"downloadUrl":      "data:" + mime + ";charset=utf-8;base64," + base64.StdEncoding.EncodeToString(payload),
		"expiresInSeconds": exportExpiresInSeconds,
	})
}
