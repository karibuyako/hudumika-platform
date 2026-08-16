package api

// RIDER-SELF bounded context (backend/DATA-MODEL.md §riders; ERROR-CODES.md
// §Rider self service): the rider's personal settings — preferences, goals,
// expenses, trusted emergency contacts, security posture, destination filter
// and safety events. Every handler is rider-gated through riderOpsRider
// (GetByOwner(subject user id) → 404 when no rider row; no database → 500).
//
// Deviations, documented honestly:
//   - Contract enums win over the draft values: rider_expenses.category and
//     safety_events.kind CHECK constraints hold the generated contract enums
//     (equipment/fuel/insurance/maintenance/other/tax_deduction and
//     crash_detected/fall_detected/fatigue_detected/rest_enforced/
//     threat_detected), not the draft's (fuel/maintenance/food/other and
//     sos/accident/harassment/road_hazard/other). The API layer stores
//     contract strings verbatim so reads round-trip without mapping.
//   - rider_preferences.language is the contract language; the rest of the
//     contract surface (autoAccept, soundNotifications, longDistance,
//     wifiOnlyMaps, destinationFilters) lives in the notifications jsonb.
//     theme stays at its 'system' default — the contract has no theme field.
//   - rider_goals persists only earningsGoalTZS (weekly_earnings_tzs);
//     hoursGoalPerWeek, peakHourAlerts and weeklyAvailability are validated
//     but have no storage column, so they read back zero/omitted.
//     weekly_deliveries is reserved for a future contract weeklyDeliveries
//     field and is never written.
//   - rider_expenses.incurredAt lands in created_at; deductible and
//     receiptUrl have no storage column and read back omitted.
//   - trusted_contacts persists name/phone/relation only; notifiedOnSos and
//     shareLocation have no storage column and read back omitted.
//   - destination_filters.areas (jsonb) holds the single contract
//     DestinationFilter as a one-element array; the contract has no GET path,
//     so the filter is write-only.
//   - GET /riders/me/security returns {securityScore, alerts}: the draft's
//     pinEnabled/maskedPhone fields never landed in the generated schema, so
//     there is no PIN or masked-phone surface to expose (and no contract path
//     reads or sets a PIN — rider_security rows stay unused). With no fraud
//     engine wired the honest answer is a zero score and no alerts.
//   - ReportSafetyEvent stores the contract type as kind, the details map as
//     JSON in the description text column, and echoes source back (no column);
//     severity/acknowledged/emergencyContacted are not persisted.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

const (
	// maxTrustedContacts is the per-rider trusted-contact cap (409
	// CONTACT_LIMIT_REACHED beyond it).
	maxTrustedContacts = 10
	// safetyEventRateLimit is the per-rider hourly safety-event budget
	// (429 SAFETY_EVENT_RATE_LIMITED beyond it).
	safetyEventRateLimit  int64 = 3
	safetyEventRateWindow       = time.Hour
)

// riderPreferenceLanguages is the language set accepted by
// PUT /riders/me/preferences (422 PREFERENCES_INVALID otherwise).
var riderPreferenceLanguages = map[string]bool{"en": true, "sw": true, "ar": true}

// riderSelfIsNoRows reports whether err is the no-row sentinel.
func riderSelfIsNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// riderSelfStrPtr builds a *string; nil stays nil.
func riderSelfStrPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// riderPrefsRow is a rider_preferences row projection.
type riderPrefsRow struct {
	language string
	theme    string
	extra    []byte
}

// riderPrefsExtra is the non-language contract preference surface persisted
// as jsonb in rider_preferences.notifications.
type riderPrefsExtra struct {
	AutoAccept         *bool    `json:"autoAccept,omitempty"`
	SoundNotifications bool     `json:"soundNotifications"`
	LongDistance       *bool    `json:"longDistance,omitempty"`
	WifiOnlyMaps       *bool    `json:"wifiOnlyMaps,omitempty"`
	DestinationFilters []string `json:"destinationFilters,omitempty"`
}

// loadRiderPrefs reads the preferences row, or (zero, nil) when absent.
func (s *Server) loadRiderPrefs(ctx context.Context, riderID uuid.UUID) (riderPrefsRow, error) {
	var row riderPrefsRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT language, theme, notifications FROM rider_preferences WHERE rider_id = $1`,
		riderID).Scan(&row.language, &row.theme, &row.extra)
	if riderSelfIsNoRows(err) {
		return riderPrefsRow{}, nil
	}
	if err != nil {
		return riderPrefsRow{}, fmt.Errorf("load rider preferences: %w", err)
	}
	return row, nil
}

// ensureRiderPrefs lazily creates the rider's preferences row with the
// storage defaults and returns it, so GET never 404s a first visit.
func (s *Server) ensureRiderPrefs(ctx context.Context, riderID uuid.UUID) (riderPrefsRow, error) {
	if _, err := s.db.Pool().Exec(ctx,
		`INSERT INTO rider_preferences (rider_id) VALUES ($1) ON CONFLICT (rider_id) DO NOTHING`,
		riderID); err != nil {
		return riderPrefsRow{}, fmt.Errorf("ensure rider preferences: %w", err)
	}
	return s.loadRiderPrefs(ctx, riderID)
}

// toRiderPreferences maps the stored row onto the contract RiderPreferences.
func toRiderPreferences(row riderPrefsRow) gen.RiderPreferences {
	lang := row.language
	out := gen.RiderPreferences{Language: &lang}
	var extra riderPrefsExtra
	if len(row.extra) > 0 {
		_ = json.Unmarshal(row.extra, &extra)
	}
	out.SoundNotifications = extra.SoundNotifications
	out.AutoAccept = extra.AutoAccept
	out.LongDistance = extra.LongDistance
	out.WifiOnlyMaps = extra.WifiOnlyMaps
	if len(extra.DestinationFilters) > 0 {
		out.DestinationFilters = &extra.DestinationFilters
	}
	return out
}

// GetRiderPreferences returns the caller rider's preferences (GET
// /riders/me/preferences). The first visit lazily creates the storage
// defaults, so the response is always the rider's own row.
func (s *Server) GetRiderPreferences(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	row, err := s.ensureRiderPrefs(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("rider preferences lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderPreferences(row))
}

// riderPrefsUpdate is the PUT /riders/me/preferences body. The contract
// reuses RiderPreferences, whose soundNotifications is a plain bool — an
// absent key would be indistinguishable from false — so the update shape
// uses pointers and only present fields overwrite the stored values.
type riderPrefsUpdate struct {
	AutoAccept         *bool     `json:"autoAccept"`
	DestinationFilters *[]string `json:"destinationFilters"`
	Language           *string   `json:"language"`
	LongDistance       *bool     `json:"longDistance"`
	SoundNotifications *bool     `json:"soundNotifications"`
	WifiOnlyMaps       *bool     `json:"wifiOnlyMaps"`
}

// PutRiderPreferences updates the caller rider's preferences (PUT
// /riders/me/preferences). A language outside en|sw|ar is 422
// PREFERENCES_INVALID; omitted fields keep their current values.
func (s *Server) PutRiderPreferences(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body riderPrefsUpdate
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Language != nil && !riderPreferenceLanguages[*body.Language] {
		writeError(w, http.StatusUnprocessableEntity, "PREFERENCES_INVALID", "language must be one of en, sw, ar")
		return
	}

	cur, err := s.ensureRiderPrefs(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("rider preferences load failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	language := cur.language
	if body.Language != nil {
		language = *body.Language
	}
	extra := riderPrefsExtra{}
	if len(cur.extra) > 0 {
		_ = json.Unmarshal(cur.extra, &extra)
	}
	if body.AutoAccept != nil {
		extra.AutoAccept = body.AutoAccept
	}
	if body.SoundNotifications != nil {
		extra.SoundNotifications = *body.SoundNotifications
	}
	if body.LongDistance != nil {
		extra.LongDistance = body.LongDistance
	}
	if body.WifiOnlyMaps != nil {
		extra.WifiOnlyMaps = body.WifiOnlyMaps
	}
	if body.DestinationFilters != nil {
		extra.DestinationFilters = *body.DestinationFilters
	}
	raw, err := json.Marshal(extra)
	if err != nil {
		s.logger.Error("rider preferences marshal failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO rider_preferences (rider_id, language, notifications)
		 VALUES ($1, $2, $3::jsonb)
		 ON CONFLICT (rider_id) DO UPDATE
		   SET language = EXCLUDED.language, notifications = EXCLUDED.notifications, updated_at = now()`,
		rider.ID, language, string(raw)); err != nil {
		s.logger.Error("rider preferences upsert failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := s.loadRiderPrefs(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("rider preferences reload failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderPreferences(row))
}

// loadRiderGoals reads the persisted earnings goal (weekly_earnings_tzs), or
// (0, nil) when no row exists.
func (s *Server) loadRiderGoals(ctx context.Context, riderID uuid.UUID) (int64, error) {
	var earnings int64
	err := s.db.Pool().QueryRow(ctx,
		`SELECT weekly_earnings_tzs FROM rider_goals WHERE rider_id = $1`,
		riderID).Scan(&earnings)
	if riderSelfIsNoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("load rider goals: %w", err)
	}
	return earnings, nil
}

// toRiderGoals maps the persisted earnings goal onto the contract
// RiderGoals. hoursGoalPerWeek / peakHourAlerts / weeklyAvailability have no
// storage column (see the package comment) and read as zero/omitted.
func toRiderGoals(earningsTZS int64) gen.RiderGoals {
	return gen.RiderGoals{
		EarningsGoalTZS:  int(earningsTZS),
		HoursGoalPerWeek: 0,
	}
}

// GetRiderGoals returns the caller rider's goals (GET /riders/me/goals): the
// persisted earnings goal, or the lazy zero row on first visit.
func (s *Server) GetRiderGoals(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	earnings, err := s.loadRiderGoals(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("rider goals lookup failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderGoals(earnings))
}

// PutRiderGoals upserts the caller rider's goals (PUT /riders/me/goals).
// Negative earnings/hours goals — or a weekly-availability day outside
// 0..6 — are 422 GOALS_INVALID. Only earningsGoalTZS persists (see the
// package comment); the response reflects the persisted state.
func (s *Server) PutRiderGoals(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.PutRiderGoalsJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.EarningsGoalTZS < 0 || body.HoursGoalPerWeek < 0 {
		writeError(w, http.StatusUnprocessableEntity, "GOALS_INVALID", "earningsGoalTZS and hoursGoalPerWeek must be non-negative")
		return
	}
	if body.WeeklyAvailability != nil {
		for _, slot := range *body.WeeklyAvailability {
			if slot.DayOfWeek < 0 || slot.DayOfWeek > 6 {
				writeError(w, http.StatusUnprocessableEntity, "GOALS_INVALID", "weeklyAvailability dayOfWeek must be within 0..6")
				return
			}
		}
	}

	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO rider_goals (rider_id, weekly_earnings_tzs)
		 VALUES ($1, $2)
		 ON CONFLICT (rider_id) DO UPDATE
		   SET weekly_earnings_tzs = EXCLUDED.weekly_earnings_tzs, updated_at = now()`,
		rider.ID, int64(body.EarningsGoalTZS)); err != nil {
		s.logger.Error("rider goals upsert failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	earnings, err := s.loadRiderGoals(r.Context(), rider.ID)
	if err != nil {
		s.logger.Error("rider goals reload failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderGoals(earnings))
}

// riderExpenseRow is a rider_expenses row projection.
type riderExpenseRow struct {
	id        uuid.UUID
	category  string
	amountTZS int64
	note      *string
	createdAt time.Time
}

const riderExpenseColumns = `id, rider_id, category, amount_tzs, note, created_at`

func scanRiderExpense(row *riderExpenseRow, s interface{ Scan(...any) error }) error {
	var riderID uuid.UUID
	return s.Scan(&row.id, &riderID, &row.category, &row.amountTZS, &row.note, &row.createdAt)
}

// toRiderExpense maps a row onto the contract RiderExpense. incurredAt reads
// from created_at; deductible and receiptUrl have no column and read back
// omitted.
func toRiderExpense(row riderExpenseRow) gen.RiderExpense {
	id := newUUID(row.id.String())
	return gen.RiderExpense{
		Id:         &id,
		Category:   gen.RiderExpenseCategory(row.category),
		AmountTZS:  int(row.amountTZS),
		IncurredAt: row.createdAt,
		Note:       row.note,
	}
}

// CreateRiderExpense records an expense for the caller rider (POST
// /riders/me/expenses). An unknown category or a negative amount is 422
// EXPENSE_INVALID. incurredAt lands in created_at (see the package comment).
func (s *Server) CreateRiderExpense(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.CreateRiderExpenseJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Category.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "EXPENSE_INVALID",
			"category must be one of equipment, fuel, insurance, maintenance, other, tax_deduction")
		return
	}
	if body.AmountTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "EXPENSE_INVALID", "amountTZS must be non-negative")
		return
	}
	if body.IncurredAt.IsZero() {
		writeError(w, http.StatusUnprocessableEntity, "EXPENSE_INVALID", "incurredAt is required")
		return
	}

	id := uuid.New()
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO rider_expenses (id, rider_id, category, amount_tzs, note, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		id, rider.ID, string(body.Category), int64(body.AmountTZS), body.Note, body.IncurredAt); err != nil {
		s.logger.Error("create rider expense failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toRiderExpense(riderExpenseRow{
		id:        id,
		category:  string(body.Category),
		amountTZS: int64(body.AmountTZS),
		note:      body.Note,
		createdAt: body.IncurredAt,
	}))
}

// ListRiderExpenses returns the caller rider's expenses (GET
// /riders/me/expenses), newest first. The contract's from/to date window is
// applied to incurredAt (created_at); pagination is a documented extension
// mirroring ListRiderShifts: limit (default 20, max 100) and offset query
// parameters, response stays a plain array.
func (s *Server) ListRiderExpenses(w http.ResponseWriter, r *http.Request, params gen.ListRiderExpensesParams) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	query := `SELECT ` + riderExpenseColumns + ` FROM rider_expenses WHERE rider_id = $1`
	args := []any{rider.ID}
	argi := 2
	if params.From != nil {
		query += fmt.Sprintf(` AND created_at >= $%d`, argi)
		args = append(args, (*params.From).Time)
		argi++
	}
	if params.To != nil {
		query += fmt.Sprintf(` AND created_at < $%d`, argi)
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
	query += fmt.Sprintf(` ORDER BY created_at DESC, id LIMIT $%d OFFSET $%d`, argi, argi+1)
	args = append(args, limit, offset)

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list rider expenses failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.RiderExpense, 0, limit)
	for rows.Next() {
		var row riderExpenseRow
		if err := scanRiderExpense(&row, rows); err != nil {
			s.logger.Error("scan rider expense failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toRiderExpense(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate rider expenses failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// trustedContactRow is a trusted_contacts row projection.
type trustedContactRow struct {
	id        uuid.UUID
	name      string
	phone     string
	relation  *string
	createdAt time.Time
}

// toTrustedContact maps a row onto the contract TrustedContact.
// notifiedOnSos and shareLocation have no column and read back omitted.
func toTrustedContact(row trustedContactRow) gen.TrustedContact {
	id := newUUID(row.id.String())
	return gen.TrustedContact{
		Id:           &id,
		Name:         row.name,
		Phone:        row.phone,
		Relationship: row.relation,
	}
}

// ListTrustedContacts returns the caller rider's trusted contacts (GET
// /riders/me/contacts), oldest first.
func (s *Server) ListTrustedContacts(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, rider_id, name, phone, relation, created_at
		 FROM trusted_contacts WHERE rider_id = $1 ORDER BY created_at, id`,
		rider.ID)
	if err != nil {
		s.logger.Error("list trusted contacts failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.TrustedContact, 0, 10)
	for rows.Next() {
		var row trustedContactRow
		var riderID uuid.UUID
		if err := rows.Scan(&row.id, &riderID, &row.name, &row.phone, &row.relation, &row.createdAt); err != nil {
			s.logger.Error("scan trusted contact failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toTrustedContact(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate trusted contacts failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateTrustedContact adds an emergency contact for the caller rider (POST
// /riders/me/contacts). name and phone are required (422 VALIDATION_FAILED);
// the 11th contact is 409 CONTACT_LIMIT_REACHED. notifiedOnSos and
// shareLocation are accepted but not persisted (see the package comment).
func (s *Server) CreateTrustedContact(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.CreateTrustedContactJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" || body.Phone == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and phone are required")
		return
	}

	var count int
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT count(*) FROM trusted_contacts WHERE rider_id = $1`, rider.ID).Scan(&count); err != nil {
		s.logger.Error("trusted contact count failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if count >= maxTrustedContacts {
		writeError(w, http.StatusConflict, "CONTACT_LIMIT_REACHED", "A rider may have at most 10 trusted contacts")
		return
	}

	id := uuid.New()
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO trusted_contacts (id, rider_id, name, phone, relation)
		 VALUES ($1, $2, $3, $4, $5)`,
		id, rider.ID, body.Name, body.Phone, body.Relationship); err != nil {
		s.logger.Error("create trusted contact failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toTrustedContact(trustedContactRow{
		id:       id,
		name:     body.Name,
		phone:    body.Phone,
		relation: body.Relationship,
	}))
}

// riderSecurityAlert is one alert of the contract security response.
type riderSecurityAlert struct {
	Type     string    `json:"type"`
	Severity string    `json:"severity"`
	At       time.Time `json:"at"`
}

// riderSecurityResponse is the contract GET /riders/me/security body (the
// schema is inline, so no named gen type exists).
type riderSecurityResponse struct {
	SecurityScore int                  `json:"securityScore"`
	Alerts        []riderSecurityAlert `json:"alerts"`
}

// GetRiderSecurity returns the caller rider's fraud/security posture (GET
// /riders/me/security). The generated response is {securityScore, alerts} —
// the draft's pinEnabled/maskedPhone fields never landed (see the package
// comment) — so with no fraud engine wired the honest answer is a zero score
// and an empty alert list.
func (s *Server) GetRiderSecurity(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.riderOpsRider(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, riderSecurityResponse{
		SecurityScore: 0,
		Alerts:        []riderSecurityAlert{},
	})
}

// SetDestinationFilter saves the caller rider's destination filter (PUT
// /riders/me/destination-filter). The filter needs at least an area or
// coordinates (422 DEST_FILTER_INVALID); out-of-range coordinates are also
// 422 DEST_FILTER_INVALID. The single contract filter is stored as a
// one-element array in destination_filters.areas (jsonb); there is no GET
// path, so the filter is write-only.
func (s *Server) SetDestinationFilter(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.SetDestinationFilterJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Area == nil && body.Lat == nil && body.Lon == nil {
		writeError(w, http.StatusUnprocessableEntity, "DEST_FILTER_INVALID",
			"destination filter needs at least an area or coordinates")
		return
	}
	if body.Lat != nil && (*body.Lat < -90 || *body.Lat > 90) {
		writeError(w, http.StatusUnprocessableEntity, "DEST_FILTER_INVALID", "lat must be within -90..90")
		return
	}
	if body.Lon != nil && (*body.Lon < -180 || *body.Lon > 180) {
		writeError(w, http.StatusUnprocessableEntity, "DEST_FILTER_INVALID", "lon must be within -180..180")
		return
	}

	raw, err := json.Marshal([]gen.DestinationFilter{body})
	if err != nil {
		s.logger.Error("destination filter marshal failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO destination_filters (rider_id, areas)
		 VALUES ($1, $2::jsonb)
		 ON CONFLICT (rider_id) DO UPDATE
		   SET areas = EXCLUDED.areas, updated_at = now()`,
		rider.ID, string(raw)); err != nil {
		s.logger.Error("destination filter upsert failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// ClearDestinationFilter removes the caller rider's destination filter
// (DELETE /riders/me/destination-filter). Clearing an absent filter is a
// no-op success, so the response is 204 either way.
func (s *Server) ClearDestinationFilter(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM destination_filters WHERE rider_id = $1`, rider.ID); err != nil {
		s.logger.Error("destination filter clear failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// safetyEventRow is a safety_events row projection.
type safetyEventRow struct {
	id          uuid.UUID
	kind        string
	lat         *float64
	lon         *float64
	description *string
	createdAt   time.Time
}

// toSafetyEvent maps a row onto the contract SafetyEvent. kind reads back as
// type, the details JSON is decoded from the description column, and source
// is echoed as "manual" (it is not persisted — see the package comment).
func toSafetyEvent(riderID uuid.UUID, row safetyEventRow) gen.SafetyEvent {
	id := newUUID(row.id.String())
	rider := newUUID(riderID.String())
	out := gen.SafetyEvent{
		Id:        &id,
		RiderId:   &rider,
		CreatedAt: &row.createdAt,
		Type:      gen.SafetyEventType(row.kind),
		Source:    gen.SafetyEventSourceManual,
	}
	if row.lat != nil {
		v := float32(*row.lat)
		out.Lat = &v
	}
	if row.lon != nil {
		v := float32(*row.lon)
		out.Lon = &v
	}
	if row.description != nil {
		var details map[string]interface{}
		if err := json.Unmarshal([]byte(*row.description), &details); err == nil {
			out.Details = &details
		}
	}
	return out
}

// ReportSafetyEvent records a safety event for the caller rider (POST
// /riders/me/safety-events). Unknown source/type values are 422
// SAFETY_EVENT_INVALID and out-of-range coordinates are 422
// LOCATION_INVALID; the per-rider budget is 3 reports per hour (429
// SAFETY_EVENT_RATE_LIMITED). The contract details map is stored as JSON in
// the description column (see the package comment).
func (s *Server) ReportSafetyEvent(w http.ResponseWriter, r *http.Request) {
	rider, ok := s.riderOpsRider(w, r)
	if !ok {
		return
	}
	var body gen.ReportSafetyEventJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Source.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "SAFETY_EVENT_INVALID",
			"source must be one of accelerometer, camera, gps, gyroscope, manual, system")
		return
	}
	if !body.Type.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "SAFETY_EVENT_INVALID",
			"type must be one of crash_detected, fall_detected, fatigue_detected, rest_enforced, threat_detected")
		return
	}
	if body.Lat != nil && (*body.Lat < -90 || *body.Lat > 90) {
		writeError(w, http.StatusUnprocessableEntity, "LOCATION_INVALID", "lat must be within -90..90")
		return
	}
	if body.Lon != nil && (*body.Lon < -180 || *body.Lon > 180) {
		writeError(w, http.StatusUnprocessableEntity, "LOCATION_INVALID", "lon must be within -180..180")
		return
	}

	decision, err := s.stores.Rate.Allow(r.Context(), "rider:safety:"+rider.ID.String(),
		safetyEventRateLimit, safetyEventRateWindow, time.Now())
	if err != nil {
		s.logger.Warn("safety event rate limit store failed", "rider", rider.ID, "error", err)
	} else if !decision.Allowed {
		writeErrorWithRetry(w, http.StatusTooManyRequests, "SAFETY_EVENT_RATE_LIMITED",
			"Safety event reports are throttled", int(decision.RetryAfter.Seconds()))
		return
	}

	var description *string
	if body.Details != nil {
		raw, err := json.Marshal(body.Details)
		if err != nil {
			s.logger.Error("safety event details marshal failed", "rider", rider.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		description = riderSelfStrPtr(string(raw))
	}
	id := uuid.New()
	var lat, lon *float64
	if body.Lat != nil {
		v := float64(*body.Lat)
		lat = &v
	}
	if body.Lon != nil {
		v := float64(*body.Lon)
		lon = &v
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO safety_events (id, rider_id, kind, lat, lon, description)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		id, rider.ID, string(body.Type), lat, lon, description); err != nil {
		s.logger.Error("create safety event failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toSafetyEvent(rider.ID, safetyEventRow{
		id:          id,
		kind:        string(body.Type),
		lat:         lat,
		lon:         lon,
		description: description,
		createdAt:   time.Now(),
	}))
}
