package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// printerRow is the canonical DB shape for a printer.
type printerRow struct {
	ID            uuid.UUID
	MerchantID    uuid.UUID
	Name          *string
	Model         *string
	Type          *string
	Status        string
	IP            *string
	Config        []byte
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// printerToMap renders a printer row as a camelCase JSON object.
func printerToMap(p printerRow) map[string]any {
	m := map[string]any{
		"id":         p.ID.String(),
		"merchantId": p.MerchantID.String(),
		"status":     p.Status,
		"createdAt":  p.CreatedAt,
		"updatedAt":  p.UpdatedAt,
	}
	if p.Name != nil {
		m["name"] = *p.Name
	}
	if p.Model != nil {
		m["model"] = *p.Model
	}
	if p.Type != nil {
		m["type"] = *p.Type
	}
	if p.IP != nil {
		m["ip"] = *p.IP
	}
	if len(p.Config) > 0 {
		m["config"] = json.RawMessage(p.Config)
	}
	return m
}

// MthListPrintersReal lists the printers owned by the session merchant.
func (s *Server) MthListPrintersReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}

	query := `SELECT id, merchant_id, name, model, type, status, ip, config, created_at, updated_at FROM printers`
	args := []any{}
	if merchantID != uuid.Nil {
		query += ` WHERE merchant_id = $1`
		args = append(args, merchantID)
	}
	query += ` ORDER BY created_at DESC`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list printers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]map[string]any, 0)
	for rows.Next() {
		var p printerRow
		if err := scanPrinter(rows.Scan, &p); err != nil {
			s.logger.Error("scan printer failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, printerToMap(p))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate printers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthCreatePrinterReal creates a printer for the session merchant. Creation is
// idempotent: a repeated Idempotency-Key replays the original row (200) instead
// of inserting a duplicate (the unique idempotency_key column guards races).
func (s *Server) MthCreatePrinterReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}

	var body struct {
		Name      *string          `json:"name"`
		Model     *string          `json:"model"`
		Type      *string          `json:"type"`
		IP        *string          `json:"ip"`
		Config    json.RawMessage  `json:"config"`
		IdemKey   *string          `json:"idempotencyKey"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == nil || strings.TrimSpace(*body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if body.Type == nil || strings.TrimSpace(*body.Type) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type is required")
		return
	}
	idem := mthIdemKey(r, body.IdemKey)
	if idem == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "idempotencyKey is required")
		return
	}

	// Idempotency replay: return the existing row if the key was used before.
	var existing printerRow
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT id, merchant_id, name, model, type, status, ip, config, created_at, updated_at
		 FROM printers WHERE idempotency_key = $1`, idem).Scan(
		&existing.ID, &existing.MerchantID, &existing.Name, &existing.Model, &existing.Type,
		&existing.Status, &existing.IP, &existing.Config, &existing.CreatedAt, &existing.UpdatedAt)
	if err == nil {
		writeJSON(w, http.StatusOK, printerToMap(existing))
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("printer idempotency lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var p printerRow
	var cfg any
	if len(body.Config) > 0 {
		cfg = string(body.Config)
	}
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO printers (merchant_id, name, model, type, ip, config, idempotency_key)
		 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
		 RETURNING id, merchant_id, name, model, type, status, ip, config, created_at, updated_at`,
		merchantID, body.Name, body.Model, body.Type, body.IP, cfg, idem).Scan(
		&p.ID, &p.MerchantID, &p.Name, &p.Model, &p.Type, &p.Status, &p.IP, &p.Config, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// Race: another request with the same key won. Replay it.
			var race printerRow
			_ = s.db.Pool().QueryRow(r.Context(),
				`SELECT id, merchant_id, name, model, type, status, ip, config, created_at, updated_at
				 FROM printers WHERE idempotency_key = $1`, idem).Scan(
				&race.ID, &race.MerchantID, &race.Name, &race.Model, &race.Type,
				&race.Status, &race.IP, &race.Config, &race.CreatedAt, &race.UpdatedAt)
			writeJSON(w, http.StatusOK, printerToMap(race))
			return
		}
		s.logger.Error("create printer failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, printerToMap(p))
}

// MthGetPrinterReal returns a single printer owned by the session merchant.
func (s *Server) MthGetPrinterReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id must be a valid UUID")
		return
	}

	var p printerRow
	query := `SELECT id, merchant_id, name, model, type, status, ip, config, created_at, updated_at
	           FROM printers WHERE id = $1`
	args := []any{id}
	if merchantID != uuid.Nil {
		query += ` AND merchant_id = $2`
		args = append(args, merchantID)
	}
	err = s.db.Pool().QueryRow(r.Context(), query, args...).Scan(
		&p.ID, &p.MerchantID, &p.Name, &p.Model, &p.Type, &p.Status, &p.IP, &p.Config, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Printer not found")
		return
	}
	if err != nil {
		s.logger.Error("get printer failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, printerToMap(p))
}

// MthUpdatePrinterReal patches name, status and/or config on a printer.
func (s *Server) MthUpdatePrinterReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id must be a valid UUID")
		return
	}

	var body struct {
		Name   *string         `json:"name"`
		Status *string         `json:"status"`
		Config json.RawMessage `json:"config"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	// Resolve current row (merchant-scoped) and build a partial update.
	var cur printerRow
	base := `SELECT id, merchant_id, name, model, type, status, ip, config FROM printers WHERE id = $1`
	bargs := []any{id}
	if merchantID != uuid.Nil {
		base += ` AND merchant_id = $2`
		bargs = append(bargs, merchantID)
	}
	err = s.db.Pool().QueryRow(r.Context(), base, bargs...).Scan(
		&cur.ID, &cur.MerchantID, &cur.Name, &cur.Model, &cur.Type, &cur.Status, &cur.IP, &cur.Config)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Printer not found")
		return
	}
	if err != nil {
		s.logger.Error("resolve printer for update failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	name := cur.Name
	if body.Name != nil {
		v := strings.TrimSpace(*body.Name)
		name = &v
	}
	status := cur.Status
	if body.Status != nil {
		status = strings.TrimSpace(*body.Status)
	}
	config := cur.Config
	if len(body.Config) > 0 {
		config = body.Config
	}

	var p printerRow
	err = s.db.Pool().QueryRow(r.Context(),
		`UPDATE printers SET name = $1, status = $2, config = $3::jsonb, updated_at = now()
		 WHERE id = $4 RETURNING id, merchant_id, name, model, type, status, ip, config, created_at, updated_at`,
		name, status, string(config), id).Scan(
		&p.ID, &p.MerchantID, &p.Name, &p.Model, &p.Type, &p.Status, &p.IP, &p.Config, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		s.logger.Error("update printer failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, printerToMap(p))
}

// MthDeletePrinterReal deletes a printer; 204 on success, 404 if absent.
func (s *Server) MthDeletePrinterReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id must be a valid UUID")
		return
	}

	query := `DELETE FROM printers WHERE id = $1`
	args := []any{id}
	if merchantID != uuid.Nil {
		query += ` AND merchant_id = $2`
		args = append(args, merchantID)
	}
	tag, err := s.db.Pool().Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("delete printer failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Printer not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MthConnectPrinterReal marks a printer as connected.
func (s *Server) MthConnectPrinterReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id must be a valid UUID")
		return
	}

	var p printerRow
	query := `UPDATE printers SET status = 'connected', updated_at = now()
	           WHERE id = $1 RETURNING id, merchant_id, name, model, type, status, ip, config, created_at, updated_at`
	args := []any{id}
	if merchantID != uuid.Nil {
		query = `UPDATE printers SET status = 'connected', updated_at = now()
		         WHERE id = $1 AND merchant_id = $2
		         RETURNING id, merchant_id, name, model, type, status, ip, config, created_at, updated_at`
		args = append(args, merchantID)
	}
	err = s.db.Pool().QueryRow(r.Context(), query, args...).Scan(
		&p.ID, &p.MerchantID, &p.Name, &p.Model, &p.Type, &p.Status, &p.IP, &p.Config, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Printer not found")
		return
	}
	if err != nil {
		s.logger.Error("connect printer failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, printerToMap(p))
}

// MthTestPrinterReal logs a device test for the printer and returns the result.
// The durable record is a device_tests row (mirrors the existing
// /devices/{id}/test contract). device_tests.device_id is a FK to devices(id);
// a printer has no devices row, so on the FK violation the test result is still
// returned (200) without persisting — see report caveats.
func (s *Server) MthTestPrinterReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id must be a valid UUID")
		return
	}

	// Verify ownership before recording a test.
	var exists bool
	check := `SELECT true FROM printers WHERE id = $1`
	cargs := []any{id}
	if merchantID != uuid.Nil {
		check += ` AND merchant_id = $2`
		cargs = append(cargs, merchantID)
	}
	err = s.db.Pool().QueryRow(r.Context(), check, cargs...).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Printer not found")
		return
	}
	if err != nil {
		s.logger.Error("resolve printer for test failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	result := map[string]any{"printerId": id.String(), "status": "passed", "detail": "Printer test dispatched"}
	detail, _ := json.Marshal(result)
	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO device_tests (device_id, status, detail) VALUES ($1, 'passed', $2)`, id, string(detail))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			// No matching devices row for this printer: return the result
			// without persisting the device_tests row.
			s.logger.Warn("printer test not persisted: device_tests requires a devices row", "printerId", id)
			writeJSON(w, http.StatusOK, result)
			return
		}
		s.logger.Error("insert printer test failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// scanPrinter populates a printerRow from a pgx row scanner.
func scanPrinter(scan func(...any) error, p *printerRow) error {
	return scan(&p.ID, &p.MerchantID, &p.Name, &p.Model, &p.Type, &p.Status, &p.IP, &p.Config, &p.CreatedAt, &p.UpdatedAt)
}
