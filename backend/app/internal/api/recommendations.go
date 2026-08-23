package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/recommendations"
)

// GetHomeRecommendations serves GET /home/recommendations — the live recommendation engine.
func (s *Server) GetHomeRecommendations(w http.ResponseWriter, r *http.Request, params gen.GetHomeRecommendationsParams) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	limit := 5
	if params.Limit != nil {
		limit = *params.Limit
	}

	var cityID *uuid.UUID
	if params.CityId != nil {
		v := uuid.UUID(*params.CityId)
		cityID = &v
	}

	// Cursor is opaque; for now we ignore it and return first page.
	var lat64, lon64 *float64
	if params.Lat != nil {
		v := float64(*params.Lat)
		lat64 = &v
	}
	if params.Lon != nil {
		v := float64(*params.Lon)
		lon64 = &v
	}
	start := time.Now()
	svc := recommendations.NewService(s.db.Pool())
	items, err := svc.GetRecommendations(r.Context(), user.ID, cityID, lat64, lon64, limit, "")
	latency := time.Since(start)
	if err != nil {
		s.RecordRecommendation("unknown", "error", latency)
		s.logger.Error("recommendations failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	mode := "warm"
	if len(items) > 0 && items[0].Reason == "Top rated in your city" {
		// Cold-start heuristic: first item is top-rated and no personalized reason.
		// The service's isCold is more accurate, but this is a close proxy without changing the return signature.
		mode = "cold"
		// If any item has personalized reason, it's warm even if first is top-rated due to padding.
		for _, it := range items {
			if it.Reason != "Top rated in your city" {
				mode = "warm"
				break
			}
		}
	} else if len(items) == 0 {
		mode = "cold"
	}
	s.RecordRecommendation(mode, "success", latency)

	// Ensure items is never null for contract honesty.
	if items == nil {
		items = []gen.RecommendedMerchant{}
	}

	resp := struct {
		Items      []gen.RecommendedMerchant `json:"items"`
		NextCursor *string                   `json:"nextCursor"`
	}{
		Items: items,
	}
	writeJSON(w, http.StatusOK, resp)
}

// PostUserEvent records a behavior event for recommendations.
func (s *Server) PostUserEvent(w http.ResponseWriter, r *http.Request) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	var body gen.PostUserEventJSONBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	// Validate enum already done by gen, but double-check type
	if !body.Type.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid event type")
		return
	}

	// Map gen enum to DB string
	eventType := string(body.Type)

	// Compute daypart server-side
	daypart := recommendations.DaypartFor(time.Now())

	var merchantID *uuid.UUID
	if body.MerchantId != nil {
		v := uuid.UUID(*body.MerchantId)
		merchantID = &v
	}
	var cityID *uuid.UUID
	if body.CityId != nil {
		v := uuid.UUID(*body.CityId)
		cityID = &v
	}
	var lat, lon *float64
	if body.Lat != nil {
		v := float64(*body.Lat)
		lat = &v
	}
	if body.Lon != nil {
		v := float64(*body.Lon)
		lon = &v
	}

	_, err = s.db.Pool().Exec(r.Context(),
		`INSERT INTO user_behavior_events (user_id, event_type, merchant_id, query, city_id, lat, lon, daypart) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		user.ID, eventType, merchantID, body.Query, cityID, lat, lon, daypart)
	if err != nil {
		s.logger.Error("record user event failed", "user", user.ID, "type", eventType, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
