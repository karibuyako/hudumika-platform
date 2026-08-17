package api

// LIVE DEALS bounded context (API-CONTRACT.yaml /marketing/live-deals,
// 神抢手-lite, consumer docs/CONTRACT-ADDITIONS.md "Live deals"): scheduled
// flash-sale sessions with countdowns, response {sessions: LiveDealSession[],
// nextCursor}. Session status is DERIVED from the window at list time — a
// session with starts_at <= now < ends_at is 'live'; before its starts_at it
// is 'scheduled'; from its ends_at onward it is 'ended' and dropped from the
// list — mirroring the consumer mock (mock/marketing.ts deriveLiveDealStatus)
// and the migration comment (the stored status column is never trusted).
// The response array is [] (never null) when the table is empty, and
// nextCursor is always null: the contract marks it nullable and this surface
// has no pagination knobs (a session list is bounded by the active window).

import (
	"net/http"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

// liveDealsResponse is the contract's inline {sessions, nextCursor} shape
// (no generated type exists for it).
type liveDealsResponse struct {
	Sessions   []gen.LiveDealSession `json:"sessions"`
	NextCursor *string               `json:"nextCursor"`
}

// ListLiveDeals returns the active flash-sale sessions (GET
// /marketing/live-deals), ordered by starts_at. The caller is resolved
// DB-gated (the session list is marketplace data): with no database the
// handler answers the uniform 500 envelope. Only sessions whose window is
// still open (ends_at > now) are returned; status is computed from the clock.
func (s *Server) ListLiveDeals(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT l.id, l.title, l.deal_price_tzs, l.original_price_tzs,
		        l.starts_at, l.ends_at, l.slots_total,
		        l.merchant_id, m.business_name
		 FROM live_deals l
		 JOIN merchants m ON m.id = l.merchant_id
		 WHERE l.ends_at > now()
		 ORDER BY l.starts_at, l.id`)
	if err != nil {
		s.logger.Error("live deals query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	now := time.Now()
	out := make([]gen.LiveDealSession, 0, 8)
	for rows.Next() {
		var (
			id           string
			title        string
			dealPrice    int64
			original     int64
			startsAt     time.Time
			endsAt       time.Time
			slotsTotal   int
			merchantID   string
			merchantName string
		)
		if err := rows.Scan(&id, &title, &dealPrice, &original, &startsAt, &endsAt,
			&slotsTotal, &merchantID, &merchantName); err != nil {
			s.logger.Error("live deals scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.LiveDealSession{
			Id:       newUUID(id),
			Title:    title,
			StartsAt: startsAt,
			EndsAt:   endsAt,
			Status:   liveDealStatusFor(now, startsAt, endsAt),
			Deals: &[]struct {
				MerchantId       string `json:"merchantId"`
				MerchantName     string `json:"merchantName"`
				OriginalPriceTZS int    `json:"originalPriceTZS"`
				PriceTZS         int    `json:"priceTZS"`
				QuantityLimit    *int   `json:"quantityLimit,omitempty"`
				Title            string `json:"title"`
			}{{
				MerchantId:       merchantID,
				MerchantName:     merchantName,
				Title:            title,
				PriceTZS:         int(dealPrice),
				OriginalPriceTZS: int(original),
				QuantityLimit:    liveDealQuantityLimit(slotsTotal),
			}},
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("live deals iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, liveDealsResponse{Sessions: out})
}

// liveDealStatusFor derives the contract status from the session window at
// the given instant (starts_at inclusive, ends_at exclusive — a session
// whose ends_at has passed is 'ended' and is filtered out by the query, so
// this only ever yields scheduled or live).
func liveDealStatusFor(now, startsAt, endsAt time.Time) gen.LiveDealSessionStatus {
	if now.Before(startsAt) {
		return gen.LiveDealSessionStatusScheduled
	}
	if !now.Before(endsAt) {
		return gen.LiveDealSessionStatusEnded
	}
	return gen.LiveDealSessionStatusLive
}

// liveDealQuantityLimit maps the session's total slots to the contract's
// per-customer quantityLimit; there is no per-customer cap in the schema, so
// the field is omitted (nil) when no slots are configured.
func liveDealQuantityLimit(slotsTotal int) *int {
	if slotsTotal <= 0 {
		return nil
	}
	limit := slotsTotal
	return &limit
}