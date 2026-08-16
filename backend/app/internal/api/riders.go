package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/riders"
)

// riderVehicles is the set of vehicle values accepted by the contract and the
// riders table CHECK constraint.
var riderVehicles = map[string]bool{
	"motorcycle": true,
	"bicycle":    true,
	"car":        true,
}

// riderStore returns the riders Store bound to the server pool. It panics
// only when called with a nil database; callers must guard s.db first.
func (s *Server) riderStore() *riders.Store {
	return riders.NewStore(s.db.Pool())
}

// riderRegistry returns the Redis-backed online registry; nil when the server
// runs with in-memory stores (no REDIS_URL).
func (s *Server) riderRegistry() *riders.OnlineRegistry {
	if s.stores == nil || s.stores.Redis == nil {
		return nil
	}
	return riders.NewOnlineRegistry(s.stores.Redis)
}

// ApplyRider submits a rider application for the caller (POST /riders). The
// session subject (phone) is authoritative for identity; a user may apply
// exactly once.
func (s *Server) ApplyRider(w http.ResponseWriter, r *http.Request) {
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	var body gen.ApplyRiderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if body.City == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "city is required")
		return
	}
	if body.Vehicle == nil || !body.Vehicle.Valid() || !riderVehicles[string(*body.Vehicle)] {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "vehicle must be one of motorcycle, bicycle, car")
		return
	}

	id, err := s.riderStore().Apply(r.Context(), user.ID, body.Name, body.City, string(*body.Vehicle))
	if errors.Is(err, riders.ErrAlreadyApplied) {
		writeError(w, http.StatusConflict, "CONFLICT", "Rider application already submitted for this account")
		return
	}
	if err != nil {
		s.logger.Error("rider application failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.LeadCreated{
		Id:        newUUID(id.String()),
		Status:    gen.LeadCreatedStatusSubmitted,
		CreatedAt: time.Now().UTC(),
	})
}

// GetMyRider returns the caller's rider profile with the live online flag
// (GET /riders/me). Earnings summary fields remain at zero until the ledger
// context lands.
func (s *Server) GetMyRider(w http.ResponseWriter, r *http.Request) {
	rider, _, ok := s.myRider(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, toRiderPrivate(rider))
}

// UpdateMyRider patches the caller's rider profile (PATCH /riders/me). The
// contract exposes vehicle as the mutable profile field; name is not
// patchable and is kept as-is.
func (s *Server) UpdateMyRider(w http.ResponseWriter, r *http.Request) {
	rider, userID, ok := s.myRider(w, r)
	if !ok {
		return
	}

	var body gen.UpdateMyRiderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	vehicle := rider.Vehicle
	if body.Vehicle != nil {
		v := string(*body.Vehicle)
		if !riderVehicles[v] {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "vehicle must be one of motorcycle, bicycle, car")
			return
		}
		vehicle = v
	}

	if err := s.riderStore().UpdateProfile(r.Context(), rider.ID, rider.Name, vehicle); err != nil {
		s.logger.Error("rider profile update failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	updated, err := s.riderStore().GetByOwner(r.Context(), userID)
	if err != nil || updated == nil {
		s.logger.Error("rider reload failed after profile update", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRiderPrivate(updated))
}

// SetRiderAvailability flips the dispatch online flag (PUT
// /riders/me/availability): the durable DB flag plus the Redis online set so
// any dispatch instance sees the change. A Redis failure degrades to the DB
// flag (logged, never fatal); the request still succeeds.
func (s *Server) SetRiderAvailability(w http.ResponseWriter, r *http.Request) {
	rider, _, ok := s.myRider(w, r)
	if !ok {
		return
	}

	var body gen.SetRiderAvailabilityJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	if err := s.riderStore().SetOnline(r.Context(), rider.ID, body.Online); err != nil {
		s.logger.Error("rider online flag update failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if reg := s.riderRegistry(); reg != nil {
		if err := reg.SetOnline(r.Context(), rider.ID, body.Online); err != nil {
			s.logger.Warn("rider online set sync failed", "rider", rider.ID, "online", body.Online, "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReportRiderLocation accepts a throttled location ping (POST
// /riders/me/location). Coordinates are validated, the write is rate-limited
// per rider (12 writes per 60 s ≈ one per 5 s), and the position lands in
// Redis with a short TTL.
func (s *Server) ReportRiderLocation(w http.ResponseWriter, r *http.Request) {
	rider, _, ok := s.myRider(w, r)
	if !ok {
		return
	}

	var body gen.ReportRiderLocationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Lat < -90 || body.Lat > 90 || body.Lon < -180 || body.Lon > 180 {
		writeError(w, http.StatusUnprocessableEntity, "LOCATION_INVALID", "lat must be within -90..90 and lon within -180..180")
		return
	}

	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	decision, err := s.stores.Rate.Allow(r.Context(), "rider:loc:"+claims.Subject, 12, time.Minute, time.Now())
	if err != nil {
		s.logger.Warn("location rate limit store failed", "error", err)
	} else if !decision.Allowed {
		writeErrorWithRetry(w, http.StatusTooManyRequests, "LOCATION_RATE_LIMITED", "Location updates are throttled", int(decision.RetryAfter.Seconds()))
		return
	}

	reg := s.riderRegistry()
	if reg == nil {
		s.logger.Error("location ping rejected: no Redis configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := reg.Location(r.Context(), rider.ID, float64(body.Lat), float64(body.Lon)); err != nil {
		s.logger.Error("location store failed", "rider", rider.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// myRider resolves the caller's rider row, writing the error envelope and
// returning ok=false when it cannot. The caller is authenticated (RequireAuth
// has run) and the subject maps to the users row; a missing rider row is the
// 404 case.
func (s *Server) myRider(w http.ResponseWriter, r *http.Request) (*riders.Rider, uuid.UUID, bool) {
	user, _, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return nil, uuid.Nil, false
	}
	rider, err := s.riderStore().GetByOwner(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("rider lookup failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, uuid.Nil, false
	}
	if rider == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No rider profile for this account")
		return nil, uuid.Nil, false
	}
	return rider, user.ID, true
}

// toRiderPrivate maps a riders row onto the contract RiderPrivate. Earnings
// summary fields are zeros until the ledger context lands.
func toRiderPrivate(r *riders.Rider) gen.RiderPrivate {
	out := gen.RiderPrivate{
		Id:           newUUID(r.ID.String()),
		Name:         r.Name,
		City:         r.CityID,
		Vehicle:      gen.RiderPrivateVehicle(r.Vehicle),
		Verification: gen.VerificationState(r.Verification),
		Online:       r.Online,
	}
	if r.Rating != nil {
		v := float32(*r.Rating)
		out.Rating = &v
	}
	if r.ReviewCount != nil {
		v := *r.ReviewCount
		out.ReviewCount = &v
	}
	return out
}
