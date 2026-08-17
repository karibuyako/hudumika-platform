package payments

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// darajaUnitConfig is the fixture configuration every unit test builds on.
func darajaUnitConfig() DarajaConfig {
	return DarajaConfig{
		Env:            "sandbox",
		ConsumerKey:    "unit-consumer-key",
		ConsumerSecret: "unit-consumer-secret",
		ShortCode:      "174379",
		PassKey:        "unit-pass-key",
		CallbackURL:    "https://api.example.test/payments/webhooks/mpesa",
	}
}

// darajaUnitNow is the fixed clock every unit test runs on, so the STK
// password and token TTLs are deterministic.
var darajaUnitNow = time.Date(2026, 8, 17, 10, 30, 45, 0, time.UTC)

// newDarajaUnitClient builds a client pointed at the fixture server with the
// fixed clock.
func newDarajaUnitClient(t *testing.T, server *httptest.Server) *DarajaClient {
	t.Helper()
	cfg := darajaUnitConfig()
	cfg.HTTPClient = server.Client()
	cfg.BaseURL = server.URL
	cfg.Now = func() time.Time { return darajaUnitNow }
	c, err := NewDarajaClient(cfg)
	if err != nil {
		t.Fatalf("NewDarajaClient: %v", err)
	}
	return c
}

// darajaTokenServer answers the OAuth endpoint with access_token and
// expires_in, counting requests.
func darajaTokenServer(t *testing.T, accessToken, expiresIn string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != darajaTokenPath {
			t.Errorf("token path = %q, want %q", r.URL.Path, darajaTokenPath)
		}
		if got := r.URL.Query().Get("grant_type"); got != "client_credentials" {
			t.Errorf("grant_type = %q, want client_credentials", got)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "unit-consumer-key" || pass != "unit-consumer-secret" {
			t.Errorf("basic auth = %q/%q ok %v, want unit-consumer-key/unit-consumer-secret", user, pass, ok)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"`+accessToken+`","expires_in":"`+expiresIn+`"}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

// TestDarajaTokenFlow: the OAuth client-credentials grant fetches a token
// with Basic auth, caches it until just before expiry (no second request
// within the window), and refetches after expiry.
func TestDarajaTokenFlow(t *testing.T) {
	srv, calls := darajaTokenServer(t, "unit-access-token", "3600")
	c := newDarajaUnitClient(t, srv)

	tok, err := c.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "unit-access-token" {
		t.Fatalf("token = %q, want unit-access-token", tok)
	}
	if calls.Load() != 1 {
		t.Fatalf("token requests = %d, want 1", calls.Load())
	}

	// Cached: another call within the window must not hit the wire.
	if tok, err = c.Token(context.Background()); err != nil {
		t.Fatalf("cached Token: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("cached token requests = %d, want 1", calls.Load())
	}

	// Expired: the next call refetches.
	c.now = func() time.Time { return darajaUnitNow.Add(3600 * time.Second) }
	if _, err = c.Token(context.Background()); err != nil {
		t.Fatalf("refetch Token: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("refetched token requests = %d, want 2", calls.Load())
	}
}

// TestDarajaTokenRejectsNon2xx: a failing token endpoint is surfaced as an
// error so the delivery worker retries with backoff.
func TestDarajaTokenRejectsNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	c := newDarajaUnitClient(t, srv)

	if _, err := c.Token(context.Background()); err == nil {
		t.Fatal("Token = nil error, want one from a 401 response")
	}
}

// TestNormalizeMpesaPhone: the accepted local forms all map to the Daraja
// MSISDN (2547XXXXXXXX); anything else fails with a clear error.
func TestNormalizeMpesaPhone(t *testing.T) {
	for input, want := range map[string]string{
		"+255712345678": "254712345678",
		"255712345678":  "254712345678",
		"0712345678":    "254712345678",
		"712345678":     "254712345678",
		"254712345678":  "254712345678",
	} {
		got, err := NormalizeMpesaPhone(input)
		if err != nil {
			t.Fatalf("NormalizeMpesaPhone(%q) error = %v, want %q", input, err, want)
		}
		if got != want {
			t.Fatalf("NormalizeMpesaPhone(%q) = %q, want %q", input, got, want)
		}
	}
	for _, input := range []string{"", "+255612345678", "0612345678", "12345", "2547999999999", "abc"} {
		if _, err := NormalizeMpesaPhone(input); err == nil {
			t.Fatalf("NormalizeMpesaPhone(%q) = nil error, want one", input)
		}
	}
}

// stkCapturedRequest is what the fixture STK server saw on the wire.
type stkCapturedRequest struct {
	headers  http.Header
	body     map[string]any
	password string
	token    string
}

// darajaStkServer answers the token endpoint and the STK processrequest,
// capturing the invoke body. The STK response is configurable.
func darajaStkServer(t *testing.T, stkResponse string) (*httptest.Server, *stkCapturedRequest) {
	t.Helper()
	var captured stkCapturedRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case darajaTokenPath:
			_, _ = io.WriteString(w, `{"access_token":"unit-access-token","expires_in":"3600"}`)
		case darajaStkPushPath:
			captured.headers = r.Header.Clone()
			captured.token = r.Header.Get("Authorization")
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &captured.body); err != nil {
				t.Errorf("stk body: %v", err)
			}
			if p, ok := captured.body["Password"].(string); ok {
				captured.password = p
			}
			_, _ = io.WriteString(w, stkResponse)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &captured
}

// TestDarajaSTKPushShape: the processrequest payload carries every Daraja
// field with the normalized MSISDN, the base64(shortcode+passkey+timestamp)
// password, and the Bearer token from the OAuth step.
func TestDarajaSTKPushShape(t *testing.T) {
	srv, captured := darajaStkServer(t, `{"MerchantRequestID":"M-1","CheckoutRequestID":"C-1","ResponseCode":"0","ResponseDesc":"Success"}`)
	c := newDarajaUnitClient(t, srv)

	resp, err := c.STKPush(context.Background(), STKPushRequest{
		AmountTZS:        16000,
		Phone:            "+255712345678",
		AccountReference: "order-123",
		TransactionDesc:  "Hudumika payment",
	})
	if err != nil {
		t.Fatalf("STKPush: %v", err)
	}
	if resp.CheckoutRequestID != "C-1" || resp.MerchantRequestID != "M-1" {
		t.Fatalf("response = %+v, want CheckoutRequestID C-1 MerchantRequestID M-1", resp)
	}

	want := map[string]any{
		"BusinessShortCode": "174379",
		"Timestamp":         "20260817103045",
		"TransactionType":   "CustomerPayBillOnline",
		"Amount":            float64(16000),
		"PartyA":            "254712345678",
		"PartyB":            "174379",
		"PhoneNumber":       "254712345678",
		"CallBackURL":       "https://api.example.test/payments/webhooks/mpesa",
		"AccountReference":  "order-123",
		"TransactionDesc":   "Hudumika payment",
	}
	for k, v := range want {
		if got := captured.body[k]; got != v {
			t.Fatalf("payload[%s] = %v, want %v (payload %v)", k, got, v, captured.body)
		}
	}
	if captured.token != "Bearer unit-access-token" {
		t.Fatalf("Authorization = %q, want Bearer unit-access-token", captured.token)
	}
	// Password = base64(shortcode + passkey + timestamp).
	wantPassword := base64.StdEncoding.EncodeToString([]byte("174379" + "unit-pass-key" + "20260817103045"))
	if captured.password != wantPassword {
		t.Fatalf("Password = %q, want %q", captured.password, wantPassword)
	}
	if got := captured.body["PhoneNumber"]; got != "254712345678" {
		t.Fatalf("PhoneNumber = %v, want normalized 254712345678", got)
	}
}

// TestDarajaSTKPushRejectsBadPhone: an unparseable number fails at invoke
// time with a clear error and never reaches the wire.
func TestDarajaSTKPushRejectsBadPhone(t *testing.T) {
	srv, _ := darajaStkServer(t, `{}`)
	c := newDarajaUnitClient(t, srv)

	_, err := c.STKPush(context.Background(), STKPushRequest{
		AmountTZS:        1000,
		Phone:            "not-a-phone",
		AccountReference: "order-1",
	})
	if err == nil || !strings.Contains(err.Error(), "not a valid") {
		t.Fatalf("STKPush error = %v, want a phone normalization error", err)
	}
}

// TestDarajaSTKPushRejectsDarajaResponseCode: a non-"0" ResponseCode from
// Daraja is an error carrying the description.
func TestDarajaSTKPushRejectsDarajaResponseCode(t *testing.T) {
	srv, _ := darajaStkServer(t, `{"MerchantRequestID":"M-1","CheckoutRequestID":"C-1","ResponseCode":"1","ResponseDesc":"The service request is rejected"}`)
	c := newDarajaUnitClient(t, srv)

	_, err := c.STKPush(context.Background(), STKPushRequest{
		AmountTZS:        1000,
		Phone:            "+255712345678",
		AccountReference: "order-1",
	})
	if err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("STKPush error = %v, want a rejection error", err)
	}
}

// TestParseSTKCallbackPaid: ResultCode 0 with CallbackMetadata maps to the
// paid outcome with the amount, receipt and account reference lifted from
// the metadata.
func TestParseSTKCallbackPaid(t *testing.T) {
	body := []byte(`{
		"Body": {
			"stkCallback": {
				"MerchantRequestID": "M-1",
				"CheckoutRequestID": "C-1",
				"ResultCode": 0,
				"ResultDesc": "The service request is processed successfully.",
				"CallbackMetadata": {
					"Item": [
						{"Name": "Amount", "Value": 16000},
						{"Name": "MpesaReceiptNumber", "Value": "PBF1A2B3C4"},
						{"Name": "TransactionDate", "Value": 20260817103045},
						{"Name": "PhoneNumber", "Value": "254712345678"},
						{"Name": "AccountReference", "Value": "order-123"},
						{"Name": "TransactionDesc", "Value": "Hudumika payment"}
					]
				}
			}
		}
	}`)
	cb, err := ParseSTKCallback(body)
	if err != nil {
		t.Fatalf("ParseSTKCallback: %v", err)
	}
	if cb.Status() != "paid" {
		t.Fatalf("Status() = %q, want paid (ResultCode 0)", cb.Status())
	}
	if cb.CheckoutRequestID != "C-1" || cb.MerchantRequestID != "M-1" {
		t.Fatalf("callback = %+v, want C-1/M-1", cb)
	}
	if cb.AmountTZS != 16000 {
		t.Fatalf("AmountTZS = %d, want 16000", cb.AmountTZS)
	}
	if cb.MpesaReceipt != "PBF1A2B3C4" || cb.AccountReference != "order-123" || cb.Phone != "254712345678" {
		t.Fatalf("callback = %+v, want receipt/account/phone lifted from metadata", cb)
	}
}

// TestParseSTKCallbackFailed: a non-zero ResultCode maps to failed with the
// Daraja ResultDesc as the reason.
func TestParseSTKCallbackFailed(t *testing.T) {
	body := []byte(`{
		"Body": {
			"stkCallback": {
				"MerchantRequestID": "M-2",
				"CheckoutRequestID": "C-2",
				"ResultCode": 1,
				"ResultDesc": "The balance is insufficient for the transaction."
			}
		}
	}`)
	cb, err := ParseSTKCallback(body)
	if err != nil {
		t.Fatalf("ParseSTKCallback: %v", err)
	}
	if cb.Status() != "failed" {
		t.Fatalf("Status() = %q, want failed (ResultCode 1)", cb.Status())
	}
	if cb.ResultDesc != "The balance is insufficient for the transaction." {
		t.Fatalf("ResultDesc = %q, want the Daraja reason", cb.ResultDesc)
	}
	if cb.AmountTZS != 0 {
		t.Fatalf("AmountTZS = %d, want 0 (no metadata on a failed callback)", cb.AmountTZS)
	}
}

// TestParseSTKCallbackNotDaraja: a payload without a CheckoutRequestID is
// not a Daraja callback and is an error, so the webhook handler's platform
// path stays authoritative.
func TestParseSTKCallbackNotDaraja(t *testing.T) {
	for name, body := range map[string]string{
		"platform-shape": `{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-1","status":"paid"}`,
		"empty":          `{}`,
		"garbage":        `not json`,
	} {
		if _, err := ParseSTKCallback([]byte(body)); err == nil {
			t.Fatalf("%s: ParseSTKCallback = nil error, want one", name)
		}
	}
}

// TestDarajaConfigFromEnvFallbackDecision: without MPESA_CONSUMER_KEY the
// config loader reports "not configured", which is the explicit signal to
// keep the generic HTTP gateway (mock-gateway) path in the delivery worker.
func TestDarajaConfigFromEnvFallbackDecision(t *testing.T) {
	t.Setenv("MPESA_CONSUMER_KEY", "")
	t.Setenv("MPESA_CONSUMER_SECRET", "")
	t.Setenv("MPESA_SHORTCODE", "")
	t.Setenv("MPESA_PASSKEY", "")
	t.Setenv("MPESA_STK_CALLBACK_URL", "")
	if _, ok := DarajaConfigFromEnv(); ok {
		t.Fatal("DarajaConfigFromEnv = configured with no MPESA_CONSUMER_KEY, want fallback")
	}

	t.Setenv("MPESA_CONSUMER_KEY", "unit-key")
	t.Setenv("MPESA_CONSUMER_SECRET", "unit-secret")
	t.Setenv("MPESA_SHORTCODE", "174379")
	t.Setenv("MPESA_PASSKEY", "unit-pass")
	t.Setenv("MPESA_STK_CALLBACK_URL", "https://api.example.test/payments/webhooks/mpesa")
	cfg, ok := DarajaConfigFromEnv()
	if !ok {
		t.Fatal("DarajaConfigFromEnv = not configured with MPESA_CONSUMER_KEY set, want configured")
	}
	if cfg.Env != "sandbox" {
		t.Fatalf("MPESA_ENV default = %q, want sandbox", cfg.Env)
	}
	if cfg.ConsumerKey != "unit-key" || cfg.ShortCode != "174379" {
		t.Fatalf("config = %+v, want unit-key/174379", cfg)
	}
}

// TestDarajaConfigFromEnvInvalidEnv: MPESA_ENV outside sandbox/production
// fails client construction with a clear operator error.
func TestDarajaConfigFromEnvInvalidEnv(t *testing.T) {
	cfg := darajaUnitConfig()
	cfg.Env = "banana"
	if _, err := NewDarajaClient(cfg); err == nil {
		t.Fatal("NewDarajaClient = nil error for MPESA_ENV=banana, want one")
	}
}

// TestSTKPushRequestFromProviderRequest: the enqueued outbox payload maps
// onto the Daraja invocation, preferring the payload's AccountReference
// (order id) and normalizing nothing here — the client normalizes the phone
// at invoke time.
func TestSTKPushRequestFromProviderRequest(t *testing.T) {
	orderID := uuid.MustParse("00000000-0000-4000-8000-000000000002")
	intentID := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	req, err := BuildProviderRequest("mpesa", IntentRow{ID: intentID, OrderID: &orderID, Method: "mpesa", AmountTZS: 16000}, "+255712345678")
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	stk, err := STKPushRequestFromProviderRequest(req)
	if err != nil {
		t.Fatalf("STKPushRequestFromProviderRequest: %v", err)
	}
	if stk.AmountTZS != 16000 {
		t.Fatalf("AmountTZS = %d, want 16000", stk.AmountTZS)
	}
	if stk.AccountReference != orderID.String() {
		t.Fatalf("AccountReference = %q, want the order id", stk.AccountReference)
	}
	if _, err := STKPushRequestFromProviderRequest(ProviderRequest{AmountTZS: 0, Reference: "r"}); err == nil {
		t.Fatal("zero amount = nil error, want one")
	}
}