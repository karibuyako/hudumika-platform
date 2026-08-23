package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MthProcessSupplierReturnReal processes a supplier return: it transitions the
// supplier_returns row into the 'processed' state. Merchant-scoped via
// merchantIDForSession; non-owners (or missing rows) get 404. Replaces the
// 501 stub mounted at POST /supplier-returns/{id}/process.
func (s *Server) MthProcessSupplierReturnReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var rowMerchant uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(), `SELECT merchant_id FROM supplier_returns WHERE id=$1`, id).Scan(&rowMerchant)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Supplier return not found")
		return
	}
	if err != nil {
		s.logger.Error("lookup supplier return failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, oerr := s.merchantRowOwned(r.Context(), merchantID, rowMerchant)
	if oerr != nil {
		s.logger.Error("supplier return ownership check failed", "error", oerr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Supplier return not found")
		return
	}
	var status string
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE supplier_returns SET status='processed', updated_at=now() WHERE id=$1 RETURNING status`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Supplier return not found")
		return
	}
	if err != nil {
		s.logger.Error("process supplier return failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": status})
}

// MthRejectSupplierReturnReal rejects a supplier return: it transitions the
// supplier_returns row into the 'rejected' state. Merchant-scoped; non-owners
// or missing rows get 404. Replaces the 501 stub mounted at
// POST /supplier-returns/{id}/reject.
func (s *Server) MthRejectSupplierReturnReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var rowMerchant uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(), `SELECT merchant_id FROM supplier_returns WHERE id=$1`, id).Scan(&rowMerchant)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Supplier return not found")
		return
	}
	if err != nil {
		s.logger.Error("lookup supplier return failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, oerr := s.merchantRowOwned(r.Context(), merchantID, rowMerchant)
	if oerr != nil {
		s.logger.Error("supplier return ownership check failed", "error", oerr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Supplier return not found")
		return
	}
	var status string
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE supplier_returns SET status='rejected', updated_at=now() WHERE id=$1 RETURNING status`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Supplier return not found")
		return
	}
	if err != nil {
		s.logger.Error("reject supplier return failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": status})
}

// MthCompleteTaskReal marks a task as completed. Merchant-scoped via
// merchantIDForSession (tasks.owner_user_id references users, so the ownership
// check resolves the legacy users->merchants mapping). Non-owners or missing
// rows get 404. Replaces the 501 stub mounted at POST /tasks/{id}/complete.
func (s *Server) MthCompleteTaskReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var ownerID uuid.UUID
	err = s.db.Pool().QueryRow(r.Context(), `SELECT owner_user_id FROM tasks WHERE id=$1`, id).Scan(&ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		s.logger.Error("lookup task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, oerr := s.merchantRowOwned(r.Context(), merchantID, ownerID)
	if oerr != nil {
		s.logger.Error("task ownership check failed", "error", oerr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	var status string
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE tasks SET status='completed', updated_at=now() WHERE id=$1 RETURNING status`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		s.logger.Error("complete task failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": status})
}

// MthTableQrReal generates a QR payload for a dine-in table and persists a
// store_qr_codes row (idempotently — re-requesting the same table returns the
// existing code). Merchant-scoped via merchantIDForSession. Returns 200 with
// {qrData, tableId}. Replaces the 501 stub mounted at POST /tables/{id}/qr.
func (s *Server) MthTableQrReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tableID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var rowMerchant uuid.UUID
	var label string
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id, label FROM dine_in_tables WHERE id=$1`, tableID).Scan(&rowMerchant, &label)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Table not found")
		return
	}
	if err != nil {
		s.logger.Error("lookup dine-in table failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, oerr := s.merchantRowOwned(r.Context(), merchantID, rowMerchant)
	if oerr != nil {
		s.logger.Error("table ownership check failed", "error", oerr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Table not found")
		return
	}

	code := "TBL-" + strings.ReplaceAll(tableID.String(), "-", "")
	payload, mErr := json.Marshal(map[string]any{
		"type":       "dine_in_table",
		"tableId":    tableID.String(),
		"merchantId": rowMerchant.String(),
		"code":       code,
	})
	if mErr != nil {
		s.logger.Error("marshal qr payload failed", "error", mErr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	qrData := string(payload)

	// Idempotent: reuse an existing store_qr_codes row for this table.
	var existingCode string
	eErr := s.db.Pool().QueryRow(r.Context(),
		`SELECT code FROM store_qr_codes WHERE code=$1`, code).Scan(&existingCode)
	if errors.Is(eErr, pgx.ErrNoRows) {
		_, iErr := s.db.Pool().Exec(r.Context(),
			`INSERT INTO store_qr_codes (merchant_id, label, code, active)
			 VALUES ($1,$2,$3,true)`, rowMerchant, "Dine-in Table "+label, code)
		if iErr != nil {
			s.logger.Error("insert store qr code failed", "error", iErr)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	} else if eErr != nil {
		s.logger.Error("lookup store qr code failed", "error", eErr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"qrData": qrData, "tableId": tableID.String()})
}
