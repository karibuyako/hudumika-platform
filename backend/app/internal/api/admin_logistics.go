package api

// ADMIN-LOGISTICS bounded context (API-CONTRACT.yaml /admin/hubs/{hubId}/dashboard,
// /admin/logistics/control-tower, /admin/shipments/{shipmentId}/escalate,
// /admin/riders/{riderId}/cod and /admin/risk/cases): hub operations
// dashboards, the logistics network control tower, the dispatcher escalation
// registry (incident/safety), rider COD reconciliation shift sessions and the
// trust & risk case review surface.
//
// Gating: routePolicy restricts /admin/* to MFA-verified staff before the
// handler runs; the handlers resolve the session and fail hard (500
// INTERNAL_ERROR) when no database is wired (dev, no DATABASE_URL). Write
// bodies are validated BEFORE the database gate so malformed requests answer
// 422 without touching state.
//
// Mapping notes:
//   - HubDashboard.load.incoming/outgoing/awaitingSort derive from the
//     shipments physically at the hub (custody_hub_id) by status
//     (at_hub/in_transit/pending); capacityPct, sortationQueues and
//     staffOnDuty are honest zeros until capacity sensing, sortation and
//     hub-attendance pipelines land (attendance is merchant-scoped, 00024).
//     updatedAt is the newest shipment event at the hub (or the hub's
//     created_at when the ledger is empty).
//   - ControlTower totals: activeShipments sums the in-flight statuses,
//     exceptions counts the exception status, atRisk is the open escalation
//     count (escalated shipments are the at-risk set), delayed is an honest
//     zero (no delay-detection pipeline yet) and tripsByHub groups the
//     in-progress trips by origin hub. criticalExceptions is an empty array:
//     escalations surface through atRisk until a typed exception
//     classification pipeline exists. Network hub/vehicle aggregates (hubs
//     count, vehicles in maintenance) have no ControlTower field in this
//     contract revision and are omitted (see AdminOperationsControlTower).
//   - RiderCodReconciliation: cod_reconciliation_sessions are the shift
//     ledger; expected_tzs is seeded by ops (0 by default) because COD order
//     linkage requires the orders payment_method column, which lands later.
//     A GET that finds no session for a rider opens one so the surface is
//     always actionable.
//   - RiskCase: risk_events rows (00029) map onto the case shape; severity
//     derives from the numeric score (>= 0.9 critical, >= 0.66 high,
//     >= 0.33 medium, else low). Review decisions persist into status
//     (dismissed/resolved), reviewed_by, resolution (the admin's reason) and
//     reviewed_at; the exact decided action is not persisted by risk_events,
//     so decidedAction round-trips only for dismissals (derived from status)
//     — documented limitation.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Admin risk-case list pagination bounds (page size 25: the contract has no
// pagination parameters, so limit/offset ride the raw query string).
const (
	defaultAdminRiskCaseLimit = 25
	maxAdminRiskCaseLimit     = 100
)

// codShiftStatusToGen maps a stored session status onto the contract
// shift status: open -> pending, reconciled -> reconciled, exception ->
// mismatch.
func codShiftStatusToGen(status string) gen.RiderCodReconciliationShiftsStatus {
	switch status {
	case "reconciled":
		return gen.RiderCodReconciliationShiftsStatusReconciled
	case "exception":
		return gen.RiderCodReconciliationShiftsStatusMismatch
	}
	return gen.RiderCodReconciliationShiftsStatusPending
}

// ---- hub dashboard ----

// AdminHubDashboard returns the hub operations dashboard (GET
// /admin/hubs/{hubId}/dashboard). A missing hub is 404
// HUB_DASHBOARD_UNAVAILABLE; the load bucket comes from one GROUP BY over
// the shipments physically at the hub (custody_hub_id) and vehiclesPresent
// counts the vehicles parked at the hub.
func (s *Server) AdminHubDashboard(w http.ResponseWriter, r *http.Request, hubId openapi_types.UUID) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("hub dashboard failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	hub, err := logistics.NewStore(s.db.Pool()).GetHub(ctx, uuid.UUID(hubId))
	if errors.Is(err, logistics.ErrNotFound) {
		writeError(w, http.StatusNotFound, "HUB_DASHBOARD_UNAVAILABLE", "Hub not found")
		return
	}
	if err != nil {
		s.logger.Error("hub dashboard hub lookup failed", "hub", hubId, "error", err)
		writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
		return
	}

	load := struct {
		AwaitingSort *int     `json:"awaitingSort,omitempty"`
		CapacityPct  *float32 `json:"capacityPct,omitempty"`
		Exceptions   *int     `json:"exceptions,omitempty"`
		Incoming     *int     `json:"incoming,omitempty"`
		Outgoing     *int     `json:"outgoing,omitempty"`
	}{
		Incoming:     analyticsIntPtr(0),
		Outgoing:     analyticsIntPtr(0),
		AwaitingSort: analyticsIntPtr(0),
		Exceptions:   analyticsIntPtr(0),
		CapacityPct:  float32Ptr(float64(0)),
	}
	rows, err := s.db.Pool().Query(ctx,
		`SELECT status, count(*) FROM shipments WHERE custody_hub_id = $1 GROUP BY status`,
		uuid.UUID(hubId))
	if err != nil {
		s.logger.Error("hub dashboard shipments query failed", "hub", hubId, "error", err)
		writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
		return
	}
	for rows.Next() {
		var (
			status string
			count  int
		)
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			s.logger.Error("hub dashboard scan failed", "hub", hubId, "error", err)
			writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
			return
		}
		switch status {
		case logistics.StatusAtHub:
			*load.Incoming += count
		case logistics.StatusInTransit:
			*load.Outgoing += count
		case logistics.StatusPending:
			*load.AwaitingSort += count
		case logistics.StatusException:
			*load.Exceptions += count
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("hub dashboard iterate failed", "hub", hubId, "error", err)
		writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
		return
	}
	rows.Close()

	vehiclesPresent := 0
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM vehicles WHERE hub_id = $1`, uuid.UUID(hubId)).Scan(&vehiclesPresent); err != nil {
		s.logger.Error("hub dashboard vehicles query failed", "hub", hubId, "error", err)
		writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
		return
	}

	openEscalations := 0
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM shipment_escalations e
		 JOIN shipments sh ON sh.id = e.shipment_id
		 WHERE e.status = 'open' AND sh.custody_hub_id = $1`, uuid.UUID(hubId)).Scan(&openEscalations); err != nil {
		s.logger.Error("hub dashboard escalations query failed", "hub", hubId, "error", err)
		writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
		return
	}

	updatedAt := hub.CreatedAt
	var lastEvent *time.Time
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT max(at) FROM shipment_events WHERE hub_id = $1`, uuid.UUID(hubId)).Scan(&lastEvent); err != nil {
		s.logger.Error("hub dashboard events query failed", "hub", hubId, "error", err)
		writeError(w, http.StatusInternalServerError, "HUB_DASHBOARD_UNAVAILABLE", "Hub dashboard is unavailable")
		return
	}
	if lastEvent != nil {
		updatedAt = *lastEvent
	}

	writeJSON(w, http.StatusOK, gen.HubDashboard{
		HubId: newUUID(hub.ID.String()),
		Name:  hub.Name,
		Load:  load,
		SortationQueues: &[]struct {
			Count int    `json:"count"`
			Zone  string `json:"zone"`
		}{},
		StaffOnDuty:     analyticsIntPtr(0),
		VehiclesPresent: analyticsIntPtr(vehiclesPresent),
		UpdatedAt:       &updatedAt,
	})
}

// ---- logistics control tower ----

// LogisticsControlTower returns the network-wide logistics snapshot (GET
// /admin/logistics/control-tower): shipments by status, in-progress trips
// (total and per origin hub), the open escalation count (the at-risk set)
// and the exception count.
func (s *Server) LogisticsControlTower(w http.ResponseWriter, r *http.Request) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("logistics control tower failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	now := time.Now()

	statusCounts := map[string]int{}
	rows, err := s.db.Pool().Query(ctx, `SELECT status, count(*) FROM shipments GROUP BY status`)
	if err != nil {
		s.logger.Error("control tower shipments query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
		return
	}
	for rows.Next() {
		var (
			status string
			count  int
		)
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			s.logger.Error("control tower shipments scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
			return
		}
		statusCounts[status] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("control tower shipments iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
		return
	}
	rows.Close()

	activeShipments := 0
	for _, status := range []string{logistics.StatusPending, logistics.StatusAtHub, logistics.StatusInTransit, logistics.StatusOutForDelivery} {
		activeShipments += statusCounts[status]
	}
	exceptions := statusCounts[logistics.StatusException]

	var activeTrips int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM trips WHERE status = 'in_progress'`).Scan(&activeTrips); err != nil {
		s.logger.Error("control tower trips query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
		return
	}

	var openEscalations int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM shipment_escalations WHERE status = 'open'`).Scan(&openEscalations); err != nil {
		s.logger.Error("control tower escalations query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
		return
	}

	tripsByHub := make([]struct {
		HubName string `json:"hubName"`
		Trips   int    `json:"trips"`
	}, 0, 8)
	rows, err = s.db.Pool().Query(ctx,
		`SELECT COALESCE(h.name, 'Unassigned'), count(*)
		 FROM trips t
		 LEFT JOIN hubs h ON h.id = t.origin_hub_id
		 WHERE t.status = 'in_progress'
		 GROUP BY h.name
		 ORDER BY count(*) DESC, h.name`)
	if err != nil {
		s.logger.Error("control tower trips-by-hub query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
		return
	}
	for rows.Next() {
		var (
			hubName string
			count   int
		)
		if err := rows.Scan(&hubName, &count); err != nil {
			rows.Close()
			s.logger.Error("control tower trips-by-hub scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
			return
		}
		tripsByHub = append(tripsByHub, struct {
			HubName string `json:"hubName"`
			Trips   int    `json:"trips"`
		}{HubName: hubName, Trips: count})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("control tower trips-by-hub iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "CONTROL_TOWER_UNAVAILABLE", "Control tower is unavailable")
		return
	}
	rows.Close()

	writeJSON(w, http.StatusOK, gen.ControlTower{
		GeneratedAt: now,
		Totals: struct {
			ActiveShipments *int `json:"activeShipments,omitempty"`
			ActiveTrips     *int `json:"activeTrips,omitempty"`
			AtRisk          *int `json:"atRisk,omitempty"`
			Delayed         *int `json:"delayed,omitempty"`
			Exceptions      *int `json:"exceptions,omitempty"`
			TripsByHub      *[]struct {
				HubName string `json:"hubName"`
				Trips   int    `json:"trips"`
			} `json:"tripsByHub,omitempty"`
		}{
			ActiveShipments: analyticsIntPtr(activeShipments),
			Exceptions:      analyticsIntPtr(exceptions),
			Delayed:         analyticsIntPtr(0),
			AtRisk:          analyticsIntPtr(openEscalations),
			ActiveTrips:     analyticsIntPtr(activeTrips),
			TripsByHub:      &tripsByHub,
		},
		CriticalExceptions: []struct {
			Detail     *string                                `json:"detail,omitempty"`
			ShipmentId string                                 `json:"shipmentId"`
			Type       gen.ControlTowerCriticalExceptionsType `json:"type"`
		}{},
	})
}

// ---- shipment escalation ----

// AdminEscalateShipment records a dispatcher incident/safety escalation for a
// shipment (POST /admin/shipments/{shipmentId}/escalate). Only in-transit or
// exception shipments may be escalated (409 SHIPMENT_NOT_ESCALATABLE
// otherwise); a missing shipment is 404 SHIPMENT_NOT_FOUND and an empty
// reason is 422 ADMIN_REASON_REQUIRED. The escalation row and an 'escalated'
// waybill event land in one transaction; the shipment itself is returned.
func (s *Server) AdminEscalateShipment(w http.ResponseWriter, r *http.Request, shipmentId openapi_types.UUID) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.AdminEscalateShipmentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("admin escalate failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	reason := strings.TrimSpace(body.Reason)
	actor := s.resolvedActorID(r)

	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("admin escalate begin failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM shipments WHERE id = $1 FOR UPDATE`, uuid.UUID(shipmentId)).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "SHIPMENT_NOT_FOUND", "Shipment not found")
		return
	}
	if err != nil {
		s.logger.Error("admin escalate shipment lookup failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if status != logistics.StatusInTransit && status != logistics.StatusException {
		writeError(w, http.StatusConflict, "SHIPMENT_NOT_ESCALATABLE", "Only in-transit or exception shipments can be escalated")
		return
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_escalations (shipment_id, escalated_by, reason)
		 VALUES ($1, $2, $3)`, uuid.UUID(shipmentId), actor, reason); err != nil {
		s.logger.Error("admin escalate insert failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note)
		 VALUES ($1, 'escalated', $2, $3)`, uuid.UUID(shipmentId), actor, reason); err != nil {
		s.logger.Error("admin escalate event failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("admin escalate commit failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	detail, err := logistics.NewStore(s.db.Pool()).GetShipmentDetail(ctx, uuid.UUID(shipmentId))
	if err != nil {
		s.logger.Error("admin escalate reload failed", "shipment", shipmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenShipment(detail.Shipment, detail.Packages))
}

// resolvedActorID resolves the session subject to a users row id, best-effort
// (nil when the subject has no account — the ledger and escalation records
// stay readable without one).
func (s *Server) resolvedActorID(r *http.Request) *uuid.UUID {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil
	}
	if id, ok := s.userIDByPhone(r.Context(), claims.Subject); ok {
		return &id
	}
	return nil
}

// ---- rider COD reconciliation ----

// codSessionRow is one cod_reconciliation_sessions row (migration 00039).
type codSessionRow struct {
	ID           uuid.UUID
	ShiftID      *uuid.UUID
	StartedAt    time.Time
	EndedAt      *time.Time
	CollectedTZ  int64
	ExpectedTZ   int64
	Status       string
	ReconciledBy *uuid.UUID
	Note         *string
}

const codSessionColumns = `id, shift_id, started_at, ended_at, collected_tzs, expected_tzs, status, reconciled_by, note`

// scanCodSession scans one cod session row (codSessionColumns order).
func scanCodSession(row pgx.Row) (codSessionRow, error) {
	var s codSessionRow
	err := row.Scan(&s.ID, &s.ShiftID, &s.StartedAt, &s.EndedAt, &s.CollectedTZ, &s.ExpectedTZ, &s.Status, &s.ReconciledBy, &s.Note)
	return s, err
}

// AdminRiderCodReconciliation returns the COD reconciliation for a rider (GET
// /admin/riders/{riderId}/cod): the shift sessions (collected vs expected)
// and their totals. When the rider has no session at all, an open session is
// opened so the surface is always actionable. expected_tzs is seeded by ops
// (0 by default) — the COD order linkage (payment_method on orders) lands in
// a later milestone. A missing rider is 404 NOT_FOUND.
func (s *Server) AdminRiderCodReconciliation(w http.ResponseWriter, r *http.Request, riderId openapi_types.UUID, params gen.AdminRiderCodReconciliationParams) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("rider cod reconciliation failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()

	var exists bool
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT true FROM riders WHERE id = $1`, uuid.UUID(riderId)).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Rider not found")
		return
	} else if err != nil {
		s.logger.Error("rider cod rider lookup failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "COD_RECONCILIATION_UNAVAILABLE", "COD reconciliation is unavailable")
		return
	}

	// Open a shift session when the rider has none at all, so the surface
	// always shows the rider's current shift (documented above).
	var sessionCount int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM cod_reconciliation_sessions WHERE rider_id = $1`, uuid.UUID(riderId)).Scan(&sessionCount); err != nil {
		s.logger.Error("rider cod session count failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "COD_RECONCILIATION_UNAVAILABLE", "COD reconciliation is unavailable")
		return
	}
	if sessionCount == 0 {
		if _, err := s.db.Pool().Exec(ctx,
			`INSERT INTO cod_reconciliation_sessions (rider_id, started_at) VALUES ($1, now())`,
			uuid.UUID(riderId)); err != nil {
			s.logger.Error("rider cod open session failed", "rider", riderId, "error", err)
			writeError(w, http.StatusInternalServerError, "COD_RECONCILIATION_UNAVAILABLE", "COD reconciliation is unavailable")
			return
		}
	}

	var from, to *time.Time
	if params.From != nil {
		t := params.From.Time
		from = &t
	}
	if params.To != nil {
		t := params.To.Time.Add(24 * time.Hour)
		to = &t
	}
	query := `SELECT ` + codSessionColumns + ` FROM cod_reconciliation_sessions WHERE rider_id = $1`
	args := []any{uuid.UUID(riderId)}
	if from != nil {
		args = append(args, *from)
		query += ` AND started_at >= $` + strconv.Itoa(len(args))
	}
	if to != nil {
		args = append(args, *to)
		query += ` AND started_at < $` + strconv.Itoa(len(args))
	}
	query += ` ORDER BY started_at DESC`

	rows, err := s.db.Pool().Query(ctx, query, args...)
	if err != nil {
		s.logger.Error("rider cod sessions query failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "COD_RECONCILIATION_UNAVAILABLE", "COD reconciliation is unavailable")
		return
	}
	sessions := make([]codSessionRow, 0, 8)
	for rows.Next() {
		session, err := scanCodSession(rows)
		if err != nil {
			rows.Close()
			s.logger.Error("rider cod session scan failed", "rider", riderId, "error", err)
			writeError(w, http.StatusInternalServerError, "COD_RECONCILIATION_UNAVAILABLE", "COD reconciliation is unavailable")
			return
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("rider cod sessions iterate failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "COD_RECONCILIATION_UNAVAILABLE", "COD reconciliation is unavailable")
		return
	}
	rows.Close()

	var totalExpected, totalCollected int64
	shifts := make([]struct {
		CollectedTZS int                                    `json:"collectedTZS"`
		Date         openapi_types.Date                     `json:"date"`
		ExpectedTZS  int                                    `json:"expectedTZS"`
		Note         *string                                `json:"note,omitempty"`
		ShiftId      openapi_types.UUID                     `json:"shiftId"`
		Status       gen.RiderCodReconciliationShiftsStatus `json:"status"`
	}, 0, len(sessions))
	for _, session := range sessions {
		totalExpected += session.ExpectedTZ
		totalCollected += session.CollectedTZ
		date := openapi_types.Date{Time: session.StartedAt}
		shifts = append(shifts, struct {
			CollectedTZS int                                    `json:"collectedTZS"`
			Date         openapi_types.Date                     `json:"date"`
			ExpectedTZS  int                                    `json:"expectedTZS"`
			Note         *string                                `json:"note,omitempty"`
			ShiftId      openapi_types.UUID                     `json:"shiftId"`
			Status       gen.RiderCodReconciliationShiftsStatus `json:"status"`
		}{
			ShiftId:      newUUID(session.ID.String()),
			Date:         date,
			ExpectedTZS:  int(session.ExpectedTZ),
			CollectedTZS: int(session.CollectedTZ),
			Status:       codShiftStatusToGen(session.Status),
			Note:         session.Note,
		})
	}
	variance := totalCollected - totalExpected

	writeJSON(w, http.StatusOK, gen.RiderCodReconciliation{
		RiderId: newUUID(uuid.UUID(riderId).String()),
		From:    params.From,
		To:      params.To,
		Shifts:  shifts,
		Totals: &struct {
			CollectedTZS *int `json:"collectedTZS,omitempty"`
			ExpectedTZS  *int `json:"expectedTZS,omitempty"`
			VarianceTZS  *int `json:"varianceTZS,omitempty"`
		}{
			ExpectedTZS:  analyticsIntPtr(int(totalExpected)),
			CollectedTZS: analyticsIntPtr(int(totalCollected)),
			VarianceTZS:  analyticsIntPtr(int(variance)),
		},
	})
}

// ---- risk cases ----

// AdminListRiskCases returns the trust & risk cases (GET /admin/risk/cases):
// risk_events rows (00029) mapped onto the RiskCase shape, filtered by the
// contract status/severity params and paginated (limit default 25, max 100;
// offset default 0 — the contract declares no pagination params, so they
// ride the raw query string). The response is never nil ([] when empty).
func (s *Server) AdminListRiskCases(w http.ResponseWriter, r *http.Request, params gen.AdminListRiskCasesParams) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("list risk cases failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()

	limit := defaultAdminRiskCaseLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
			if limit > maxAdminRiskCaseLimit {
				limit = maxAdminRiskCaseLimit
			}
		}
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
			offset = n
		}
	}

	query := `SELECT ` + riskQueryColumns + ` FROM risk_events`
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	var where []string
	if params.Status != nil {
		status, ok := riskStatusInternal(string(*params.Status))
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
		where = append(where, `status = `+arg(status))
	}
	if params.Severity != nil {
		lo, hi, ok := riskSeverityScoreBounds(string(*params.Severity))
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "severity is invalid")
			return
		}
		if hi == nil {
			where = append(where, `score >= `+arg(lo))
		} else {
			where = append(where, `score >= `+arg(lo)+` AND score < `+arg(*hi))
		}
	}
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, ` AND `)
	}
	query += ` ORDER BY created_at DESC, id LIMIT ` + arg(limit) + ` OFFSET ` + arg(offset)

	rows, err := s.db.Pool().Query(ctx, query, args...)
	if err != nil {
		s.logger.Error("list risk cases query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.RiskCase, 0, 16)
	for rows.Next() {
		row, err := scanRisk(rows)
		if err != nil {
			rows.Close()
			s.logger.Error("scan risk case failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, riskCaseToGen(row))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("iterate risk cases failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows.Close()
	writeJSON(w, http.StatusOK, out)
}

// AdminReviewRiskCase decides a risk case (POST /admin/risk/cases/{caseId}/review).
// A missing case is 404 RISK_CASE_NOT_FOUND; a case that is already decided is
// 409 RISK_CASE_ALREADY_DECIDED; the reason is required (422
// ADMIN_REASON_REQUIRED) and the decision must be one of dismiss, block_user,
// block_provider, escalate, hold. dismiss lands status dismissed, every other
// decision lands resolved; the reason and reviewer are persisted on the
// risk_events row.
func (s *Server) AdminReviewRiskCase(w http.ResponseWriter, r *http.Request, caseId openapi_types.UUID) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.AdminReviewRiskCaseJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Action.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action must be dismiss, block_user, block_provider, escalate or hold")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("review risk case failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	reviewer, ok := s.userIDByPhone(ctx, claimsSubject(r))
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated session has no account")
		return
	}

	status := "resolved"
	if body.Action == gen.AdminReviewRiskCaseJSONBodyActionDismiss {
		status = "dismissed"
	}
	var row riskRow
	err := s.db.Pool().QueryRow(ctx,
		`UPDATE risk_events
		 SET status = $1, reviewed_by = $2, resolution = $3, reviewed_at = now()
		 WHERE id = $4 AND status IN ('open', 'in_review')
		 RETURNING `+riskQueryColumns,
		status, reviewer, strings.TrimSpace(body.Reason), caseId).Scan(
		&row.ID, &row.EntityType, &row.EntityID, &row.Signal, &row.Score, &row.Status,
		&row.ReviewedBy, &row.Resolution, &row.CreatedAt, &row.ReviewedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// The guarded UPDATE answered no row: either the case is missing or
		// it was already decided. Distinguish for the correct envelope.
		var existing statusOnly
		if sErr := s.db.Pool().QueryRow(ctx,
			`SELECT status FROM risk_events WHERE id = $1`, caseId).Scan(&existing.Status); sErr != nil {
			if errors.Is(sErr, pgx.ErrNoRows) {
				writeError(w, http.StatusNotFound, "RISK_CASE_NOT_FOUND", "Risk case not found")
				return
			}
			s.logger.Error("review risk case lookup failed", "case", caseId, "error", sErr)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeError(w, http.StatusConflict, "RISK_CASE_ALREADY_DECIDED", "Risk case was already decided")
		return
	}
	if err != nil {
		s.logger.Error("review risk case failed", "case", caseId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, riskCaseToGen(row))
}

// statusOnly is a minimal projection for the already-decided probe.
type statusOnly struct {
	Status string
}

// claimsSubject returns the authenticated subject ("" when absent).
func claimsSubject(r *http.Request) string {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return ""
	}
	return claims.Subject
}

// riskStatusInternal maps a contract risk-case status onto the stored
// risk_events status vocabulary; the second return reports whether the value
// is known.
func riskStatusInternal(contract string) (string, bool) {
	switch contract {
	case "open":
		return "open", true
	case "investigating":
		return "in_review", true
	case "resolved":
		return "resolved", true
	case "dismissed":
		return "dismissed", true
	}
	return "", false
}

// riskSeverityScoreBounds maps a contract severity onto the score half-open
// interval [lo, hi); hi is nil for the top bucket.
func riskSeverityScoreBounds(severity string) (float64, *float64, bool) {
	switch severity {
	case "low":
		return 0, float64Ptr(0.33), true
	case "medium":
		return 0.33, float64Ptr(0.66), true
	case "high":
		return 0.66, float64Ptr(0.9), true
	case "critical":
		return 0.9, nil, true
	}
	return 0, nil, false
}

// riskSeverityToGen derives the contract severity from the stored score.
func riskSeverityToGen(score float64) gen.RiskCaseSeverity {
	switch {
	case score >= 0.9:
		return gen.RiskCaseSeverityCritical
	case score >= 0.66:
		return gen.RiskCaseSeverityHigh
	case score >= 0.33:
		return gen.RiskCaseSeverityMedium
	}
	return gen.RiskCaseSeverityLow
}

// riskCaseToGen maps a risk_events row onto the contract RiskCase shape.
// The signal becomes the single-element signals list; the stored status maps
// open/in_review/resolved/dismissed onto open/investigating/resolved/
// dismissed; the entity reference lands in related when its type is one of
// the contract's related slots; resolution round-trips as reason. decidedAction
// is derived from the status (dismissed -> dismiss); the exact decision is not
// persisted by risk_events (documented above).
func riskCaseToGen(e riskRow) gen.RiskCase {
	out := gen.RiskCase{
		Id:        e.ID,
		Severity:  riskSeverityToGen(e.Score),
		Signals:   []string{e.Signal},
		Status:    gen.RiskCaseStatusOpen,
		CreatedAt: e.CreatedAt,
	}
	switch e.Status {
	case "in_review":
		out.Status = gen.RiskCaseStatusInvestigating
	case "resolved":
		out.Status = gen.RiskCaseStatusResolved
	case "dismissed":
		out.Status = gen.RiskCaseStatusDismissed
		action := "dismiss"
		out.DecidedAction = &action
	}
	if e.Resolution != nil && *e.Resolution != "" {
		out.Reason = e.Resolution
	}
	if e.EntityID != nil {
		related := &struct {
			CustomerUserId *openapi_types.UUID   `json:"customerUserId,omitempty"`
			DeviceIds      *[]string             `json:"deviceIds,omitempty"`
			IpHistory      *[]string             `json:"ipHistory,omitempty"`
			OrderIds       *[]openapi_types.UUID `json:"orderIds,omitempty"`
			ProviderId     *openapi_types.UUID   `json:"providerId,omitempty"`
			RiderId        *openapi_types.UUID   `json:"riderId,omitempty"`
		}{}
		entity := newUUID(e.EntityID.String())
		switch e.EntityType {
		case "user", "customer":
			related.CustomerUserId = &entity
		case "rider":
			related.RiderId = &entity
		case "provider", "merchant":
			related.ProviderId = &entity
		case "order":
			related.OrderIds = &[]openapi_types.UUID{entity}
		default:
			related = nil
		}
		out.Related = related
	}
	return out
}

// ---- helpers ----

func float64Ptr(v float64) *float64 { return &v }
