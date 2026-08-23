package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/hudumika/api-backend/internal/bus"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// busOption is the search result envelope: a route plus live arrival and
// vehicle availability.
type busOption struct {
	Route                   bus.RouteRow    `json:"route"`
	NextArrivalMinutes      int             `json:"nextArrivalMinutes"`
	FollowingArrivalMinutes *int            `json:"followingArrivalMinutes"`
	Vehicles                []bus.VehicleRow `json:"vehicles"`
	Available               bool            `json:"available"`
}

// ListBusRoutes searches bus routes by origin and destination (GET
// /bus/routes). Both query parameters are required; an empty value is a 422.
func (s *Server) ListBusRoutes(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	origin := r.URL.Query().Get("origin")
	destination := r.URL.Query().Get("destination")
	if origin == "" || destination == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "origin and destination are required")
		return
	}
	st := bus.NewStore(s.db.Pool())
	routes, err := st.ListRoutes(r.Context(), origin, destination)
	if err != nil {
		s.logger.Error("list bus routes failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]busOption, 0, len(routes))
	for _, route := range routes {
		vehicles, err := st.ListVehicles(r.Context(), route.ID)
		if err != nil {
			s.logger.Warn("list bus vehicles failed", "route", route.ID, "error", err)
			vehicles = nil
		}
		next := route.FrequencyMinutes
		if next <= 0 {
			next = 5
		}
		var following *int
		if route.FrequencyMinutes > 0 {
			f := next + route.FrequencyMinutes
			following = &f
		}
		out = append(out, busOption{
			Route:                   route,
			NextArrivalMinutes:      next,
			FollowingArrivalMinutes: following,
			Vehicles:                vehicles,
			Available:               len(vehicles) > 0,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// GetBusRoute returns a single route with its stops (GET /bus/routes/{routeId}).
func (s *Server) GetBusRoute(w http.ResponseWriter, r *http.Request, routeId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	route, err := bus.NewStore(s.db.Pool()).GetRoute(r.Context(), routeId)
	if errors.Is(err, bus.ErrRouteNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Route not found")
		return
	}
	if err != nil {
		s.logger.Error("get bus route failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, route)
}

// GetBusRouteVehicles returns the live vehicles of a route (GET
// /bus/routes/{routeId}/vehicles).
func (s *Server) GetBusRouteVehicles(w http.ResponseWriter, r *http.Request, routeId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	vehicles, err := bus.NewStore(s.db.Pool()).ListVehicles(r.Context(), routeId)
	if err != nil {
		s.logger.Error("list bus vehicles failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, vehicles)
}

// GetBusVehicle returns a single vehicle (GET /bus/vehicles/{vehicleId}).
func (s *Server) GetBusVehicle(w http.ResponseWriter, r *http.Request, vehicleId openapi_types.UUID) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	vehicle, err := bus.NewStore(s.db.Pool()).GetVehicle(r.Context(), vehicleId)
	if errors.Is(err, bus.ErrVehicleNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Vehicle not found")
		return
	}
	if err != nil {
		s.logger.Error("get bus vehicle failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, vehicle)
}

// ListBusReminders returns the caller's stop reminders (GET /bus/reminders).
func (s *Server) ListBusReminders(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	rows, err := bus.NewStore(s.db.Pool()).ListReminders(r.Context(), userID)
	if err != nil {
		s.logger.Error("list bus reminders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// CreateBusReminder creates or toggles a stop reminder (POST /bus/reminders).
// enabled=false removes the reminder and returns null; enabled=true returns
// the created reminder (201).
func (s *Server) CreateBusReminder(w http.ResponseWriter, r *http.Request) {
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
		RouteId string `json:"routeId"`
		StopId  string `json:"stopId"`
		Enabled bool   `json:"enabled"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.RouteId == "" || body.StopId == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "routeId and stopId are required")
		return
	}
	routeID, err := uuid.Parse(body.RouteId)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "routeId is not a valid UUID")
		return
	}
	stopID, err := uuid.Parse(body.StopId)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "stopId is not a valid UUID")
		return
	}
	row, err := bus.NewStore(s.db.Pool()).UpsertReminder(r.Context(), userID, routeID, stopID, body.Enabled)
	if errors.Is(err, bus.ErrRouteNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Route or stop not found")
		return
	}
	if err != nil {
		s.logger.Error("upsert bus reminder failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}
