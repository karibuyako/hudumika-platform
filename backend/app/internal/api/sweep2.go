package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/bookings"
	"github.com/hudumika/api-backend/internal/gen"
)

// sweepBookingRow loads a booking row for the sweep booking handlers,
// mapping a missing row to the 404 envelope. The database must already be
// verified.
func (s *Server) sweepBookingRow(w http.ResponseWriter, r *http.Request, bookingID openapi_types.UUID) *bookings.BookingRow {
	row, err := bookings.NewStore(s.db.Pool()).GetBookingRow(r.Context(), uuid.UUID(bookingID))
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return nil
	}
	if err != nil {
		s.logger.Error("sweep: load booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil
	}
	return row
}

// sweepBookingTransition applies a guarded booking status transition and
// writes the contract envelopes for the two failure modes.
func (s *Server) sweepBookingTransition(w http.ResponseWriter, r *http.Request, row *bookings.BookingRow, from []string, to, note string) (int, bool) {
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return 0, false
	}
	version, err := bookings.NewStore(s.db.Pool()).TransitionBooking(r.Context(), row.ID, row.Version, from, to, actor, note)
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot move to "+to+" in its current state")
		return 0, false
	}
	if err != nil {
		s.logger.Error("booking transition failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return 0, false
	}
	return version, true
}

// bookingNoteAuthorRole maps the caller's role claim onto the contract's
// author-role enum for team notes.
func bookingNoteAuthorRole(role string) string {
	switch role {
	case RoleProvider, RoleMerchant:
		return "provider_owner"
	case RoleRider:
		return "technician"
	case RoleAdmin, RoleOps, RoleFinance, RoleCompliance:
		return "dispatcher"
	default:
		return "supervisor"
	}
}

// AddBookingNote persists an internal team note on a job
// (POST /bookings/{bookingId}/notes). The note is stored as a booking event
// with the caller's role-derived author label.
func (s *Server) AddBookingNote(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.AddBookingNoteJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Body == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body is required")
		return
	}
	if s.db == nil {
		s.logger.Error("add booking note failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	var noteID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO booking_events (booking_id, status, by, note)
		 VALUES ($1, 'note', $2, $3) RETURNING id`,
		row.ID, actor, body.Body).Scan(&noteID); err != nil {
		s.logger.Error("add booking note failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		Id         openapi_types.UUID `json:"id"`
		Body       string             `json:"body"`
		AuthorRole string             `json:"authorRole"`
		CreatedAt  time.Time          `json:"createdAt"`
	}{
		Id:         newUUID(noteID.String()),
		Body:       body.Body,
		AuthorRole: bookingNoteAuthorRole(claims.Role),
		CreatedAt:  time.Now(),
	})
}

// AddBookingParts records parts used on a job (POST /bookings/{bookingId}/parts).
// Parts attach to the booking's latest quote; without a quote there is
// nothing to bill them against, which answers 409. The booking is returned
// unchanged in terms of totals — the parts surface on the final invoice
// (IssueServiceInvoice).
func (s *Server) AddBookingParts(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.AddBookingPartsJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Parts) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one part is required")
		return
	}
	if s.db == nil {
		s.logger.Error("add booking parts failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	var quoteID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id FROM booking_quotes WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
		row.ID).Scan(&quoteID); err != nil {
		writeError(w, http.StatusConflict, "BOOKING_NO_QUOTE", "Booking has no quote to attach parts to")
		return
	}
	for _, p := range body.Parts {
		if p.Quantity <= 0 || p.UnitCostTZS < 0 || p.Name == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "part name, positive quantity and unit cost are required")
			return
		}
	}
	for _, p := range body.Parts {
		if _, err := s.db.Pool().Exec(r.Context(),
			`INSERT INTO booking_parts (quote_id, name, quantity, unit_cost_tzs, total_tzs)
			 VALUES ($1, $2, $3, $4, $5)`,
			quoteID, p.Name, p.Quantity, p.UnitCostTZS, p.Quantity*p.UnitCostTZS); err != nil {
			s.logger.Error("add booking part failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO booking_events (booking_id, status, by, note) VALUES ($1, 'parts_added', $2, $3)`,
		row.ID, actor, ""); err != nil {
		s.logger.Error("parts added event failed", "error", err)
	}
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// CheckInBooking records the provider's arrival at the job location
// (POST /bookings/{bookingId}/check-in). The booking moves to
// provider_arrived; the GPS stamp is kept on the event note.
func (s *Server) CheckInBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.CheckInBookingJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		s.logger.Error("check-in booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	note := "check-in"
	version, ok := s.sweepBookingTransition(w, r, row,
		[]string{"provider_accepted", "scheduled", "in_progress"}, "provider_arrived", note)
	if !ok {
		return
	}
	row.Status = "provider_arrived"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// PauseBooking pauses work on a job (POST /bookings/{bookingId}/pause). The
// 'paused' state is added to the booking status enum in 00050_sweep.sql.
func (s *Server) PauseBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.PauseBookingJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if s.db == nil {
		s.logger.Error("pause booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	version, ok := s.sweepBookingTransition(w, r, row,
		[]string{"provider_arrived", "in_progress", "scheduled"}, "paused", body.Reason)
	if !ok {
		return
	}
	row.Status = "paused"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// AssignBookingTechnician assigns a technician to a booking
// (POST /bookings/{bookingId}/assign-technician). The assignment is a plain
// guarded update (technician_id added in 00050_sweep.sql) plus an event; no
// dispatch workflow exists for re-assignment, so the state is recorded
// as-is.
func (s *Server) AssignBookingTechnician(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.AssignBookingTechnicianJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.TechnicianId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "technicianId is required")
		return
	}
	if s.db == nil {
		s.logger.Error("assign booking technician failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE bookings SET technician_id = $2, updated_at = now() WHERE id = $1`,
		row.ID, uuid.UUID(body.TechnicianId)); err != nil {
		s.logger.Error("assign booking technician failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO booking_events (booking_id, status, by, note) VALUES ($1, 'technician_assigned', $2, $3)`,
		row.ID, actor, note); err != nil {
		s.logger.Error("assign technician event failed", "error", err)
	}
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// IssueServiceInvoice issues the final invoice for a booking
// (POST /bookings/{bookingId}/invoice). Labor comes from the request; parts
// are summed from the booking's quote lines; trip fee and tax carry over
// from the booking; the total is recomputed server-side (never client
// supplied). The invoice row lands in service_invoices (00050_sweep.sql).
func (s *Server) IssueServiceInvoice(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.IssueServiceInvoiceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.LaborTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "laborTZS must not be negative")
		return
	}
	if s.db == nil {
		s.logger.Error("issue service invoice failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	var partsTZS int64
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COALESCE(SUM(bp.total_tzs), 0)
		 FROM booking_parts bp
		 JOIN booking_quotes q ON q.id = bp.quote_id
		 WHERE q.booking_id = $1`,
		row.ID).Scan(&partsTZS); err != nil {
		s.logger.Error("sum booking parts failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	discount := 0
	if body.DiscountTZS != nil {
		discount = *body.DiscountTZS
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	total := int64(body.LaborTZS) + partsTZS + row.DeliveryFeeTZS + row.TaxTZS - int64(discount)
	if total < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "invoice total must not be negative")
		return
	}
	var invoiceID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO service_invoices
		   (booking_id, labor_tzs, parts_tzs, trip_fee_tzs, tax_tzs, discount_tzs, total_tzs, note)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		row.ID, body.LaborTZS, partsTZS, row.DeliveryFeeTZS, row.TaxTZS, discount, total, note).Scan(&invoiceID); err != nil {
		s.logger.Error("issue service invoice insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	issuedAt := time.Now()
	partsInt := int(partsTZS)
	writeJSON(w, http.StatusCreated, gen.ServiceInvoice{
		Id:          newUUID(invoiceID.String()),
		BookingId:   bookingId,
		LaborTZS:    body.LaborTZS,
		PartsTZS:    &partsInt,
		TripFeeTZS:  intPtr(row.DeliveryFeeTZS),
		TaxTZS:      intPtr(row.TaxTZS),
		DiscountTZS: &discount,
		TotalTZS:    int(total),
		Note:        &note,
		Status:      gen.ServiceInvoiceStatus("issued"),
		IssuedAt:    &issuedAt,
	})
}

// IssueServiceWarranty issues a warranty on a completed booking
// (POST /bookings/{bookingId}/warranty, table service_warranties in
// 00050_sweep.sql).
func (s *Server) IssueServiceWarranty(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	var body gen.ServiceWarranty
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.ValidDays <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "validDays must be positive")
		return
	}
	if s.db == nil {
		s.logger.Error("issue service warranty failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row := s.sweepBookingRow(w, r, bookingId)
	if row == nil {
		return
	}
	coverage := ""
	if body.Coverage != nil {
		coverage = *body.Coverage
	}
	var warrantyID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO service_warranties (booking_id, valid_days, coverage, follow_up_at)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		row.ID, body.ValidDays, coverage, body.FollowUpAt).Scan(&warrantyID); err != nil {
		s.logger.Error("issue service warranty insert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	issuedAt := time.Now()
	status := gen.ServiceWarrantyStatus("active")
	writeJSON(w, http.StatusCreated, gen.ServiceWarranty{
		Id:         newUUIDPtr(warrantyID),
		BookingId:  bookingId,
		ValidDays:  body.ValidDays,
		Coverage:   body.Coverage,
		FollowUpAt: body.FollowUpAt,
		IssuedAt:   &issuedAt,
		Status:     &status,
	})
}
