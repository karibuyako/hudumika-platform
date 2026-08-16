package api

// RIDER-OPS bounded context (backend/DATA-MODEL.md §riders; ERROR-CODES.md
// §Dispatch and delivery exceptions): rider shift scheduling with
// clock-in/out and COD cash collection, in-shift breaks, shift swap requests,
// the rider's active trip bundle and trip sharing. Every handler is
// rider-gated: the riders row is resolved via GetByOwner(subject user id)
// and a missing row is 404.
//
// Deviations, documented honestly:
//   - The generated ServerInterface has no POST /riders/me/shifts route, so
//     shift creation lives in the unexported createRiderShift handler (the
//     same pattern AdvanceMyOrder uses for contract-less endpoints). It is
//     exercised through a RequireAuth-wrapped test handler and is the path
//     dispatch-style scheduling would call internally.
//   - rider_shifts.status is the storage enum (scheduled, active, ended,
//     cancelled, swapped); ended reads back as the contract "completed" and
//     swapped as "cancelled" (the swapped shift is no longer worked).
//     swappable / swap_requested_at / swap_reason are storage-only: the
//     contract RiderShift schema has no such fields.
//   - The contract POST /riders/me/trips/{orderId}/share sends phone
//     recipients with expiresInHours (default 24), not a rider id; the brief
//     draft's 15-minute expiry predates the contract and the contract wins.
//     One trip_shares row is inserted per recipient (shared_with_rider_id is
//     filled when the phone maps to a rider row, else NULL) and the row id
//     doubles as the share token.
//   - The contract has no share accept/decline surface, so TRIP_SHARE_EXPIRED
//     is unreachable until one lands; rows simply stay pending and expire.
//   - A "trip" is the rider's current bundle of in-flight orders (status
//     rider_assigned/picked_up/delivering); the trip id is the oldest order
//     in the bundle. Reorder validates the request against the bundle and
//     echoes the reordered stop sequence without persisting (no trip table).
//   - ListRiderShifts pagination (limit default 20 / offset) is a documented
//     extension on top of the contract scope filter, mirroring
//     ListAttendance.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/riders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// rider-shift storage statuses.
const (
	riderShiftStatusScheduled = "scheduled"
	riderShiftStatusActive    = "active"
	riderShiftStatusEnded     = "ended"
	riderShiftStatusCancelled = "cancelled"
	riderShiftStatusSwapped   = "swapped"
)

// riderTripStatuses is the order window that forms the rider's current trip
// bundle (a "trip" is the active assigned bundle; delivered orders are not
// part of it).
var riderTripStatuses = []string{"rider_assigned", "picked_up", "delivering"}

// riderOpsRider resolves the caller's riders row (GET /riders/me gate). The
// database is checked first: with no database wired (dev, unit tests) the
// request is an operational failure — 500 INTERNAL_ERROR — never NOT_FOUND.
func (s *Server) riderOpsRider(w http.ResponseWriter, r *http.Request) (*riders.Rider, bool) {
	if s.db == nil {
		s.logger.Error("rider ops failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, false
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("rider ops user lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return nil, false
	}
	rider, err := riders.NewStore(s.db.Pool()).GetByOwner(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("rider ops rider lookup failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, false
	}
	if rider == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No rider profile for this account")
		return nil, false
	}
	return rider, true
}

// riderShiftRow is one rider_shifts row projection.
type riderShiftRow struct {
	id              uuid.UUID
	riderID         uuid.UUID
	startAt         time.Time
	endAt           time.Time
	status          string
	swappable       bool
	swapRequestedAt *time.Time
	swapReason      *string
	clockedInAt     *time.Time
	clockedOutAt    *time.Time
	collectedCash   int64
}

const riderShiftColumns = `id, rider_id, start_at, end_at, status, swappable, swap_requested_at, swap_reason, clocked_in_at, clocked_out_at, collected_cash_tzs`

func scanRiderShift(row *riderShiftRow, s interface{ Scan(...any) error }) error {
	return s.Scan(&row.id, &row.riderID, &row.startAt, &row.endAt, &row.status,
		&row.swappable, &row.swapRequestedAt, &row.swapReason,
		&row.clockedInAt, &row.clockedOutAt, &row.collectedCash)
}

// riderShiftStatusFromStorage maps the storage enum onto the contract enum
// (ended→completed, swapped→cancelled).
func riderShiftStatusFromStorage(st string) gen.RiderShiftStatus {
	switch st {
	case riderShiftStatusEnded:
		return gen.RiderShiftStatusCompleted
	case riderShiftStatusSwapped:
		return gen.RiderShiftStatusCancelled
	default:
		return gen.RiderShiftStatus(st)
	}
}

// toRiderShift maps a shift row onto the contract RiderShift. swappable and
// the swap fields have no contract representation; cashReconciled reads as
// false (the storage row only tracks collected_cash_tzs).
func toRiderShift(row riderShiftRow) gen.RiderShift {
	id := newUUID(row.id.String())
	riderID := newUUID(row.riderID.String())
	cash := int(row.collectedCash)
	reconciled := false
	out := gen.RiderShift{
		Id:               id,
		RiderId:          &riderID,
		StartsAt:         row.startAt,
		EndsAt:           &row.endAt,
		Status:           riderShiftStatusFromStorage(row.status),
		CashCollectedTZS: &cash,
		CashReconciled:   &reconciled,
		ClockedInAt:      row.clockedInAt,
		ClockedOutAt:     row.clockedOutAt,
	}
	return out
}

// loadRiderShift loads one shift by id, restricted to the rider; a missing
// or foreign row returns (nil, nil).
func (s *Server) loadRiderShift(ctx context.Context, riderID, shiftID uuid.UUID) (*riderShiftRow, error) {
	var row riderShiftRow
	err := scanRiderShift(&row, s.db.Pool().QueryRow(ctx,
		`SELECT `+riderShiftColumns+` FROM rider_shifts WHERE id = $1 AND rider_id = $2`,
		shiftID, riderID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load rider shift: %w", err)
	}
	return &row, nil
}

// riderShiftOverlaps reports whether a non-cancelled shift of the rider
// overlaps [startAt, endAt); one query, mirroring the staff-ops gate.
func (s *Server) riderShiftOverlaps(ctx context.Context, riderID uuid.UUID, startAt, endAt time.Time) (bool, error) {
	var clash uuid.UUID
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id FROM rider_shifts
		 WHERE rider_id = $1 AND status IN ('scheduled', 'active')
		   AND start_at < $3 AND end_at > $2 LIMIT 1`,
		riderID, startAt, endAt).Scan(&clash)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("rider shift overlap check: %w", err)
	}
	return true, nil
}

// riderShiftCreateBody is the internal create-shift payload (the generated
// contract has no POST /riders/me/shifts route; see the package comment).
type riderShiftCreateBody struct {
	StartAt   time.Time `json:"startAt"`
	EndAt     time.Time `json:"endAt"`
	Swappable bool      `json:"swappable"`
}

// createRiderShift schedules a shift for the caller rider. The database gate
// comes first, so a missing database is always 500 before any validation;
// then a start in the past is SHIFT_IN_PAST and a clash with another
// scheduled/active shift is SHIFT_OVERLAP.
func (s *Server) createRiderShift(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body riderShiftCreateBody
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
	overlap, err := s.riderShiftOverlaps(r.Context(), rider.ID, body.StartAt, body.EndAt)
	if err != nil {
		s.logger.Error("create rider shift overlap check failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if overlap {
		writeError(w, http.StatusConflict, "SHIFT_OVERLAP", "Shift overlaps an existing shift for this rider")
		return
	}

	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO rider_shifts (rider_id, start_at, end_at, status, swappable)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		rider.ID, body.StartAt, body.EndAt, riderShiftStatusScheduled, body.Swappable).Scan(&id); err != nil {
		s.logger.Error("create rider shift failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	shift, err := s.loadRiderShift(r.Context(), rider.ID, id)
	if err != nil {
		s.logger.Error("reload rider shift failed", "shift", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toRiderShift(*shift))
}

// ListRiderShifts returns the caller rider's shifts (GET /riders/me/shifts)
// filtered by the contract scope (current/upcoming/past). Pagination is a
// documented extension: limit (default 20, max 100) and offset query
// parameters; the response stays a plain array.
func (s *Server) ListRiderShifts(w http.ResponseWriter, r *http.Request, params gen.ListRiderShiftsParams) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	query := `SELECT ` + riderShiftColumns + ` FROM rider_shifts WHERE rider_id = $1`
	args := []any{rider.ID}
	argi := 2
	if params.Scope != nil {
		switch *params.Scope {
		case gen.Current:
			query += fmt.Sprintf(` AND (status = '%s' OR (status = '%s' AND start_at <= now() AND end_at > now()))`,
				riderShiftStatusActive, riderShiftStatusScheduled)
		case gen.Upcoming:
			query += fmt.Sprintf(` AND status = '%s' AND start_at > now()`, riderShiftStatusScheduled)
		case gen.Past:
			query += fmt.Sprintf(` AND status IN ('%s', '%s', '%s')`,
				riderShiftStatusEnded, riderShiftStatusCancelled, riderShiftStatusSwapped)
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "scope must be current, upcoming or past")
			return
		}
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
	query += fmt.Sprintf(` ORDER BY start_at DESC, id LIMIT $%d OFFSET $%d`, argi, argi+1)
	args = append(args, limit, offset)

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list rider shifts failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.RiderShift, 0, limit)
	for rows.Next() {
		var row riderShiftRow
		if err := scanRiderShift(&row, rows); err != nil {
			s.logger.Error("scan rider shift failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toRiderShift(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate rider shifts failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RiderClockIn activates a scheduled shift of the caller rider (POST
// /riders/me/shifts/clock-in). The guarded update (scheduled→active) is the
// single-winner guarantee: an already-active shift for the rider — or a
// concurrent clock-in — maps to 409 SHIFT_ALREADY_ACTIVE. lat/lon are
// accepted but not stored (no location column).
func (s *Server) RiderClockIn(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.RiderClockInJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	shiftID := uuid.UUID(body.ShiftId)
	if shiftID == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "shiftId is required")
		return
	}
	shift, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("clock-in shift lookup failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if shift == nil {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}

	// A rider may have only one active shift: any active shift — this one
	// already clocked in, or another scheduled one activated meanwhile —
	// maps to SHIFT_ALREADY_ACTIVE. The guarded update below is the
	// race-safety backstop for concurrent clock-ins.
	var alreadyActive bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM rider_shifts WHERE rider_id = $1 AND status = $2)`,
		rider.ID, riderShiftStatusActive).Scan(&alreadyActive); err != nil {
		s.logger.Error("clock-in active check failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if alreadyActive {
		writeError(w, http.StatusConflict, "SHIFT_ALREADY_ACTIVE", "Rider already has an active shift")
		return
	}

	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE rider_shifts SET status = $3, clocked_in_at = now()
		 WHERE id = $1 AND rider_id = $2 AND status = $4`,
		shiftID, rider.ID, riderShiftStatusActive, riderShiftStatusScheduled)
	if err != nil {
		s.logger.Error("clock-in failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "SHIFT_ALREADY_ACTIVE", "Rider already has an active shift")
		return
	}
	updated, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("clock-in reload failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderShift(*updated))
}

// RiderClockOut ends the caller rider's active shift (POST
// /riders/me/shifts/clock-out): clocked_out_at is set and the status flips
// to ended. A shift that was never clocked in is SHIFT_CLOCKOUT_WITHOUT_CLOCKIN;
// collected COD cash that is not marked reconciled is SHIFT_CASH_MISMATCH
// (COD ledger reconciliation required).
func (s *Server) RiderClockOut(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.RiderClockOutJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	shiftID := uuid.UUID(body.ShiftId)
	if shiftID == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "shiftId is required")
		return
	}
	shift, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("clock-out shift lookup failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if shift == nil {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}
	if shift.clockedInAt == nil {
		writeError(w, http.StatusConflict, "SHIFT_CLOCKOUT_WITHOUT_CLOCKIN", "Rider is not clocked in for this shift")
		return
	}
	cash := int64(0)
	if body.CashCollectedTZS != nil {
		cash = int64(*body.CashCollectedTZS)
	}
	reconciled := body.CashReconciled != nil && *body.CashReconciled
	if cash > 0 && !reconciled {
		writeError(w, http.StatusConflict, "SHIFT_CASH_MISMATCH", "COD cash must be reconciled before clock-out")
		return
	}

	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE rider_shifts SET status = $3, clocked_out_at = now(), collected_cash_tzs = $4
		 WHERE id = $1 AND rider_id = $2 AND clocked_in_at IS NOT NULL AND clocked_out_at IS NULL`,
		shiftID, rider.ID, riderShiftStatusEnded, cash)
	if err != nil {
		s.logger.Error("clock-out failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "SHIFT_CLOCKOUT_WITHOUT_CLOCKIN", "Rider is not clocked in for this shift")
		return
	}
	updated, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("clock-out reload failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderShift(*updated))
}

// ManageShiftBreak starts or ends a break within a shift of the caller rider
// (POST /riders/me/shifts/{shiftId}/break). Breaks are only allowed inside
// an active shift (BREAK_NOT_ALLOWED otherwise); at most one open break may
// exist per shift (BREAK_ALREADY_ACTIVE), enforced by the partial unique
// index. The response is the current RiderShift.
func (s *Server) ManageShiftBreak(w http.ResponseWriter, r *http.Request, shiftId openapi_types.UUID) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.ManageShiftBreakJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	shiftID := uuid.UUID(shiftId)
	shift, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("break shift lookup failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if shift == nil {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}

	switch body.Action {
	case gen.ManageShiftBreakJSONBodyActionStart:
		if shift.status != riderShiftStatusActive {
			writeError(w, http.StatusConflict, "BREAK_NOT_ALLOWED", "Breaks are only allowed inside an active shift")
			return
		}
		var id uuid.UUID
		err := s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO rider_breaks (shift_id, started_at) VALUES ($1, now())
			 ON CONFLICT (shift_id) WHERE ended_at IS NULL DO NOTHING
			 RETURNING id`,
			shiftID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "BREAK_ALREADY_ACTIVE", "A break is already active for this shift")
			return
		}
		if err != nil {
			s.logger.Error("break start failed", "rider", rider.ID, "shift", shiftID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	case gen.ManageShiftBreakJSONBodyActionEnd:
		tag, err := s.db.Pool().Exec(r.Context(),
			`UPDATE rider_breaks SET ended_at = now()
			 WHERE shift_id = $1 AND ended_at IS NULL`,
			shiftID)
		if err != nil {
			s.logger.Error("break end failed", "rider", rider.ID, "shift", shiftID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, http.StatusConflict, "BREAK_NOT_ALLOWED", "No open break to end for this shift")
			return
		}
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action must be start or end")
		return
	}

	updated, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("break reload failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderShift(*updated))
}

// RequestShiftSwap asks to hand a swappable, not-yet-active shift of the
// caller rider to another rider (POST /riders/me/shifts/{shiftId}/swap-request).
// The request is recorded on the shift row (swap_requested_at, swap_reason);
// the storage schema has no swap-requests table, so the shift id doubles as
// the swap request id in the 201 response. Unknown targets are 404; the
// target rider id itself is not persisted (documented deviation).
func (s *Server) RequestShiftSwap(w http.ResponseWriter, r *http.Request, shiftId openapi_types.UUID) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.RequestShiftSwapJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	shiftID := uuid.UUID(shiftId)
	shift, err := s.loadRiderShift(r.Context(), rider.ID, shiftID)
	if err != nil {
		s.logger.Error("swap shift lookup failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if shift == nil {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "Shift not found")
		return
	}
	if !shift.swappable || shift.status == riderShiftStatusActive {
		writeError(w, http.StatusConflict, "SWAP_NOT_ALLOWED", "Shift is not swappable")
		return
	}
	if shift.swapRequestedAt != nil {
		writeError(w, http.StatusConflict, "SWAP_ALREADY_REQUESTED", "A swap request already exists for this shift")
		return
	}
	target, err := riders.NewStore(s.db.Pool()).GetRider(r.Context(), uuid.UUID(body.TargetRiderId))
	if err != nil {
		s.logger.Error("swap target lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if target == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Target rider not found")
		return
	}

	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE rider_shifts SET swap_requested_at = now(), swap_reason = $3
		 WHERE id = $1 AND rider_id = $2 AND swappable AND swap_requested_at IS NULL`,
		shiftID, rider.ID, note)
	if err != nil {
		s.logger.Error("swap request failed", "rider", rider.ID, "shift", shiftID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "SWAP_ALREADY_REQUESTED", "A swap request already exists for this shift")
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		SwapRequestId openapi_types.UUID                            `json:"swapRequestId"`
		Status        gen.RequestShiftSwap201JSONResponseBodyStatus `json:"status"`
	}{
		SwapRequestId: shiftId,
		Status:        gen.RequestShiftSwap201JSONResponseBodyStatusPending,
	})
}

// tripOrderRow is one in-flight order of the rider's current bundle.
type tripOrderRow struct {
	id        uuid.UUID
	status    string
	createdAt time.Time
}

// myInFlightOrders lists the rider's current trip bundle: orders bound to
// them in rider_assigned/picked_up/delivering, oldest first. The oldest
// order anchors the trip id.
func (s *Server) myInFlightOrders(ctx context.Context, riderID uuid.UUID) ([]tripOrderRow, error) {
	rows, err := s.db.Pool().Query(ctx,
		`SELECT id, status, created_at FROM orders
		 WHERE rider_id = $1 AND status = ANY($2)
		 ORDER BY created_at, id`,
		riderID, riderTripStatuses)
	if err != nil {
		return nil, fmt.Errorf("rider in-flight orders: %w", err)
	}
	defer rows.Close()
	out := make([]tripOrderRow, 0, 4)
	for rows.Next() {
		var row tripOrderRow
		if err := rows.Scan(&row.id, &row.status, &row.createdAt); err != nil {
			return nil, fmt.Errorf("scan rider in-flight order: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rider in-flight orders: %w", err)
	}
	return out, nil
}

// toRiderTrip maps the rider's in-flight bundle onto the contract Trip. One
// dropoff stop per order in bundle order; the trip id is the anchor (oldest)
// order's id and startedAt is that order's creation time.
func toRiderTrip(riderID uuid.UUID, rows []tripOrderRow) gen.Trip {
	orderIDs := make([]openapi_types.UUID, 0, len(rows))
	stops := make([]struct {
		OrderId  openapi_types.UUID    `json:"orderId"`
		Sequence int                   `json:"sequence"`
		Status   gen.TripStopsStatus   `json:"status"`
		StopType gen.TripStopsStopType `json:"stopType"`
	}, 0, len(rows))
	for i, row := range rows {
		orderIDs = append(orderIDs, openapi_types.UUID(row.id))
		stops = append(stops, struct {
			OrderId  openapi_types.UUID    `json:"orderId"`
			Sequence int                   `json:"sequence"`
			Status   gen.TripStopsStatus   `json:"status"`
			StopType gen.TripStopsStopType `json:"stopType"`
		}{
			OrderId:  openapi_types.UUID(row.id),
			Sequence: i + 1,
			Status:   gen.TripStopsStatusPending,
			StopType: gen.TripStopsStopTypeDropoff,
		})
	}
	rider := newUUID(riderID.String())
	return gen.Trip{
		Id:        newUUID(rows[0].id.String()),
		RiderId:   &rider,
		OrderIds:  orderIDs,
		Status:    gen.TripStatusActive,
		StartedAt: &rows[0].createdAt,
		Stops:     stops,
	}
}

// GetActiveTrip returns the caller rider's current trip bundle (GET
// /riders/me/trips): all their in-flight orders grouped as one trip; 404
// TRIP_NOT_FOUND when there is none.
func (s *Server) GetActiveTrip(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	orders, err := s.myInFlightOrders(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("active trip lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if len(orders) == 0 {
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "No active trip for this rider")
		return
	}
	writeJSON(w, http.StatusOK, toRiderTrip(rider.ID, orders))
}

// GetTrip returns the caller rider's trip detail (GET
// /riders/me/trips/{tripId}). The trip is virtual — the rider's in-flight
// bundle — so any order id within the bundle (including the anchor trip id)
// resolves to the same trip; anything else is 404 TRIP_NOT_FOUND.
func (s *Server) GetTrip(w http.ResponseWriter, r *http.Request, tripId openapi_types.UUID) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	orders, err := s.myInFlightOrders(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("trip detail lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	want := uuid.UUID(tripId)
	found := false
	for _, row := range orders {
		if row.id == want {
			found = true
			break
		}
	}
	if len(orders) == 0 || !found {
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Trip not found")
		return
	}
	writeJSON(w, http.StatusOK, toRiderTrip(rider.ID, orders))
}

// ReorderTripStops validates a new stop sequence for the caller rider's trip
// (POST /riders/me/trips/{tripId}/reorder). Unknown order ids are
// REORDER_INVALID; the trip is in-flight by construction (a completed bundle
// never resolves, so REORDER_NOT_ALLOWED is the defensive gate for when
// completed-trip detail lands). Nothing is persisted — there is no trip
// table — and the response echoes the reordered stops.
func (s *Server) ReorderTripStops(w http.ResponseWriter, r *http.Request, tripId openapi_types.UUID) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	orders, err := s.myInFlightOrders(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("reorder trip lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if len(orders) == 0 {
		writeError(w, http.StatusConflict, "REORDER_NOT_ALLOWED", "Trip is completed or has no in-flight orders")
		return
	}
	want := uuid.UUID(tripId)
	found := false
	for _, row := range orders {
		if row.id == want {
			found = true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "TRIP_NOT_FOUND", "Trip not found")
		return
	}

	var body gen.ReorderTripStopsJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.OrderIds) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderIds must not be empty")
		return
	}
	inBundle := make(map[uuid.UUID]bool, len(orders))
	for _, row := range orders {
		inBundle[row.id] = true
	}
	for _, orderID := range body.OrderIds {
		if !inBundle[uuid.UUID(orderID)] {
			writeError(w, http.StatusConflict, "REORDER_INVALID", "orderIds contains an order that is not in this trip")
			return
		}
	}

	orderIDs := make([]openapi_types.UUID, 0, len(body.OrderIds))
	stops := make([]struct {
		OrderId  openapi_types.UUID    `json:"orderId"`
		Sequence int                   `json:"sequence"`
		Status   gen.TripStopsStatus   `json:"status"`
		StopType gen.TripStopsStopType `json:"stopType"`
	}, 0, len(body.OrderIds))
	for i, orderID := range body.OrderIds {
		orderIDs = append(orderIDs, orderID)
		stops = append(stops, struct {
			OrderId  openapi_types.UUID    `json:"orderId"`
			Sequence int                   `json:"sequence"`
			Status   gen.TripStopsStatus   `json:"status"`
			StopType gen.TripStopsStopType `json:"stopType"`
		}{
			OrderId:  orderID,
			Sequence: i + 1,
			Status:   gen.TripStopsStatusPending,
			StopType: gen.TripStopsStopTypeDropoff,
		})
	}
	riderID := newUUID(rider.ID.String())
	writeJSON(w, http.StatusOK, gen.Trip{
		Id:        newUUID(want.String()),
		RiderId:   &riderID,
		OrderIds:  orderIDs,
		Status:    gen.TripStatusActive,
		StartedAt: &orders[0].createdAt,
		Stops:     stops,
	})
}

// ShareTrip shares a live order of the caller rider with trusted contacts
// (POST /riders/me/trips/{orderId}/share). The order must belong to the
// rider and be in flight (TRIP_SHARE_NOT_ALLOWED otherwise). One pending
// trip_shares row is inserted per recipient (recipients are phones; the
// shared_with_rider_id is resolved when the phone maps to a rider row, else
// NULL) and the row id doubles as the share token. The contract's default
// expiry is 24 h (expiresInHours), clamped to [1, 168].
func (s *Server) ShareTrip(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.ShareTripJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Recipients) == 0 || len(body.Recipients) > 5 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "recipients must contain 1 to 5 phone numbers")
		return
	}
	orderID := uuid.UUID(orderId)
	var inFlight bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM orders WHERE id = $1 AND rider_id = $2 AND status = ANY($3))`,
		orderID, rider.ID, riderTripStatuses).Scan(&inFlight); err != nil {
		s.logger.Error("share order check failed", "rider", rider.ID, "order", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !inFlight {
		writeError(w, http.StatusConflict, "TRIP_SHARE_NOT_ALLOWED", "Order is not an in-flight trip of this rider")
		return
	}

	hours := 24
	if body.ExpiresInHours != nil {
		hours = *body.ExpiresInHours
		if hours < 1 {
			hours = 1
		}
		if hours > 168 {
			hours = 168
		}
	}
	expiresAt := time.Now().Add(time.Duration(hours) * time.Hour)

	var token uuid.UUID
	for _, recipient := range body.Recipients {
		var sharedWith *uuid.UUID
		var resolved uuid.UUID
		err := s.db.Pool().QueryRow(r.Context(),
			`SELECT r.id FROM riders r JOIN users u ON u.id = r.owner_user_id WHERE u.phone = $1`,
			recipient).Scan(&resolved)
		if err == nil {
			sharedWith = &resolved
		} else if !errors.Is(err, pgx.ErrNoRows) {
			s.logger.Error("share recipient lookup failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		var shareID uuid.UUID
		if err := s.db.Pool().QueryRow(r.Context(),
			`INSERT INTO trip_shares (trip_rider_id, shared_with_rider_id, order_id, status, expires_at)
			 VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
			rider.ID, sharedWith, orderID, expiresAt).Scan(&shareID); err != nil {
			s.logger.Error("trip share insert failed", "rider", rider.ID, "order", orderID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		token = shareID
	}
	writeJSON(w, http.StatusCreated, struct {
		ShareToken string    `json:"shareToken"`
		ExpiresAt  time.Time `json:"expiresAt"`
	}{
		ShareToken: token.String(),
		ExpiresAt:  expiresAt,
	})
}
