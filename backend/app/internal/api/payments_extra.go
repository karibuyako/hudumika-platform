package api

// PAYMENTS-EXTRA surface (backend/API-CONTRACT.yaml "Payments"): the static
// methods list, payment history, intent reversal, quick customer payment
// requests and QR generation. Error codes follow ERROR-CODES.md "Payments"
// (PAYMENT_INTENT_NOT_FOUND, PAYMENT_ALREADY_PAID, PAYMENT_METHOD_UNSUPPORTED,
// PAYMENT_PROVIDER_ERROR, PAYMENT_QR_PROVIDER_UNSUPPORTED).
//
// NOTE ON THE OPERATION NAMES: the contract operation for /payments/request
// is requestCustomerPayment, so the generated interface method is
// RequestCustomerPayment — there is no RequestPayment method in
// internal/gen/openapi.gen.go. The contract body is {phone, amountTZS,
// method, note} (no orderId): the intent is order-less.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payments"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

const (
	// paymentHistoryDefaultLimit is the contract default page size for
	// /payments/history; paymentHistoryMaxLimit caps it (same convention as
	// the wallet transaction lists).
	paymentHistoryDefaultLimit = 20
	paymentHistoryMaxLimit     = 100
	// paymentQrTTL is how long a generated QR payload stays presentable.
	// The intent itself is not auto-expired; the client must not present
	// the QR after expiresAt.
	paymentQrTTL = 15 * time.Minute
)

// paymentMethodStatus is one entry of GET /payments/methods (contract inline
// schema {method, available}; no generated type exists).
type paymentMethodStatus struct {
	Method    string `json:"method"`
	Available bool   `json:"available"`
}

// ListPaymentMethods returns the static list of supported payment methods
// (GET /payments/methods). Every method in the PaymentIntentCreate enum is
// accepted by the handler-level validation (paymentMethods), so all eight
// are reported available — a static, optimistic answer until per-provider
// routing config exists. No database is touched.
func (s *Server) ListPaymentMethods(w http.ResponseWriter, r *http.Request) {
	out := make([]paymentMethodStatus, 0, len(paymentMethods))
	for _, m := range []string{"mpesa", "tigo_pesa", "airtel_money", "ezy_pesa", "halotel", "card", "cod", "bank"} {
		out = append(out, paymentMethodStatus{Method: m, Available: true})
	}
	writeJSON(w, http.StatusOK, out)
}

// paymentHistoryItem is one entry of GET /payments/history (contract inline
// schema {id, method, amountTZS, status, reference, createdAt}; no generated
// type exists).
type paymentHistoryItem struct {
	Id        openapi_types.UUID `json:"id"`
	Method    string             `json:"method"`
	AmountTZS int                `json:"amountTZS"`
	Status    string             `json:"status"`
	Reference *string            `json:"reference"`
	CreatedAt time.Time          `json:"createdAt"`
}

// historyStatus maps the store status onto the contract history enum. The
// enum has no 'partially_refunded' member, so that state projects as
// 'refunded'. The contract 'reversed' state never occurs yet: reversals set
// status 'failed' (the payment_intents CHECK constraint has no 'reversed').
func historyStatus(status string) string {
	if status == "partially_refunded" {
		return "refunded"
	}
	return status
}

// toPaymentHistory maps a store row onto a history item.
func toPaymentHistory(i payments.IntentRow) paymentHistoryItem {
	return paymentHistoryItem{
		Id:        newUUID(i.ID.String()),
		Method:    i.Method,
		AmountTZS: int(i.AmountTZS),
		Status:    historyStatus(i.Status),
		Reference: i.ProviderReference,
		CreatedAt: i.CreatedAt,
	}
}

// ListPaymentHistory returns the caller's order-linked payment intents,
// newest first, keyset-paginated (GET /payments/history; limit default 20,
// max 100). The next page cursor is returned in X-Next-Cursor. Wallet top-up
// intents are order-less and payment_intents has no customer column in this
// milestone, so they are not listed (see payments.Store.ListMyIntents).
func (s *Server) ListPaymentHistory(w http.ResponseWriter, r *http.Request, params gen.ListPaymentHistoryParams) {
	user, _, ok := s.paymentUser(w, r)
	if !ok {
		return
	}
	limit := paymentHistoryDefaultLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > paymentHistoryMaxLimit {
			limit = paymentHistoryMaxLimit
		}
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}

	intents, next, err := s.paymentStore().ListMyIntents(r.Context(), user.ID, limit, cursor)
	if err != nil {
		if errors.Is(err, payments.ErrInvalidCursor) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		s.logger.Error("payment history failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]paymentHistoryItem, 0, len(intents))
	for _, i := range intents {
		out = append(out, toPaymentHistory(i))
	}
	writeJSON(w, http.StatusOK, out)
}

// ReversePayment fails a pending payment intent (POST
// /payments/{intentId}/reverse). Only the order owner or a staff role may
// reverse; only status 'pending' transitions (a created-but-unconfirmed
// intent is abandoned by never confirming it).
//
// A zero-row guarded update means the intent is no longer pending — paid,
// failed or refunded — and maps to 409 PAYMENT_ALREADY_PAID, the closest
// documented state-conflict code (documented choice; 404 would hide the
// conflict from the finance role). The reversal is appended to
// payment_transactions (best-effort) so it is reconcilable.
func (s *Server) ReversePayment(w http.ResponseWriter, r *http.Request, intentId openapi_types.UUID) {
	user, claims, ok := s.paymentUser(w, r)
	if !ok {
		return
	}

	var body gen.ReversePaymentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == "" || len(body.Reason) > 500 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"reason is required and must be at most 500 characters")
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

	rows, err := st.ReverseIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment reverse failed", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if rows == 0 {
		writeError(w, http.StatusConflict, "PAYMENT_ALREADY_PAID",
			"Payment intent is not pending and cannot be reversed")
		return
	}
	s.logReverse(r.Context(), id, body.Reason)
	intent, err = st.GetIntent(r.Context(), id)
	if err != nil {
		s.logger.Error("payment intent reload failed after reverse", "intent", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toPaymentIntent(intent))
}

// logReverse appends a 'reverse' row to payment_transactions (append-only,
// best-effort) with the documented reason.
func (s *Server) logReverse(ctx context.Context, intentID uuid.UUID, reason string) {
	payload, _ := json.Marshal(map[string]string{"reason": reason})
	if err := s.paymentStore().LogTransaction(ctx, payments.PaymentTransaction{
		IntentID: &intentID, Provider: "internal", Action: "reverse", Status: "failed", Payload: payload,
	}); err != nil {
		s.logger.Warn("payment reverse log failed", "intent", intentID, "error", err)
	}
}

// requestCustomerPaymentMethods is the method enum of POST /payments/request
// (contract: mpesa, tigo_pesa, airtel_money, ezy_pesa, halotel, bank — no
// card/cod).
var requestCustomerPaymentMethods = map[string]bool{
	"mpesa": true, "tigo_pesa": true, "airtel_money": true, "ezy_pesa": true,
	"halotel": true, "bank": true,
}

// payIdemKey derives an intent idempotency key from a phone and the
// Idempotency-Key header. When the header is absent a random nonce is mixed
// in so every no-header request still creates a fresh intent (the shared
// middleware only replays when the header is present).
func payIdemKey(phone string, r *http.Request) string {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		key = uuid.NewString()
	}
	return sha256Hex(phone + "|" + key)
}

// RequestCustomerPayment sends a quick payment request to a customer phone
// (POST /payments/request, contract operation requestCustomerPayment): it
// creates an order-less intent (order_id NULL, no order exists) for the
// amount from the body and hands it to the STK-push outbox; the response
// carries the intent id as requestId with status pending_confirmation. The
// amount is trusted from the merchant's body per the contract (there is no
// order to server-compute a total from). The Idempotency-Key header is
// honoured when present via the shared middleware.
func (s *Server) RequestCustomerPayment(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.paymentUser(w, r); !ok {
		return
	}

	var body gen.RequestCustomerPaymentJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Phone == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "phone is required")
		return
	}
	if body.AmountTZS < 1 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS must be positive")
		return
	}
	if !requestCustomerPaymentMethods[string(body.Method)] {
		writeError(w, http.StatusUnprocessableEntity, "PAYMENT_METHOD_UNSUPPORTED",
			"method must be one of mpesa, tigo_pesa, airtel_money, ezy_pesa, halotel, bank")
		return
	}
	if body.Note != nil && len(*body.Note) > 200 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "note must be at most 200 characters")
		return
	}

	customer, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), body.Phone)
	if err != nil {
		s.logger.Error("payment request customer lookup failed", "phone", body.Phone, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if customer == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Customer not found")
		return
	}

	st := s.paymentStore()
	intent, err := st.CreateWalletIntent(r.Context(), string(body.Method), int64(body.AmountTZS), payIdemKey(customer.Phone, r))
	if err != nil {
		s.logger.Error("payment request intent create failed", "phone", body.Phone, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.enqueueStkPush(r.Context(), body.Phone, intent)
	writeJSON(w, http.StatusCreated, map[string]any{
		"requestId": intent.ID.String(),
		"status":    "pending_confirmation",
	})
}

// CreatePaymentQr generates a collection QR (POST /payments/qr). Provider
// validation (contract enum mpesa | tigo_pesa | airtel_money) runs before
// any database work. With orderId the intent is charged the server-side
// order total (the platform never trusts a client amount — same rule as
// CreatePaymentIntent); without orderId the QR backs a wallet-style intent
// carrying the body amountTZS, which is then required (minimum 1000 TZS,
// same floor as wallet top-ups).
//
// HONEST PAYLOAD (documented deviation): until a provider QR integration
// exists the payload is the provider-agnostic deep link
// hudumika://pay/{intentId} — the app opens it and drives the standard
// intent flow. expiresAt is now + 15 minutes (paymentQrTTL); the intent is
// not auto-expired, only the presentation window is.
func (s *Server) CreatePaymentQr(w http.ResponseWriter, r *http.Request) {
	var body gen.CreatePaymentQrJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Provider.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "PAYMENT_QR_PROVIDER_UNSUPPORTED",
			"provider must be one of mpesa, tigo_pesa, airtel_money")
		return
	}
	if body.Description != nil && len(*body.Description) > 120 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "description must be at most 120 characters")
		return
	}

	user, _, ok := s.paymentUser(w, r)
	if !ok {
		return
	}

	st := s.paymentStore()
	var (
		intent      payments.IntentRow
		amount      *int
		merchantRef *string
		err         error
	)
	if body.OrderId != nil {
		orderID := uuid.UUID(*body.OrderId)
		total, found, err := st.GetOrderTotal(r.Context(), orderID, user.ID)
		if err != nil {
			s.logger.Error("payment QR order total failed", "order", orderID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if !found {
			writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found or not owned by caller")
			return
		}
		t := int(total)
		amount = &t
		ref := orderID.String()
		merchantRef = &ref
		intent, err = st.CreateIntent(r.Context(), orderID, string(body.Provider), total, payIdemKey(user.Phone, r))
	} else {
		if body.AmountTZS == nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
				"amountTZS is required when no orderId is given")
			return
		}
		if *body.AmountTZS < 1000 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
				"amountTZS must be at least 1000")
			return
		}
		a := *body.AmountTZS
		amount = &a
		intent, err = st.CreateWalletIntent(r.Context(), string(body.Provider), int64(a), payIdemKey(user.Phone, r))
	}
	if err != nil {
		s.logger.Error("payment QR intent create failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusCreated, gen.PaymentQr{
		QrPayload:   "hudumika://pay/" + intent.ID.String(),
		Provider:    string(body.Provider),
		AmountTZS:   amount,
		MerchantRef: merchantRef,
		ExpiresAt:   time.Now().Add(paymentQrTTL).UTC(),
	})
}
