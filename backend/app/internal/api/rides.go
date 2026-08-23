package api

import (
	"errors"
	"net/http"

	"github.com/hudumika/api-backend/internal/rides"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

type rideEstimate struct {
	FareTZS    int64   `json:"fareTZS"`
	DistanceKm float64 `json:"distanceKm"`
	DurationMin int    `json:"durationMin"`
}

func validRideType(t string) bool {
	return t == "express" || t == "premier" || t == "taxi"
}

// EstimateRide quotes a prospective ride (POST /rides/estimate). No auth and
// no idempotency key are required for a read-only quote.
func (s *Server) EstimateRide(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var body struct {
		Pickup      string `json:"pickup"`
		Destination string `json:"destination"`
		RideType    string `json:"rideType"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Pickup == "" || body.Destination == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pickup and destination are required")
		return
	}
	if !validRideType(body.RideType) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "rideType must be express, premier or taxi")
		return
	}
	fare, dist, dur := rides.NewStore(s.db.Pool()).EstimateQuote(body.Pickup, body.Destination, body.RideType)
	writeJSON(w, http.StatusOK, rideEstimate{FareTZS: fare, DistanceKm: dist, DurationMin: dur})
}

// CreateRide opens a ride (POST /rides, 201). The Idempotency-Key header is
// required by the contract.
func (s *Server) CreateRide(w http.ResponseWriter, r *http.Request) {
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
		Pickup           string          `json:"pickup"`
		Destination      string          `json:"destination"`
		RideType         string          `json:"rideType"`
		PickupCoord      *rides.Coord    `json:"pickupCoord"`
		DestinationCoord *rides.Coord    `json:"destinationCoord"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Pickup == "" || body.Destination == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pickup and destination are required")
		return
	}
	if !validRideType(body.RideType) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "rideType must be express, premier or taxi")
		return
	}
	ride, err := rides.NewStore(s.db.Pool()).Create(r.Context(), rides.CreateInput{
		UserID:           userID,
		Pickup:           body.Pickup,
		Destination:      body.Destination,
		RideType:         body.RideType,
		PickupCoord:      body.PickupCoord,
		DestinationCoord: body.DestinationCoord,
	})
	if err != nil {
		s.logger.Error("create ride failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, ride)
}

// GetRide returns a single ride (GET /rides/{rideId}).
func (s *Server) GetRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ride, err := rides.NewStore(s.db.Pool()).Get(r.Context(), userID, rideId)
	if errors.Is(err, rides.ErrRideNotFound) {
		writeError(w, http.StatusNotFound, "RIDE_NOT_FOUND", "Ride not found")
		return
	}
	if err != nil {
		s.logger.Error("get ride failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, ride)
}

// ListMyRides returns the caller's rides (GET /rides/me).
func (s *Server) ListMyRides(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ridesList, err := rides.NewStore(s.db.Pool()).ListMine(r.Context(), userID)
	if err != nil {
		s.logger.Error("list rides failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, ridesList)
}

// CancelRide cancels a not-yet-started ride (POST /rides/{rideId}/cancel).
func (s *Server) CancelRide(w http.ResponseWriter, r *http.Request, rideId openapi_types.UUID) {
	if r.Header.Get("Idempotency-Key") == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	ride, err := rides.NewStore(s.db.Pool()).Cancel(r.Context(), userID, rideId)
	if errors.Is(err, rides.ErrRideNotFound) {
		writeError(w, http.StatusNotFound, "RIDE_NOT_FOUND", "Ride not found")
		return
	}
	if errors.Is(err, rides.ErrRideNotCancellable) {
		writeError(w, http.StatusConflict, "RIDE_NOT_CANCELLABLE", "Ride can no longer be cancelled")
		return
	}
	if err != nil {
		s.logger.Error("cancel ride failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, ride)
}
