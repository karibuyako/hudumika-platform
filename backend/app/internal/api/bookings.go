package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/bookings"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payouts"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Pagination bounds and booking constraints (contract BookingCreate:
// durationMinutes 15..480; ERROR-CODES.md bookings section).
const (
	defaultBookingListLimit = 20
	maxBookingListLimit     = 50
	minBookingDuration      = 15
	maxBookingDuration      = 480
)

// bookingStatuses is the status set the bookings.status CHECK constraint
// accepts; used to reject unknown advance targets before they hit the
// database.
var bookingStatuses = map[string]struct{}{
	"draft": {}, "pending_payment": {}, "paid": {}, "provider_requested": {},
	"provider_accepted": {}, "scheduled": {}, "provider_arrived": {},
	"in_progress": {}, "awaiting_customer_confirmation": {}, "completed": {},
	"declined": {}, "cancelled": {}, "refunded": {}, "disputed": {},
	"no_show": {},
}

// providerAdvance maps the status a provider may advance FROM to the single
// status they may advance TO; customerAdvance is the customer's shorter
// chain (completion confirmation, the escrow release point).
var providerAdvance = map[string]string{
	"provider_accepted": "scheduled",
	"scheduled":         "provider_arrived",
	"provider_arrived":  "in_progress",
	"in_progress":       "awaiting_customer_confirmation",
}

var customerAdvance = map[string]string{
	"awaiting_customer_confirmation": "completed",
}

// CreateBooking creates a booking draft (POST /bookings, contract Booking
// schema, 201). The Idempotency-Key header is required by the contract; the
// generated wrapper enforces presence at the route layer, and this check
// catches an empty value. Any authenticated role may book. The price is
// recomputed server-side from the services catalogue: client-supplied
// amounts are advisory at best and are ignored.
func (s *Server) CreateBooking(w http.ResponseWriter, r *http.Request, params gen.CreateBookingParams) {
	if params.IdempotencyKey == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.BookingCreate
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		s.logger.Error("create booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	service, err := st.GetService(r.Context(), body.ServiceId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusUnprocessableEntity, "SERVICE_NOT_FOUND", "Service not found")
		return
	}
	if err != nil {
		s.logger.Error("create booking: load service failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !service.Active {
		writeError(w, http.StatusUnprocessableEntity, "SERVICE_NOT_FOUND", "Service is not available")
		return
	}
	if !body.ScheduledFor.After(time.Now()) {
		writeError(w, http.StatusUnprocessableEntity, "BOOKING_TIME_IN_PAST", "scheduledFor must be in the future")
		return
	}
	if body.DurationMinutes != nil &&
		(*body.DurationMinutes < minBookingDuration || *body.DurationMinutes > maxBookingDuration) {
		writeError(w, http.StatusUnprocessableEntity, "BOOKING_DURATION_INVALID", "durationMinutes must be between 15 and 480")
		return
	}
	// Resolve the booking's provider to a real providers row id
	// (provider_linkage.go). An explicit body providerId may name the real
	// providers row or the legacy provider-owner users id
	// (resolveProviderID maps both); an unknown id is 404
	// BOOKING_PROVIDER_UNAVAILABLE. A zero providerId means the booking
	// agent booked with their own session provider.
	providerID := body.ProviderId
	if providerID == uuid.Nil {
		providerID, err = s.providerIDForSession(r)
		if errors.Is(err, errNoProvider) {
			writeError(w, http.StatusNotFound, "BOOKING_PROVIDER_UNAVAILABLE", "No provider is available for this booking")
			return
		}
		if err != nil {
			s.logger.Error("create booking: resolve session provider failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	} else {
		resolved, rerr := resolveProviderID(r.Context(), s.db.Pool(), providerID)
		if rerr != nil {
			writeError(w, http.StatusNotFound, "BOOKING_PROVIDER_UNAVAILABLE", "Provider not found")
			return
		}
		providerID = resolved
	}
	row, err := st.CreateBooking(r.Context(), bookings.CreateInput{
		CustomerUserID:  userID,
		ProviderID:      providerID,
		ServiceID:       body.ServiceId,
		ScheduledFor:    body.ScheduledFor,
		DurationMinutes: body.DurationMinutes,
		Address:         toBookingAddress(body.Address),
		Description:     body.Description,
		IdempotencyKey:  params.IdempotencyKey,
	})
	if err != nil {
		s.logger.Error("create booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenBooking(row))
}

// ListMyBookings returns the caller's bookings (GET /bookings/me),
// cursor-paginated with an optional status filter. The next cursor is
// exposed via the X-Next-Cursor header, matching the orders listing
// convention.
func (s *Server) ListMyBookings(w http.ResponseWriter, r *http.Request, params gen.ListMyBookingsParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list bookings failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultBookingListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxBookingListLimit {
			limit = maxBookingListLimit
		}
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}

	rows, next, err := bookings.NewStore(s.db.Pool()).ListMyBookings(r.Context(), userID, status, limit, cursor)
	if errors.Is(err, bookings.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list bookings failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.Booking, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenBooking(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// GetBooking returns the booking detail with event history (GET
// /bookings/{bookingId}) for the parties only: the owning customer, the
// provider, or staff. Everyone else — including the party of a booking that
// does not exist — sees the same BOOKING_NOT_FOUND, so existence never
// leaks.
func (s *Server) GetBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
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
	if s.db == nil {
		s.logger.Error("get booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	detail, err := bookings.NewStore(s.db.Pool()).GetBookingDetail(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("get booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.canViewBooking(claims, r.Context(), userID, detail) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	writeJSON(w, http.StatusOK, toGenBookingDetail(detail))
}

func (s *Server) canViewBooking(claims *Claims, ctx context.Context, userID uuid.UUID, detail *bookings.BookingDetail) bool {
	switch claims.Role {
	case RoleCustomer:
		return detail.Booking.CustomerUserID == userID
	case RoleProvider:
		// New bookings store the real providers row id; legacy rows store
		// the provider owner's users id — providerBookingOwned accepts both
		// (provider_linkage.go).
		ok, err := s.providerBookingOwned(ctx, userID, detail.Booking.ProviderID)
		if err != nil {
			s.logger.Error("get booking: provider ownership check failed", "error", err)
			return false
		}
		return ok
	case RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		// Staff may inspect any booking; provider identity binding lands
		// with the providers bounded context.
		return true
	default:
		return false
	}
}

// AcceptBooking moves a pending booking to provider_accepted (POST
// /bookings/{bookingId}/accept), guarded by the client-observed version. A
// stale version or a state that cannot be accepted yields 409
// BOOKING_STATUS_CONFLICT.
func (s *Server) AcceptBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only providers can accept bookings")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("accept booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("accept booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.providerBookingOwned(r.Context(), actor, row.ProviderID)
	if err != nil {
		s.logger.Error("accept booking: provider ownership check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		// Non-provider parties see the same NOT_FOUND as a missing booking.
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	version, err := st.TransitionBooking(r.Context(), bookingId, row.Version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "provider_accepted", actor, "")
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot be accepted in its current state")
		return
	}
	if err != nil {
		s.logger.Error("accept booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "provider_accepted"
	row.Version = version
	publishBookingEvent(r.Context(), s, row.ID.String(), row.Status, row.CustomerUserID.String(), row.ProviderID.String(), nil)
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// DeclineBooking lets a provider decline a pending booking (POST
// /bookings/{bookingId}/decline). The reason is recorded on the event; a
// state conflict yields 409 BOOKING_STATUS_CONFLICT.
func (s *Server) DeclineBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only providers can decline bookings")
		return
	}
	var body gen.DeclineBookingJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("decline booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("decline booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	owned, err := s.providerBookingOwned(r.Context(), actor, row.ProviderID)
	if err != nil {
		s.logger.Error("decline booking: provider ownership check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !owned {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	version, err := st.TransitionBooking(r.Context(), bookingId, row.Version,
		[]string{"pending_payment", "paid", "provider_requested"}, "declined", actor, body.Reason)
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot be declined in its current state")
		return
	}
	if err != nil {
		s.logger.Error("decline booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "declined"
	row.Version = version
	publishBookingEvent(r.Context(), s, row.ID.String(), row.Status, row.CustomerUserID.String(), row.ProviderID.String(), nil)
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// CancelBooking lets the owning customer cancel before the provider
// accepts, and the provider cancel before the booking is scheduled. The
// reason is recorded on the event; cancellations outside those windows
// yield 409 BOOKING_NOT_CANCELLABLE.
func (s *Server) CancelBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer && claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the customer or the provider can cancel a booking")
		return
	}
	var body gen.CancelBookingJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("cancel booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("cancel booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if claims.Role == RoleCustomer {
		if row.CustomerUserID != actor {
			// Non-owners see the same NOT_FOUND as a missing booking.
			writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
			return
		}
	} else {
		owned, err := s.providerBookingOwned(r.Context(), actor, row.ProviderID)
		if err != nil {
			s.logger.Error("cancel booking: provider ownership check failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if !owned {
			writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
			return
		}
	}
	cancellable := row.Status == "draft" || row.Status == "pending_payment" ||
		row.Status == "paid" || row.Status == "provider_requested"
	if claims.Role == RoleProvider {
		// The provider may still cancel after accepting, up to scheduling.
		cancellable = cancellable || row.Status == "provider_accepted"
	}
	if !cancellable {
		writeError(w, http.StatusConflict, "BOOKING_NOT_CANCELLABLE", "Booking can no longer be cancelled")
		return
	}
	version, err := st.TransitionBooking(r.Context(), bookingId, row.Version,
		[]string{row.Status}, "cancelled", actor, body.Reason)
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_NOT_CANCELLABLE", "Booking can no longer be cancelled")
		return
	}
	if err != nil {
		s.logger.Error("cancel booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = "cancelled"
	row.Version = version
	publishBookingEvent(r.Context(), s, row.ID.String(), row.Status, row.CustomerUserID.String(), row.ProviderID.String(), nil)
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// CompleteBooking is the customer's completion confirmation (POST
// /bookings/{bookingId}/complete) and the escrow release point
// (PAYMENTS.md: customer payments are held until the customer confirms
// completion; never release on a client callback). On completion a
// booking_earning ledger entry is appended for the provider so the payout
// pipeline can settle it.
func (s *Server) CompleteBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the customer can confirm a completed booking")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("complete booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("complete booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row.CustomerUserID != actor {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	version, err := st.TransitionBooking(r.Context(), bookingId, row.Version,
		[]string{"in_progress", "awaiting_customer_confirmation", "provider_arrived"},
		"completed", actor, "")
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot be completed in its current state")
		return
	}
	if err != nil {
		s.logger.Error("complete booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.releaseBookingEarning(r, *row)
	row.Status = "completed"
	row.Version = version
	publishBookingEvent(r.Context(), s, row.ID.String(), row.Status, row.CustomerUserID.String(), row.ProviderID.String(), nil)
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// releaseBookingEarning appends the provider's booking_earning ledger entry
// for a completed booking (the escrow release point). It is best-effort:
// failures are logged and never fail the completion response, and the
// idempotency key makes replays no-ops. The database was verified present
// by the caller.
func (s *Server) releaseBookingEarning(r *http.Request, row bookings.BookingRow) {
	if s.db == nil {
		s.logger.Warn("booking earning skipped: no database configured", "bookingId", row.ID)
		return
	}
	ownerID := row.ProviderID
	var resolved uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(), `SELECT owner_user_id FROM providers WHERE id = $1`, row.ProviderID).Scan(&resolved); err == nil {
		ownerID = resolved
	}
	applied, err := payouts.NewStore(s.db.Pool()).AppendEntry(r.Context(), payouts.LedgerEntryInput{
		AccountOwnerID: ownerID,
		AccountType:    "provider",
		Type:           "booking_earning",
		AmountTZS:      row.TotalTZS,
		ReferenceType:  "booking",
		ReferenceID:    row.ID,
		IdempotencyKey: "booking_earning:" + row.ID.String(),
	})
	if err != nil {
		s.logger.Error("booking earning ledger entry failed", "bookingId", row.ID, "error", err)
		return
	}
	if !applied {
		s.logger.Warn("booking earning ledger entry is a duplicate", "bookingId", row.ID)
	}
}

// AdvanceBooking moves a booking one step along the fulfillment chain (POST
// /bookings/{bookingId}/status). Providers drive provider_accepted through
// awaiting_customer_confirmation; the customer drives
// awaiting_customer_confirmation to completed. The requested status must be
// the single legal next step, else 409 BOOKING_STATUS_CONFLICT.
func (s *Server) AdvanceBooking(w http.ResponseWriter, r *http.Request, bookingId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if claims.Role != RoleCustomer && claims.Role != RoleProvider {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the provider or the customer can advance a booking")
		return
	}
	var body gen.AdvanceBookingJSONBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	target := string(body.Status)
	if _, ok := bookingStatuses[target]; !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is not a valid booking status")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("advance booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := bookings.NewStore(s.db.Pool())
	row, err := st.GetBookingRow(r.Context(), bookingId)
	if errors.Is(err, bookings.ErrNotFound) {
		writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
		return
	}
	if err != nil {
		s.logger.Error("advance booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if claims.Role == RoleCustomer {
		if row.CustomerUserID != actor {
			writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
			return
		}
	} else {
		owned, err := s.providerBookingOwned(r.Context(), actor, row.ProviderID)
		if err != nil {
			s.logger.Error("advance booking: provider ownership check failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if !owned {
			writeError(w, http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found")
			return
		}
	}
	chain := providerAdvance
	if claims.Role == RoleCustomer {
		chain = customerAdvance
	}
	next, ok := chain[row.Status]
	if !ok || next != target {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot move to the requested status")
		return
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	version, err := st.TransitionBooking(r.Context(), bookingId, row.Version,
		[]string{row.Status}, target, actor, note)
	if errors.Is(err, bookings.ErrConflict) {
		writeError(w, http.StatusConflict, "BOOKING_STATUS_CONFLICT", "Booking cannot move to the requested status")
		return
	}
	if err != nil {
		s.logger.Error("advance booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row.Status = target
	row.Version = version
	publishBookingEvent(r.Context(), s, row.ID.String(), row.Status, row.CustomerUserID.String(), row.ProviderID.String(), nil)
	writeJSON(w, http.StatusOK, toGenBooking(*row))
}

// toGenBooking maps a booking row onto the contract Booking schema.
func toGenBooking(row bookings.BookingRow) gen.Booking {
	updatedAt := row.UpdatedAt
	return gen.Booking{
		Id:           newUUID(row.ID.String()),
		Status:       gen.BookingStatus(row.Status),
		ProviderId:   newUUID(row.ProviderID.String()),
		ServiceId:    newUUID(row.ServiceID.String()),
		ScheduledFor: row.ScheduledFor,
		Price: &gen.PriceBreakdown{
			SubtotalTZS:    int(row.SubtotalTZS),
			DeliveryFeeTZS: int(row.DeliveryFeeTZS),
			PlatformFeeTZS: int(row.PlatformFeeTZS),
			TaxTZS:         int(row.TaxTZS),
			DiscountTZS:    int(row.DiscountTZS),
			TotalTZS:       int(row.TotalTZS),
		},
		CreatedAt: row.CreatedAt,
		UpdatedAt: &updatedAt,
	}
}

// toGenBookingDetail maps the full booking projection onto the contract
// BookingDetail schema (Booking fields + address, description, events).
func toGenBookingDetail(d *bookings.BookingDetail) gen.BookingDetail {
	base := toGenBooking(d.Booking)

	events := make([]struct {
		At     time.Time         `json:"at"`
		By     string            `json:"by"`
		Note   *string           `json:"note,omitempty"`
		Status gen.BookingStatus `json:"status"`
	}, 0, len(d.Events))
	for _, e := range d.Events {
		by := "system"
		if e.By != nil {
			by = e.By.String()
		}
		events = append(events, struct {
			At     time.Time         `json:"at"`
			By     string            `json:"by"`
			Note   *string           `json:"note,omitempty"`
			Status gen.BookingStatus `json:"status"`
		}{
			At:     e.At,
			By:     by,
			Note:   e.Note,
			Status: gen.BookingStatus(e.Status),
		})
	}

	return gen.BookingDetail{
		Id:           base.Id,
		Status:       base.Status,
		ProviderId:   base.ProviderId,
		ServiceId:    base.ServiceId,
		ScheduledFor: base.ScheduledFor,
		Price:        base.Price,
		CreatedAt:    base.CreatedAt,
		UpdatedAt:    base.UpdatedAt,
		Address:      toGenBookingAddress(d.Booking.Address),
		Description:  d.Booking.Description,
		Events:       events,
	}
}

func toGenBookingAddress(a *bookings.AddressSnapshot) gen.AddressSnapshot {
	if a == nil {
		return gen.AddressSnapshot{}
	}
	return gen.AddressSnapshot{
		Label:        a.Label,
		Lines:        a.Lines,
		Landmark:     a.Landmark,
		Lat:          float64PtrTo32(a.Lat),
		Lon:          float64PtrTo32(a.Lon),
		ContactPhone: a.ContactPhone,
	}
}

func toBookingAddress(a *gen.AddressSnapshot) *bookings.AddressSnapshot {
	if a == nil {
		return nil
	}
	return &bookings.AddressSnapshot{
		Label:        a.Label,
		Lines:        a.Lines,
		Landmark:     a.Landmark,
		Lat:          float32PtrTo64(a.Lat),
		Lon:          float32PtrTo64(a.Lon),
		ContactPhone: a.ContactPhone,
	}
}
