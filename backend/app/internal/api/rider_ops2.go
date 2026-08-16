package api

// RIDER-OPS2 bounded context (backend/DATA-MODEL.md §riders; ERROR-CODES.md
// §Dispatch and delivery exceptions): vehicle maintenance records, rider
// missions/incentives, the training center, offline-sync batch + status, rider
// report exports, the performance scorecard, and the daily check-in. Every
// handler is rider-gated through the same riderOpsRider gate as RIDER-OPS
// (rider_ops.go): the riders row resolves via GetByOwner(subject user id) and
// a missing row is 404; a missing database is always 500 INTERNAL_ERROR first.
//
// Deviations, documented honestly:
//   - vehicle_maintenance.kind stores the CONTRACT type enum
//     (oil_change/tire_pressure/battery_health/brake_service/general_service)
//     so values round-trip without a lossy mapping; the draft brief's storage
//     kinds (service/repair/inspection/other) were dropped for that reason.
//     The storage status (scheduled/in_progress/completed) and costTZS have
//     no contract field / no column and are omitted from responses.
//   - rider_missions.kind is storage-only (the contract has no kind) and
//     description has no column, so it is honestly absent. startsAt reads
//     back as created_at (the moment the mission row existed is the earliest
//     truthful start). The contract has NO mission claim path, so
//     MISSION_NOT_FOUND / MISSION_ALREADY_CLAIMED are unreachable until a
//     claim route lands; canClaim is derived (progress >= target, not
//     claimed, not expired).
//   - Training: category/durationMinutes/certificateUrl/rewardTZS have no
//     columns and are omitted; status is completed (progress row exists) or
//     not_started, progressPct 100 or 0 — there is no in_progress state.
//   - Sync batch: events are validated (shape, then strict sequence) and the
//     rider_sync_state high-water mark advances atomically (the guarded
//     upsert is the race backstop). After the ack, events are APPLIED
//     best-effort: order_status events move the rider's own order through
//     orders.TransitionOrder with the rider actor — the same expectedVersion
//     guard as AdvanceOrder/AdvanceMyOrder, with a from-set of every earlier
//     fulfillment status so an offline jump like paid → picked_up replays —
//     while the other contract types (pod/location/safety_event/cod_cash)
//     are acknowledged but skipped (the server has no projection for them).
//     Per-event outcomes land in rejected {seq, code}: SKIPPED (unsupported
//     type or malformed payload), ORDER_STATUS_CONFLICT (stale expected
//     version or a status the rider cannot move from), ORDER_NOT_FOUND
//     (unknown order, or an order bound to another rider), INTERNAL_ERROR
//     (apply failed). accepted counts applied events; the high-water mark
//     advances regardless of outcomes and rejected is informational. A batch
//     whose first seq is not last_seq+1 — including a re-sent, already-acked
//     batch — is 409 SYNC_SEQUENCE_GAP (retries should follow the high-water
//     mark).
//   - Sync status pendingCount is 0 (the server never knows the client's
//     pending queue; honest zero). gaps is omitted.
//   - Exports: the rider_exports row IS the queue — no worker flips queued to
//     completed, so rows stay queued and the 202 is honest. format is
//     validated but not persisted (no column); a concurrent queued export is
//     409 EXPORT_IN_PROGRESS. EXPORT_IN_PROGRESS is also the only export
//     error code in ERROR-CODES.md, so invalid enums answer the generic
//     VALIDATION_FAILED 422.
//   - Performance aggregates live: delivered/completed orders (count +
//     total_tzs sum, one query) and worked shift hours (sum of clocked
//     durations, one query). There is no acceptance/on-time/rating telemetry
//     yet, so those contract-required fields are honest zeros and
//     PERFORMANCE_UNAVAILABLE is never raised (zeros + this comment instead).
//     deliveryStreak, topHours, benchmarks and the derived level have no
//     honest source and are omitted.
//   - Daily check-in stores {date, lat, lon, streak} in Redis
//     (rider:checkin:{riderID}, 48 h TTL) — multi-instance safe, no
//     migration. The check-in is rate-limited to one per calendar day per
//     rider (429 LOCATION_RATE_LIMITED; the contract's 409 has no code in
//     ERROR-CODES.md). pointsEarned/bonusPoints are honest zeros: the rider
//     loyalty ledger is not wired, so no points are claimed to be earned.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// RIDER-OPS2 surface bounds: the maintenance list page size (limit default
// 20, max 100 — a documented extension on the plain-array contract), the sync
// batch event cap (the contract's maxItems), the per-rider daily check-in
// budget and its Redis TTL.
const (
	riderOps2ListPageSize = 20
	riderOps2ListMaxSize  = 100
	syncBatchMaxEvents    = 500
	checkInRateLimit      = 1
	checkInRateWindow     = 24 * time.Hour
	checkInRedisTTL       = 48 * time.Hour
)

// maintenanceRow is one vehicle_maintenance row projection.
type maintenanceRow struct {
	id          uuid.UUID
	riderID     uuid.UUID
	kind        string
	description *string
	odometerKm  *float64
	scheduledAt time.Time
	status      string
	createdAt   time.Time
}

const maintenanceColumns = `id, rider_id, kind, description, odometer_km, scheduled_at, status, created_at`

func scanMaintenanceRow(row interface{ Scan(...any) error }) (maintenanceRow, error) {
	var m maintenanceRow
	err := row.Scan(&m.id, &m.riderID, &m.kind, &m.description, &m.odometerKm, &m.scheduledAt, &m.status, &m.createdAt)
	return m, err
}

// toVehicleMaintenance maps a row onto the contract VehicleMaintenance. The
// storage status and the contract's costTZS have no counterpart on either
// side and are omitted (honest absence).
func (m maintenanceRow) toVehicleMaintenance() gen.VehicleMaintenance {
	id := newUUID(m.id.String())
	riderID := newUUID(m.riderID.String())
	out := gen.VehicleMaintenance{
		Id:          &id,
		RiderId:     &riderID,
		Type:        gen.VehicleMaintenanceType(m.kind),
		PerformedAt: m.scheduledAt,
		Notes:       m.description,
	}
	if m.odometerKm != nil {
		mileage := int(*m.odometerKm)
		out.MileageKm = &mileage
	}
	return out
}

// ListVehicleMaintenance returns the caller rider's maintenance records
// (GET /riders/me/vehicle/maintenance), newest first, paginated via the
// documented limit (default 20, max 100) / offset extension; the response
// stays a plain array.
func (s *Server) ListVehicleMaintenance(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	limit := riderOps2ListPageSize
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= riderOps2ListMaxSize {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+maintenanceColumns+`
		 FROM vehicle_maintenance
		 WHERE rider_id = $1
		 ORDER BY created_at DESC, id
		 LIMIT $2 OFFSET $3`,
		rider.ID, limit, offset)
	if err != nil {
		s.logger.Error("list vehicle maintenance failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.VehicleMaintenance, 0, limit)
	for rows.Next() {
		row, err := scanMaintenanceRow(rows)
		if err != nil {
			s.logger.Error("scan maintenance row failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, row.toVehicleMaintenance())
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate maintenance rows failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateVehicleMaintenance records a maintenance event for the caller rider
// (POST /riders/me/vehicle/maintenance, 201 VehicleMaintenance). The kind
// must be part of the contract enum, the description non-empty and the
// performedAt set — any violation is 422 MAINTENANCE_INVALID before any
// database access other than the rider gate.
func (s *Server) CreateVehicleMaintenance(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.CreateVehicleMaintenanceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Type.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "MAINTENANCE_INVALID",
			"type must be oil_change, tire_pressure, battery_health, brake_service or general_service")
		return
	}
	if body.Notes == nil || *body.Notes == "" {
		writeError(w, http.StatusUnprocessableEntity, "MAINTENANCE_INVALID", "notes must not be empty")
		return
	}
	if body.PerformedAt.IsZero() {
		writeError(w, http.StatusUnprocessableEntity, "MAINTENANCE_INVALID", "performedAt is required")
		return
	}
	var odometer *float64
	if body.MileageKm != nil {
		km := float64(*body.MileageKm)
		odometer = &km
	}
	row, err := scanMaintenanceRow(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO vehicle_maintenance (rider_id, kind, description, odometer_km, scheduled_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING `+maintenanceColumns,
		rider.ID, string(body.Type), *body.Notes, odometer, body.PerformedAt))
	if err != nil {
		s.logger.Error("create vehicle maintenance failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, row.toVehicleMaintenance())
}

// riderMissionRow is one rider_missions row projection.
type riderMissionRow struct {
	id        uuid.UUID
	riderID   uuid.UUID
	kind      string
	title     string
	rewardTZS int64
	progress  int
	target    int
	claimed   bool
	expiresAt *time.Time
	createdAt time.Time
}

const riderMissionColumns = `id, rider_id, kind, title, reward_tzs, progress, target, claimed, expires_at, created_at`

func scanRiderMissionRow(row interface{ Scan(...any) error }) (riderMissionRow, error) {
	var m riderMissionRow
	err := row.Scan(&m.id, &m.riderID, &m.kind, &m.title, &m.rewardTZS, &m.progress,
		&m.target, &m.claimed, &m.expiresAt, &m.createdAt)
	return m, err
}

// riderMissionExpired reports whether the mission window has closed. A nil
// expires_at never expires.
func (m riderMissionRow) riderMissionExpired(now time.Time) bool {
	return m.expiresAt != nil && !m.expiresAt.After(now)
}

// toRiderMission maps a row onto the contract RiderMission. status is
// derived (expired / completed / active); description has no column and kind
// is storage-only, so both are absent. startsAt reads back as created_at.
func (m riderMissionRow) toRiderMission(now time.Time) gen.RiderMission {
	expired := m.riderMissionExpired(now)
	completed := m.progress >= m.target
	status := gen.RiderMissionStatusActive
	switch {
	case expired:
		status = gen.RiderMissionStatusExpired
	case completed:
		status = gen.RiderMissionStatusCompleted
	}
	canClaim := completed && !expired && !m.claimed
	reward := int(m.rewardTZS)
	startsAt := m.createdAt
	id := newUUID(m.id.String())
	return gen.RiderMission{
		Id:                  id,
		Title:               m.title,
		TargetDeliveries:    m.target,
		CompletedDeliveries: &m.progress,
		RewardTZS:           reward,
		Status:              status,
		Claimed:             &m.claimed,
		CanClaim:            &canClaim,
		StartsAt:            &startsAt,
		EndsAt:              m.expiresAt,
	}
}

// ListRiderMissions returns the caller rider's missions (GET
// /riders/me/missions), newest first, optionally filtered by the contract
// status (active/completed/expired); the response is a plain array.
func (s *Server) ListRiderMissions(w http.ResponseWriter, r *http.Request, params gen.ListRiderMissionsParams) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	query := `SELECT ` + riderMissionColumns + ` FROM rider_missions WHERE rider_id = $1`
	if params.Status != nil {
		switch *params.Status {
		case gen.ListRiderMissionsParamsStatusActive:
			query += ` AND NOT (expires_at IS NOT NULL AND expires_at <= now()) AND progress < target`
		case gen.ListRiderMissionsParamsStatusCompleted:
			query += ` AND progress >= target`
		case gen.ListRiderMissionsParamsStatusExpired:
			query += ` AND expires_at IS NOT NULL AND expires_at <= now()`
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be active, completed or expired")
			return
		}
	}
	query += ` ORDER BY created_at DESC, id`
	rows, err := s.db.Pool().Query(r.Context(), query, rider.ID)
	if err != nil {
		s.logger.Error("list rider missions failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	now := time.Now()
	out := make([]gen.RiderMission, 0, 16)
	for rows.Next() {
		row, err := scanRiderMissionRow(rows)
		if err != nil {
			s.logger.Error("scan rider mission row failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, row.toRiderMission(now))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate rider mission rows failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// trainingModuleRow is one training_modules row projection.
type trainingModuleRow struct {
	id        uuid.UUID
	title     string
	content   string
	required  bool
	sortOrder int
	createdAt time.Time
}

const trainingModuleColumns = `id, title, content, required, sort_order, created_at`

func scanTrainingModuleRow(row interface{ Scan(...any) error }) (trainingModuleRow, error) {
	var m trainingModuleRow
	err := row.Scan(&m.id, &m.title, &m.content, &m.required, &m.sortOrder, &m.createdAt)
	return m, err
}

// toTrainingModule maps a module row onto the contract TrainingModule given
// the rider's completion time (nil = not started). The contract's
// category/durationMinutes/certificateUrl/rewardTZS have no columns and are
// honestly absent; status is completed or not_started, progressPct 100 or 0.
func (m trainingModuleRow) toTrainingModule(completedAt *time.Time) gen.TrainingModule {
	id := newUUID(m.id.String())
	module := gen.TrainingModule{
		Id:    id,
		Title: m.title,
	}
	if completedAt != nil {
		progress := 100
		module.Status = gen.TrainingModuleStatusCompleted
		module.ProgressPct = &progress
		module.CompletedAt = completedAt
	} else {
		module.Status = gen.TrainingModuleStatusNotStarted
	}
	return module
}

// ListTrainingModules returns the training catalog with the caller rider's
// completion flags (GET /riders/me/training), one query for the modules and
// one for the rider's progress rows.
func (s *Server) ListTrainingModules(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+trainingModuleColumns+` FROM training_modules ORDER BY sort_order, title, id`)
	if err != nil {
		s.logger.Error("list training modules failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	modules := make([]trainingModuleRow, 0, 16)
	for rows.Next() {
		module, err := scanTrainingModuleRow(rows)
		if err != nil {
			rows.Close()
			s.logger.Error("scan training module row failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		modules = append(modules, module)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("iterate training module rows failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows.Close()

	progressRows, err := s.db.Pool().Query(r.Context(),
		`SELECT module_id, completed_at FROM rider_training_progress WHERE rider_id = $1`,
		rider.ID)
	if err != nil {
		s.logger.Error("list training progress failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	completed := make(map[uuid.UUID]time.Time, 8)
	for progressRows.Next() {
		var moduleID uuid.UUID
		var completedAt time.Time
		if err := progressRows.Scan(&moduleID, &completedAt); err != nil {
			progressRows.Close()
			s.logger.Error("scan training progress row failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		completed[moduleID] = completedAt
	}
	if err := progressRows.Err(); err != nil {
		progressRows.Close()
		s.logger.Error("iterate training progress rows failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	progressRows.Close()

	out := make([]gen.TrainingModule, 0, len(modules))
	for _, module := range modules {
		var completedAt *time.Time
		if at, ok := completed[module.id]; ok {
			completedAt = &at
		}
		out = append(out, module.toTrainingModule(completedAt))
	}
	writeJSON(w, http.StatusOK, out)
}

// CompleteTrainingModule marks a module complete for the caller rider (POST
// /riders/me/training/{moduleId}/complete, 200 TrainingModule). An unknown
// module is 404 TRAINING_MODULE_NOT_FOUND; a repeat completion is idempotent
// (ON CONFLICT DO NOTHING) and answers the same completed module.
func (s *Server) CompleteTrainingModule(w http.ResponseWriter, r *http.Request, moduleId openapi_types.UUID) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	moduleID := uuid.UUID(moduleId)
	module, err := scanTrainingModuleRow(s.db.Pool().QueryRow(r.Context(),
		`SELECT `+trainingModuleColumns+` FROM training_modules WHERE id = $1`, moduleID))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "TRAINING_MODULE_NOT_FOUND", "Training module not found")
		return
	}
	if err != nil {
		s.logger.Error("training module lookup failed", "rider", rider.ID, "module", moduleID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO rider_training_progress (rider_id, module_id, completed_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (rider_id, module_id) DO NOTHING`,
		rider.ID, moduleID); err != nil {
		s.logger.Error("complete training module failed", "rider", rider.ID, "module", moduleID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var completedAt time.Time
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT completed_at FROM rider_training_progress WHERE rider_id = $1 AND module_id = $2`,
		rider.ID, moduleID).Scan(&completedAt); err != nil {
		s.logger.Error("reload training progress failed", "rider", rider.ID, "module", moduleID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, module.toTrainingModule(&completedAt))
}

// syncBatchEvent mirrors one element of the contract SyncRiderBatch events
// array (the generated body is used for decoding; this is the projection the
// sequence validation and the post-ack apply work on).
type syncBatchEvent struct {
	seq       int
	eventType string
	payload   map[string]interface{}
}

// riderSyncStateRow is the rider_sync_state projection.
type riderSyncStateRow struct {
	lastSeq   int64
	updatedAt time.Time
}

// loadRiderSyncState returns the rider's high-water mark, or a zero row when
// no sync has happened yet (the lazy zero row).
func (s *Server) loadRiderSyncState(ctx context.Context, riderID uuid.UUID) (riderSyncStateRow, error) {
	var row riderSyncStateRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT last_seq, updated_at FROM rider_sync_state WHERE rider_id = $1`,
		riderID).Scan(&row.lastSeq, &row.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return riderSyncStateRow{}, nil
	}
	if err != nil {
		return riderSyncStateRow{}, fmt.Errorf("load rider sync state: %w", err)
	}
	return row, nil
}

// syncBatchRejectedEntry is one per-event outcome in the contract's rejected
// array ({seq, code}).
type syncBatchRejectedEntry struct {
	Seq  int    `json:"seq"`
	Code string `json:"code"`
}

// riderSyncBatchResponse is the contract's inline 200 response for
// POST /riders/me/sync/batch.
type riderSyncBatchResponse struct {
	Accepted      int                      `json:"accepted"`
	Rejected      []syncBatchRejectedEntry `json:"rejected"`
	HighWaterMark int                      `json:"highWaterMark"`
}

// riderLifecycleRank orders the happy-path order lifecycle (the same status
// set the orders CHECK constraint accepts, minus the terminal exception
// statuses cancelled/refunded/failed/disputed). The offline replay from-set
// for a target status is every status strictly before it: a rider may jump an
// order forward along the chain (paid → picked_up → delivering → delivered →
// completed) — the expected version guard keeps the jump honest.
var riderLifecycleRank = map[string]int{
	"draft": 0, "pending_payment": 1, "paid": 2, "merchant_accepted": 3,
	"preparing": 4, "rider_assigned": 5, "picked_up": 6, "delivering": 7,
	"delivered": 8, "completed": 9,
}

// riderSyncFromSet returns the statuses an order may be in when a rider's
// offline order_status event moves it to target: every fulfillment status
// strictly before the target in riderLifecycleRank. A target outside the
// rider chain (or a terminal status) has no from-set and cannot be replayed.
func riderSyncFromSet(target string) []string {
	rank, ok := riderLifecycleRank[target]
	if !ok {
		return nil
	}
	from := make([]string, 0, 8)
	for status, r := range riderLifecycleRank {
		if r < rank {
			from = append(from, status)
		}
	}
	return from
}

// syncOrderStatusEvent is the order_status payload projection. The contract
// defines the payload as a free-form object; the rider apps send
// {orderId, status, expectedVersion}.
type syncOrderStatusEvent struct {
	orderID         uuid.UUID
	status          string
	expectedVersion int
}

// parseSyncOrderStatusEvent projects an order_status payload. Malformed
// payloads (missing keys, a non-UUID orderId, a non-string status, a
// non-number expectedVersion) report ok=false and the event is skipped.
func parseSyncOrderStatusEvent(payload map[string]interface{}) (syncOrderStatusEvent, bool) {
	var ev syncOrderStatusEvent
	rawID, ok := payload["orderId"].(string)
	if !ok {
		return ev, false
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		return ev, false
	}
	status, ok := payload["status"].(string)
	if !ok {
		return ev, false
	}
	version, ok := payload["expectedVersion"].(float64)
	if !ok {
		return ev, false
	}
	ev.orderID = id
	ev.status = status
	ev.expectedVersion = int(version)
	return ev, true
}

// applySyncBatchEvent applies one acknowledged sync event and appends the
// per-event outcome to rejected when it could not be applied. order_status
// events move the caller rider's own order through orders.TransitionOrder
// (expectedVersion + riderSyncFromSet); every other contract type is skipped.
// The batch is already acknowledged at this point, so a failure is never
// fatal — it is recorded per-event and logged.
func (s *Server) applySyncBatchEvent(ctx context.Context, riderID uuid.UUID, actor uuid.UUID, event syncBatchEvent, rejected *[]syncBatchRejectedEntry) {
	if event.eventType != string(gen.SyncRiderBatchJSONBodyEventsTypeOrderStatus) {
		s.logger.Info("sync batch event skipped", "rider", riderID, "seq", event.seq, "type", event.eventType)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "SKIPPED"})
		return
	}
	target, ok := parseSyncOrderStatusEvent(event.payload)
	if !ok {
		s.logger.Info("sync batch order_status payload malformed", "rider", riderID, "seq", event.seq)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "SKIPPED"})
		return
	}
	from := riderSyncFromSet(target.status)
	if from == nil {
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_STATUS_CONFLICT"})
		return
	}
	st := orders.NewStore(s.db.Pool())
	row, err := st.GetOrderRow(ctx, target.orderID)
	if errors.Is(err, orders.ErrNotFound) {
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_NOT_FOUND"})
		return
	}
	if err != nil {
		s.logger.Error("sync batch order lookup failed", "rider", riderID, "seq", event.seq, "orderId", target.orderID, "error", err)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "INTERNAL_ERROR"})
		return
	}
	if row.RiderID == nil || *row.RiderID != riderID {
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_NOT_FOUND"})
		return
	}
	if _, err := st.TransitionOrder(ctx, target.orderID, target.expectedVersion, from, target.status, actor, ""); err != nil {
		if errors.Is(err, orders.ErrConflict) {
			*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "ORDER_STATUS_CONFLICT"})
			return
		}
		s.logger.Error("sync batch order status apply failed", "rider", riderID, "seq", event.seq, "orderId", target.orderID, "error", err)
		*rejected = append(*rejected, syncBatchRejectedEntry{Seq: event.seq, Code: "INTERNAL_ERROR"})
	}
}

// SyncRiderBatch accepts an offline queue batch (POST /riders/me/sync/batch).
// Validation order: body shape (events non-empty, ≤ 500, every event with a
// positive seq, a valid type and a payload object → 422 SYNC_BATCH_INVALID),
// then the strict sequence check (events[0].seq must be last_seq+1 and every
// following seq the previous +1 → 409 SYNC_SEQUENCE_GAP). Acceptance advances
// rider_sync_state.last_seq atomically (the guarded upsert is the race
// backstop: a concurrent batch that moved the high-water mark fails with 409)
// and acknowledges the batch. After the ack, each event is applied
// best-effort — order_status events via the guarded order transition (see
// applySyncBatchEvent) — and the per-event outcomes are reported in rejected;
// the high-water mark advances regardless (see the package comment).
func (s *Server) SyncRiderBatch(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.SyncRiderBatchJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID", "Invalid request body")
		return
	}
	events := make([]syncBatchEvent, 0, len(body.Events))
	if len(body.Events) == 0 || len(body.Events) > syncBatchMaxEvents {
		writeError(w, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID",
			fmt.Sprintf("events must contain between 1 and %d items", syncBatchMaxEvents))
		return
	}
	for i, event := range body.Events {
		if event.Seq < 1 || !event.Type.Valid() || event.Payload == nil {
			writeError(w, http.StatusUnprocessableEntity, "SYNC_BATCH_INVALID",
				"each event requires a positive seq, a valid type and a payload object")
			return
		}
		if i > 0 && event.Seq != body.Events[i-1].Seq+1 {
			writeError(w, http.StatusConflict, "SYNC_SEQUENCE_GAP", "Events must carry consecutive sequence numbers")
			return
		}
		events = append(events, syncBatchEvent{seq: event.Seq, eventType: string(event.Type), payload: event.Payload})
	}

	state, err := s.loadRiderSyncState(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("sync batch state lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	expected := state.lastSeq + 1
	if int64(events[0].seq) != expected {
		writeError(w, http.StatusConflict, "SYNC_SEQUENCE_GAP",
			fmt.Sprintf("First event seq must be %d (the server high-water mark is %d)", expected, state.lastSeq))
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.logger.Error("sync batch actor lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	nextSeq := int64(events[len(events)-1].seq)

	var acked int64
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO rider_sync_state (rider_id, last_seq, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (rider_id) DO UPDATE
		 SET last_seq = EXCLUDED.last_seq, updated_at = now()
		 WHERE rider_sync_state.last_seq = $3
		 RETURNING last_seq`,
		rider.ID, nextSeq, state.lastSeq).Scan(&acked)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "SYNC_SEQUENCE_GAP",
			"Concurrent sync advanced the high-water mark — retry from the current mark")
		return
	}
	if err != nil {
		s.logger.Error("sync batch apply failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rejected := make([]syncBatchRejectedEntry, 0, len(events))
	accepted := 0
	for _, event := range events {
		before := len(rejected)
		s.applySyncBatchEvent(r.Context(), rider.ID, actor, event, &rejected)
		if len(rejected) == before {
			accepted++
		}
	}
	writeJSON(w, http.StatusOK, riderSyncBatchResponse{
		Accepted:      accepted,
		Rejected:      rejected,
		HighWaterMark: int(acked),
	})
}

// GetRiderSyncStatus returns the caller rider's sync state (GET
// /riders/me/sync/status): the server high-water mark, the last sync time and
// pendingCount 0 (the server never knows the client's local queue — honest
// zero). A rider with no sync rows reads back as the lazy zero row.
func (s *Server) GetRiderSyncStatus(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	state, err := s.loadRiderSyncState(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("sync status lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	status := gen.SyncStatus{
		HighWaterMark: int(state.lastSeq),
		PendingCount:  0,
	}
	if !state.updatedAt.IsZero() {
		status.LastSyncedAt = &state.updatedAt
	}
	writeJSON(w, http.StatusOK, status)
}

// ExportRiderReport enqueues a rider report export job (POST
// /riders/me/exports, 202 {jobId, status}). The rider_exports row IS the
// queue in this milestone — no worker exists, so rows stay queued and every
// status is honest. A queued export for the same rider blocks a second one
// with 409 EXPORT_IN_PROGRESS; format/reportType outside the contract enums
// are 422 VALIDATION_FAILED (no dedicated code exists in ERROR-CODES.md).
func (s *Server) ExportRiderReport(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.ExportRiderReportJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.ReportType.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reportType must be tax, earnings or trips")
		return
	}
	if !body.Format.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "format must be csv, pdf or json")
		return
	}
	var inProgress bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM rider_exports
			WHERE rider_id = $1 AND status IN ('queued', 'processing'))`,
		rider.ID).Scan(&inProgress); err != nil {
		s.logger.Error("rider export duplicate check failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if inProgress {
		writeError(w, http.StatusConflict, "EXPORT_IN_PROGRESS", "An export is already in progress for this rider")
		return
	}
	var jobID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO rider_exports (rider_id, scope, status)
		 VALUES ($1, $2, 'queued') RETURNING id`,
		rider.ID, string(body.ReportType)).Scan(&jobID); err != nil {
		s.logger.Error("create rider export failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		JobId  openapi_types.UUID                             `json:"jobId"`
		Status gen.ExportRiderReport202JSONResponseBodyStatus `json:"status"`
	}{
		JobId:  newUUID(jobID.String()),
		Status: gen.ExportRiderReport202JSONResponseBodyStatusQueued,
	})
}

// riderPerformanceRow is the single-row orders aggregate backing the
// performance scorecard.
type riderPerformanceRow struct {
	completedOrders int
	earningsTZS     int64
	totalOrders     int
}

// loadRiderPerformance computes the rider's delivery aggregates from orders
// (one query): completed orders (delivered/completed) with their total_tzs
// sum, and the rider's total order count. The optional from/to window filters
// created_at.
func (s *Server) loadRiderPerformance(ctx context.Context, riderID uuid.UUID, from, to *time.Time) (riderPerformanceRow, error) {
	var row riderPerformanceRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE status IN ('delivered', 'completed')),
		        coalesce(sum(total_tzs) FILTER (WHERE status IN ('delivered', 'completed')), 0),
		        count(*)
		 FROM orders
		 WHERE rider_id = $1
		   AND ($2::timestamptz IS NULL OR created_at >= $2)
		   AND ($3::timestamptz IS NULL OR created_at < $3)`,
		riderID, from, to).Scan(&row.completedOrders, &row.earningsTZS, &row.totalOrders)
	if err != nil {
		return riderPerformanceRow{}, fmt.Errorf("rider performance orders: %w", err)
	}
	return row, nil
}

// loadRiderWorkedHours sums the rider's clocked shift durations in hours from
// rider_shifts (one query): only shifts with both clock-in and clock-out
// timestamps contribute. The optional window filters clocked_in_at.
func (s *Server) loadRiderWorkedHours(ctx context.Context, riderID uuid.UUID, from, to *time.Time) (float64, error) {
	var hours float64
	err := s.db.Pool().QueryRow(ctx,
		`SELECT coalesce(sum(EXTRACT(EPOCH FROM (clocked_out_at - clocked_in_at)) / 3600.0), 0)
		 FROM rider_shifts
		 WHERE rider_id = $1 AND clocked_in_at IS NOT NULL AND clocked_out_at IS NOT NULL
		   AND ($2::timestamptz IS NULL OR clocked_in_at >= $2)
		   AND ($3::timestamptz IS NULL OR clocked_in_at < $3)`,
		riderID, from, to).Scan(&hours)
	if err != nil {
		return 0, fmt.Errorf("rider performance worked hours: %w", err)
	}
	return hours, nil
}

// GetRiderPerformance returns the caller rider's scorecard (GET
// /riders/me/performance). Completed orders + earningsTZS come from orders,
// onlineHoursWeek from worked rider_shifts. There is no acceptance/on-time/
// rating telemetry in this milestone, so those contract-required fields are
// honest zeros and PERFORMANCE_UNAVAILABLE is never raised (zeros are the
// documented behavior for a rider without data — see the package comment).
func (s *Server) GetRiderPerformance(w http.ResponseWriter, r *http.Request, params gen.GetRiderPerformanceParams) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var from, to *time.Time
	if params.From != nil {
		start := time.Date(params.From.Year(), params.From.Month(), params.From.Day(), 0, 0, 0, 0, time.UTC)
		from = &start
	}
	if params.To != nil {
		end := time.Date(params.To.Year(), params.To.Month(), params.To.Day()+1, 0, 0, 0, 0, time.UTC)
		to = &end
	}
	agg, err := s.loadRiderPerformance(r.Context(), rider.ID, from, to)
	if err != nil {
		s.logger.Error("rider performance orders failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	hours, err := s.loadRiderWorkedHours(r.Context(), rider.ID, from, to)
	if err != nil {
		s.logger.Error("rider performance hours failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	earnings := int(agg.earningsTZS)
	onlineHours := float32(hours)
	performance := gen.RiderPerformance{
		AcceptanceRate:  0,
		OnTimePct:       0,
		RatingAverage:   0,
		CompletedOrders: agg.completedOrders,
		EarningsTZS:     &earnings,
		OnlineHoursWeek: &onlineHours,
	}
	if agg.completedOrders > 0 {
		avgPerTrip := earnings / agg.completedOrders
		performance.AvgPerTripTZS = &avgPerTrip
	}
	writeJSON(w, http.StatusOK, performance)
}

// riderCheckInBody is the optional daily check-in payload. The contract
// defines no request body for POST /check-in; the app sends {lat, lon} when
// it has a location fix, so the handler accepts an empty body too.
type riderCheckInBody struct {
	Lat *float32 `json:"lat"`
	Lon *float32 `json:"lon"`
}

// riderCheckInResponse is the contract's inline 200 response for
// POST /check-in plus the check-in timestamp (the contract schema has no
// timestamp field; it is added as a documented extension).
type riderCheckInResponse struct {
	PointsEarned int       `json:"pointsEarned"`
	StreakDays   int       `json:"streakDays"`
	BonusPoints  int       `json:"bonusPoints"`
	CheckedInAt  time.Time `json:"checkedInAt"`
}

// coordsValid mirrors the location gates in riders.go: lat within -90..90 and
// lon within -180..180.
func coordsValid(lat, lon float32) bool {
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

// DailyCheckIn records the caller rider's daily check-in (POST /check-in, 200
// {pointsEarned, streakDays, bonusPoints}). The optional lat/lon body is
// validated (422 LOCATION_INVALID), then the per-rider daily budget is
// enforced (429 LOCATION_RATE_LIMITED — the contract's 409 Conflict has no
// code in ERROR-CODES.md, so a same-day duplicate is rate limited instead),
// and the check-in lands in Redis as `rider:checkin:{riderID}` with fields
// date (YYYY-MM-DD), streak, lat and lon, TTL 48 h — multi-instance safe, no
// migration. pointsEarned/bonusPoints are honest zeros (no loyalty ledger).
func (s *Server) DailyCheckIn(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body riderCheckInBody
	if err := decodeJSON(r, &body); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if (body.Lat == nil) != (body.Lon == nil) {
		writeError(w, http.StatusUnprocessableEntity, "LOCATION_INVALID", "lat and lon must be provided together")
		return
	}
	if body.Lat != nil && body.Lon != nil && !coordsValid(*body.Lat, *body.Lon) {
		writeError(w, http.StatusUnprocessableEntity, "LOCATION_INVALID", "lat must be within -90..90 and lon within -180..180")
		return
	}
	if s.stores == nil || s.stores.Redis == nil {
		s.logger.Error("daily check-in failed: redis not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	now := time.Now().UTC()
	decision, err := s.stores.Rate.Allow(r.Context(),
		"checkin:"+rider.ID.String()+":"+now.Format("2006-01-02"), checkInRateLimit, checkInRateWindow, now)
	if err != nil {
		s.logger.Error("check-in rate limit check failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !decision.Allowed {
		s.logger.Warn("daily check-in rate limited", "rider", rider.ID)
		writeErrorWithRetry(w, http.StatusTooManyRequests, "LOCATION_RATE_LIMITED",
			"Daily check-in already recorded — try again tomorrow", int(decision.RetryAfter.Seconds()))
		return
	}

	client := s.stores.Redis.Client()
	key := "rider:checkin:" + rider.ID.String()
	existing, err := client.HGetAll(r.Context(), key).Result()
	if err != nil {
		s.logger.Error("check-in redis read failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	streak := 1
	if previous, ok := existing["date"]; ok && previous == now.AddDate(0, 0, -1).Format("2006-01-02") {
		if prevStreak, err := strconv.Atoi(existing["streak"]); err == nil && prevStreak > 0 {
			streak = prevStreak + 1
		}
	}
	fields := map[string]interface{}{
		"date":   now.Format("2006-01-02"),
		"streak": strconv.Itoa(streak),
	}
	if body.Lat != nil {
		fields["lat"] = fmt.Sprintf("%.6f", *body.Lat)
	}
	if body.Lon != nil {
		fields["lon"] = fmt.Sprintf("%.6f", *body.Lon)
	}
	if err := client.HSet(r.Context(), key, fields).Err(); err != nil {
		s.logger.Error("check-in redis write failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := client.Expire(r.Context(), key, checkInRedisTTL).Err(); err != nil {
		s.logger.Error("check-in redis ttl failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, riderCheckInResponse{
		PointsEarned: 0,
		StreakDays:   streak,
		BonusPoints:  0,
		CheckedInAt:  now,
	})
}
