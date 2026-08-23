package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// MthPairDualScreenReal handles POST /dual-screen/pair.
// It creates a pairing row for the authenticated merchant and returns a
// one-time pairing code (paired_token) used by the secondary device to
// associate itself with the merchant's dual-screen display.
func (s *Server) MthPairDualScreenReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body struct {
		DeviceID *string `json:"deviceId"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	_ = body.DeviceID
	storeID := chi.URLParam(r, "storeId")
	code := uuid.NewString()
	var (
		id     uuid.UUID
		status string
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO dual_screens (merchant_id, store_id, paired_token, status)
		 VALUES ($1,$2,$3,'unpaired')
		 ON CONFLICT (merchant_id) DO UPDATE
		   SET paired_token = EXCLUDED.paired_token,
		       status = 'unpaired',
		       store_id = COALESCE(NULLIF(EXCLUDED.store_id,''), dual_screens.store_id),
		       updated_at = now()
		 RETURNING id, status`,
		merchantID, nullText(storeID), code).Scan(&id, &status)
	if err != nil {
		s.logger.Error("pair dual screen failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"paired": true,
		"code":   code,
		"id":     id.String(),
		"status": status,
	})
}

// MthUpdateStoreDualScreenReal handles PATCH /stores/{storeId}/dual-screen.
// It upserts the merchant's dual-screen config (one row per merchant in the
// single-store model) and returns the stored configuration.
func (s *Server) MthUpdateStoreDualScreenReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body struct {
		Config json.RawMessage `json:"config"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Config) == 0 || strings.TrimSpace(string(body.Config)) == "null" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "config is required")
		return
	}
	var cfgCheck any
	if err := json.Unmarshal(body.Config, &cfgCheck); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "config must be valid JSON")
		return
	}
	storeID := chi.URLParam(r, "storeId")
	configStr := string(body.Config)
	var (
		id     uuid.UUID
		status string
		config []byte
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO dual_screens (merchant_id, store_id, config, status)
		 VALUES ($1,$2,$3::jsonb,'unpaired')
		 ON CONFLICT (merchant_id) DO UPDATE
		   SET config = dual_screens.config || EXCLUDED.config,
		       store_id = COALESCE(NULLIF(EXCLUDED.store_id,''), dual_screens.store_id),
		       updated_at = now()
		 RETURNING id, status, config`,
		merchantID, nullText(storeID), configStr).Scan(&id, &status, &config)
	if err != nil {
		s.logger.Error("update store dual screen failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       id.String(),
		"storeId":  storeID,
		"status":   status,
		"config":   json.RawMessage(config),
	})
}

// MthUpdateStoreQrOrderingReal handles PATCH /stores/{storeId}/qr-ordering.
// It stores the QR-ordering enabled flag inside the merchant's dual_screens
// config (single-store model) and returns the resulting flag.
func (s *Server) MthUpdateStoreQrOrderingReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		s.writeMerchantError(w, err)
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Enabled == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "enabled is required")
		return
	}
	storeID := chi.URLParam(r, "storeId")
	patch := string(mustJSON(map[string]any{"enabled": *body.Enabled}))
	var (
		id     uuid.UUID
		status string
		config []byte
	)
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO dual_screens (merchant_id, store_id, config, status)
		 VALUES ($1,$2,$3::jsonb,'unpaired')
		 ON CONFLICT (merchant_id) DO UPDATE
		   SET config = dual_screens.config || EXCLUDED.config,
		       store_id = COALESCE(NULLIF(EXCLUDED.store_id,''), dual_screens.store_id),
		       updated_at = now()
		 RETURNING id, status, config`,
		merchantID, nullText(storeID), patch).Scan(&id, &status, &config)
	if err != nil {
		s.logger.Error("update store qr ordering failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       id.String(),
		"storeId":  storeID,
		"enabled":  *body.Enabled,
		"status":   status,
	})
}

// nullText returns nil for an empty/whitespace string so nullable text columns
// stay NULL rather than storing an empty string.
func nullText(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// mustJSON marshals v to a JSON byte slice. The call sites only ever pass
// marshallable values, so on the impossible error path we fall back to {}.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}
