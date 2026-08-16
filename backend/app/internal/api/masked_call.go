package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Masked VoIP call sessions (POST /orders/{orderId}/masked-call;
// ERROR-CODES.md MASKED_CALL_*). A session is a short-lived record in Redis
// keyed by the order and the caller side — `call:{orderId}:{role}` — so the
// customer and the rider each hold their own session for the same order.
// The real number exchange happens against the VoIP gateway when
// MASKED_CALL_GATEWAY_URL is configured: this handler mints the session id,
// persists it, and answers the gateway-allocated masked number (fail-open to
// a deterministic placeholder when the gateway is unset or unreachable — see
// maskedPhoneFor). Verification (VerifyMaskedCall) compares the
// presented session id against the stored one in constant time and enforces
// the TTL, so a session can be neither forged nor replayed past its expiry.
const (
	// maskedCallTTL is the lifetime of a masked call session (5 minutes).
	maskedCallTTL = 5 * time.Minute

	// maskedCallKeyPrefix namespaces the masked-call sessions in Redis.
	maskedCallKeyPrefix = "call:"

	// maskedCallGatewayEnv names the environment variable holding the VoIP
	// gateway base URL (registered in docs/ENV-VARS.md). When set, the
	// deterministic placeholder masked number is replaced by the gateway's
	// allocation.
	maskedCallGatewayEnv = "MASKED_CALL_GATEWAY_URL"

	// maskedCallGatewayTimeout bounds a single gateway number-allocation call.
	maskedCallGatewayTimeout = 10 * time.Second
)

// errMaskedCallExpired is returned by VerifyMaskedCall when the session key
// is absent, the presented session id does not match, or the session has
// expired — the MASKED_CALL_EXPIRED semantics in ERROR-CODES.md.
var errMaskedCallExpired = errors.New("masked call session expired")

// maskedCallSession is the projection of one Redis masked-call session,
// returned by VerifyMaskedCall on success.
type maskedCallSession struct {
	SessionID  string
	OrderID    string
	CallerRole string
	ExpiresAt  time.Time
}

// maskedCallKey builds the Redis key for an order + caller side.
func maskedCallKey(orderID uuid.UUID, callerRole string) string {
	return fmt.Sprintf("%s%s:%s", maskedCallKeyPrefix, orderID, callerRole)
}

// CreateMaskedCall mints a masked VoIP call session for the order (POST
// /orders/{orderId}/masked-call, 201 MaskedCallSession). Parties only: the
// owning customer (always allowed, whether or not a rider is bound), the
// assigned rider (order.rider_id must resolve to a riders row owned by the
// session user), or any merchant session (the orders bounded-context
// milestone rule, same as canViewOrder). Everyone else — including staff and
// customers of other orders — sees the same 404 ORDER_NOT_FOUND as a missing
// order so existence never leaks; a rider whose order is not assigned to
// them gets the documented 403 MASKED_CALL_NOT_ALLOWED.
//
// The optional body may carry callerRole ("customer" | "rider") to declare
// which side initiates; it defaults to the session role (merchant sessions
// default to the customer side). The session is stored as
// HSET call:{orderId}:{callerRole} {sessionId, orderId, callerRole,
// expiresAt} with a 5-minute TTL. The masked number in the response comes
// from the VoIP gateway when MASKED_CALL_GATEWAY_URL is set (maskedPhoneFor),
// otherwise it is a deterministic placeholder derived from the session id —
// the fail-open stub the gateway milestone replaces. The contract also lists
// a 409 Conflict response, but no conflict condition exists yet: a fresh
// session always replaces the previous one for the same side.
func (s *Server) CreateMaskedCall(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("create masked call failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	orderID := uuid.UUID(orderId)
	row, err := orders.NewStore(s.db.Pool()).GetOrderRow(r.Context(), orderID)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("create masked call: order lookup failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	callerRole := ""
	var body struct {
		CallerRole *string `json:"callerRole"`
	}
	if err := decodeJSON(r, &body); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.CallerRole != nil {
		callerRole = *body.CallerRole
		if callerRole != "customer" && callerRole != "rider" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "callerRole must be customer or rider")
			return
		}
	} else {
		switch claims.Role {
		case RoleRider:
			callerRole = "rider"
		default:
			// Customers and merchants call the customer side by default.
			callerRole = "customer"
		}
	}

	allowed, err := s.maskedCallPartyAllowed(r.Context(), claims, actor, row)
	if err != nil {
		s.logger.Error("create masked call: party gate failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !allowed {
		if claims.Role == RoleRider {
			writeError(w, http.StatusForbidden, "MASKED_CALL_NOT_ALLOWED", "Order is not assigned to this rider")
		} else {
			writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		}
		return
	}
	if s.stores == nil || s.stores.Redis == nil {
		s.logger.Error("create masked call failed: Redis not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		s.logger.Error("create masked call: session id generation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	sessionID := hex.EncodeToString(raw)

	now := time.Now()
	expiresAt := now.Add(maskedCallTTL)
	key := maskedCallKey(orderID, callerRole)
	client := s.stores.Redis.Client()
	pipe := client.TxPipeline()
	pipe.HSet(r.Context(), key, map[string]any{
		"sessionId":  sessionID,
		"orderId":    orderID.String(),
		"callerRole": callerRole,
		"expiresAt":  expiresAt.UTC().Format(time.RFC3339),
	})
	pipe.Expire(r.Context(), key, maskedCallTTL)
	if _, err := pipe.Exec(r.Context()); err != nil {
		s.logger.Error("create masked call: session store failed", "orderId", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	direction := gen.RiderToCustomer
	if callerRole == "customer" {
		direction = gen.CustomerToRider
	}
	writeJSON(w, http.StatusCreated, gen.MaskedCallSession{
		SessionId:    newUUID(sessionID),
		OrderId:      newUUIDPtr(orderID),
		MaskedNumber: maskedPhoneFor(r, orderID.String(), sessionID),
		Direction:    &direction,
		ExpiresAt:    expiresAt.UTC(),
	})
}

// maskedCallPartyAllowed reports whether the authenticated session may open
// a masked call for this order: the owning customer, the assigned rider
// (order.rider_id must resolve to a riders row owned by the session user),
// or any merchant session. The error is only the rider-lookup failure — DB
// failures are 500s, never a spoofed denial.
func (s *Server) maskedCallPartyAllowed(ctx context.Context, claims *Claims, actor uuid.UUID, order *orders.OrderRow) (bool, error) {
	switch claims.Role {
	case RoleCustomer:
		return order.CustomerUserID == actor, nil
	case RoleRider:
		if order.RiderID == nil {
			return false, nil
		}
		var owner uuid.UUID
		err := s.db.Pool().QueryRow(ctx,
			`SELECT owner_user_id FROM riders WHERE id = $1`, *order.RiderID).Scan(&owner)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("masked call: rider lookup %s: %w", *order.RiderID, err)
		}
		return owner == actor, nil
	case RoleMerchant:
		// Any merchant session may call for this milestone; binding to the
		// merchant's identity lands with the merchants bounded context.
		return true, nil
	default:
		return false, nil
	}
}

// VerifyMaskedCall checks a presented session id against the Redis session
// for the order and caller side, returning the session when it is valid and
// errMaskedCallExpired otherwise. The comparison is constant-time, and a
// missing key, a mismatched id, a missing/non-positive TTL, or a stored
// expiresAt in the past all count as expired (MASKED_CALL_EXPIRED). Session
// ids are normalized (lowercased, dashes stripped) before comparison so both
// the raw 32-hex form stored in Redis and the dashed form served to clients
// verify.
func (s *Server) VerifyMaskedCall(ctx context.Context, orderID uuid.UUID, callerRole, sessionID string) (maskedCallSession, error) {
	if s.stores == nil || s.stores.Redis == nil {
		return maskedCallSession{}, fmt.Errorf("verify masked call: redis not configured")
	}
	key := maskedCallKey(orderID, callerRole)
	fields, err := s.stores.Redis.Client().HGetAll(ctx, key).Result()
	if err != nil {
		return maskedCallSession{}, fmt.Errorf("verify masked call: hgetall %s: %w", key, err)
	}
	if len(fields) == 0 {
		return maskedCallSession{}, errMaskedCallExpired
	}
	stored, ok := fields["sessionId"]
	if !ok || subtle.ConstantTimeCompare(
		[]byte(normalizeSessionID(stored)), []byte(normalizeSessionID(sessionID))) != 1 {
		return maskedCallSession{}, errMaskedCallExpired
	}
	ttl, err := s.stores.Redis.Client().TTL(ctx, key).Result()
	if err != nil {
		return maskedCallSession{}, fmt.Errorf("verify masked call: ttl %s: %w", key, err)
	}
	if ttl <= 0 {
		return maskedCallSession{}, errMaskedCallExpired
	}
	expiresAt, err := time.Parse(time.RFC3339, fields["expiresAt"])
	if err != nil || !expiresAt.After(time.Now()) {
		return maskedCallSession{}, errMaskedCallExpired
	}
	return maskedCallSession{
		SessionID:  stored,
		OrderID:    fields["orderId"],
		CallerRole: fields["callerRole"],
		ExpiresAt:  expiresAt,
	}, nil
}

// normalizeSessionID lowercases and strips dashes from a session id so the
// raw 32-hex form stored in Redis and the dashed form served to clients
// compare equal.
func normalizeSessionID(s string) string {
	return strings.ReplaceAll(strings.ToLower(s), "-", "")
}

// maskedPhoneFromSession derives the deterministic placeholder masked number
// ("07XX XXX XXX") from the 32-hex session id. It is an honest stub: a real
// VoIP gateway allocates the actual proxy number in a later milestone; the
// derivation only keeps the field stable per session.
func maskedPhoneFromSession(sessionID string) string {
	if len(sessionID) < 10 {
		return "0700 000 000"
	}
	digits := make([]byte, 10)
	for i := range digits {
		digits[i] = sessionID[(i*3)%len(sessionID)]
	}
	return "07" + string(digits[2:4]) + " " + string(digits[4:7]) + " " + string(digits[7:10])
}

// maskedCallGatewayResponse is the wire shape of the VoIP gateway's number
// allocation answer.
type maskedCallGatewayResponse struct {
	MaskedPhone string `json:"maskedPhone"`
}

// maskedPhoneFor resolves the masked number for a call session. When
// MASKED_CALL_GATEWAY_URL is set, the VoIP gateway allocates the proxy
// number: the handler POSTs {sessionId, orderId} as JSON and reads
// {maskedPhone} back, bounded by maskedCallGatewayTimeout. When the variable
// is unset — and on any gateway failure (non-200, unparseable body, empty
// maskedPhone, network error) — the deterministic placeholder from
// maskedPhoneFromSession is returned instead. The gateway is deliberately
// fail-open: a gateway outage must never break call session creation, so the
// session is stored with the stub number and the failure is only logged.
func maskedPhoneFor(r *http.Request, orderID, sessionID string) string {
	gatewayURL := os.Getenv(maskedCallGatewayEnv)
	if gatewayURL == "" {
		return maskedPhoneFromSession(sessionID)
	}
	body, err := json.Marshal(map[string]string{
		"sessionId": sessionID,
		"orderId":   orderID,
	})
	if err != nil {
		slog.Default().Warn("masked call: gateway request marshal failed, falling back to stub", "error", err)
		return maskedPhoneFromSession(sessionID)
	}
	ctx, cancel := context.WithTimeout(r.Context(), maskedCallGatewayTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, gatewayURL, bytes.NewReader(body))
	if err != nil {
		slog.Default().Warn("masked call: gateway request build failed, falling back to stub", "url", gatewayURL, "error", err)
		return maskedPhoneFromSession(sessionID)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Default().Warn("masked call: gateway call failed, falling back to stub", "url", gatewayURL, "error", err)
		return maskedPhoneFromSession(sessionID)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		slog.Default().Warn("masked call: gateway returned non-200, falling back to stub", "url", gatewayURL, "status", resp.StatusCode)
		return maskedPhoneFromSession(sessionID)
	}
	var out maskedCallGatewayResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		slog.Default().Warn("masked call: gateway response decode failed, falling back to stub", "url", gatewayURL, "error", err)
		return maskedPhoneFromSession(sessionID)
	}
	if out.MaskedPhone == "" {
		slog.Default().Warn("masked call: gateway returned an empty maskedPhone, falling back to stub", "url", gatewayURL)
		return maskedPhoneFromSession(sessionID)
	}
	return out.MaskedPhone
}
