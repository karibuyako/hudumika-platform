package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/events"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Pagination bounds for the entertainment events surfaces.
const (
	defaultEventsListLimit = 20
	maxEventsListLimit     = 50
)

// ListEvents returns events with cursor pagination and optional cityId /
// category filters (GET /entertainment/events, contract ListEvents200). The
// next cursor rides in the response body.
func (s *Server) ListEvents(w http.ResponseWriter, r *http.Request, params gen.ListEventsParams) {
	if s.db == nil {
		s.logger.Error("list events failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultEventsListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxEventsListLimit {
			limit = maxEventsListLimit
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
	category := ""
	if params.Category != nil {
		category = *params.Category
	}

	rows, next, err := events.NewStore(s.db.Pool()).ListEvents(r.Context(), cityID, category, limit, cursor)
	if errors.Is(err, events.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list events failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.EventListing, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenEventListing(row))
	}
	writeJSON(w, http.StatusOK, struct {
		Results    []gen.EventListing `json:"results"`
		NextCursor *string            `json:"nextCursor"`
	}{Results: out, NextCursor: stringPtrOrNil(next)})
}

// GetEvent returns the event detail with its ticket tiers (GET
// /entertainment/events/{eventId}, contract EventDetail). A missing event
// is 404 EVENT_NOT_FOUND.
func (s *Server) GetEvent(w http.ResponseWriter, r *http.Request, eventId openapi_types.UUID) {
	if s.db == nil {
		s.logger.Error("get event failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, tiers, err := events.NewStore(s.db.Pool()).GetEvent(r.Context(), eventId)
	if errors.Is(err, events.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EVENT_NOT_FOUND", "Event not found")
		return
	}
	if err != nil {
		s.logger.Error("get event failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	outTiers := make([]gen.EventTier, 0, len(tiers))
	for _, t := range tiers {
		outTiers = append(outTiers, gen.EventTier{
			Id:        newUUID(t.ID.String()),
			Name:      t.Name,
			PriceTZS:  t.PriceTZS,
			Available: t.Available,
			Remaining: t.Remaining,
		})
	}
	writeJSON(w, http.StatusOK, gen.EventDetail{
		Event:       toGenEventListing(*row),
		Description: row.Description,
		Tiers:       outTiers,
	})
}

// PurchaseEventTickets issues tickets for an event tier (POST
// /entertainment/event-tickets, contract EventTicket array, 201). Each
// ticket carries an EV-XXXX code; the idempotency key (body or header)
// replays the originally issued tickets without decrementing remaining
// again.
func (s *Server) PurchaseEventTickets(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	var body gen.PurchaseEventTicketsJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.EventId == uuid.Nil || body.TierId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "eventId and tierId are required")
		return
	}
	if body.Quantity < 1 || body.Quantity > 10 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Quantity must be between 1 and 10")
		return
	}
	key := body.IdempotencyKey
	if key == nil || *key == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "idempotencyKey is required")
		return
	}
	if s.db == nil {
		s.logger.Error("purchase event tickets failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	tickets, err := events.NewStore(s.db.Pool()).PurchaseTickets(r.Context(), events.PurchaseInput{
		UserID:         userID,
		EventID:        body.EventId,
		TierID:         body.TierId,
		Quantity:       body.Quantity,
		IdempotencyKey: *key,
	})
	if errors.Is(err, events.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EVENT_NOT_FOUND", "Event or ticket tier not found")
		return
	}
	if errors.Is(err, events.ErrSoldOut) {
		writeError(w, http.StatusConflict, "CONFLICT", "Not enough tickets left in this tier")
		return
	}
	if err != nil {
		s.logger.Error("purchase event tickets failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.EventTicket, 0, len(tickets))
	for _, t := range tickets {
		out = append(out, toGenEventTicket(t))
	}
	writeJSON(w, http.StatusCreated, out)
}

// ListMyEventTickets returns the caller's tickets (GET
// /entertainment/event-tickets/me), newest first, as the contract array.
func (s *Server) ListMyEventTickets(w http.ResponseWriter, r *http.Request) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list my event tickets failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := events.NewStore(s.db.Pool()).ListMyTickets(r.Context(), userID)
	if err != nil {
		s.logger.Error("list my event tickets failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.EventTicket, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGenEventTicket(row))
	}
	writeJSON(w, http.StatusOK, out)
}

func toGenEventListing(e events.Event) gen.EventListing {
	category := e.Category
	venue := e.Venue
	return gen.EventListing{
		Id:               newUUID(e.ID.String()),
		Title:            e.Title,
		Category:         category,
		CityId:           e.CityID,
		CityName:         &e.CityName,
		Venue:            venue,
		StartsAt:         e.StartsAt,
		ImageUrl:         e.ImageURL,
		StartingPriceTZS: &e.StartingPriceTZS,
	}
}

func toGenEventTicket(t events.Ticket) gen.EventTicket {
	title := t.EventTitle
	venue := t.Venue
	startsAt := t.StartsAt
	return gen.EventTicket{
		Id:         newUUID(t.ID.String()),
		EventId:    newUUID(t.EventID.String()),
		EventTitle: &title,
		Venue:      venue,
		StartsAt:   startsAt,
		TierName:   t.TierName,
		PriceTZS:   t.PriceTZS,
		Code:       t.Code,
		Status:     gen.EventTicketStatus(t.Status),
	}
}