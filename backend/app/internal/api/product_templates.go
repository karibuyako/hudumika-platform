package api

// PRODUCT TEMPLATE apply/update/delete: the second half of the
// /product-templates surface (list/create live in catalogue_bulk.go). The
// contract defines five operations; the two read/write pairs are split so
// each handler owns one verb:
//
//   - UpdateProductTemplate (PATCH /product-templates/{templateId}) applies a
//     partial update to one of the merchant's templates: name, priceTZS,
//     category and options are patchable individually, each guarded by the
//     same rules as create (name 1-160 characters, price >= 0, category
//     owned by the merchant, name unique per merchant).
//   - DeleteProductTemplate (DELETE /product-templates/{templateId}) removes
//     the merchant's template; the row is gone (204), foreign or unknown ids
//     are TEMPLATE_NOT_FOUND.
//   - ApplyProductTemplate (POST /product-templates/{templateId}/apply)
//     materialises the template as one catalogue_items row per requested
//     chain store of the merchant (batched insert in one transaction). The
//     contract marks storeIds required, so an empty list is VALIDATION_FAILED;
//     every requested store must belong to the merchant (404 NOT_FOUND
//     otherwise). The contract's overwritePrices flag presupposes tracking
//     which items came from which template — product_templates has no link to
//     catalogue_items (migration 00048), so applications always insert and
//     the flag is accepted but inert; the contract's 204 response carries no
//     appliedCount.
//
// All three share the catalogueMerchantID gate and the product_templates
// table of the create handler; mutations additionally write the merchant's
// store_logs row via recordStoreLog, like create does.

import (
	"errors"
	"fmt"
	"github.com/hudumika/api-backend/internal/auth"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// updateProductTemplateBody is the PATCH body. Like createProductTemplateBody
// it carries the priceTZS/category/options extensions the generated
// UpdateProductTemplateJSONRequestBody (an alias of ProductTemplate) cannot,
// with every field a pointer so a PATCH may touch only the fields it names.
type updateProductTemplateBody struct {
	Name     *string              `json:"name"`
	PriceTZS *int                 `json:"priceTZS"`
	Category *string              `json:"category"`
	Options  *catalogueOptionList `json:"options"`
}

// UpdateProductTemplate applies a partial update to one of the merchant's
// templates (PATCH /product-templates/{templateId}, 200 ProductTemplate).
// Validation order: merchant gate, body shape (422 VALIDATION_FAILED), name
// bound and non-negative price (422 VALIDATION_FAILED), category ownership
// (404 CATEGORY_NOT_FOUND), then one guarded UPDATE — a foreign or unknown
// template id is 404 TEMPLATE_NOT_FOUND and a name collision with another of
// the merchant's templates is 409 TEMPLATE_KEY_EXISTS.
func (s *Server) UpdateProductTemplate(w http.ResponseWriter, r *http.Request, templateId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body updateProductTemplateBody
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

	ctx := r.Context()
	var categoryID *uuid.UUID
	if body.Category != nil {
		if trimmed := strings.TrimSpace(*body.Category); trimmed != "" {
			var err error
			categoryID, err = resolveCategoryID(ctx, s.db.Pool(), merchantID, trimmed, false)
			if err != nil {
				if errors.Is(err, errCategoryNotFound) {
					writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category does not belong to this merchant")
					return
				}
				s.logger.Error("update product template category lookup failed", "merchant", merchantID, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
		}
	}
	var options []byte
	if body.Options != nil {
		var err error
		if options, err = marshalCatalogueOptions(body.Options); err != nil {
			s.logger.Error("update product template options marshal failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	// The SET clause is assembled only from a fixed field list, so every
	// value stays a positional parameter.
	args := []any{uuid.UUID(templateId), merchantID}
	sets := []string{"updated_at = now()"}
	if body.Name != nil {
		args = append(args, strings.TrimSpace(*body.Name))
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if body.PriceTZS != nil {
		args = append(args, *body.PriceTZS)
		sets = append(sets, fmt.Sprintf("price_tzs = $%d", len(args)))
	}
	if body.Category != nil {
		args = append(args, categoryID)
		sets = append(sets, fmt.Sprintf("category_id = $%d", len(args)))
	}
	if body.Options != nil {
		args = append(args, options)
		sets = append(sets, fmt.Sprintf("options = $%d", len(args)))
	}

	var (
		id        uuid.UUID
		name      string
		createdAt time.Time
	)
	err := s.db.Pool().QueryRow(ctx, fmt.Sprintf(
		`UPDATE product_templates SET %s WHERE id = $1 AND merchant_id = $2
		 RETURNING id, name, created_at`, strings.Join(sets, ", ")), args...).
		Scan(&id, &name, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "TEMPLATE_NOT_FOUND", "Template not found")
			return
		}
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "TEMPLATE_KEY_EXISTS", "A template with this name already exists")
			return
		}
		s.logger.Error("update product template failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.recordStoreLog(ctx, merchantID, merchantID, "catalogue.template.update", "product_templates", map[string]any{
		"templateId": id.String(), "name": name,
	})
	writeJSON(w, http.StatusOK, gen.ProductTemplate{
		Id:        newUUIDPtr(id),
		Name:      name,
		CreatedAt: &createdAt,
	})
}

// DeleteProductTemplate removes one of the merchant's templates (DELETE
// /product-templates/{templateId}, 204). A foreign or unknown template id is
// 404 TEMPLATE_NOT_FOUND.
func (s *Server) DeleteProductTemplate(w http.ResponseWriter, r *http.Request, templateId openapi_types.UUID) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM product_templates WHERE id = $1 AND merchant_id = $2`,
		uuid.UUID(templateId), merchantID)
	if err != nil {
		s.logger.Error("delete product template failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "TEMPLATE_NOT_FOUND", "Template not found")
		return
	}
	s.recordStoreLog(r.Context(), merchantID, merchantID, "catalogue.template.delete", "product_templates", map[string]any{
		"templateId": templateId.String(),
	})
	w.WriteHeader(http.StatusNoContent)
}

// ApplyProductTemplate materialises one of the merchant's templates as a
// catalogue_items row per requested chain store (POST
// /product-templates/{templateId}/apply, 204). Validation order: body shape
// and a non-empty storeIds (422 VALIDATION_FAILED), merchant gate, template
// ownership (404 TEMPLATE_NOT_FOUND), store ownership (404 NOT_FOUND when any
// requested store is not the merchant's), then one transaction: a single
// batched INSERT copies name/price/category/options per store. The merchant
// id on the inserted rows is the catalogue merchant id (the session user id,
// see catalogues.go) — the chain_stores.merchant_id is the merchants-context
// id and does not own catalogue rows in this milestone.
func (s *Server) ApplyProductTemplate(w http.ResponseWriter, r *http.Request, templateId openapi_types.UUID) {
	var body gen.ApplyProductTemplateJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.StoreIds) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "storeIds must contain at least one store")
		return
	}

	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var (
		name       string
		priceTZS   int64
		categoryID *uuid.UUID
		options    []byte
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT name, price_tzs, category_id, options FROM product_templates
		 WHERE id = $1 AND merchant_id = $2`,
		uuid.UUID(templateId), merchantID).Scan(&name, &priceTZS, &categoryID, &options)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "TEMPLATE_NOT_FOUND", "Template not found")
			return
		}
		s.logger.Error("apply product template lookup failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	storeIDs := make([]uuid.UUID, len(body.StoreIds))
	for i, id := range body.StoreIds {
		storeIDs[i] = uuid.UUID(id)
	}
	ownerID, err := s.sessionUserID(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	owned := make(map[uuid.UUID]bool, len(storeIDs))
	rows, err := s.db.Pool().Query(ctx,
		`SELECT id FROM chain_stores WHERE owner_user_id = $1 AND id = ANY($2)`,
		ownerID, storeIDs)
	if err != nil {
		s.logger.Error("apply product template store lookup failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			s.logger.Error("scan chain store failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		owned[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate chain stores failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for _, id := range storeIDs {
		if !owned[id] {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "One or more stores do not belong to this merchant")
			return
		}
	}

	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("apply product template begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `INSERT INTO catalogue_items
		(merchant_id, name, price_tzs, category_id, options)
		SELECT $1, $2, $3, $4, $5 FROM unnest($6::uuid[]) AS s(store_id)`,
		merchantID, name, priceTZS, categoryID, options, storeIDs); err != nil {
		s.logger.Error("apply product template insert failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("apply product template commit failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.recordStoreLog(ctx, merchantID, merchantID, "catalogue.template.apply", "product_templates", map[string]any{
		"templateId": templateId.String(), "name": name, "stores": len(storeIDs),
	})
	w.WriteHeader(http.StatusNoContent)
}

// sessionUserID resolves the authenticated subject (phone) to their users.id
// (the chain-store owner). Used where an ownership check keys on the session
// user rather than the merchant row.
func (s *Server) sessionUserID(r *http.Request) (uuid.UUID, error) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims.Subject == "" {
		return uuid.Nil, errNoBearerToken
	}
	if s.db == nil {
		return uuid.Nil, errNoDatabase
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return uuid.Nil, err
	}
	if user == nil {
		return uuid.Nil, errUserNotFound
	}
	return user.ID, nil
}
