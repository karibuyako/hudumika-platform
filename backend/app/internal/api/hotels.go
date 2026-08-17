package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/hotels"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Pagination bounds for the hotels surfaces (mirrors the group buy
// convention).
const (
	defaultHotelsListLimit = 20
	maxHotelsListLimit     = 50
)

// ListHotels returns hotels for city-scoped search (GET /hotels). The
// optional checkIn/checkOut/guests params are accepted for contract
// compatibility; like the consumer mock, availability is room-level and the
// listing filters by city only. The next cursor rides in the response body
// (contract ListHotels200).
func (s *Server) ListHotels(w http.ResponseWriter, r *http.Request, params gen.ListHotelsParams) {
	if s.db == nil {
		s.logger.Error("list hotels failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultHotelsListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxHotelsListLimit {
			limit = maxHotelsListLimit
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	cityID := ""
	if params.CityId != nil {
		cityID = *params.CityId
	}

	rows, next, err := hotels.NewStore(s.db.Pool()).ListHotels(r.Context(), cityID, limit, cursor)
	if errors.Is(err, hotels.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list hotels failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Hotel, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenHotel(row))
	}
	writeJSON(w, http.StatusOK, struct {
		Results    []gen.Hotel `json:"results"`
		NextCursor *string     `json:"nextCursor"`
	}{Results: out, NextCursor: stringPtrOrNil(next)})
}

// GetHotel returns the hotel detail with its rooms (GET /hotels/{hotelId},
// contract HotelDetail). A missing hotel is 404 HOTEL_NOT_FOUND.
func (s *Server) GetHotel(w http.ResponseWriter, r *http.Request, hotelId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get hotel failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := hotels.NewStore(s.db.Pool())
	row, rooms, err := st.GetHotel(r.Context(), hotelId)
	if errors.Is(err, hotels.ErrNotFound) {
		writeError(w, http.StatusNotFound, "HOTEL_NOT_FOUND", "Hotel not found")
		return
	}
	if err != nil {
		s.logger.Error("get hotel failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	desc, err := st.GetDescription(r.Context(), hotelId)
	if err != nil {
		s.logger.Error("get hotel description failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	outRooms := make([]gen.HotelRoom, 0, len(rooms))
	for _, rm := range rooms {
		amenities := rm.Amenities
		outRooms = append(outRooms, gen.HotelRoom{
			Id:               newUUID(rm.ID.String()),
			HotelId:          newUUID(rm.HotelID.String()),
			Name:             rm.Name,
			PricePerNightTZS: int(rm.PricePerNightTZS),
			Capacity:         rm.Capacity,
			Available:        &rm.Available,
			Amenities:        &amenities,
		})
	}
	writeJSON(w, http.StatusOK, gen.HotelDetail{
		Hotel:       toGenHotel(*row),
		Description: stringPtrOrNil(desc),
		Rooms:       outRooms,
	})
}

// CreateHotelBooking books a hotel room (POST /hotel-bookings, contract
// HotelBooking schema, 201). The total is recomputed server-side from the
// room's per-night rate × nights; the idempotency key (body or header)
// replays the original booking so a retry never double-books. Any
// authenticated role may book (router policy: unconstrained).
func (s *Server) CreateHotelBooking(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.HotelBookingCreate
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.HotelId == uuid.Nil || body.RoomId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "hotelId and roomId are required")
		return
	}
	if body.Guests < 1 || body.Guests > 10 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Guests must be between 1 and 10")
		return
	}
	if !body.CheckOut.Time.After(body.CheckIn.Time) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Check-out must be after check-in")
		return
	}
	key := body.IdempotencyKey
	if key == nil || *key == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "idempotencyKey is required")
		return
	}
	if s.db == nil {
		s.logger.Error("create hotel booking failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	contact := ""
	if body.ContactPhone != nil {
		contact = *body.ContactPhone
	}
	row, err := hotels.NewStore(s.db.Pool()).CreateBooking(r.Context(), hotels.CreateBookingInput{
		UserID:         userID,
		HotelID:        body.HotelId,
		RoomID:         body.RoomId,
		CheckIn:        body.CheckIn.Time,
		CheckOut:       body.CheckOut.Time,
		Guests:         body.Guests,
		ContactPhone:   contact,
		IdempotencyKey: *key,
	})
	if errors.Is(err, hotels.ErrNotFound) {
		writeError(w, http.StatusNotFound, "HOTEL_NOT_FOUND", "Hotel or room not found")
		return
	}
	if errors.Is(err, hotels.ErrRoomUnavailable) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "This room is not available for booking")
		return
	}
	if err != nil {
		s.logger.Error("create hotel booking failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenHotelBooking(row))
}

// ListMyHotelBookings returns the caller's hotel bookings (GET
// /hotel-bookings/me), newest first, as the contract array.
func (s *Server) ListMyHotelBookings(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list hotel bookings failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := hotels.NewStore(s.db.Pool()).ListMyBookings(r.Context(), userID)
	if err != nil {
		s.logger.Error("list hotel bookings failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.HotelBooking, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenHotelBooking(row))
	}
	writeJSON(w, http.StatusOK, out)
}

func toGenHotel(h hotels.Hotel) gen.Hotel {
	amenities := h.Amenities
	image := h.ImageURL
	return gen.Hotel{
		Id:               newUUID(h.ID.String()),
		Name:             h.Name,
		CityId:           h.CityID,
		CityName:         &h.CityName,
		StarRating:       h.StarRating,
		Rating:           float32(h.Rating),
		ReviewCount:      &h.ReviewCount,
		StartingPriceTZS: int(h.StartingPriceTZS),
		ImageUrl:         image,
		Amenities:        &amenities,
		AddressLine:      h.AddressLine,
	}
}

func toGenHotelBooking(b hotels.Booking) gen.HotelBooking {
	createdAt := b.CreatedAt
	nights := b.Nights
	return gen.HotelBooking{
		Id:        newUUID(b.ID.String()),
		HotelId:   newUUID(b.HotelID.String()),
		HotelName: &b.HotelName,
		RoomId:    newUUID(b.RoomID.String()),
		RoomName:  &b.RoomName,
		CheckIn:   openapi_types.Date{Time: b.CheckIn},
		CheckOut:  openapi_types.Date{Time: b.CheckOut},
		Guests:    b.Guests,
		Nights:    &nights,
		TotalTZS:  int(b.TotalTZS),
		Status:    gen.HotelBookingStatus(b.Status),
		CreatedAt: &createdAt,
	}
}

func stringPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}