package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MthListDisputeHoldsReal lists the merchant's dispute holds (GET
// /finance/dispute-holds). Merchant-scoped via merchantIDForSession.
func (s *Server) MthListDisputeHoldsReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, created_at, updated_at, merchant_id, dispute_id, amount_tzs, currency, reason, status, released_at, released_by
		 FROM dispute_holds WHERE merchant_id = $1 ORDER BY created_at DESC`, merchantID)
	if err != nil {
		s.logger.Error("list dispute holds failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, mID uuid.UUID
		var disputeID *uuid.UUID
		var amountTzs int64
		var currency string
		var reason *string
		var status string
		var createdAt, updatedAt time.Time
		var releasedAt *time.Time
		var releasedBy *uuid.UUID
		if err := rows.Scan(&id, &createdAt, &updatedAt, &mID, &disputeID, &amountTzs, &currency, &reason, &status, &releasedAt, &releasedBy); err != nil {
			s.logger.Error("scan dispute hold failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		m := map[string]any{
			"id":         id.String(),
			"merchantId": mID.String(),
			"amountTzs":  amountTzs,
			"currency":   currency,
			"status":     status,
			"createdAt":  createdAt,
			"updatedAt":  updatedAt,
		}
		if disputeID != nil {
			m["disputeId"] = disputeID.String()
		}
		if reason != nil {
			m["reason"] = *reason
		}
		if releasedAt != nil {
			m["releasedAt"] = *releasedAt
		}
		if releasedBy != nil {
			m["releasedBy"] = releasedBy.String()
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate dispute holds failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthListInvoicesReal lists the merchant's invoices (GET /invoices).
// Merchant-scoped via merchantIDForSession; returns 200 with an array
// (empty when none).
func (s *Server) MthListInvoicesReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, number, subtotal_tzs, tax_tzs, total_tzs, status, issued_at, paid_at, created_at, updated_at
		 FROM invoices WHERE merchant_id = $1 ORDER BY created_at DESC`, merchantID)
	if err != nil {
		s.logger.Error("list invoices failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, mID uuid.UUID
		var number string
		var subtotalTzs, taxTzs, totalTzs int64
		var status string
		var issuedAt, paidAt, createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &mID, &number, &subtotalTzs, &taxTzs, &totalTzs, &status, &issuedAt, &paidAt, &createdAt, &updatedAt); err != nil {
			s.logger.Error("scan invoice failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, map[string]any{
			"id":          id.String(),
			"merchantId":  mID.String(),
			"number":      number,
			"subtotalTzs": subtotalTzs,
			"taxTzs":      taxTzs,
			"totalTzs":    totalTzs,
			"status":      status,
			"issuedAt":    issuedAt,
			"paidAt":      paidAt,
			"createdAt":   createdAt,
			"updatedAt":   updatedAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate invoices failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// paymentAccountUpdateBody is the shape of PATCH /payment-accounts/{id}.
// Only the merchant-owned account's label and status are updateable here.
type paymentAccountUpdateBody struct {
	Status *string `json:"status"`
	Label  *string `json:"label"`
}

// MthUpdatePaymentAccountReal updates a merchant-owned payment account
// (PATCH /payment-accounts/{id}). The account must belong to the session
// merchant (scoped via merchant_id); otherwise 404. Returns the updated
// account on success or 422 on invalid input.
func (s *Server) MthUpdatePaymentAccountReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	idParam := chi.URLParam(r, "id")
	accountID, err := uuid.Parse(idParam)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id must be a valid UUID")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body paymentAccountUpdateBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	status := ""
	if body.Status != nil {
		status = strings.TrimSpace(*body.Status)
	}
	label := ""
	if body.Label != nil {
		label = strings.TrimSpace(*body.Label)
	}
	if status == "" && label == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one of status or label is required")
		return
	}
	cols := make([]string, 0, 2)
	args := make([]any, 0, 4)
	idx := 1
	if status != "" {
		cols = append(cols, "status = $"+strconv.Itoa(idx))
		args = append(args, status)
		idx++
	}
	if label != "" {
		cols = append(cols, "label = $"+strconv.Itoa(idx))
		args = append(args, label)
		idx++
	}
	cols = append(cols, "updated_at = now()")
	args = append(args, accountID, merchantID)

	var (
		outID, outMID                       uuid.UUID
		outLabel, outType, outAccountNumber string
		outStatus                           string
		outDefault, outVerified             bool
		outCreatedAt, outUpdatedAt          time.Time
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE payment_accounts SET `+strings.Join(cols, ", ")+
			` WHERE id = $`+strconv.Itoa(idx)+` AND merchant_id = $`+strconv.Itoa(idx+1)+
			` RETURNING id, merchant_id, label, type, account_number, status, is_default, verified, created_at, updated_at`,
		args...,
	).Scan(&outID, &outMID, &outLabel, &outType, &outAccountNumber, &outStatus, &outDefault, &outVerified, &outCreatedAt, &outUpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "payment account not found")
			return
		}
		s.logger.Error("update payment account failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":            outID.String(),
		"merchantId":    outMID.String(),
		"label":         outLabel,
		"type":          outType,
		"accountNumber": outAccountNumber,
		"status":        outStatus,
		"isDefault":     outDefault,
		"verified":      outVerified,
		"createdAt":     outCreatedAt,
		"updatedAt":     outUpdatedAt,
	})
}
