package api

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/groupbuy"
)

// EditReviewReply edits the reply the caller wrote on a review (PATCH
// /reviews/{reviewId}/reply). Only the reply author may edit; a missing
// review or a reply owned by someone else both answer 404 so authorship
// never leaks.
func (s *Server) EditReviewReply(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}
	var body gen.EditReviewReplyJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Reply body is required")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE reviews SET reply_body = $2, reply_created_at = now()
		 WHERE id = $1 AND reply_author_user_id = $3`,
		uuid.UUID(reviewId), body.Body, user.ID)
	if err != nil {
		s.logger.Error("edit review reply failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "REVIEW_REPLY_NOT_FOUND", "Review reply not found or not yours to edit")
		return
	}
	now := time.Now().UTC()
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	role := replyAuthorRole(claims.Role)
	writeJSON(w, http.StatusOK, gen.ReviewReply{
		Id:           newUUID(replyID(uuid.UUID(reviewId)).String()),
		ReviewId:     reviewId,
		AuthorUserId: newUUIDPtr(user.ID),
		AuthorRole:   role,
		Body:         body.Body,
		CreatedAt:    now,
	})
}

// DeleteReviewReply removes the reply the caller wrote on a review (DELETE
// /reviews/{reviewId}/reply). Idempotent: an already-absent reply answers
// 204.
func (s *Server) DeleteReviewReply(w http.ResponseWriter, r *http.Request, reviewId openapi_types.UUID) {
	user, err := s.reviewUser(r)
	if err != nil {
		s.writeReviewUserError(w, err)
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE reviews
		 SET reply_body = NULL, reply_author_user_id = NULL, reply_created_at = NULL
		 WHERE id = $1 AND reply_author_user_id = $2`,
		uuid.UUID(reviewId), user.ID); err != nil {
		s.logger.Error("delete review reply failed", "review", reviewId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// replyAuthorRole maps a user's role onto the contract reply author-role
// enum.
func replyAuthorRole(role string) gen.ReviewReplyAuthorRole {
	switch role {
	case "provider":
		return gen.ReviewReplyAuthorRoleProvider
	case "rider":
		return gen.ReviewReplyAuthorRoleRider
	default: // merchant and staff
		return gen.ReviewReplyAuthorRoleMerchant
	}
}

// DeleteDineInTable deactivates a dine-in table of the caller's store
// (DELETE /dine-in/tables/{tableId}). Tables are soft-deleted (active =
// false) so open dine-in orders keep their reference; deletion is scoped to
// the caller's merchant.
func (s *Server) DeleteDineInTable(w http.ResponseWriter, r *http.Request, tableId openapi_types.UUID) {
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("delete dine-in table failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE dine_in_tables SET active = false, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`,
		uuid.UUID(tableId), merchantID); err != nil {
		s.logger.Error("delete dine-in table failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UpdateGroupBuy updates the caller's own group-buy deal (PATCH
// /group-buys/{groupId}). Only deal fields with backing columns are
// writable; sold-count and pricing invariants are enforced by the table
// constraints.
func (s *Server) UpdateGroupBuy(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	deal, ok := s.merchantDeal(w, r, groupId)
	if !ok {
		return
	}
	var body gen.UpdateGroupBuyJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Title == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title is required")
		return
	}
	if body.OriginalPriceTZS < 0 || body.PriceTZS < 0 || body.Quantity <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "prices must not be negative and quantity must be positive")
		return
	}
	if body.SalesStartAt.IsZero() || body.SalesEndAt.IsZero() || !body.SalesEndAt.After(body.SalesStartAt) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "salesEndAt must be after salesStartAt")
		return
	}
	if body.Quantity < deal.QuantitySold {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "quantity cannot drop below the sold count")
		return
	}
	description := ""
	if body.Description != nil {
		description = *body.Description
	}
	status := deal.Status
	if body.Status != "" {
		status = string(body.Status)
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE group_buy_deals SET
		   title = $2, description = $3, original_price_tzs = $4, deal_price_tzs = $5,
		   quantity_total = $6, start_at = $7, end_at = $8, status = $9, updated_at = now()
		 WHERE id = $1`,
		deal.ID, body.Title, description, body.OriginalPriceTZS, body.PriceTZS,
		body.Quantity, body.SalesStartAt, body.SalesEndAt, status); err != nil {
		s.logger.Error("update group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	updated, err := groupbuy.NewStore(s.db.Pool()).GetDeal(r.Context(), deal.ID)
	if err != nil {
		s.logger.Error("reload group buy failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenGroupBuyDeal(updated))
}

// ListGroupBuyVouchers lists the vouchers sold for the caller's own deal
// (GET /group-buys/{groupId}/vouchers), optionally filtered by status, with
// a cap of 100 rows (cursor pagination is declared in the contract but no
// voucher list cursor exists yet).
func (s *Server) ListGroupBuyVouchers(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID, params gen.ListGroupBuyVouchersParams) {
	deal, ok := s.merchantDeal(w, r, groupId)
	if !ok {
		return
	}
	if s.db == nil {
		s.logger.Error("list group buy vouchers failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := 20
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > 100 {
			limit = 100
		}
	}
	query := `SELECT v.id, v.deal_id, v.user_id, v.code, v.status, v.expires_at, v.redeemed_at, v.created_at,
	                 d.title, d.deal_price_tzs, d.merchant_id
	          FROM vouchers v JOIN group_buy_deals d ON d.id = v.deal_id
	          WHERE v.deal_id = $1`
	args := []any{deal.ID}
	if params.Status != nil && *params.Status != "" {
		args = append(args, string(*params.Status))
		query += fmt.Sprintf(" AND v.status = $%d", len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY v.created_at, v.id LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list group buy vouchers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	vouchers := make([]gen.Voucher, 0, limit)
	for rows.Next() {
		var row groupbuy.VoucherRow
		if err := rows.Scan(&row.ID, &row.DealID, &row.UserID, &row.Code, &row.Status,
			&row.ExpiresAt, &row.RedeemedAt, &row.CreatedAt,
			&row.DealTitle, &row.DealPriceTZS, &row.MerchantID); err != nil {
			s.logger.Error("scan group buy voucher failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		vouchers = append(vouchers, toGenVoucher(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate group buy vouchers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, vouchers)
}

// GenerateItemBarcode creates a barcode record for a catalogue item
// (POST /products/{itemId}/barcode/generate). The code is a 13-digit
// EAN-shaped string generated server-side; uniqueness is enforced by the
// barcodes.code unique index, so a collision (cryptographically unlikely)
// retries up to three times.
func (s *Server) GenerateItemBarcode(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	var body gen.GenerateItemBarcodeJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Format == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "format is required")
		return
	}
	if s.db == nil {
		s.logger.Error("generate barcode failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var itemMerchantID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM catalogue_items WHERE id = $1`, uuid.UUID(itemId)).Scan(&itemMerchantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "ITEM_NOT_FOUND", "Catalogue item not found")
			return
		}
		s.logger.Error("generate barcode item lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var barcodeID uuid.UUID
	var code string
	for attempt := 0; attempt < 3; attempt++ {
		code = sweepBarcodeCode()
		err := s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO barcodes (merchant_id, code, catalogue_item_id, format)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			itemMerchantID, code, uuid.UUID(itemId), string(body.Format)).Scan(&barcodeID)
		if err == nil {
			break
		}
		if isUniqueViolation(err) {
			continue
		}
		s.logger.Error("generate barcode insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if barcodeID == uuid.Nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not allocate a unique barcode")
		return
	}
	now := time.Now()
	idGen := newUUID(barcodeID.String())
	writeJSON(w, http.StatusCreated, gen.BarcodeInfo{
		Id:              &idGen,
		CatalogueItemId: &itemId,
		Code:            code,
		Format:          gen.BarcodeInfoFormat(body.Format),
		CreatedAt:       &now,
	})
}

// sweepBarcodeCode returns a 13-digit EAN-shaped code built from
// cryptographically random digits.
func sweepBarcodeCode() string {
	var b strings.Builder
	b.Grow(13)
	b.WriteByte('9')
	var buf [2]byte
	for i := 0; i < 12; i++ {
		if i%2 == 0 {
			if _, err := rand.Read(buf[:]); err != nil {
				b.WriteByte('0')
				continue
			}
		}
		b.WriteByte(byte('0' + (int(buf[i%2]) % 10)))
	}
	return b.String()
}

// DeleteItemBarcode removes a barcode from a catalogue item
// (DELETE /products/{itemId}/barcode/{code}). Idempotent: an absent code
// still answers 204.
func (s *Server) DeleteItemBarcode(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID, code string) {
	if s.db == nil {
		s.logger.Error("delete barcode failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM barcodes WHERE catalogue_item_id = $1 AND code = $2`,
		uuid.UUID(itemId), code); err != nil {
		s.logger.Error("delete barcode failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListItemBarcodes returns the barcodes registered for a catalogue item
// (GET /products/{itemId}/barcodes).
func (s *Server) ListItemBarcodes(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("list barcodes failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, code, format, created_at FROM barcodes
		 WHERE catalogue_item_id = $1 ORDER BY created_at`, uuid.UUID(itemId))
	if err != nil {
		s.logger.Error("list barcodes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	barcodes := make([]gen.BarcodeInfo, 0, 4)
	for rows.Next() {
		var (
			id        uuid.UUID
			code      string
			format    string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &code, &format, &createdAt); err != nil {
			s.logger.Error("scan barcode failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		idGen := newUUID(id.String())
		itemIDGen := itemId
		barcodes = append(barcodes, gen.BarcodeInfo{
			Id:              &idGen,
			CatalogueItemId: &itemIDGen,
			Code:            code,
			Format:          gen.BarcodeInfoFormat(format),
			CreatedAt:       &createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate barcodes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, barcodes)
}

// GetCategoryQuestions answers the intake questionnaire for a service
// category (GET /service-categories/{categoryId}/questions). Categories
// carry no per-category question configuration yet, so every category
// answers the same static core questionnaire rather than an invented
// per-category one.
func (s *Server) GetCategoryQuestions(w http.ResponseWriter, r *http.Request, categoryId openapi_types.UUID) {
	questions := []gen.ServiceQuestion{
		{Key: "job_description", Label: "Describe the job", Type: gen.ServiceQuestionTypeText, Required: boolPtr(true)},
		{Key: "photos", Label: "Add photos of the issue", Type: gen.ServiceQuestionTypePhoto, Required: boolPtr(false)},
		{Key: "preferred_time", Label: "Preferred visit time", Type: gen.ServiceQuestionTypeText, Required: boolPtr(false)},
		{Key: "access_notes", Label: "Access or parking notes", Type: gen.ServiceQuestionTypeText, Required: boolPtr(false)},
	}
	writeJSON(w, http.StatusOK, questions)
}

// boolPtr returns a pointer to b for optional contract fields.
func boolPtr(b bool) *bool { return &b }
