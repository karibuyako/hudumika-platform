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

// ListExpenses returns the caller's expense records (GET /finance/expenses),
// newest first, capped at 100 rows, optionally filtered by incurred-on
// range.
func (s *Server) ListExpenses(w http.ResponseWriter, r *http.Request, params gen.ListExpensesParams) {
	if s.db == nil {
		s.logger.Error("list expenses failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	user, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	query := `SELECT id, category, amount_tzs, incurred_at, note, created_at
	          FROM expenses WHERE owner_user_id = $1`
	args := []any{user}
	if params.From != nil {
		args = append(args, params.From.Time)
		query += " AND incurred_at >= $2"
	}
	if params.To != nil {
		args = append(args, params.To.Time.Add(24*time.Hour))
		query += " AND incurred_at <= $3"
	}
	query += " ORDER BY incurred_at DESC, id LIMIT 100"

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list expenses failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	expenses := make([]gen.ExpenseRecord, 0, 16)
	for rows.Next() {
		var (
			id         uuid.UUID
			category   string
			amountTZS  int64
			incurredAt time.Time
			note       *string
			createdAt  time.Time
		)
		if err := rows.Scan(&id, &category, &amountTZS, &incurredAt, &note, &createdAt); err != nil {
			s.logger.Error("scan expense failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		idGen := newUUID(id.String())
		createdAtGen := createdAt
		expenses = append(expenses, gen.ExpenseRecord{
			Id:         &idGen,
			Category:   gen.ExpenseRecordCategory(category),
			AmountTZS:  int(amountTZS),
			IncurredAt: incurredAt,
			Note:       note,
			CreatedAt:  &createdAtGen,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate expenses failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, expenses)
}

// CreateExpense records an expense for the caller (POST /finance/expenses,
// table expenses in 00050_sweep.sql). The amount must be non-negative
// integer TZS and the incurred date must be present.
func (s *Server) CreateExpense(w http.ResponseWriter, r *http.Request) {
	var body gen.CreateExpenseJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.AmountTZS < 0 || body.Category == "" || body.IncurredAt.IsZero() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS, category and incurredAt are required")
		return
	}
	if s.db == nil {
		s.logger.Error("create expense failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var id uuid.UUID
	var createdAt time.Time
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO expenses (owner_user_id, category, amount_tzs, incurred_at, note)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		userID, string(body.Category), body.AmountTZS, body.IncurredAt, body.Note).Scan(&id, &createdAt); err != nil {
		s.logger.Error("create expense failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	idGen := newUUID(id.String())
	createdAtGen := createdAt
	writeJSON(w, http.StatusCreated, gen.ExpenseRecord{
		Id:         &idGen,
		Category:   body.Category,
		AmountTZS:  body.AmountTZS,
		IncurredAt: body.IncurredAt,
		Note:       body.Note,
		CreatedAt:  &createdAtGen,
	})
}

// DeleteExpense removes one of the caller's expense records
// (DELETE /finance/expenses/{expenseId}). Idempotent: an absent or foreign
// row still answers 204.
func (s *Server) DeleteExpense(w http.ResponseWriter, r *http.Request, expenseId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("delete expense failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM expenses WHERE id = $1 AND owner_user_id = $2`,
		uuid.UUID(expenseId), userID); err != nil {
		s.logger.Error("delete expense failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReportTransactionIssue opens a support ticket for a transaction issue
// (POST /finance/transactions/{transactionId}/issue). The ticket is the
// honest home for the report; there is no issue-resolution pipeline yet, so
// the status is always 'open'.
func (s *Server) ReportTransactionIssue(w http.ResponseWriter, r *http.Request, transactionId openapi_types.UUID) {
	var body gen.ReportTransactionIssueJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.IssueType == "" || body.Description == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "issueType and description are required")
		return
	}
	if s.db == nil {
		s.logger.Error("report transaction issue failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var ticketID uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO support_tickets (requester_user_id, role, subject)
		 VALUES ($1, $2, $3) RETURNING id`,
		userID, claims.Role, "transaction issue "+string(body.IssueType)+": "+body.Description).Scan(&ticketID); err != nil {
		s.logger.Error("report transaction issue failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		TicketId openapi_types.UUID `json:"ticketId"`
		Status   string             `json:"status"`
	}{
		TicketId: newUUID(ticketID.String()),
		Status:   "open",
	})
}

// CreateSosAlert records a rider emergency alert (POST /sos, table
// sos_alerts in 00050_sweep.sql). The alert is persisted with the caller's
// user id, type, note and GPS stamp; dispatch acknowledgement is not part of
// this contract surface, so the status stays 'open'.
func (s *Server) CreateSosAlert(w http.ResponseWriter, r *http.Request) {
	var body gen.CreateSosAlertJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Type == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type is required")
		return
	}
	if s.db == nil {
		s.logger.Error("create sos alert failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var id uuid.UUID
	var createdAt time.Time
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO sos_alerts (rider_user_id, type, note, lat, lon)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		userID, string(body.Type), body.Note, body.Lat, body.Lon).Scan(&id, &createdAt); err != nil {
		s.logger.Error("create sos alert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	idGen := newUUID(id.String())
	writeJSON(w, http.StatusCreated, gen.SosAlert{
		Id:        idGen,
		RiderId:   newUUIDPtr(userID),
		Type:      gen.SosAlertType(body.Type),
		Note:      body.Note,
		Lat:       body.Lat,
		Lon:       body.Lon,
		Status:    gen.SosAlertStatus("open"),
		CreatedAt: createdAt,
	})
}

// ListAvailableDispatchOrders answers the rider grab-mode feed
// (GET /dispatch/available-orders): open orders with no rider assigned yet.
// Distance and prep time are not computed here, so they stay absent rather
// than invented; the earnings estimate is the server-side delivery fee plus
// platform fee.
func (s *Server) ListAvailableDispatchOrders(w http.ResponseWriter, r *http.Request, params gen.ListAvailableDispatchOrdersParams) {
	if s.db == nil {
		s.logger.Error("list available dispatch orders failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := 10
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > 50 {
			limit = 50
		}
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, delivery_fee_tzs, platform_fee_tzs, deadline_at, created_at
		 FROM orders
		 WHERE rider_id IS NULL AND status IN ('paid', 'merchant_accepted', 'preparing')
		 ORDER BY created_at LIMIT $1`, limit)
	if err != nil {
		s.logger.Error("list available dispatch orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	offers := make([]gen.DispatchOffer, 0, limit)
	for rows.Next() {
		var (
			id        uuid.UUID
			delivery  int64
			platform  int64
			deadline  *time.Time
			createdAt time.Time
		)
		if err := rows.Scan(&id, &delivery, &platform, &deadline, &createdAt); err != nil {
			s.logger.Error("scan dispatch offer failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		expiresAt := createdAt.Add(15 * time.Minute)
		if deadline != nil {
			expiresAt = *deadline
		}
		offers = append(offers, gen.DispatchOffer{
			OrderId:              newUUID(id.String()),
			DistanceKm:           0,
			EstimatedEarningsTZS: int(delivery + platform),
			ExpiresAt:            expiresAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate dispatch offers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, offers)
}

// ListProviderJobs answers the provider job marketplace
// (GET /dispatch/provider-jobs): bookings waiting for a provider decision.
// Distance and match scores are not computed here and stay absent.
func (s *Server) ListProviderJobs(w http.ResponseWriter, r *http.Request, params gen.ListProviderJobsParams) {
	if s.db == nil {
		s.logger.Error("list provider jobs failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := 20
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > 50 {
			limit = 50
		}
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, scheduled_for FROM bookings
		 WHERE status IN ('provider_requested', 'paid')
		 ORDER BY scheduled_for LIMIT $1`, limit)
	if err != nil {
		s.logger.Error("list provider jobs failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	jobs := make([]gen.ProviderJobOffer, 0, limit)
	for rows.Next() {
		var (
			id          uuid.UUID
			scheduledAt time.Time
		)
		if err := rows.Scan(&id, &scheduledAt); err != nil {
			s.logger.Error("scan provider job failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		jobs = append(jobs, gen.ProviderJobOffer{
			BookingId:    newUUID(id.String()),
			DistanceKm:   0,
			Kind:         gen.ProviderJobOfferKind("nearby"),
			ScheduledFor: &scheduledAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate provider jobs failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

// AcceptProviderJobOffer accepts a marketplace job offer
// (POST /dispatch/provider-jobs/{bookingId}/accept). Only the provider the
// booking was requested of may accept; the booking moves to
// provider_accepted.
func (s *Server) AcceptProviderJobOffer(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("accept provider job failed: database not configured")
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
	if row.ProviderID != actor {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	version, err := bookings.NewStore(s.db.Pool()).TransitionBooking(r.Context(), row.ID, row.Version,
		[]string{"provider_requested", "paid"}, "provider_accepted", actor, "accepted from job marketplace")
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot be accepted in its current state")
		return
	}
	if err != nil {
		s.logger.Error("accept provider job failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "provider_accepted"
	row.Version = version
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}
