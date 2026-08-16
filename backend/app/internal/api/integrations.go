package api

// INTEGRATIONS and WEBHOOKS bounded context (migration 00026): the
// per-merchant connector registry (integrations), the outgoing webhook
// registry (webhook_subscriptions) and the delivery attempt log
// (webhook_deliveries). All three are merchant-scoped: the merchant id is the
// authenticated session's users row id (see catalogues.go package comment).
// The webhook dispatcher owns webhook_deliveries writes; these handlers only
// read them.
//
// Contract drift vs this implementation (API-CONTRACT.yaml 5044-5170):
//   - The contract has no POST /integrations (create) and no GET
//     /webhooks/{webhookId} routes, so CreateIntegration and GetWebhook have
//     no generated signatures and are not implemented. The per-provider
//     allowed-scope set is still defined below for the create endpoint once
//     the contract grows one.
//   - disconnectIntegration responds 204 No Content (the contract's only
//     response for that route), not 200.
//   - ERROR-CODES.md has no webhook-not-found code (only WEBHOOK_URL_INVALID,
//     WEBHOOK_EVENT_INVALID, WEBHOOK_SECRET_MISSING, WEBHOOK_DELIVERY_FAILED),
//     so missing webhook ids surface the generic NOT_FOUND catalog code.
//   - listWebhookDeliveries paginates by keyset (created_at DESC, id DESC)
//     with a non-contract `cursor` query extension; the contract only
//     exposes webhookId + limit, which cannot express a second page.
//   - webhook status storage is a boolean active; the contract status enum
//     active|disabled|failing maps to active|disabled (failing is
//     dispatcher-owned).

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// integrationAllowedScopes is the scope vocabulary per provider that the
// create-integration endpoint will enforce (INTEGRATION_SCOPE_INVALID). The
// current contract has no create route; this table is the contract for it.
var integrationAllowedScopes = map[string]map[string]bool{
	"pos":        {"orders:read": true, "orders:write": true, "inventory:read": true, "customers:read": true},
	"erp":        {"orders:read": true, "inventory:read": true, "inventory:write": true, "finance:read": true},
	"accounting": {"finance:read": true, "finance:write": true},
	"payroll":    {"payroll:read": true, "payroll:write": true},
	"crm":        {"customers:read": true, "customers:write": true},
}

// validateIntegrationScope reports the first scope that is not in the
// provider's allowed set. An empty scope list is invalid: integrations are
// created with at least one scope.
func validateIntegrationScope(provider string, scopes []string) error {
	allowed, ok := integrationAllowedScopes[provider]
	if !ok {
		return fmt.Errorf("unknown provider %q", provider)
	}
	if len(scopes) == 0 {
		return errors.New("scope list must not be empty")
	}
	for _, s := range scopes {
		if !allowed[s] {
			return fmt.Errorf("scope %q is not valid for provider %q", s, provider)
		}
	}
	return nil
}

// integrationClaims enforces the merchant role from the bearer claims without
// any database access, so 401/403 land before body validation and before the
// user-id lookup.
func integrationClaims(w http.ResponseWriter, r *http.Request) (*Claims, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage integrations and webhooks")
		return nil, false
	}
	return claims, true
}

// integrationUserID resolves the authenticated subject to the users row id
// (the merchant id for this milestone). A missing database surfaces the
// INTERNAL_ERROR envelope.
func (s *Server) integrationUserID(w http.ResponseWriter, r *http.Request, claims *Claims) (uuid.UUID, bool) {
	if s.db == nil {
		s.logger.Error("integration user lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("integration user lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// integrationsMerchantID is the full merchant gate: claims, then the
// users-row id lookup.
func (s *Server) integrationsMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := integrationClaims(w, r)
	if !ok {
		return uuid.Nil, false
	}
	return s.integrationUserID(w, r, claims)
}

// validWebhookURL enforces the contract url format: the endpoint must be
// reachable over TLS, except loopback destinations that may stay on plain
// http for local development.
func validWebhookURL(raw string) bool {
	url := strings.TrimSpace(raw)
	return strings.HasPrefix(url, "https://") || strings.HasPrefix(url, "http://localhost")
}

// validWebhookEvents requires a non-empty array of non-empty event names.
func validWebhookEvents(events []string) bool {
	if len(events) == 0 {
		return false
	}
	for _, e := range events {
		if strings.TrimSpace(e) == "" {
			return false
		}
	}
	return true
}

// newWebhookSecret returns 32 cryptographically random bytes hex-encoded (64
// hex characters). It is returned to the client exactly once; only the raw
// string is stored.
func newWebhookSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate webhook secret: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// mapWebhookStatus projects the storage active boolean onto the contract
// status enum (active|disabled|failing; failing is dispatcher-owned).
func mapWebhookStatus(active bool) gen.WebhookSubscriptionStatus {
	if active {
		return gen.WebhookSubscriptionStatus("active")
	}
	return gen.WebhookSubscriptionStatus("disabled")
}

// mapDeliveryStatus projects the storage status enum
// (pending|delivered|failed) onto the contract enum (success|failed|
// retrying).
func mapDeliveryStatus(status string) gen.WebhookDeliveryStatus {
	switch status {
	case "delivered":
		return gen.WebhookDeliveryStatus("success")
	case "failed":
		return gen.WebhookDeliveryStatus("failed")
	default: // pending
		return gen.WebhookDeliveryStatus("retrying")
	}
}

// ListIntegrations returns the merchant's connected integrations and status
// (GET /integrations). Empty results serialize as [].
func (s *Server) ListIntegrations(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.integrationsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, provider, name, scope, status
		 FROM integrations
		 WHERE merchant_id = $1
		 ORDER BY created_at DESC, id DESC`, merchantID)
	if err != nil {
		s.logger.Error("list integrations failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.IntegrationInfo, 0, 8)
	for rows.Next() {
		var (
			id       uuid.UUID
			provider string
			name     *string
			scope    []byte
			status   string
		)
		if err := rows.Scan(&id, &provider, &name, &scope, &status); err != nil {
			s.logger.Error("scan integration failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		info := gen.IntegrationInfo{
			Id:       newUUID(id.String()),
			Provider: gen.IntegrationInfoProvider(provider),
			Status:   gen.IntegrationStatus(status),
			Label:    name,
		}
		if len(scope) > 0 {
			var scopes []string
			if err := json.Unmarshal(scope, &scopes); err == nil {
				info.Scopes = &scopes
			}
		}
		out = append(out, info)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate integrations failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DisconnectIntegration flips a connected integration to disconnected (POST
// /integrations/{integrationId}/disconnect, contract response 204). An
// unknown id surfaces INTEGRATION_NOT_FOUND; disconnecting an already
// disconnected integration surfaces INTEGRATION_DISCONNECTED.
func (s *Server) DisconnectIntegration(w http.ResponseWriter, r *http.Request, integrationId openapi_types.UUID) {
	merchantID, ok := s.integrationsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.DisconnectIntegrationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}

	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE integrations
		 SET status = 'disconnected', disconnected_at = now(), disconnect_reason = $3, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2 AND status = 'connected'`,
		integrationId, merchantID, strings.TrimSpace(body.Reason))
	if err != nil {
		s.logger.Error("disconnect integration failed", "integration", integrationId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		var status string
		err := s.db.Pool().QueryRow(r.Context(),
			`SELECT status FROM integrations WHERE id = $1 AND merchant_id = $2`,
			integrationId, merchantID).Scan(&status)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			writeError(w, http.StatusNotFound, "INTEGRATION_NOT_FOUND", "Integration not found")
		case err != nil:
			s.logger.Error("integration ownership lookup failed", "integration", integrationId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		case status == "disconnected":
			writeError(w, http.StatusConflict, "INTEGRATION_DISCONNECTED", "Integration is already disconnected")
		default:
			writeError(w, http.StatusNotFound, "INTEGRATION_NOT_FOUND", "Integration not found")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// loadWebhookSubscription loads one owned subscription without its secret.
// A missing or foreign row yields (nil, nil).
func (s *Server) loadWebhookSubscription(ctx context.Context, id, merchantID uuid.UUID) (*gen.WebhookSubscription, error) {
	var (
		subID      uuid.UUID
		url        string
		eventsJSON []byte
		active     bool
		createdAt  time.Time
		delivered  *time.Time
	)
	err := s.db.Pool().QueryRow(ctx, `
		SELECT w.id, w.url, w.event_types, w.active, w.created_at, d.delivered_at
		FROM webhook_subscriptions w
		LEFT JOIN LATERAL (
			SELECT delivered_at FROM webhook_deliveries
			WHERE subscription_id = w.id AND delivered_at IS NOT NULL
			ORDER BY created_at DESC, id DESC LIMIT 1
		) d ON true
		WHERE w.id = $1 AND w.merchant_id = $2`, id, merchantID).
		Scan(&subID, &url, &eventsJSON, &active, &createdAt, &delivered)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load webhook subscription %s: %w", id, err)
	}
	events := []string{}
	if len(eventsJSON) > 0 {
		if err := json.Unmarshal(eventsJSON, &events); err != nil {
			return nil, fmt.Errorf("decode webhook events %s: %w", id, err)
		}
	}
	uuidOut := newUUID(subID.String())
	status := mapWebhookStatus(active)
	return &gen.WebhookSubscription{
		Id:             &uuidOut,
		Url:            url,
		Events:         events,
		Status:         &status,
		LastDeliveryAt: delivered,
		CreatedAt:      &createdAt,
	}, nil
}

// ListWebhookSubscriptions returns the merchant's webhook subscriptions (GET
// /webhooks). The secret is never returned again after creation.
func (s *Server) ListWebhookSubscriptions(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.integrationsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(), `
		SELECT w.id, w.url, w.event_types, w.active, w.created_at, d.delivered_at
		FROM webhook_subscriptions w
		LEFT JOIN LATERAL (
			SELECT delivered_at FROM webhook_deliveries
			WHERE subscription_id = w.id AND delivered_at IS NOT NULL
			ORDER BY created_at DESC, id DESC LIMIT 1
		) d ON true
		WHERE w.merchant_id = $1
		ORDER BY w.created_at DESC, w.id DESC`, merchantID)
	if err != nil {
		s.logger.Error("list webhook subscriptions failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.WebhookSubscription, 0, 8)
	for rows.Next() {
		var (
			id        uuid.UUID
			url       string
			eventsJ   []byte
			active    bool
			createdAt time.Time
			delivered *time.Time
		)
		if err := rows.Scan(&id, &url, &eventsJ, &active, &createdAt, &delivered); err != nil {
			s.logger.Error("scan webhook subscription failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		events := []string{}
		if len(eventsJ) > 0 {
			if err := json.Unmarshal(eventsJ, &events); err != nil {
				s.logger.Error("decode webhook events failed", "subscription", id, "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
		}
		uuidOut := newUUID(id.String())
		status := mapWebhookStatus(active)
		out = append(out, gen.WebhookSubscription{
			Id:             &uuidOut,
			Url:            url,
			Events:         events,
			Status:         &status,
			LastDeliveryAt: delivered,
			CreatedAt:      &createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate webhook subscriptions failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateWebhookSubscription registers an outbound webhook (POST /webhooks).
// Validation (url, events) runs before any database access so invalid payloads
// answer 422 without touching the store. The generated secret is returned in
// the 201 body once (WebhookSubscription.secret is documented write-only, set
// once) and mirrored on the X-Webhook-Secret header; it is never stored or
// returned again.
func (s *Server) CreateWebhookSubscription(w http.ResponseWriter, r *http.Request) {
	claims, ok := integrationClaims(w, r)
	if !ok {
		return
	}
	var body gen.CreateWebhookSubscriptionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !validWebhookURL(body.Url) {
		writeError(w, http.StatusUnprocessableEntity, "WEBHOOK_URL_INVALID", "webhook url must start with https:// or http://localhost")
		return
	}
	if !validWebhookEvents(body.Events) {
		writeError(w, http.StatusUnprocessableEntity, "WEBHOOK_EVENT_INVALID", "events must be a non-empty array of event names")
		return
	}
	merchantID, ok := s.integrationUserID(w, r, claims)
	if !ok {
		return
	}

	secret, err := newWebhookSecret()
	if err != nil {
		s.logger.Error("webhook secret generation failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	eventsJSON, err := json.Marshal(body.Events)
	if err != nil {
		s.logger.Error("webhook events marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var (
		id        uuid.UUID
		createdAt time.Time
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO webhook_subscriptions (merchant_id, url, event_types, secret, active)
		 VALUES ($1, $2, $3::jsonb, $4, true) RETURNING id, created_at`,
		merchantID, strings.TrimSpace(body.Url), string(eventsJSON), secret).Scan(&id, &createdAt); err != nil {
		s.logger.Error("create webhook subscription failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	uuidOut := newUUID(id.String())
	status := mapWebhookStatus(true)
	resp := gen.WebhookSubscription{
		Id:        &uuidOut,
		Url:       strings.TrimSpace(body.Url),
		Events:    body.Events,
		Secret:    &secret,
		Status:    &status,
		CreatedAt: &createdAt,
	}
	w.Header().Set("X-Webhook-Secret", secret)
	writeJSON(w, http.StatusCreated, resp)
}

// UpdateWebhookSubscription patches url, events and/or the active toggle
// (PATCH /webhooks/{webhookId}; the contract status enum drives the toggle).
// The secret is immutable and never returned. A missing or foreign id
// surfaces the generic NOT_FOUND code (no webhook-specific code exists in
// ERROR-CODES.md).
func (s *Server) UpdateWebhookSubscription(w http.ResponseWriter, r *http.Request, webhookId openapi_types.UUID) {
	merchantID, ok := s.integrationsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateWebhookSubscriptionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	sets := []string{"updated_at = now()"}
	args := make([]any, 0, 5)
	if body.Url != "" {
		if !validWebhookURL(body.Url) {
			writeError(w, http.StatusUnprocessableEntity, "WEBHOOK_URL_INVALID", "webhook url must start with https:// or http://localhost")
			return
		}
		args = append(args, strings.TrimSpace(body.Url))
		sets = append(sets, fmt.Sprintf("url = $%d", len(args)))
	}
	if body.Events != nil {
		if !validWebhookEvents(body.Events) {
			writeError(w, http.StatusUnprocessableEntity, "WEBHOOK_EVENT_INVALID", "events must be a non-empty array of event names")
			return
		}
		eventsJSON, err := json.Marshal(body.Events)
		if err != nil {
			s.logger.Error("webhook events marshal failed", "webhook", webhookId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		args = append(args, string(eventsJSON))
		sets = append(sets, fmt.Sprintf("event_types = $%d::jsonb", len(args)))
	}
	if body.Status != nil {
		switch *body.Status {
		case gen.WebhookSubscriptionStatus("active"), gen.WebhookSubscriptionStatus("disabled"):
			args = append(args, *body.Status == gen.WebhookSubscriptionStatus("active"))
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be active or disabled")
			return
		}
		sets = append(sets, fmt.Sprintf("active = $%d", len(args)))
	}
	args = append(args, webhookId, merchantID)
	query := fmt.Sprintf(`UPDATE webhook_subscriptions SET %s WHERE id = $%d AND merchant_id = $%d`,
		strings.Join(sets, ", "), len(args)-1, len(args))

	tag, err := s.db.Pool().Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update webhook subscription failed", "webhook", webhookId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Webhook subscription not found")
		return
	}
	sub, err := s.loadWebhookSubscription(r.Context(), webhookId, merchantID)
	if err != nil {
		s.logger.Error("reload webhook subscription failed", "webhook", webhookId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

// DeleteWebhookSubscription removes a subscription and its delivery log
// (DELETE /webhooks/{webhookId}, ON DELETE CASCADE). A missing or foreign id
// surfaces the generic NOT_FOUND code.
func (s *Server) DeleteWebhookSubscription(w http.ResponseWriter, r *http.Request, webhookId openapi_types.UUID) {
	merchantID, ok := s.integrationsMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM webhook_subscriptions WHERE id = $1 AND merchant_id = $2`,
		webhookId, merchantID)
	if err != nil {
		s.logger.Error("delete webhook subscription failed", "webhook", webhookId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Webhook subscription not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// defaultWebhookDeliveriesLimit is the contract default page size.
const defaultWebhookDeliveriesLimit = 20

// maxWebhookDeliveriesLimit caps a requested limit.
const maxWebhookDeliveriesLimit = 100

// encodeDeliveriesCursor renders an opaque keyset cursor for the delivery
// list: base64url("createdAtRFC3339Nano|id"). The cursor is a non-contract
// extension of listWebhookDeliveries (the contract exposes no cursor
// parameter), so second pages stay stable under concurrent inserts.
func encodeDeliveriesCursor(at time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id.String()))
}

// decodeDeliveriesCursor parses a cursor produced by encodeDeliveriesCursor.
func decodeDeliveriesCursor(raw string) (time.Time, uuid.UUID, error) {
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor: %w", err)
	}
	parts := strings.SplitN(string(b), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, errors.New("invalid cursor")
	}
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor id: %w", err)
	}
	return at, id, nil
}

// ListWebhookDeliveries returns the merchant's webhook delivery attempts
// (GET /webhooks/deliveries), newest first, keyset-paginated: ORDER BY
// created_at DESC, id DESC with a LIMIT, plus an optional non-contract
// `cursor` query parameter for subsequent pages. webhookId filters to one
// subscription. Empty results serialize as [].
func (s *Server) ListWebhookDeliveries(w http.ResponseWriter, r *http.Request, params gen.ListWebhookDeliveriesParams) {
	merchantID, ok := s.integrationsMerchantID(w, r)
	if !ok {
		return
	}
	limit := defaultWebhookDeliveriesLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
	}
	if limit > maxWebhookDeliveriesLimit {
		limit = maxWebhookDeliveriesLimit
	}

	query := `SELECT d.id, d.subscription_id, d.event, d.status, d.attempts,
		d.last_status_code, d.next_attempt_at, d.delivered_at
		FROM webhook_deliveries d
		JOIN webhook_subscriptions w ON w.id = d.subscription_id
		WHERE w.merchant_id = $1`
	args := []any{merchantID}
	if params.WebhookId != nil {
		args = append(args, *params.WebhookId)
		query += fmt.Sprintf(` AND d.subscription_id = $%d`, len(args))
	}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		at, id, err := decodeDeliveriesCursor(raw)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid cursor")
			return
		}
		args = append(args, at, id)
		query += fmt.Sprintf(` AND (d.created_at, d.id) < ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(` ORDER BY d.created_at DESC, d.id DESC LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list webhook deliveries failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.WebhookDelivery, 0, limit)
	for rows.Next() {
		var (
			id             uuid.UUID
			subscriptionID uuid.UUID
			event          string
			status         string
			attempts       int
			lastCode       *int
			nextRetryAt    *time.Time
			deliveredAt    *time.Time
		)
		if err := rows.Scan(&id, &subscriptionID, &event, &status, &attempts,
			&lastCode, &nextRetryAt, &deliveredAt); err != nil {
			s.logger.Error("scan webhook delivery failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.WebhookDelivery{
			Id:          newUUID(id.String()),
			WebhookId:   newUUID(subscriptionID.String()),
			Event:       event,
			Status:      mapDeliveryStatus(status),
			Attempts:    attempts,
			StatusCode:  lastCode,
			NextRetryAt: nextRetryAt,
			DeliveredAt: deliveredAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate webhook deliveries failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
