package payments

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// ErrPushUnsupported is returned by BuildProviderRequest when the intent's
// method has no STK/USSD push flow (cod, bank, ezy_pesa, halotel). Those
// intents are still created and tracked; only the outbox enqueue is skipped
// (the caller logs and continues).
var ErrPushUnsupported = errors.New("payments: provider has no push flow")

// ProviderRequest is the outbox payload the STK-push delivery worker consumes
// (Template "stk_push", channel "sms"). Provider is the intent method,
// Reference is the platform-side unique reference (the intent id) used for
// reconciliation across providers, and Payload carries the
// provider-gateway-specific request shape (see BuildProviderRequest).
type ProviderRequest struct {
	Provider  string         `json:"provider"`
	Reference string         `json:"reference"`
	AmountTZS int64          `json:"amountTZS"`
	Phone     string         `json:"phone"`
	OrderID   *uuid.UUID     `json:"orderId,omitempty"`
	Payload   map[string]any `json:"payload"`
}

// BuildProviderRequest shapes the provider gateway request for a push-capable
// method (mpesa, tigo_pesa, airtel_money, card). Methods without a push flow
// (cod, bank, ezy_pesa, halotel) return ErrPushUnsupported. The payload
// shapes are best-effort per each gateway's public API; gateway credential
// and callback fields (BusinessShortCode, Password, CallBackURL, ...) are
// operator-level configuration applied by the delivery worker, never stored
// here.
//
//   - mpesa (Daraja STK Push): {TransactionType: "CustomerPayBillOnline",
//     Amount, Msisdn, AccountReference: order no}. AccountReference is the
//     order id; order-less intents (wallet top-up, payment request) fall back
//     to the intent id.
//   - tigo_pesa (Tigo Pesa payment gateway): {msisdn, amount, currency: "TZS",
//     reference, description}.
//   - airtel_money (Airtel Money merchant API): {subscriberMsisdn, amount,
//     currency: "TZS", reference, description}.
//   - card (card gateway): {amount, currency: "TZS", reference}.
func BuildProviderRequest(provider string, intent IntentRow, phone string) (ProviderRequest, error) {
	ref := intent.ID.String()
	req := ProviderRequest{
		Provider:  provider,
		Reference: ref,
		AmountTZS: intent.AmountTZS,
		Phone:     phone,
		OrderID:   intent.OrderID,
	}
	switch provider {
	case "mpesa":
		accountRef := ref
		if intent.OrderID != nil {
			accountRef = intent.OrderID.String()
		}
		req.Payload = map[string]any{
			"TransactionType":  "CustomerPayBillOnline",
			"Amount":           intent.AmountTZS,
			"Msisdn":           phone,
			"AccountReference": accountRef,
		}
	case "tigo_pesa":
		req.Payload = map[string]any{
			"msisdn":      phone,
			"amount":      intent.AmountTZS,
			"currency":    "TZS",
			"reference":   ref,
			"description": "Hudumika payment",
		}
	case "airtel_money":
		req.Payload = map[string]any{
			"subscriberMsisdn": phone,
			"amount":           intent.AmountTZS,
			"currency":         "TZS",
			"reference":        ref,
			"description":      "Hudumika payment",
		}
	case "card":
		req.Payload = map[string]any{
			"amount":    intent.AmountTZS,
			"currency":  "TZS",
			"reference": ref,
		}
	default:
		return ProviderRequest{}, fmt.Errorf("payments: build %s push request: %w", provider, ErrPushUnsupported)
	}
	return req, nil
}

// ToJSON marshals the request to the wire form stored in the outbox.
func (r ProviderRequest) ToJSON() ([]byte, error) {
	b, err := json.Marshal(r)
	if err != nil {
		return nil, fmt.Errorf("payments: marshal %s push request: %w", r.Provider, err)
	}
	return b, nil
}
