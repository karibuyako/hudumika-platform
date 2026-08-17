package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/hudumika/api-backend/internal/payments"
)

// The Daraja (M-Pesa) STK push delivery path: the outbox worker routes
// stk_push messages (enqueued by api.CreatePaymentIntent through
// payments.BuildProviderRequest) to the real Daraja client when MPESA
// credentials are configured, and to the generic HTTP gateway chain
// (mock-gateway) otherwise. STKPushProvider implements Provider alongside
// HTTPGateway, and STKPushRouter keeps the two paths separate so the generic
// chain never sees a stk_push payload.

// ErrNotSTKPush is returned by STKPushProvider for messages that are not
// stk_push deliveries; the router never forwards those, but the error keeps
// the provider honest if it is ever wired directly into a chain.
var ErrNotSTKPush = errors.New("notifications: message is not an stk_push delivery")

// CheckoutRecorder persists the Daraja CheckoutRequestID returned by the STK
// invoke against the intent's provider_reference, so the webhook handler can
// resolve a callback by reference alone (api/payments.go PaymentWebhook).
// main.go binds it to payments.Store.SetProviderReference.
type CheckoutRecorder interface {
	RecordCheckoutRequestID(ctx context.Context, intentID, checkoutRequestID string) error
}

// STKPushProvider delivers stk_push outbox messages through the real Daraja
// STK client: it decodes the enqueued payments.ProviderRequest, shapes the
// Daraja invocation, and records the returned CheckoutRequestID on the
// intent (best-effort — a recorder failure is logged, never a delivery
// failure). Messages that are not stk_push are a hard error so a Chain fails
// over instead of a silent success.
type STKPushProvider struct {
	client   payments.STKPushClient
	recorder CheckoutRecorder
	logger   *slog.Logger
}

// NewSTKPushProvider returns a provider bound to the Daraja client. The
// recorder may be nil; the logger may be nil (tests).
func NewSTKPushProvider(client payments.STKPushClient, recorder CheckoutRecorder, logger *slog.Logger) *STKPushProvider {
	return &STKPushProvider{client: client, recorder: recorder, logger: logger}
}

// Send delivers a stk_push message through Daraja.
func (p *STKPushProvider) Send(ctx context.Context, msg Message) error {
	if msg.Channel != "sms" || msg.Template != "stk_push" {
		return ErrNotSTKPush
	}
	var req payments.ProviderRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		return fmt.Errorf("notifications: stk push payload: %w", err)
	}
	if req.Provider != "mpesa" {
		return fmt.Errorf("notifications: stk push provider %q is not mpesa", req.Provider)
	}
	stk, err := payments.STKPushRequestFromProviderRequest(req)
	if err != nil {
		return err
	}
	resp, err := p.client.STKPush(ctx, stk)
	if err != nil {
		return err
	}
	if resp.CheckoutRequestID != "" && p.recorder != nil {
		if err := p.recorder.RecordCheckoutRequestID(ctx, req.Reference, resp.CheckoutRequestID); err != nil {
			p.warn("stk push checkout request id not recorded", "intent", req.Reference, "error", err)
		}
	}
	p.info("stk push accepted by daraja",
		"intent", req.Reference, "merchantRequestId", resp.MerchantRequestID, "checkoutRequestId", resp.CheckoutRequestID)
	return nil
}

func (p *STKPushProvider) warn(msg string, args ...any) {
	if p.logger != nil {
		p.logger.Warn(msg, args...)
	}
}

func (p *STKPushProvider) info(msg string, args ...any) {
	if p.logger != nil {
		p.logger.Info(msg, args...)
	}
}

// isSTKPushMessage reports whether a message is an stk_push delivery.
func isSTKPushMessage(msg Message) bool {
	return msg.Channel == "sms" && msg.Template == "stk_push"
}

// STKPushRouter is a Provider fronting the generic delivery chain: stk_push
// messages go to the Daraja provider, everything else (OTP, email, push)
// straight to the generic chain — so enabling Daraja never perturbs the
// other channels, and without Daraja the whole router is absent and the
// mock-gateway path stays untouched.
type STKPushRouter struct {
	daraja Provider
	rest   Provider
}

// NewSTKPushRouter returns a router sending stk_push messages to daraja and
// every other message to rest.
func NewSTKPushRouter(daraja, rest Provider) *STKPushRouter {
	return &STKPushRouter{daraja: daraja, rest: rest}
}

// Send routes the message by template.
func (r *STKPushRouter) Send(ctx context.Context, msg Message) error {
	if isSTKPushMessage(msg) {
		return r.daraja.Send(ctx, msg)
	}
	return r.rest.Send(ctx, msg)
}