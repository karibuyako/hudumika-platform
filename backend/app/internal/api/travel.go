package api

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/travel"
)

// travelDateRE is the strict YYYY-MM-DD local-day format the contract
// requires for GET /travel/options?date= (the consumer mock enforces the
// same rule, rejecting rollovers like 2026-13-40).
var travelDateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ListTravelOptions returns the options for a route on a requested local
// day (GET /travel/options, contract TravelOption array). The schedule is
// daily-repeating: concrete departure/arrival timestamps are issued for the
// requested date, mirroring the consumer mock.
func (s *Server) ListTravelOptions(w http.ResponseWriter, r *http.Request, params gen.ListTravelOptionsParams) {
	if s.db == nil {
		s.logger.Error("list travel options failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	date := params.Date.Time.Format("2006-01-02")
	if !travelDateRE.MatchString(date) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Travel date must be a YYYY-MM-DD local day")
		return
	}
	if params.OriginCityId == "" || params.DestinationCityId == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "originCityId and destinationCityId are required")
		return
	}
	mode := ""
	if params.Mode != nil {
		mode = string(*params.Mode)
	}

	rows, err := travel.NewStore(s.db.Pool()).Search(r.Context(), params.OriginCityId, params.DestinationCityId, mode, date)
	if err != nil {
		s.logger.Error("list travel options failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.TravelOption, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenTravelOption(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateTravelBooking books seats on a departure (POST /travel/bookings,
// contract TravelBooking schema, 201). The total is recomputed server-side
// from the option's unit price × passengers; the idempotency key (body or
// header) replays the original booking so a retry never double-books.
func (s *Server) CreateTravelBooking(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.CreateTravelBookingJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.TravelOptionId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "travelOptionId is required")
		return
	}
	if body.Passengers < 1 || body.Passengers > 20 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Passengers must be between 1 and 20")
		return
	}
	contact := body.ContactPhone
	if contact == "" || len(contact) > 20 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "A valid contact phone is required")
		return
	}
	key := body.IdempotencyKey
	if key == nil || *key == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "idempotencyKey is required")
		return
	}
	if s.db == nil {
		s.logger.Error("create travel booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	row, err := travel.NewStore(s.db.Pool()).CreateBooking(r.Context(), travel.CreateBookingInput{
		UserID:         userID,
		TravelOptionID: body.TravelOptionId,
		Passengers:     body.Passengers,
		ContactPhone:   contact,
		IdempotencyKey: *key,
		Now:            time.Now(),
	})
	if errors.Is(err, travel.ErrNotFound) {
		writeError(w, http.StatusNotFound, "TRAVEL_OPTION_NOT_FOUND", "Travel option not found")
		return
	}
	if errors.Is(err, travel.ErrDeparted) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "This departure has already left — search for a later date")
		return
	}
	if errors.Is(err, travel.ErrNoSeats) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Not enough seats left on this departure")
		return
	}
	if err != nil {
		s.logger.Error("create travel booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenTravelBooking(row))
}

// ListMyTravelBookings returns the caller's travel bookings (GET
// /travel/bookings/me), newest first, as the contract array.
func (s *Server) ListMyTravelBookings(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list travel bookings failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := travel.NewStore(s.db.Pool()).ListMyBookings(r.Context(), userID)
	if err != nil {
		s.logger.Error("list travel bookings failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.TravelBooking, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenTravelBooking(row))
	}
	writeJSON(w, http.StatusOK, out)
}

func toGenTravelOption(o travel.Option) gen.TravelOption {
	provider := o.Provider
	return gen.TravelOption{
		Id:                  newUUID(o.ID.String()),
		Mode:                gen.TravelOptionMode(o.Mode),
		Provider:            &provider,
		OriginCityId:        o.OriginCityID,
		OriginCityName:      &o.OriginCityName,
		DestinationCityId:   o.DestinationCityID,
		DestinationCityName: &o.DestinationCityName,
		DepartureAt:         o.DepartureAt,
		ArrivalAt:           o.ArrivalAt,
		PriceTZS:            int(o.PriceTZS),
		SeatsAvailable:      o.SeatsAvailable,
	}
}

func toGenTravelBooking(b travel.Booking) gen.TravelBooking {
	createdAt := b.CreatedAt
	mode := gen.TravelBookingMode(b.Mode)
	departureAt := b.DepartureAt
	contact := b.ContactPhone
	return gen.TravelBooking{
		Id:                  newUUID(b.ID.String()),
		TravelOptionId:      newUUID(b.TravelOptionID.String()),
		Mode:                &mode,
		OriginCityName:      &b.OriginCityName,
		DestinationCityName: &b.DestinationCityName,
		DepartureAt:         &departureAt,
		Passengers:          b.Passengers,
		ContactPhone:        &contact,
		TotalTZS:            int(b.TotalTZS),
		Status:              gen.TravelBookingStatus(b.Status),
		CreatedAt:           &createdAt,
	}
}