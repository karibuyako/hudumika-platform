package api

import (
	"net/http"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payouts"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Pagination bounds for /payouts/me.
const (
	defaultPayoutListLimit = 20
	maxPayoutListLimit     = 50
)

// ListMyPayouts returns the caller's payout history (GET /payouts/me),
// keyset-paginated with the next page in X-Next-Cursor. An empty array
// (never null) when the earner has no payouts.
func (s *Server) ListMyPayouts(w http.ResponseWriter, r *http.Request, params gen.ListMyPayoutsParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("list payouts failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	limit := defaultPayoutListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > maxPayoutListLimit {
			limit = maxPayoutListLimit
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}

	rows, next, err := payouts.NewStore(s.db.Pool()).ListPayouts(r.Context(), userID, limit, cursor)
	if err != nil {
		s.logger.Error("list payouts failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.PayoutSummary, 0, len(rows))
	for _, row := range rows {
		out = append(out, toPayoutSummary(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// GetMyStatement returns the caller's ledger statement for the requested
// window (GET /payouts/me/statement). from/to default to 30 days ago and
// now; from after to is rejected with 422 VALIDATION_FAILED. The to date is
// inclusive of the whole day.
func (s *Server) GetMyStatement(w http.ResponseWriter, r *http.Request, params gen.GetMyStatementParams) {
	userID, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("get statement failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	now := time.Now().UTC()
	from := now.AddDate(0, 0, -30)
	if params.From != nil {
		from = params.From.Time
	}
	fromEcho := openapi_types.Date{Time: from}

	toEcho := openapi_types.Date{Time: now}
	to := now
	if params.To != nil {
		toEcho = *params.To
		// The to date is inclusive: extend the window through the whole day.
		to = params.To.Time.Add(24 * time.Hour)
	}
	if from.After(to) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "from must not be after to")
		return
	}

	opening, closing, entries, err := payouts.NewStore(s.db.Pool()).Statement(r.Context(), userID, from, to)
	if err != nil {
		s.logger.Error("get statement failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	openingTZS := int(opening)
	closingTZS := int(closing)
	out := make([]gen.LedgerEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, toLedgerEntry(e))
	}
	writeJSON(w, http.StatusOK, gen.LedgerStatement{
		From:              fromEcho,
		To:                toEcho,
		OpeningBalanceTZS: &openingTZS,
		ClosingBalanceTZS: &closingTZS,
		Entries:           out,
	})
}

// toPayoutSummary maps a payout_entries row onto the contract
// PayoutSummary.
func toPayoutSummary(row payouts.PayoutRow) gen.PayoutSummary {
	var method *string
	if row.Method != "" {
		m := row.Method
		method = &m
	}
	return gen.PayoutSummary{
		Id:        newUUID(row.ID.String()),
		AmountTZS: int(row.AmountTZS),
		Status:    gen.PayoutSummaryStatus(row.Status),
		Method:    method,
		CreatedAt: row.CreatedAt,
		PaidAt:    row.PaidAt,
	}
}

// toLedgerEntry maps a ledger_entries row onto the contract LedgerEntry.
func toLedgerEntry(row payouts.LedgerEntryRow) gen.LedgerEntry {
	var refID *openapi_types.UUID
	if row.ReferenceID != nil {
		v := newUUID(row.ReferenceID.String())
		refID = &v
	}
	return gen.LedgerEntry{
		Id:            newUUID(row.ID.String()),
		Type:          gen.LedgerEntryType(row.Type),
		AmountTZS:     int(row.AmountTZS),
		BalanceTZS:    int(row.BalanceTZS),
		ReferenceType: row.ReferenceType,
		ReferenceId:   refID,
		CreatedAt:     row.CreatedAt,
	}
}
