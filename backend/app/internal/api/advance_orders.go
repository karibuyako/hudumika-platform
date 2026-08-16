package api

import (
	"net/http"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
)

// ListAdvanceOrders returns the merchant's scheduled (advance) orders for the
// given day: orders whose scheduled_at falls on the requested date. Scheduled
// orders are the "advance" pre-orders the merchant prepares ahead of time.
func (s *Server) ListAdvanceOrders(w http.ResponseWriter, r *http.Request, params gen.ListAdvanceOrdersParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}

	dayStart := time.Date(params.Date.Year(), params.Date.Month(), params.Date.Day(), 0, 0, 0, 0, time.UTC)
	dayEnd := dayStart.Add(24 * time.Hour)

	store := orders.NewStore(s.db.Pool())
	list, err := store.ListAdvanceOrders(r.Context(), userID, dayStart, dayEnd, 100)
	if err != nil {
		s.logger.Error("list advance orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out := make([]gen.Order, 0, len(list))
	for i := range list {
		row, err := store.GetOrderRow(r.Context(), list[i])
		if err != nil {
			s.logger.Warn("advance order row skipped", "orderId", list[i], "error", err)
			continue
		}
		o := toGenOrder(*row)
		o.ScheduledAt = row.ScheduledAt
		out = append(out, o)
	}
	writeJSON(w, http.StatusOK, out)
}
