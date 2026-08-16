package payments

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// TestBuildProviderRequestMpesa: the Daraja STK push shape with the order id
// as AccountReference and the intent id as the platform reference.
func TestBuildProviderRequestMpesa(t *testing.T) {
	orderID := uuid.New()
	intentID := uuid.New()
	intent := IntentRow{ID: intentID, OrderID: &orderID, Method: "mpesa", AmountTZS: 16000}

	req, err := BuildProviderRequest("mpesa", intent, "+255712345678")
	if err != nil {
		t.Fatalf("build mpesa request: %v", err)
	}
	if req.Provider != "mpesa" || req.Reference != intentID.String() {
		t.Fatalf("request = %+v, want provider mpesa reference %s", req, intentID)
	}
	if req.AmountTZS != 16000 || req.Phone != "+255712345678" {
		t.Fatalf("request = %+v, want amount 16000 phone +255712345678", req)
	}
	if req.OrderID == nil || *req.OrderID != orderID {
		t.Fatalf("request order = %v, want %s", req.OrderID, orderID)
	}
	if got := req.Payload["TransactionType"]; got != "CustomerPayBillOnline" {
		t.Fatalf("TransactionType = %v, want CustomerPayBillOnline", got)
	}
	if got := req.Payload["Amount"]; got != int64(16000) {
		t.Fatalf("Amount = %v, want 16000", got)
	}
	if got := req.Payload["Msisdn"]; got != "+255712345678" {
		t.Fatalf("Msisdn = %v, want +255712345678", got)
	}
	if got := req.Payload["AccountReference"]; got != orderID.String() {
		t.Fatalf("AccountReference = %v, want %s", got, orderID)
	}
}

// TestBuildProviderRequestMpesaNoOrder: order-less intents (wallet top-up,
// payment request) fall back to the intent id as AccountReference.
func TestBuildProviderRequestMpesaNoOrder(t *testing.T) {
	intentID := uuid.New()
	intent := IntentRow{ID: intentID, Method: "mpesa", AmountTZS: 10000}

	req, err := BuildProviderRequest("mpesa", intent, "+255700000000")
	if err != nil {
		t.Fatalf("build mpesa request: %v", err)
	}
	if req.OrderID != nil {
		t.Fatalf("request order = %v, want nil", req.OrderID)
	}
	if got := req.Payload["AccountReference"]; got != intentID.String() {
		t.Fatalf("AccountReference = %v, want intent id %s", got, intentID)
	}
}

// TestBuildProviderRequestTigoPesa: the Tigo Pesa gateway shape (best-effort
// per the public API) carries msisdn, amount, TZS currency, reference and a
// description.
func TestBuildProviderRequestTigoPesa(t *testing.T) {
	intentID := uuid.New()
	req, err := BuildProviderRequest("tigo_pesa", IntentRow{ID: intentID, Method: "tigo_pesa", AmountTZS: 8000}, "+255713000000")
	if err != nil {
		t.Fatalf("build tigo request: %v", err)
	}
	if req.Provider != "tigo_pesa" || req.Reference != intentID.String() {
		t.Fatalf("request = %+v, want tigo_pesa reference %s", req, intentID)
	}
	want := map[string]any{"msisdn": "+255713000000", "amount": int64(8000), "currency": "TZS", "reference": intentID.String()}
	for k, v := range want {
		if req.Payload[k] != v {
			t.Fatalf("payload[%s] = %v, want %v (payload %v)", k, req.Payload[k], v, req.Payload)
		}
	}
}

// TestBuildProviderRequestAirtelMoney: the Airtel Money merchant API shape
// (best-effort) carries subscriberMsisdn, amount, TZS currency, reference and
// a description.
func TestBuildProviderRequestAirtelMoney(t *testing.T) {
	intentID := uuid.New()
	req, err := BuildProviderRequest("airtel_money", IntentRow{ID: intentID, Method: "airtel_money", AmountTZS: 9000}, "+255717000000")
	if err != nil {
		t.Fatalf("build airtel request: %v", err)
	}
	if req.Provider != "airtel_money" || req.Reference != intentID.String() {
		t.Fatalf("request = %+v, want airtel_money reference %s", req, intentID)
	}
	want := map[string]any{"subscriberMsisdn": "+255717000000", "amount": int64(9000), "currency": "TZS", "reference": intentID.String()}
	for k, v := range want {
		if req.Payload[k] != v {
			t.Fatalf("payload[%s] = %v, want %v (payload %v)", k, req.Payload[k], v, req.Payload)
		}
	}
}

// TestBuildProviderRequestCard: the card request carries amount, TZS currency
// and the platform reference only.
func TestBuildProviderRequestCard(t *testing.T) {
	intentID := uuid.New()
	req, err := BuildProviderRequest("card", IntentRow{ID: intentID, Method: "card", AmountTZS: 25000}, "")
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

// TestBuildProviderRequestUnsupported: methods without an STK push flow
// (cod, bank, ezy_pesa, halotel) return ErrPushUnsupported and the caller
// skips the enqueue.
func TestBuildProviderRequestUnsupported(t *testing.T) {
	for _, method := range []string{"cod", "bank", "ezy_pesa", "halotel"} {
		_, err := BuildProviderRequest(method, IntentRow{ID: uuid.New(), Method: method, AmountTZS: 5000}, "+255700000000")
		if !errors.Is(err, ErrPushUnsupported) {
			t.Fatalf("method %s error = %v, want ErrPushUnsupported", method, err)
		}
	}
}

// TestProviderRequestToJSON: ToJSON marshals the full request including the
// provider payload into the outbox wire form.
func TestProviderRequestToJSON(t *testing.T) {
	orderID := uuid.New()
	req, err := BuildProviderRequest("mpesa", IntentRow{ID: uuid.New(), OrderID: &orderID, Method: "mpesa", AmountTZS: 16000}, "+255700000000")
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	raw, err := req.ToJSON()
	if err != nil {
		t.Fatalf("to JSON: %v", err)
	}
	var decoded ProviderRequest
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("round-trip unmarshal: %v", err)
	}
	if decoded.Provider != req.Provider || decoded.Reference != req.Reference ||
		decoded.AmountTZS != req.AmountTZS || decoded.Phone != req.Phone {
		t.Fatalf("round-trip = %+v, want %+v", decoded, req)
	}
	if decoded.OrderID == nil || *decoded.OrderID != orderID {
		t.Fatalf("round-trip order = %v, want %s", decoded.OrderID, orderID)
	}
	if got := decoded.Payload["TransactionType"]; got != "CustomerPayBillOnline" {
		t.Fatalf("round-trip TransactionType = %v, want CustomerPayBillOnline", got)
	}
}
