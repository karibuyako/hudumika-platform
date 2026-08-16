package api

// STAFF-OPS and DEVICES bounded contexts (backend/DATA-MODEL.md §merchant
// staff and devices; backend/ERROR-CODES.md §staff operations): device
// registration, shift scheduling, attendance clock-in/out, staff performance
// and commission rules. Every handler is merchant-gated — the merchant id is
// the authenticated merchant's users row id (same milestone simplification
// as the catalogues context).
//
// Enum mapping: the API contract enums are a superset of the storage enums.
// devices.type normalizes on write (kitchen_display→kiosk,
// cashier_terminal→pos) and maps back on read (kiosk→kitchen_display).
// devices.status normalizes error/pairing→offline on write; the
// storage-only disabled value reads back as offline because the contract
// has no disabled value. staff_shifts.status maps ended→completed 1:1.
// commission_rules.applies_to maps 1:1 onto the contract rule type
// (delivery→per_order, dine_in→per_service, takeaway→per_revenue) so both
// enums round-trip losslessly.

import (
	"context"
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

// staffOpsMerchantID resolves the authenticated session to the staff-ops
// merchant id: only merchant-role sessions pass (403 otherwise), and the
// merchant id is the caller's users row id (see package comment).
func (s *Server) staffOpsMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage staff operations")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("staff ops merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("staff ops merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// validDeviceType accepts both the contract enum (printer, pos,
// kitchen_display, cashier_terminal) and the storage enum (printer, pos,
// tablet, kiosk).
func validDeviceType(t gen.MerchantDeviceType) bool {
	switch t {
	case "printer", "pos", "tablet", "kiosk", "kitchen_display", "cashier_terminal":
		return true
	}
	return false
}

// deviceTypeToStorage maps the contract device type onto the devices table
// enum; kitchen_display and cashier_terminal have no storage value and
// normalize to kiosk and pos respectively.
func deviceTypeToStorage(t gen.MerchantDeviceType) string {
	switch t {
	case "kitchen_display":
		return "kiosk"
	case "cashier_terminal":
		return "pos"
	default:
		return string(t)
	}
}

// deviceTypeFromStorage maps the storage enum back onto the contract enum;
// the storage-only tablet value is passed through.
func deviceTypeFromStorage(t string) gen.MerchantDeviceType {
	switch t {
	case "kiosk":
		return "kitchen_display"
	default:
		return gen.MerchantDeviceType(t)
	}
}

// deviceStatusToStorage normalizes the contract status onto the storage
// enum: the transient error/pairing states become offline.
func deviceStatusToStorage(st *gen.MerchantDeviceStatus) string {
	if st == nil {
		return "offline"
	}
	switch *st {
	case "online", "offline":
		return string(*st)
	default:
		return "offline"
	}
}

// deviceStatusFromStorage maps the storage enum onto the contract enum; the
// storage-only disabled value reads back as offline.
func deviceStatusFromStorage(st string) gen.MerchantDeviceStatus {
	switch st {
	case "online", "offline":
		return gen.MerchantDeviceStatus(st)
	default:
		return "offline"
	}
}

// deviceRow is a devices row projection (contract label is stored as name).
type deviceRow struct {
	id      uuid.UUID
	typeVal string
	name    string
	status  string
}

const deviceColumns = `id, type, name, status`

// loadDevice reads one device row by id.
func (s *Server) loadDevice(ctx context.Context, id uuid.UUID) (*deviceRow, error) {
	var d deviceRow
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT `+deviceColumns+` FROM devices WHERE id = $1`, id).
		Scan(&d.id, &d.typeVal, &d.name, &d.status); err != nil {
		return nil, fmt.Errorf("load device: %w", err)
	}
	return &d, nil
}

// toMerchantDevice maps a devices row onto the contract MerchantDevice.
func toMerchantDevice(d deviceRow) gen.MerchantDevice {
	id := newUUID(d.id.String())
	status := deviceStatusFromStorage(d.status)
	return gen.MerchantDevice{
		Id:     &id,
		Label:  d.name,
		Type:   deviceTypeFromStorage(d.typeVal),
		Status: &status,
	}
}

// ListMerchantDevices returns the merchant's registered devices (GET
// /devices). The response is always an array — empty when none are
// registered.
func (s *Server) ListMerchantDevices(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+deviceColumns+` FROM devices WHERE merchant_id = $1 ORDER BY created_at, id`, merchantID)
	if err != nil {
		s.logger.Error("list devices failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.MerchantDevice, 0, 8)
	for rows.Next() {
		var d deviceRow
		if err := rows.Scan(&d.id, &d.typeVal, &d.name, &d.status); err != nil {
			s.logger.Error("scan device failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toMerchantDevice(d))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate devices failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RegisterMerchantDevice registers one device for the merchant (POST
// /devices).
func (s *Server) RegisterMerchantDevice(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.RegisterMerchantDeviceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Label) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "label must not be empty")
		return
	}
	if !validDeviceType(body.Type) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be printer, pos, kitchen_display, cashier_terminal, tablet or kiosk")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO devices (merchant_id, type, name, status) VALUES ($1, $2, $3, $4) RETURNING id`,
		merchantID, deviceTypeToStorage(body.Type), strings.TrimSpace(body.Label),
		deviceStatusToStorage(body.Status)).Scan(&id); err != nil {
		s.logger.Error("register device failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	d, err := s.loadDevice(r.Context(), id)
	if err != nil {
		s.logger.Error("reload device failed", "device", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toMerchantDevice(*d))
}

// UpdateMerchantDevice patches one device (PATCH /devices/{deviceId}); the
// label is only applied when non-empty and the type only when non-blank.
// Unknown or foreign ids surface DEVICE_NOT_FOUND.
func (s *Server) UpdateMerchantDevice(w http.ResponseWriter, r *http.Request, deviceId openapi_types.UUID) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateMerchantDeviceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Type != "" && !validDeviceType(body.Type) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be printer, pos, kitchen_display, cashier_terminal, tablet or kiosk")
		return
	}
	sets := []string{"updated_at = now()"}
	args := make([]any, 0, 4)
	if name := strings.TrimSpace(body.Label); name != "" {
		args = append(args, name)
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if body.Type != "" {
		args = append(args, deviceTypeToStorage(body.Type))
		sets = append(sets, fmt.Sprintf("type = $%d", len(args)))
	}
	if body.Status != nil {
		args = append(args, deviceStatusToStorage(body.Status))
		sets = append(sets, fmt.Sprintf("status = $%d", len(args)))
	}
	args = append(args, deviceId, merchantID)
	query := fmt.Sprintf(`UPDATE devices SET %s WHERE id = $%d AND merchant_id = $%d`,
		strings.Join(sets, ", "), len(args)-1, len(args))

	tag, err := s.db.Pool().Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update device failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND", "Device not found")
		return
	}
	d, err := s.loadDevice(r.Context(), uuid.MustParse(deviceId.String()))
	if err != nil {
		s.logger.Error("reload device failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toMerchantDevice(*d))
}

// DeleteMerchantDevice unregisters one device (DELETE /devices/{deviceId});
// unknown or foreign ids surface DEVICE_NOT_FOUND.
func (s *Server) DeleteMerchantDevice(w http.ResponseWriter, r *http.Request, deviceId openapi_types.UUID) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM devices WHERE id = $1 AND merchant_id = $2`, deviceId, merchantID)
	if err != nil {
		s.logger.Error("delete device failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND", "Device not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// staffShiftRow is a staff_shifts row projection joined with the staff role.
type staffShiftRow struct {
	id       uuid.UUID
	staffID  uuid.UUID
	startAt  time.Time
	endAt    time.Time
	status   string
	roleName string
}

// staffShiftColumns is the shared SELECT list for staff shifts.
const staffShiftColumns = `ss.id, ss.staff_id, ss.start_at, ss.end_at, ss.status, ms.role`

// validShiftStatus accepts the contract shift status enum.
func validShiftStatus(st gen.StaffShiftStatus) bool {
	switch st {
	case "scheduled", "active", "completed", "cancelled":
		return true
	}
	return false
}

// shiftStatusToStorage maps the contract status onto the storage enum
// (completed→ended).
func shiftStatusToStorage(st gen.StaffShiftStatus) string {
	if st == "completed" {
		return "ended"
	}
	return string(st)
}

// shiftStatusFromStorage maps the storage enum onto the contract enum
// (ended→completed).
func shiftStatusFromStorage(st string) gen.StaffShiftStatus {
	if st == "ended" {
		return "completed"
	}
	return gen.StaffShiftStatus(st)
}

// toStaffShift maps a shift row onto the contract StaffShift.
func toStaffShift(row staffShiftRow) gen.StaffShift {
	id := newUUID(row.id.String())
	status := shiftStatusFromStorage(row.status)
	role := gen.MerchantStaffRole(row.roleName)
	return gen.StaffShift{
		Id:      &id,
		StaffId: newUUID(row.staffID.String()),
		Role:    &role,
		StartAt: row.startAt,
		EndAt:   row.endAt,
		Status:  &status,
	}
}

// loadStaffShift loads one shift of the merchant by id.
func (s *Server) loadStaffShift(ctx context.Context, merchantID, shiftID uuid.UUID) (*gen.StaffShift, error) {
	var row staffShiftRow
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT `+staffShiftColumns+`
		 FROM staff_shifts ss JOIN merchant_staff ms ON ms.id = ss.staff_id
		 WHERE ss.id = $1 AND ss.merchant_id = $2`, shiftID, merchantID).
		Scan(&row.id, &row.staffID, &row.startAt, &row.endAt, &row.status, &row.roleName); err != nil {
		return nil, fmt.Errorf("load staff shift: %w", err)
	}
	out := toStaffShift(row)
	return &out, nil
}

// shiftOverlaps reports whether a non-cancelled shift of the same staff
// overlaps [startAt, endAt). Only rows of the merchant are considered; when
// excludeID is non-nil the shift itself is skipped (update semantics). It
// is one query per the staff-ops spec.
func (s *Server) shiftOverlaps(ctx context.Context, merchantID uuid.UUID, staffID uuid.UUID, startAt, endAt time.Time, excludeID *uuid.UUID) (bool, error) {
	query := `SELECT id FROM staff_shifts
		WHERE merchant_id = $1 AND staff_id = $2 AND status != 'cancelled'
		  AND start_at < $4 AND end_at > $3`
	args := []any{merchantID, staffID, startAt, endAt}
	if excludeID != nil {
		query += ` AND id != $5`
		args = append(args, *excludeID)
	}
	query += ` LIMIT 1`
	var clash uuid.UUID
	err := s.db.Pool().QueryRow(ctx, query, args...).Scan(&clash)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("shift overlap check: %w", err)
	}
	return true, nil
}

// shiftStaffBelongs checks that the staff row exists for the merchant.
func (s *Server) shiftStaffBelongs(ctx context.Context, merchantID uuid.UUID, staffID uuid.UUID) (bool, error) {
	var exists bool
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM merchant_staff WHERE id = $1 AND merchant_id = $2)`,
		staffID, merchantID).Scan(&exists); err != nil {
		return false, fmt.Errorf("staff existence check: %w", err)
	}
	return exists, nil
}

// ListStaffShifts returns the merchant's shift schedule within the required
// [from, to] day window (GET /staff/shifts). The window is start_at-based
// and inclusive of the `to` day.
func (s *Server) ListStaffShifts(w http.ResponseWriter, r *http.Request, params gen.ListStaffShiftsParams) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	from := params.From.Time
	toExclusive := params.To.Time.Add(24 * time.Hour)
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+staffShiftColumns+`
		 FROM staff_shifts ss JOIN merchant_staff ms ON ms.id = ss.staff_id
		 WHERE ss.merchant_id = $1 AND ss.start_at >= $2 AND ss.start_at < $3
		 ORDER BY ss.start_at, ss.id`, merchantID, from, toExclusive)
	if err != nil {
		s.logger.Error("list staff shifts failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.StaffShift, 0, 8)
	for rows.Next() {
		var row staffShiftRow
		if err := rows.Scan(&row.id, &row.staffID, &row.startAt, &row.endAt, &row.status, &row.roleName); err != nil {
			s.logger.Error("scan staff shift failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toStaffShift(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate staff shifts failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateStaffShift schedules a shift (POST /staff/shifts). A start in the
// past is SHIFT_IN_PAST; a clash with another non-cancelled shift of the
// same staff is SHIFT_OVERLAP; an unknown staff is STAFF_NOT_FOUND.
func (s *Server) CreateStaffShift(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateStaffShiftJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.StartAt.Before(time.Now()) {
		writeError(w, http.StatusUnprocessableEntity, "SHIFT_IN_PAST", "Shift cannot start in the past")
		return
	}
	if !body.EndAt.After(body.StartAt) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "endAt must be after startAt")
		return
	}
	status := "scheduled"
	if body.Status != nil {
		if !validShiftStatus(*body.Status) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be scheduled, active, completed or cancelled")
			return
		}
		status = shiftStatusToStorage(*body.Status)
	}

	ctx := r.Context()
	exists, err := s.shiftStaffBelongs(ctx, merchantID, body.StaffId)
	if err != nil {
		s.logger.Error("create shift staff check failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "STAFF_NOT_FOUND", "Staff not found")
		return
	}
	overlap, err := s.shiftOverlaps(ctx, merchantID, body.StaffId, body.StartAt, body.EndAt, nil)
	if err != nil {
		s.logger.Error("create shift overlap check failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if overlap {
		writeError(w, http.StatusConflict, "SHIFT_OVERLAP", "Shift overlaps an existing shift for this staff")
		return
	}

	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO staff_shifts (merchant_id, staff_id, start_at, end_at, status)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		merchantID, body.StaffId, body.StartAt, body.EndAt, status).Scan(&id); err != nil {
		s.logger.Error("create staff shift failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	shift, err := s.loadStaffShift(ctx, merchantID, id)
	if err != nil {
		s.logger.Error("reload staff shift failed", "shift", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, shift)
}

// UpdateStaffShift rewrites one shift (PATCH /staff/shifts/{shiftId}). The
// same SHIFT_IN_PAST / SHIFT_OVERLAP / STAFF_NOT_FOUND rules as create
// apply; unknown or foreign ids surface SHIFT_NOT_FOUND.
func (s *Server) UpdateStaffShift(w http.ResponseWriter, r *http.Request, shiftId openapi_types.UUID) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateStaffShiftJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.StartAt.Before(time.Now()) {
		writeError(w, http.StatusUnprocessableEntity, "SHIFT_IN_PAST", "Shift cannot start in the past")
		return
	}
	if !body.EndAt.After(body.StartAt) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "endAt must be after startAt")
		return
	}
	status := "scheduled"
	if body.Status != nil {
		if !validShiftStatus(*body.Status) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be scheduled, active, completed or cancelled")
			return
		}
		status = shiftStatusToStorage(*body.Status)
	}

	ctx := r.Context()
	id, err := uuid.Parse(shiftId.String())
	if err != nil {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}
	exists, err := s.shiftStaffBelongs(ctx, merchantID, body.StaffId)
	if err != nil {
		s.logger.Error("update shift staff check failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "STAFF_NOT_FOUND", "Staff not found")
		return
	}
	overlap, err := s.shiftOverlaps(ctx, merchantID, body.StaffId, body.StartAt, body.EndAt, &id)
	if err != nil {
		s.logger.Error("update shift overlap check failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if overlap {
		writeError(w, http.StatusConflict, "SHIFT_OVERLAP", "Shift overlaps an existing shift for this staff")
		return
	}

	tag, err := s.db.Pool().Exec(ctx,
		`UPDATE staff_shifts SET staff_id = $2, start_at = $3, end_at = $4, status = $5
		 WHERE id = $1 AND merchant_id = $6`,
		shiftId, body.StaffId, body.StartAt, body.EndAt, status, merchantID)
	if err != nil {
		s.logger.Error("update staff shift failed", "shift", shiftId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}
	shift, err := s.loadStaffShift(ctx, merchantID, id)
	if err != nil {
		s.logger.Error("reload staff shift failed", "shift", shiftId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, shift)
}

// DeleteStaffShift deletes one shift (DELETE /staff/shifts/{shiftId});
// unknown or foreign ids surface SHIFT_NOT_FOUND.
func (s *Server) DeleteStaffShift(w http.ResponseWriter, r *http.Request, shiftId openapi_types.UUID) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM staff_shifts WHERE id = $1 AND merchant_id = $2`, shiftId, merchantID)
	if err != nil {
		s.logger.Error("delete staff shift failed", "shift", shiftId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// attendanceRow is an attendance row projection.
type attendanceRow struct {
	id           uuid.UUID
	staffID      uuid.UUID
	shiftID      *uuid.UUID
	clockedInAt  time.Time
	clockedOutAt *time.Time
}

const attendanceColumns = `id, staff_id, shift_id, clocked_in_at, clocked_out_at`

// toAttendanceRecord maps an attendance row onto the contract
// AttendanceRecord; durationMinutes is only set for closed records.
func toAttendanceRecord(row attendanceRow) gen.AttendanceRecord {
	out := gen.AttendanceRecord{
		Id:          newUUID(row.id.String()),
		StaffId:     newUUID(row.staffID.String()),
		ClockedInAt: row.clockedInAt,
	}
	if row.shiftID != nil {
		id := newUUID(row.shiftID.String())
		out.ShiftId = &id
	}
	if row.clockedOutAt != nil {
		out.ClockedOutAt = row.clockedOutAt
		mins := int(row.clockedOutAt.Sub(row.clockedInAt).Minutes())
		out.DurationMinutes = &mins
	}
	return out
}

// staffForSession resolves the merchant_staff row whose phone matches the
// authenticated session subject — the staff self-service identity for
// clock-in/out (the merchant gate already restricted the caller to merchant
// role; the staff phone is the session phone within the merchant).
func (s *Server) staffForSession(ctx context.Context, merchantID uuid.UUID, phone string) (*uuid.UUID, error) {
	var id uuid.UUID
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id FROM merchant_staff WHERE merchant_id = $1 AND phone = $2 AND active`,
		merchantID, phone).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("staff for session: %w", err)
	}
	return &id, nil
}

// activeShiftForStaff finds the staff's currently in-flight active shift, if
// any, to attach a clock-in to.
func (s *Server) activeShiftForStaff(ctx context.Context, merchantID, staffID uuid.UUID, at time.Time) (*uuid.UUID, error) {
	var id uuid.UUID
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id FROM staff_shifts
		 WHERE merchant_id = $1 AND staff_id = $2 AND status = 'active'
		   AND start_at <= $3 AND end_at > $3 ORDER BY start_at LIMIT 1`,
		merchantID, staffID, at).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("active shift for staff: %w", err)
	}
	return &id, nil
}

// ClockIn opens an attendance record for the calling staff (POST
// /staff/attendance/clock-in). The partial unique index on open records is
// the single-winner guarantee: a concurrent or repeated clock-in maps to
// ATTENDANCE_ALREADY_CLOCKED_IN.
func (s *Server) ClockIn(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	claims, _ := ClaimsFromContext(r.Context())
	staffID, err := s.staffForSession(r.Context(), merchantID, claims.Subject)
	if err != nil {
		s.logger.Error("clock-in staff lookup failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if staffID == nil {
		writeError(w, http.StatusNotFound, "STAFF_NOT_FOUND", "No staff account matches this session")
		return
	}

	ctx := r.Context()
	now := time.Now()
	shiftID, err := s.activeShiftForStaff(ctx, merchantID, *staffID, now)
	if err != nil {
		s.logger.Error("clock-in active shift lookup failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var rec attendanceRow
	err = s.db.Pool().QueryRow(ctx, `INSERT INTO attendance
		(merchant_id, staff_id, shift_id, clocked_in_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (staff_id) WHERE clocked_out_at IS NULL DO NOTHING
		RETURNING `+attendanceColumns,
		merchantID, *staffID, shiftID, now).
		Scan(&rec.id, &rec.staffID, &rec.shiftID, &rec.clockedInAt, &rec.clockedOutAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "ATTENDANCE_ALREADY_CLOCKED_IN", "Staff is already clocked in")
		return
	}
	if err != nil {
		s.logger.Error("clock-in failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toAttendanceRecord(rec))
}

// ClockOut closes the staff's open attendance record (POST
// /staff/attendance/clock-out); a missing open record surfaces
// ATTENDANCE_NOT_CLOCKED_IN.
func (s *Server) ClockOut(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	claims, _ := ClaimsFromContext(r.Context())
	staffID, err := s.staffForSession(r.Context(), merchantID, claims.Subject)
	if err != nil {
		s.logger.Error("clock-out staff lookup failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if staffID == nil {
		writeError(w, http.StatusNotFound, "STAFF_NOT_FOUND", "No staff account matches this session")
		return
	}

	var rec attendanceRow
	err = s.db.Pool().QueryRow(r.Context(), `UPDATE attendance
		SET clocked_out_at = now()
		WHERE merchant_id = $1 AND staff_id = $2 AND clocked_out_at IS NULL
		RETURNING `+attendanceColumns,
		merchantID, *staffID).
		Scan(&rec.id, &rec.staffID, &rec.shiftID, &rec.clockedInAt, &rec.clockedOutAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "ATTENDANCE_NOT_CLOCKED_IN", "Staff is not clocked in")
		return
	}
	if err != nil {
		s.logger.Error("clock-out failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toAttendanceRecord(rec))
}

// ListAttendance returns the merchant's attendance records (GET
// /staff/attendance) with optional staffId / from / to filters, newest
// first. Pagination is a documented extension via the limit (default 20,
// max 100) and offset query parameters; the contract response stays a plain
// array.
func (s *Server) ListAttendance(w http.ResponseWriter, r *http.Request, params gen.ListAttendanceParams) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	query := `SELECT ` + attendanceColumns + ` FROM attendance WHERE merchant_id = $1`
	args := []any{merchantID}
	argi := 2
	if params.StaffId != nil {
		query += fmt.Sprintf(` AND staff_id = $%d`, argi)
		args = append(args, *params.StaffId)
		argi++
	}
	if params.From != nil {
		query += fmt.Sprintf(` AND clocked_in_at >= $%d`, argi)
		args = append(args, (*params.From).Time)
		argi++
	}
	if params.To != nil {
		query += fmt.Sprintf(` AND clocked_in_at < $%d`, argi)
		args = append(args, (*params.To).Time.Add(24*time.Hour))
		argi++
	}

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	query += fmt.Sprintf(` ORDER BY clocked_in_at DESC, id LIMIT $%d OFFSET $%d`, argi, argi+1)
	args = append(args, limit, offset)

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list attendance failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.AttendanceRecord, 0, limit)
	for rows.Next() {
		var rec attendanceRow
		if err := rows.Scan(&rec.id, &rec.staffID, &rec.shiftID, &rec.clockedInAt, &rec.clockedOutAt); err != nil {
			s.logger.Error("scan attendance failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toAttendanceRecord(rec))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate attendance failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// performanceRow is one aggregated merchant_staff row: scheduled shift
// hours, attendance hours and the completed attendance count, all within the
// optional [from, to] day window.
type performanceRow struct {
	staffID        uuid.UUID
	name           string
	shiftSecs      float64
	attendanceSecs float64
}

// GetStaffPerformance returns per-staff aggregates over the optional range
// (GET /staff/performance). Honest mapping onto the contract schema: this
// context tracks shifts and attendance only, so ordersProcessed,
// cancellations, ratingAverage and commissionTZS are honest zeros/absent,
// and attendanceRate is the share of scheduled shift time covered by
// attendance (SUM(clocked_out_at - clocked_in_at) vs scheduled shift
// duration, capped at 100). The aggregate is one query.
func (s *Server) GetStaffPerformance(w http.ResponseWriter, r *http.Request, params gen.GetStaffPerformanceParams) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var from, toExclusive *time.Time
	if params.From != nil {
		f := (*params.From).Time
		from = &f
	}
	if params.To != nil {
		t := (*params.To).Time.Add(24 * time.Hour)
		toExclusive = &t
	}

	rows, err := s.db.Pool().Query(r.Context(), `
		SELECT ms.id, ms.name,
			(SELECT COALESCE(sum(EXTRACT(EPOCH FROM (ss.end_at - ss.start_at)))::float8, 0)
			  FROM staff_shifts ss
			  WHERE ss.staff_id = ms.id AND ss.merchant_id = ms.merchant_id
			    AND ss.status != 'cancelled'
			    AND ($2::timestamptz IS NULL OR ss.start_at >= $2)
			    AND ($3::timestamptz IS NULL OR ss.start_at < $3)) AS shift_secs,
			(SELECT COALESCE(sum(EXTRACT(EPOCH FROM (a.clocked_out_at - a.clocked_in_at)))::float8, 0)
			  FROM attendance a
			  WHERE a.staff_id = ms.id AND a.merchant_id = ms.merchant_id
			    AND a.clocked_out_at IS NOT NULL
			    AND ($2::timestamptz IS NULL OR a.clocked_in_at >= $2)
			    AND ($3::timestamptz IS NULL OR a.clocked_in_at < $3)) AS attendance_secs
		FROM merchant_staff ms
		WHERE ms.merchant_id = $1
		ORDER BY ms.name, ms.id`, merchantID, from, toExclusive)
	if err != nil {
		s.logger.Error("staff performance aggregate failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.StaffPerformance, 0, 8)
	for rows.Next() {
		var p performanceRow
		if err := rows.Scan(&p.staffID, &p.name, &p.shiftSecs, &p.attendanceSecs); err != nil {
			s.logger.Error("scan staff performance failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		zero := 0
		rate := float32(0)
		if p.attendanceSecs > 0 && p.shiftSecs > 0 {
			rate = float32(100 * p.attendanceSecs / p.shiftSecs)
			if rate > 100 {
				rate = 100
			}
		}
		out = append(out, gen.StaffPerformance{
			StaffId:         newUUID(p.staffID.String()),
			Name:            p.name,
			OrdersProcessed: &zero,
			Cancellations:   &zero,
			AttendanceRate:  &rate,
			CommissionTZS:   &zero,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate staff performance failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// validCommissionType accepts the contract commission rule type enum.
func validCommissionType(t gen.CommissionRuleType) bool {
	switch t {
	case "per_order", "per_service", "per_revenue":
		return true
	}
	return false
}

// commissionAppliesToToStorage maps the contract rule type onto the storage
// applies_to enum (1:1, see package comment).
func commissionAppliesToToStorage(t gen.CommissionRuleType) string {
	switch t {
	case "per_order":
		return "delivery"
	case "per_service":
		return "dine_in"
	default:
		return "takeaway"
	}
}

// commissionAppliesToFromStorage maps the storage applies_to enum onto the
// contract rule type (1:1).
func commissionAppliesToFromStorage(appliesTo string) gen.CommissionRuleType {
	switch appliesTo {
	case "delivery":
		return "per_order"
	case "dine_in":
		return "per_service"
	default:
		return "per_revenue"
	}
}

// GetCommissionRules returns the merchant's commission rules (GET
// /staff/commissions). The response is always an array — empty when none
// are configured.
func (s *Server) GetCommissionRules(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, rate_bps, applies_to, active FROM commission_rules WHERE merchant_id = $1 ORDER BY created_at, id`,
		merchantID)
	if err != nil {
		s.logger.Error("list commission rules failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.CommissionRule, 0, 8)
	for rows.Next() {
		var (
			id        uuid.UUID
			rateBps   int
			appliesTo string
			active    bool
		)
		if err := rows.Scan(&id, &rateBps, &appliesTo, &active); err != nil {
			s.logger.Error("scan commission rule failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		ruleID := newUUID(id.String())
		out = append(out, gen.CommissionRule{
			Id:      &ruleID,
			RateBps: rateBps,
			Type:    commissionAppliesToFromStorage(appliesTo),
			Active:  &active,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate commission rules failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// PutCommissionRules replaces the merchant's commission rules (PUT
// /staff/commissions): the incoming set is validated (rateBps 0-10000 and a
// known type — the type doubles as the rule name, which is never empty for
// a valid rule) and swapped in atomically. A rule outside the bounds maps
// to COMMISSION_RULE_INVALID.
func (s *Server) PutCommissionRules(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.PutCommissionRulesJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	for _, rule := range body.Rules {
		if rule.RateBps < 0 || rule.RateBps > 10000 || !validCommissionType(rule.Type) {
			writeError(w, http.StatusUnprocessableEntity, "COMMISSION_RULE_INVALID",
				"rateBps must be between 0 and 10000 and type must be per_order, per_service or per_revenue")
			return
		}
	}

	ctx := r.Context()
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("commission rules begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM commission_rules WHERE merchant_id = $1`, merchantID); err != nil {
		s.logger.Error("commission rules replace delete failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for _, rule := range body.Rules {
		active := true
		if rule.Active != nil {
			active = *rule.Active
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO commission_rules (merchant_id, name, rate_bps, applies_to, active)
			 VALUES ($1, $2, $3, $4, $5)`,
			merchantID, string(rule.Type), rule.RateBps, commissionAppliesToToStorage(rule.Type), active); err != nil {
			s.logger.Error("commission rule insert failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("commission rules commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	rows, err := s.db.Pool().Query(ctx,
		`SELECT id, rate_bps, applies_to, active FROM commission_rules WHERE merchant_id = $1 ORDER BY created_at, id`,
		merchantID)
	if err != nil {
		s.logger.Error("reload commission rules failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.CommissionRule, 0, 8)
	for rows.Next() {
		var (
			id        uuid.UUID
			rateBps   int
			appliesTo string
			active    bool
		)
		if err := rows.Scan(&id, &rateBps, &appliesTo, &active); err != nil {
			s.logger.Error("scan commission rule failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		ruleID := newUUID(id.String())
		out = append(out, gen.CommissionRule{
			Id:      &ruleID,
			RateBps: rateBps,
			Type:    commissionAppliesToFromStorage(appliesTo),
			Active:  &active,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate commission rules failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
