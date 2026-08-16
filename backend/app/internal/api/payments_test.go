package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payments"
)

// webhookTestSecret is shared by the webhook unit tests; PAYMENT_WEBHOOK_SECRET
// is set per-test via t.Setenv.
const webhookTestSecret = "unit-test-webhook-secret"

// TestCreatePaymentIntentRequiresToken: POST /payments/intent without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestCreatePaymentIntentRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/payments/intent", `{"orderId":"00000000-0000-4000-8000-000000000000","method":"mpesa"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestCreatePaymentIntentRequiresIdempotencyKey: intent creation without an
// Idempotency-Key is rejected with 422 VALIDATION_FAILED before any database
// work happens. The handler is invoked directly because the generated routing
// wrapper rejects a missing/empty header with a plain-text 400 first (the
// wrapper never reaches the handler in that case).
func TestCreatePaymentIntentRequiresIdempotencyKey(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/payments/intent",
		strings.NewReader(`{"orderId":"00000000-0000-4000-8000-000000000000","method":"mpesa"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.CreatePaymentIntent(rec, req, gen.CreatePaymentIntentParams{})

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestRefundPaymentRequiresToken: POST /payments/{intentId}/refund without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestRefundPaymentRequiresToken(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost,
		"/payments/00000000-0000-4000-8000-000000000000/refund", `{"amount":1000,"reason":"test"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// newWebhookRequest builds a POST to the webhook endpoint carrying the given
// signature header and raw body.
func newWebhookRequest(path, signatureHeader, signature, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if signature != "" {
		req.Header.Set(signatureHeader, signature)
	}
	return req
}

// TestPaymentWebhookWithoutSecret: with PAYMENT_WEBHOOK_SECRET unset the
// endpoint answers 503 — verification cannot run and nothing is trusted.
func TestPaymentWebhookWithoutSecret(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "")
	s := newTestServer()

	req := newWebhookRequest("/payments/webhooks/mpesa", "X-Webhook-Signature", "deadbeef",
		`{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-1","status":"paid"}`)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProviderMpesa)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "SERVICE_UNAVAILABLE" {
		t.Fatalf("error code = %q, want SERVICE_UNAVAILABLE", errBody.Code)
	}
}

// TestPaymentWebhookBadSignature: a wrong signature is rejected with 401
// PAYMENT_SIGNATURE_INVALID — the raw payload is never acted on.
func TestPaymentWebhookBadSignature(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", webhookTestSecret)
	s := newTestServer()

	req := newWebhookRequest("/payments/webhooks/mpesa", "X-Webhook-Signature", "deadbeef",
		`{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-2","status":"paid"}`)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProviderMpesa)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PAYMENT_SIGNATURE_INVALID" {
		t.Fatalf("error code = %q, want PAYMENT_SIGNATURE_INVALID", errBody.Code)
	}
}

// TestPaymentWebhookValidSignatureNoDB: with a valid signature but no
// database wired the endpoint answers a 500 envelope — the intent cannot be
// resolved and the payload must not be silently dropped.
func TestPaymentWebhookValidSignatureNoDB(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", webhookTestSecret)
	s := newTestServer()

	body := `{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-3","status":"paid"}`
	req := newWebhookRequest("/payments/webhooks/mpesa", "X-Webhook-Signature", hmacHex(webhookTestSecret, []byte(body)), body)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProviderMpesa)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestPaymentWebhookUnknownProvider: a provider outside the contract enum is
// rejected with 400 VALIDATION_FAILED.
func TestPaymentWebhookUnknownProvider(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", webhookTestSecret)
	s := newTestServer()

	req := newWebhookRequest("/payments/webhooks/other", "", "", `{}`)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProvider("other"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

// TestWebhookSecretForPerProviderWins: when both the per-provider secret and
// the default PAYMENT_WEBHOOK_SECRET are set, each provider resolves to its
// own key; providers without a dedicated env fall back to the default.
func TestWebhookSecretForPerProviderWins(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "default-secret")
	t.Setenv("MPESA_WEBHOOK_SECRET", "mpesa-secret")
	t.Setenv("TIGO_WEBHOOK_SECRET", "tigo-secret")

	secret, ok := webhookSecretFor("mpesa")
	if !ok || string(secret) != "mpesa-secret" {
		t.Fatalf("mpesa secret = %q ok=%v, want mpesa-secret true", secret, ok)
	}
	secret, ok = webhookSecretFor("tigo")
	if !ok || string(secret) != "tigo-secret" {
		t.Fatalf("tigo secret = %q ok=%v, want tigo-secret true", secret, ok)
	}
	// cardtonic has no dedicated env: the default applies.
	secret, ok = webhookSecretFor("cardtonic")
	if !ok || string(secret) != "default-secret" {
		t.Fatalf("cardtonic secret = %q ok=%v, want default-secret true", secret, ok)
	}
	// An unknown provider (never reaches the handler: provider.Valid() runs
	// first) still resolves through the default.
	secret, ok = webhookSecretFor("other")
	if !ok || string(secret) != "default-secret" {
		t.Fatalf("unknown provider secret = %q ok=%v, want default-secret true", secret, ok)
	}
}

// TestWebhookSecretForFallback: with only PAYMENT_WEBHOOK_SECRET set every
// provider verifies against it — the documented default for all.
func TestWebhookSecretForFallback(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "default-secret")
	t.Setenv("MPESA_WEBHOOK_SECRET", "")
	t.Setenv("AIRTEL_WEBHOOK_SECRET", "")

	for _, p := range []string{"mpesa", "tigo", "airtel", "card", "cardtonic"} {
		secret, ok := webhookSecretFor(p)
		if !ok || string(secret) != "default-secret" {
			t.Fatalf("provider %s secret = %q ok=%v, want default-secret true", p, secret, ok)
		}
	}
}

// TestWebhookSecretForNone: with no secret configured anywhere the lookup
// reports not-ok so the handler keeps its 503 path.
func TestWebhookSecretForNone(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "")
	t.Setenv("MPESA_WEBHOOK_SECRET", "")
	t.Setenv("CARD_WEBHOOK_SECRET", "")

	if secret, ok := webhookSecretFor("mpesa"); ok || len(secret) != 0 {
		t.Fatalf("mpesa secret = %q ok=%v, want empty/not-ok", secret, ok)
	}
	if secret, ok := webhookSecretFor("cardtonic"); ok || len(secret) != 0 {
		t.Fatalf("cardtonic secret = %q ok=%v, want empty/not-ok", secret, ok)
	}
}

// TestPaymentWebhookPerProviderSecret: a payload signed with MPESA_WEBHOOK_SECRET
// passes verification (no DB wired → the flow proceeds to the 500 envelope;
// reaching it proves the per-provider key replaced the default).
func TestPaymentWebhookPerProviderSecret(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "wrong-default")
	t.Setenv("MPESA_WEBHOOK_SECRET", webhookTestSecret)
	s := newTestServer()

	body := `{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-4","status":"paid"}`
	req := newWebhookRequest("/payments/webhooks/mpesa", "X-Webhook-Signature", hmacHex(webhookTestSecret, []byte(body)), body)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProviderMpesa)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (verification passed, no DB) (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestPaymentWebhookPerProviderSecretDefaultRejected: signing with the default
// PAYMENT_WEBHOOK_SECRET while a per-provider secret is set is rejected — the
// per-provider key is exclusive, not additive.
func TestPaymentWebhookPerProviderSecretDefaultRejected(t *testing.T) {
	t.Setenv("PAYMENT_WEBHOOK_SECRET", "default-secret")
	t.Setenv("MPESA_WEBHOOK_SECRET", webhookTestSecret)
	s := newTestServer()

	body := `{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-5","status":"paid"}`
	req := newWebhookRequest("/payments/webhooks/mpesa", "X-Webhook-Signature", hmacHex("default-secret", []byte(body)), body)
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProviderMpesa)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PAYMENT_SIGNATURE_INVALID" {
		t.Fatalf("error code = %q, want PAYMENT_SIGNATURE_INVALID", errBody.Code)
	}
}

// TestBuildProviderRequestMpesaShape: BuildProviderRequest shapes the mpesa
// STK push payload with the Daraja fields, the order id as AccountReference,
// and the platform reference (intent id) for reconciliation.
func TestBuildProviderRequestMpesaShape(t *testing.T) {
	orderID := uuid.New()
	req, err := payments.BuildProviderRequest("mpesa", payments.IntentRow{
		ID: uuid.New(), OrderID: &orderID, Method: "mpesa", AmountTZS: 16000,
	}, "+255700000000")
	if err != nil {
		t.Fatalf("build mpesa request: %v", err)
	}
	if req.Provider != "mpesa" || req.AmountTZS != 16000 || req.Phone != "+255700000000" {
		t.Fatalf("request = %+v, want mpesa/16000/+255700000000", req)
	}
	if req.Reference == "" || req.OrderID == nil || *req.OrderID != orderID {
		t.Fatalf("request = %+v, want reference set and order %s", req, orderID)
	}
	if got := req.Payload["TransactionType"]; got != "CustomerPayBillOnline" {
		t.Fatalf("TransactionType = %v, want CustomerPayBillOnline", got)
	}
	if got := req.Payload["Amount"]; got != int64(16000) {
		t.Fatalf("Amount = %v, want 16000", got)
	}
	if got := req.Payload["Msisdn"]; got != "+255700000000" {
		t.Fatalf("Msisdn = %v, want +255700000000", got)
	}
	if got := req.Payload["AccountReference"]; got != orderID.String() {
		t.Fatalf("AccountReference = %v, want %s", got, orderID)
	}
}

// TestBuildProviderRequestCardShape: the card request carries amount, TZS
// currency and the platform reference only.
func TestBuildProviderRequestCardShape(t *testing.T) {
	intentID := uuid.New()
	req, err := payments.BuildProviderRequest("card", payments.IntentRow{
		ID: intentID, Method: "card", AmountTZS: 25000,
	}, "")
	if err != nil {
		t.Fatalf("build card request: %v", err)
	}
	if req.Provider != "card" || req.Reference != intentID.String() || req.AmountTZS != 25000 {
		t.Fatalf("request = %+v, want card request for %s", req, intentID)
	}
	if got := req.Payload["amount"]; got != int64(25000) {
		t.Fatalf("amount = %v, want 25000", got)
	}
	if got := req.Payload["currency"]; got != "TZS" {
		t.Fatalf("currency = %v, want TZS", got)
	}
	if got := req.Payload["reference"]; got != intentID.String() {
		t.Fatalf("reference = %v, want %s", got, intentID)
	}
}

// TestBuildProviderRequestUnsupported: methods without a push flow return
// ErrPushUnsupported so the enqueue call site can log-and-skip.
func TestBuildProviderRequestUnsupported(t *testing.T) {
	for _, method := range []string{"cod", "bank", "ezy_pesa", "halotel"} {
		_, err := payments.BuildProviderRequest(method, payments.IntentRow{
			ID: uuid.New(), Method: method, AmountTZS: 5000,
		}, "+255700000000")
		if !errors.Is(err, payments.ErrPushUnsupported) {
			t.Fatalf("method %s error = %v, want ErrPushUnsupported", method, err)
		}
	}
}

// hmacHex computes the hex HMAC-SHA256 of body keyed by secret — the exact
// value a provider signs with.
func hmacHex(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
