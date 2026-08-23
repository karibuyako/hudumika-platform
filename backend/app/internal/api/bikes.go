package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/hudumika/api-backend/internal/bikes"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// ListNearbyBikes returns available bikes, optionally near a point (GET
// /bikes/nearby).
func (s *Server) ListNearbyBikes(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var lat, lon, radius float64
	if v := r.URL.Query().Get("lat"); v != "" {
		lat, _ = strconv.ParseFloat(v, 64)
	}
	if v := r.URL.Query().Get("lon"); v != "" {
		lon, _ = strconv.ParseFloat(v, 64)
	}
	if v := r.URL.Query().Get("radiusKm"); v != "" {
		radius, _ = strconv.ParseFloat(v, 64)
	}
	rows, err := bikes.NewStore(s.db.Pool()).ListNearby(r.Context(), lat, lon, radius)
	if err != nil {
		s.logger.Error("list nearby bikes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// GetBike returns a single bike (GET /bikes/{bikeId}).
func (s *Server) GetBike(w http.ResponseWriter, r *http.Request, bikeId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bike, err := bikes.NewStore(s.db.Pool()).GetBike(r.Context(), bikeId)
	if errors.Is(err, bikes.ErrBikeNotFound) {
		writeError(w, http.StatusNotFound, "BIKE_NOT_FOUND", "Bike not found")
		return
	}
	if err != nil {
		s.logger.Error("get bike failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, bike)
}

// GetActiveBikeRide returns the caller's in-progress ride or null (GET
// /bikes/rides/active).
func (s *Server) GetActiveBikeRide(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ride, err := bikes.NewStore(s.db.Pool()).GetActiveRide(r.Context(), userID)
	if err != nil {
		s.logger.Error("get active bike ride failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// UnlockBike starts a ride on a bike identified by id or code (POST
// /bikes/unlock).
func (s *Server) UnlockBike(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body struct {
		BikeId string `json:"bikeId"`
		Code   string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.BikeId == "" && body.Code == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "bikeId or code is required")
		return
	}
	st := bikes.NewStore(s.db.Pool())
	var bike *bikes.BikeRow
	if body.BikeId != "" {
		id, err := uuid.Parse(body.BikeId)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "bikeId is not a valid UUID")
			return
		}
		bike, err = st.GetBike(r.Context(), id)
		if err != nil {
			bike = nil
		}
	} else {
		bike, err = st.GetByCode(r.Context(), body.Code)
		if err != nil {
			bike = nil
		}
	}
	if bike == nil {
		writeError(w, http.StatusNotFound, "BIKE_NOT_FOUND", "Bike not found")
		return
	}
	ride, err := st.Unlock(r.Context(), userID, bike.ID)
	switch {
	case errors.Is(err, bikes.ErrBikeNotFound):
		writeError(w, http.StatusNotFound, "BIKE_NOT_FOUND", "Bike not found")
		return
	case errors.Is(err, bikes.ErrBikeNotAvailable):
		writeError(w, http.StatusConflict, "BIKE_NOT_AVAILABLE", "Bike is not available")
		return
	case errors.Is(err, bikes.ErrRideAlreadyActive):
		writeError(w, http.StatusConflict, "RIDE_ALREADY_ACTIVE", "You already have an active ride")
		return
	case err != nil:
		s.logger.Error("unlock bike failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// LockBikeRide temporarily locks an active ride (POST /bikes/rides/{rideId}/lock).
func (s *Server) LockBikeRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ride, err := bikes.NewStore(s.db.Pool()).Lock(r.Context(), userID, rideId)
	if err != nil {
		writeBikeRideError(w, s, err)
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// UnlockBikeRide re-unlocks a temporarily locked ride (POST
// /bikes/rides/{rideId}/unlock).
func (s *Server) UnlockBikeRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ride, err := bikes.NewStore(s.db.Pool()).UnlockRide(r.Context(), userID, rideId)
	if err != nil {
		writeBikeRideError(w, s, err)
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// FinishBikeRide ends a ride at the given coordinates (POST
// /bikes/rides/{rideId}/finish).
func (s *Server) FinishBikeRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body struct {
		Lat float64 `json:"lat"`
		Lon float64 `json:"lon"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	ride, err := bikes.NewStore(s.db.Pool()).Finish(r.Context(), userID, rideId, body.Lat, body.Lon)
	if err != nil {
		writeBikeRideError(w, s, err)
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// PayBikeRide settles a completed ride (POST /bikes/rides/{rideId}/pay).
func (s *Server) PayBikeRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body struct {
		Method string `json:"method"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Method == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "method is required")
		return
	}
	ride, err := bikes.NewStore(s.db.Pool()).Pay(r.Context(), userID, rideId, body.Method)
	if err != nil {
		writeBikeRideError(w, s, err)
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// ListMyBikeRides returns the caller's ride history (GET /bikes/rides/me).
func (s *Server) ListMyBikeRides(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	rides, err := bikes.NewStore(s.db.Pool()).ListRides(r.Context(), userID)
	if err != nil {
		s.logger.Error("list bike rides failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, rides)
}

// GetBikeRide returns a single ride (GET /bikes/rides/{rideId}).
func (s *Server) GetBikeRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ride, err := bikes.NewStore(s.db.Pool()).GetRide(r.Context(), userID, rideId)
	if errors.Is(err, bikes.ErrRideNotFound) {
		writeError(w, http.StatusNotFound, "RIDE_NOT_FOUND", "Ride not found")
		return
	}
	if err != nil {
		s.logger.Error("get bike ride failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// writeBikeRideError maps bike-ride store errors to envelopes.
func writeBikeRideError(w http.ResponseWriter, s *Server, err error) {
	switch {
	case errors.Is(err, bikes.ErrRideNotFound):
		writeError(w, http.StatusNotFound, "RIDE_NOT_FOUND", "Ride not found")
	case errors.Is(err, bikes.ErrBikeNotFound):
		writeError(w, http.StatusNotFound, "BIKE_NOT_FOUND", "Bike not found")
	case errors.Is(err, bikes.ErrBikeNotAvailable):
		writeError(w, http.StatusConflict, "BIKE_NOT_AVAILABLE", "Bike is not available")
	case errors.Is(err, bikes.ErrRideAlreadyActive):
		writeError(w, http.StatusConflict, "RIDE_ALREADY_ACTIVE", "You already have an active ride")
	case errors.Is(err, bikes.ErrRideNotActive):
		writeError(w, http.StatusConflict, "RIDE_NOT_ACTIVE", "Ride is not active")
	default:
		s.logger.Error("bike ride action failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}
