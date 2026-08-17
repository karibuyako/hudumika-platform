package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/hudumika/api-backend/internal/payments"
)

// stkRecorder records CheckoutRequestID calls for the STKPushProvider.
type stkRecorder struct {
	intentID string
	checkout string
}

func (r *stkRecorder) RecordCheckoutRequestID(ctx context.Context, intentID, checkoutRequestID string) error {
	r.intentID = intentID
	r.checkout = checkoutRequestID
	return nil
}

// stkUnitClient is a stub payments.STKPushClient for provider tests.
type stkUnitClient struct {
	resp payments.STKPushResponse
	err  error
}

func (c *stkUnitClient) STKPush(ctx context.Context, req payments.STKPushRequest) (payments.STKPushResponse, error) {
	return c.resp, c.err
}

// stkUnitMessage is an stk_push outbox message shaped like the one
// api.CreatePaymentIntent enqueues.
func stkUnitMessage() Message {
	payload, _ := json.Marshal(map[string]any{
		"provider":  "mpesa",
		"reference": "00000000-0000-4000-8000-000000000001",
		"amountTZS": float64(16000),
		"phone":     "+255712345678",
		"payload":   map[string]any{"TransactionType": "CustomerPayBillOnline"},
	})
	return Message{Channel: "sms", Recipient: "+255712345678", Template: "stk_push", Payload: payload}
}

// TestSTKPushRouterRoutesByTemplate: stk_push messages go to the Daraja
// provider, everything else to the generic chain — the mock-gateway path
// keeps working for non-stk traffic and the router never mixes the two.
func TestSTKPushRouterRoutesByTemplate(t *testing.T) {
	daraja := &recordingProvider{}
	rest := &recordingProvider{}
	router := NewSTKPushRouter(daraja, rest)

	otp := Message{Channel: "sms", Recipient: "+255712345678", Template: "otp", Payload: []byte("code")}
	if err := router.Send(context.Background(), otp); err != nil {
		t.Fatalf("otp send: %v", err)
	}
	if len(daraja.messages) != 0 || len(rest.messages) != 1 || rest.messages[0].Template != "otp" {
		t.Fatalf("otp routed to daraja %d generic %d, want 0/1 with template otp", len(daraja.messages), len(rest.messages))
	}

	if err := router.Send(context.Background(), stkUnitMessage()); err != nil {
		t.Fatalf("stk send: %v", err)
	}
	if len(daraja.messages) != 1 || len(rest.messages) != 1 {
		t.Fatalf("stk routed to daraja %d generic %d, want 1/1", len(daraja.messages), len(rest.messages))
	}
}

// TestSTKPushProviderRejectsNonSTK: a non-stk message is a hard error so a
// chain fails over instead of a silent success.
func TestSTKPushProviderRejectsNonSTK(t *testing.T) {
	p := NewSTKPushProvider(&stkUnitClient{}, nil, nil)
	if err := p.Send(context.Background(), Message{Channel: "sms", Template: "otp", Payload: []byte("x")}); err == nil {
		t.Fatal("otp message = nil error, want ErrNotSTKPush")
	}
}

// TestSTKPushProviderRecordsCheckout: after a successful Daraja invoke the
// provider records the CheckoutRequestID against the intent reference.
func TestSTKPushProviderRecordsCheckout(t *testing.T) {
	recorder := &stkRecorder{}
	p := NewSTKPushProvider(&stkUnitClient{
		resp: payments.STKPushResponse{MerchantRequestID: "M-1", CheckoutRequestID: "C-1", ResponseCode: "0"},
	}, recorder, nil)

	if err := p.Send(context.Background(), stkUnitMessage()); err != nil {
		t.Fatalf("stk send: %v", err)
	}
	if recorder.intentID != "00000000-0000-4000-8000-000000000001" || recorder.checkout != "C-1" {
		t.Fatalf("recorded = %q/%q, want intent id/C-1", recorder.intentID, recorder.checkout)
	}
}

// TestSTKPushProviderForwardsDarajaError: a Daraja rejection propagates so
// the worker retries with backoff instead of completing the job.
func TestSTKPushProviderForwardsDarajaError(t *testing.T) {
	p := NewSTKPushProvider(&stkUnitClient{err: errors.New("payments: daraja: stk push rejected")}, nil, nil)
	if err := p.Send(context.Background(), stkUnitMessage()); err == nil {
		t.Fatal("stk send = nil error, want the daraja error")
	}
}