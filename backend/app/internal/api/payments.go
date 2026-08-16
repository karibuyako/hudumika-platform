package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/notifications"
	"github.com/hudumika/api-backend/internal/payments"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// paymentMethods is the set of methods accepted by PaymentIntentCreate
// (contract enum, mirrored by the payment_intents CHECK constraint).
var paymentMethods = map[string]bool{
	"mpesa": true, "tigo_pesa": true, "airtel_money": true, "ezy_pesa": true,
	"halotel": true, "card": true, "cod": true, "bank": true,
}

// staffRoles are the roles allowed to read and refund any payment intent.
var staffRoles = map[string]bool{
	RoleAdmin: true, RoleFinance: true, RoleOps: true, RoleCompliance: true,
}

// paymentStore returns the payments Store bound to the server pool. Callers
// must guard s.db before calling.
func (s *Server) paymentStore() *payments.Store {
	return payments.NewStore(s.db.Pool())
}

// paymentUser resolves the authenticated subject (JWT subject = phone) to
// the users row. Unlike currentUser, a missing database is a 500 here: money
// lookups must never degrade into a 404. Returns ok=false after writing the
// error envelope.
func (s *Server) paymentUser(w http.ResponseWriter, r *http.Request) (*auth.UserRow, *Claims, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, nil, false
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("payments user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return nil, nil, false
	}
	return user, claims, true
}

// paymentIntentOwner resolves the customer that owns the order behind the
// intent; (nil, nil) when the intent has no resolvable order (or the order
// row is absent). Callers treat nil as "not visible to the caller".
func (s *Server) paymentIntentOwner(ctx context.Context, st *payments.Store, intent *payments.IntentRow) (*uuid.UUID, error) {
	if intent.OrderID == nil {
		return nil, nil
	}
	return st.OrderCustomerUserID(ctx, *intent.OrderID)
}

// paymentVisible reports whether the caller may read/refund the intent: the
// order owner or a staff role. Ownership is never revealed to third parties.
func (s *Server) paymentVisible(user *auth.UserRow, role string, owner *uuid.UUID) bool {
	if staffRoles[role] {
		return true
	}
	return owner != nil && *owner == user.ID
}

// toPaymentIntent maps a store row onto the contract PaymentIntent.
func toPaymentIntent(i *payments.IntentRow) gen.PaymentIntent {
	return gen.PaymentIntent{
		Id:                newUUID(i.ID.String()),
		Status:            gen.PaymentIntentStatus(i.Status),
		AmountTZS:         int(i.AmountTZS),
		Method:            i.Method,
		ProviderReference: i.ProviderReference,
		PaidAt:            i.PaidAt,
	}
}

// CreatePaymentIntent creates a payment intent for an order the caller owns
// (POST /payments/intent, Idempotency-Key header required). The amount always
// comes from the server-side order total, never from the client. On success
// the provider flow (STK push) is handed to the outbox best-effort.
func (s *Server) CreatePaymentIntent(w http.ResponseWriter, r *http.Request, params gen.CreatePaymentIntentParams) {
	if params.IdempotencyKey == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	user, _, ok := s.paymentUser(w, r)
	if !ok {
		return
	}

	var body gen.CreatePaymentIntentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !paymentMethods[string(body.Method)] {
		writeError(w, http.StatusUnprocessableEntity, "PAYMENT_METHOD_UNSUPPORTED",
			"method must be one of mpesa, tigo_pesa, airtel_money, ezy_pesa, halotel, card, cod, bank")
		return
	}

	st := s.paymentStore()
	orderID := uuid.UUID(body.OrderId)
	total, found, err := st.GetOrderTotal(r.Context(), orderID, user.ID)
	if err != nil {
		s.logger.Error("payment order total failed", "order", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found or not owned by caller")
		return
	}

	idemKey := sha256Hex(user.Phone + "|" + params.IdempotencyKey)
	intent, err := st.CreateIntent(r.Context(), orderID, string(body.Method), total, idemKey)
	if err != nil {
		s.logger.Error("payment intent create failed", "order", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.enqueueStkPush(r.Context(), user.Phone, intent)
	writeJSON(w, http.StatusCreated, toPaymentIntent(&intent))
}

// enqueueStkPush hands the intent to the outbox so the delivery worker can
// trigger the provider STK push (Template "stk_push"). The payload is the
// per-provider request built by payments.BuildProviderRequest. Best-effort: a
// missing outbox, an unsupported provider (cod, bank, ezy_pesa, halotel — no
// push flow) or an enqueue failure is logged, never fatal to the request.
func (s *Server) enqueueStkPush(ctx context.Context, phone string, intent payments.IntentRow) {
	if s.outbox == nil {
		s.logger.Warn("stk push skipped: no outbox configured", "intent", intent.ID)
		return
	}
	req, err := payments.BuildProviderRequest(intent.Method, intent, phone)
	if err != nil {
		s.logger.Warn("stk push skipped: provider has no push flow",
			"intent", intent.ID, "method", intent.Method, "error", err)
		return
	}
	payload, err := req.ToJSON()
	if err != nil {
		s.logger.Error("stk push payload marshal failed", "intent", intent.ID, "error", err)
		return
	}
	if err := s.outbox.Enqueue(ctx, notifications.Message{
		Channel:   "sms",
		Recipient: phone,
		Template:  "stk_push",
		Payload:   payload,
	}); err != nil {
		s.logger.Warn("stk push enqueue failed", "intent", intent.ID, "error", err)
	}
}

// ConfirmPayment moves a created intent to pending (POST
// /payments/{intentId}/confirm) for providers that require a client-side
// confirmation before the STK/USSD/card flow starts. The order owner only;
// the SetStatus guard makes a repeat confirm an idempotent no-op.
func (s *Server) ConfirmPayment(w http.ResponseWriter, r *http.Request, intentId openapi_types.UUID) {
	user, _, ok := s.paymentUser(w, r)
	if !ok {
		return
	}

	st := s.paymentStore()
	id := uuid.UUID(intentId)
	intent, err := st.GetIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment intent lookup failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if intent == nil {
		writeError(w, http.StatusNotFound, "PAYMENT_INTENT_NOT_FOUND", "Payment intent not found")
		return
	}
	owner, err := s.paymentIntentOwner(r.Context(), st, intent)
	if err != nil {
		s.logger.Error("payment intent owner lookup failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if owner == nil || *owner != user.ID {
		writeError(w, http.StatusNotFound, "PAYMENT_INTENT_NOT_FOUND", "Payment intent not found")
		return
	}

	if _, err := st.SetStatus(r.Context(), id, "created", "pending"); err != nil {
		s.logger.Error("payment intent confirm failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// Reload for the response: a zero-row guarded update (already past
	// 'created') replays the current state instead of erroring.
	intent, err = st.GetIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment intent reload failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toPaymentIntent(intent))
}

// webhookPayload is the documented shape every signed provider webhook must
// carry:
//
//	{
//	  "orderId":   "<uuid>",           // order the intent was created for
//	  "reference": "<provider tx id>", // provider reference; also the replay anchor
//	  "status":    "paid" | "failed",  // terminal outcome only
//	  "reason":    "<failure text>"    // optional, failures only
//	}
//
// Providers that only carry their own reference may omit orderId; the intent
// is then resolved by reference alone. Anything that cannot be resolved to
// an intent is acknowledged with 200 so deliveries stop retrying — the
// platform never fails loudly on late or unknown webhooks.
type webhookPayload struct {
	OrderID   uuid.UUID `json:"orderId"`
	Reference string    `json:"reference"`
	Status    string    `json:"status"`
	Reason    string    `json:"reason"`
}

// webhookSecretEnv maps the contract webhook provider enum to its dedicated
// secret env var. Each provider gateway signs with its own key; the generic
// PAYMENT_WEBHOOK_SECRET remains the default for all providers, including
// cardtonic, which has no dedicated secret env.
var webhookSecretEnv = map[string]string{
	"mpesa":  "MPESA_WEBHOOK_SECRET",
	"tigo":   "TIGO_WEBHOOK_SECRET",
	"airtel": "AIRTEL_WEBHOOK_SECRET",
	"card":   "CARD_WEBHOOK_SECRET",
}

// webhookSecretFor returns the HMAC-SHA256 key that verifies a provider's
// webhook signature: the per-provider env (MPESA_WEBHOOK_SECRET,
// TIGO_WEBHOOK_SECRET, AIRTEL_WEBHOOK_SECRET, CARD_WEBHOOK_SECRET) when set,
// falling back to PAYMENT_WEBHOOK_SECRET (the documented default for all
// providers). ok is false when no secret is configured — the caller keeps
// the existing 503 "verification not configured" path.
func webhookSecretFor(provider string) ([]byte, bool) {
	if env := webhookSecretEnv[provider]; env != "" {
		if v := os.Getenv(env); v != "" {
			return []byte(v), true
		}
	}
	if v := os.Getenv("PAYMENT_WEBHOOK_SECRET"); v != "" {
		return []byte(v), true
	}
	return nil, false
}

// PaymentWebhook receives signed provider callbacks (POST
// /payments/webhooks/{provider}); it is deliberately outside the auth tree
// and unauthenticated. The signature is the ONLY trust anchor: unverified
// payloads are logged and rejected; verified payloads drive the intent state
// machine. Replays are idempotent by intent state — a second "paid" webhook
// for an already-paid intent changes nothing.
func (s *Server) PaymentWebhook(w http.ResponseWriter, r *http.Request, provider gen.PaymentWebhookParamsProvider) {
	if !provider.Valid() {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "provider must be one of mpesa, tigo, airtel, card, cardtonic")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "Request body too large or unreadable")
		return
	}

	secret, ok := webhookSecretFor(string(provider))
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Payment webhook verification is not configured")
		return
	}
	// Per-provider signature scheme: mpesa (Daraja) additionally accepts the
	// "base64:" digest form, every other provider uses the default hex HMAC
	// scheme. Unregistered providers fall back to HMACVerifier, the platform
	// default; the fallback path stays live for schemes added to the registry.
	verifier := payments.DefaultVerifiers()[string(provider)]
	if verifier == nil {
		verifier = payments.HMACVerifier{}
	}
	valid, err := verifier.Verify(secret, body, r.Header)
	if err != nil || !valid {
		s.logger.Warn("payment webhook signature invalid", "provider", provider, "error", err)
		s.logWebhook(r.Context(), provider, nil, "signature_invalid", body)
		writeError(w, http.StatusUnauthorized, "PAYMENT_SIGNATURE_INVALID", "Webhook signature verification failed")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	st := s.paymentStore()
	s.logWebhook(r.Context(), provider, nil, "verified", body)

	var p webhookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		// Signed but malformed: acknowledge so the provider stops retrying,
		// and keep the raw payload for reconciliation.
		s.logWebhook(r.Context(), provider, nil, "malformed", body)
		writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
		return
	}

	var intent *payments.IntentRow
	if p.Reference != "" {
		intent, err = st.FindIntentByProviderReference(r.Context(), p.Reference)
		if err != nil {
			s.logger.Error("payment webhook reference lookup failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if intent == nil && p.OrderID != uuid.Nil {
		intent, err = st.FindIntentByOrderID(r.Context(), p.OrderID)
		if err != nil {
			s.logger.Error("payment webhook order lookup failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if intent == nil {
		// Late or unknown webhook (order created after the provider settled,
		// or a foreign reference). Acknowledge so the provider stops retrying.
		s.logWebhook(r.Context(), provider, nil, "unresolved", body)
		writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
		return
	}

	switch p.Status {
	case "paid":
		rows, err := st.MarkPaid(r.Context(), intent.ID)
		if err != nil {
			s.logger.Error("payment webhook mark paid failed", "intent", intent.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		// rows==0 means the intent was already paid (replay) — still 200.
		if rows > 0 && p.Reference != "" && (intent.ProviderReference == nil || *intent.ProviderReference == "") {
			if err := st.SetProviderReference(r.Context(), intent.ID, p.Reference); err != nil {
				s.logger.Warn("payment provider reference set failed", "intent", intent.ID, "error", err)
			}
		}
		if intent.OrderID != nil {
			// The order row may lag behind the intent; a failure is logged,
			// never fatal to the webhook.
			if err := st.UpdateOrderToPaid(r.Context(), *intent.OrderID); err != nil {
				s.logger.Warn("payment order-to-paid failed", "order", *intent.OrderID, "error", err)
			}
			customerID, err := st.OrderCustomerUserID(r.Context(), *intent.OrderID)
			if err != nil {
				s.logger.Warn("payment.paid customer lookup failed", "order", *intent.OrderID, "error", err)
				customerID = nil
			}
			customer := ""
			if customerID != nil {
				customer = customerID.String()
			}
			publishPaymentEvent(r.Context(), s, "payment.paid", intent.OrderID.String(), customer,
				map[string]any{"intentId": intent.ID, "amountTZS": intent.AmountTZS})
		}
	case "failed":
		if _, err := st.MarkFailed(r.Context(), intent.ID, p.Reason); err != nil {
			s.logger.Error("payment webhook mark failed failed", "intent", intent.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if intent.OrderID != nil {
			customerID, err := st.OrderCustomerUserID(r.Context(), *intent.OrderID)
			if err != nil {
				s.logger.Warn("payment.failed customer lookup failed", "order", *intent.OrderID, "error", err)
				customerID = nil
			}
			customer := ""
			if customerID != nil {
				customer = customerID.String()
			}
			publishPaymentEvent(r.Context(), s, "payment.failed", intent.OrderID.String(), customer,
				map[string]any{"intentId": intent.ID, "reason": p.Reason})
		}
	default:
		// Unknown status from a verified provider: log and acknowledge.
		s.logWebhook(r.Context(), provider, &intent.ID, "unhandled_status", body)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

// logWebhook records the raw payload and verification outcome into
// payment_transactions (append-only). Best-effort: a logging failure never
// changes the webhook response. Non-JSON bodies are wrapped in a JSON string
// so the jsonb column never rejects a log row.
func (s *Server) logWebhook(ctx context.Context, provider gen.PaymentWebhookParamsProvider, intentID *uuid.UUID, status string, body []byte) {
	if s.db == nil {
		return
	}
	payload := body
	if !json.Valid(body) {
		payload, _ = json.Marshal(string(body))
	}
	if err := s.paymentStore().LogTransaction(ctx, payments.PaymentTransaction{
		IntentID: intentID,
		Provider: string(provider),
		Action:   "webhook",
		Status:   status,
		Payload:  payload,
	}); err != nil {
		s.logger.Warn("payment webhook log failed", "status", status, "error", err)
	}
}

// RefundPayment refunds a paid intent (POST /payments/{intentId}/refund).
// Only the order owner or a staff role may refund. Error mapping
// (ERROR-CODES.md "Payments"): an intent that is not paid conflicts — the
// closest documented state-conflict code is PAYMENT_ALREADY_PAID; a refund
// larger than the charged amount is PAYMENT_REFUND_EXCEEDS_AMOUNT.
func (s *Server) RefundPayment(w http.ResponseWriter, r *http.Request, intentId openapi_types.UUID) {
	user, claims, ok := s.paymentUser(w, r)
	if !ok {
		return
	}

	var body gen.RefundPaymentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Amount <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amount must be positive")
		return
	}
	if body.Reason == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}

	st := s.paymentStore()
	id := uuid.UUID(intentId)
	intent, err := st.GetIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment intent lookup failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if intent == nil {
		writeError(w, http.StatusNotFound, "PAYMENT_INTENT_NOT_FOUND", "Payment intent not found")
		return
	}
	owner, err := s.paymentIntentOwner(r.Context(), st, intent)
	if err != nil {
		s.logger.Error("payment intent owner lookup failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.paymentVisible(user, claims.Role, owner) {
		writeError(w, http.StatusNotFound, "PAYMENT_INTENT_NOT_FOUND", "Payment intent not found")
		return
	}

	if intent.Status != "paid" {
		writeError(w, http.StatusConflict, "PAYMENT_ALREADY_PAID", "Payment intent is not in a refundable state")
		return
	}
	if int64(body.Amount) > intent.AmountTZS {
		writeError(w, http.StatusConflict, "PAYMENT_REFUND_EXCEEDS_AMOUNT", "Refund amount exceeds the paid amount")
		return
	}
	if _, err := st.ApplyRefund(r.Context(), id, int64(body.Amount), body.Reason); err != nil {
		if errors.Is(err, payments.ErrNotRefundable) {
			writeError(w, http.StatusConflict, "PAYMENT_REFUND_EXCEEDS_AMOUNT", "Refund amount exceeds the paid amount")
			return
		}
		s.logger.Error("payment refund failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	intent, err = st.GetIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment intent reload failed after refund", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	orderID := ""
	if intent.OrderID != nil {
		orderID = intent.OrderID.String()
	}
	customer := ""
	if owner != nil {
		customer = owner.String()
	}
	publishPaymentEvent(r.Context(), s, "payment.refunded", orderID, customer,
		map[string]any{"intentId": intent.ID, "amountTZS": int64(body.Amount), "reason": body.Reason})
	writeJSON(w, http.StatusOK, toPaymentIntent(intent))
}

// GetPaymentIntentStatus returns the intent to its owner or a staff role
// (GET /payments/{intentId}).
func (s *Server) GetPaymentIntentStatus(w http.ResponseWriter, r *http.Request, intentId openapi_types.UUID) {
	user, claims, ok := s.paymentUser(w, r)
	if !ok {
		return
	}

	st := s.paymentStore()
	id := uuid.UUID(intentId)
	intent, err := st.GetIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment intent lookup failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if intent == nil {
		writeError(w, http.StatusNotFound, "PAYMENT_INTENT_NOT_FOUND", "Payment intent not found")
		return
	}
	owner, err := s.paymentIntentOwner(r.Context(), st, intent)
	if err != nil {
		s.logger.Error("payment intent owner lookup failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !s.paymentVisible(user, claims.Role, owner) {
		writeError(w, http.StatusNotFound, "PAYMENT_INTENT_NOT_FOUND", "Payment intent not found")
		return
	}
	writeJSON(w, http.StatusOK, toPaymentIntent(intent))
}
