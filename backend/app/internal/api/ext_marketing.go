package api

import (
	"net/http"
	"time"

	"github.com/google/uuid"
)

// MthStopCampaignReal stops a merchant's coupon campaign by flipping its
// status to 'stopped'. It replaces the 501 stub MthStopCampaign on the same
// path (POST /campaigns/{id}/stop).
//
// Caveat: the live coupon_campaigns.status CHECK constraint currently only
// permits ('draft','live','ended'). Writing 'stopped' will be rejected by the
// database at runtime until a migration extends that constraint to include
// 'stopped'. The handler performs the UPDATE as instructed and reports DB
// errors; the orchestrator must add the allowed status via migration.
func (s *Server) MthStopCampaignReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnauthorized, "VALIDATION_FAILED", "Invalid campaign id")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}

	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE coupon_campaigns SET status = 'stopped', updated_at = now()
		  WHERE id = $1 AND merchant_id = $2`, id, merchantID)
	if err != nil {
		s.logger.Error("stop campaign failed", "campaign", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Campaign not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id.String(), "status": "stopped"})
}

// MthListMarketingCouponsReal lists the coupons belonging to the session
// merchant's coupon campaigns. It replaces the 501 stub
// MthListMarketingCoupons on the same path (GET /marketing/coupons).
func (s *Server) MthListMarketingCouponsReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT c.id, c.campaign_id, c.code, c.status, c.claimed_at, c.used_at, c.expires_at,
		        c.created_at, camp.title
		   FROM coupons c
		   JOIN coupon_campaigns camp ON camp.id = c.campaign_id
		  WHERE camp.merchant_id = $1
		  ORDER BY c.created_at DESC, c.id`, merchantID)
	if err != nil {
		s.logger.Error("list marketing coupons failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	type couponOut struct {
		ID            string     `json:"id"`
		CampaignID    string     `json:"campaignId"`
		CampaignTitle string     `json:"campaignTitle"`
		Code          string     `json:"code"`
		Status        string     `json:"status"`
		ClaimedAt     *time.Time `json:"claimedAt"`
		UsedAt        *time.Time `json:"usedAt"`
		ExpiresAt     *time.Time `json:"expiresAt"`
		CreatedAt     time.Time  `json:"createdAt"`
	}

	out := make([]couponOut, 0)
	for rows.Next() {
		var (
			id, campaignID               uuid.UUID
			code, status, campaignTitle string
			claimedAt, usedAt, expiresAt *time.Time
			createdAt                   time.Time
		)
		if err := rows.Scan(&id, &campaignID, &code, &status, &claimedAt, &usedAt, &expiresAt, &createdAt, &campaignTitle); err != nil {
			s.logger.Error("scan marketing coupon failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, couponOut{
			ID:            id.String(),
			CampaignID:    campaignID.String(),
			CampaignTitle: campaignTitle,
			Code:          code,
			Status:        status,
			ClaimedAt:     claimedAt,
			UsedAt:        usedAt,
			ExpiresAt:     expiresAt,
			CreatedAt:     createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate marketing coupons failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthExportAnalyticsReportReal creates a data_exports row scoped to the
// session merchant (stored against the session user id) for an analytics
// report and returns its id, status and a download URL. NEW ROUTE
// (POST /analytics/reports/export).
func (s *Server) MthExportAnalyticsReportReal(w http.ResponseWriter, r *http.Request) {
	s.exportReport(w, r, "analytics")
}

// MthExportChainReportReal creates a data_exports row scoped to the session
// merchant (stored against the session user id) for a chain report and
// returns its id, status and a download URL. NEW ROUTE (POST /chain/reports).
func (s *Server) MthExportChainReportReal(w http.ResponseWriter, r *http.Request) {
	s.exportReport(w, r, "chain")
}

func (s *Server) exportReport(w http.ResponseWriter, r *http.Request, scope string) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}

	var body struct {
		Format string `json:"format"`
	}
	if err := decodeJSON(r, &body); err != nil {
		// Body is optional; treat a missing/invalid body as an empty filter.
		body.Format = "csv"
	}
	format := body.Format
	if format == "" {
		format = "csv"
	}

	var id uuid.UUID
	var status string
	downloadURL := "https://api.hudumika.app/exports/" + uuid.NewString() + "/download"
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO data_exports (user_id, scope, format, status, file_url)
		  VALUES ($1, $2, $3, 'queued', $4)
		  RETURNING id, status`, userID, scope, format, downloadURL).
		Scan(&id, &status)
	if err != nil {
		s.logger.Error("create export failed", "scope", scope, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":          id.String(),
		"status":      status,
		"downloadUrl": downloadURL,
	})
}

