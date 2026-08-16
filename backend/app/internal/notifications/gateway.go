package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/hudumika/api-backend/internal/tracing"
)

const (
	// defaultGatewayTimeout bounds a gateway POST when HTTPGatewayConfig.Timeout
	// is not set.
	defaultGatewayTimeout = 10 * time.Second
	// maxGatewayResponse is the cap on the response body read after a gateway
	// POST; anything beyond it is discarded.
	maxGatewayResponse = 1024
)

// HTTPGatewayConfig configures a single-channel HTTP delivery gateway
// (Africa's Talking / Twilio-style): a JSON POST to URL carrying the message,
// authenticated with APIKey.
type HTTPGatewayConfig struct {
	// URL is the gateway endpoint receiving the JSON POST.
	URL string
	// APIKey, when set, is sent as "Authorization: Bearer <apiKey>".
	APIKey string
	// Sender is the SMS sender id / short code sent as the "from" field.
	Sender string
	// Timeout bounds the whole POST; zero means 10 seconds.
	Timeout time.Duration
}

// HTTPGateway delivers messages for one channel through a JSON HTTP gateway.
// It implements Provider and returns a clear error whenever a message cannot
// be delivered (wrong channel, non-2xx response, network/timeout), so a Chain
// fails over instead of a silent success.
type HTTPGateway struct {
	channel string
	url     string
	apiKey  string
	sender  string
	client  *http.Client
}

// NewHTTPGateway returns a gateway for channel ("sms" or "email"). An empty
// URL is an error: the caller is expected to skip the gateway and keep the
// provider stub in that case.
func NewHTTPGateway(cfg HTTPGatewayConfig, channel string) (*HTTPGateway, error) {
	if channel != "sms" && channel != "email" {
		return nil, fmt.Errorf("notifications: http gateway: unsupported channel %q", channel)
	}
	if strings.TrimSpace(cfg.URL) == "" {
		return nil, fmt.Errorf("notifications: http gateway: %s gateway URL is empty", channel)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultGatewayTimeout
	}
	return &HTTPGateway{
		channel: channel,
		url:     cfg.URL,
		apiKey:  cfg.APIKey,
		sender:  cfg.Sender,
		client:  tracing.HTTPClient(&http.Client{Timeout: timeout}),
	}, nil
}

// smsPayload is the JSON body POSTed for an SMS: recipient, sender and text.
type smsPayload struct {
	To      string `json:"to"`
	From    string `json:"from"`
	Message string `json:"message"`
}

// emailPayload is the JSON body POSTed for an email.
type emailPayload struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

// smsFrom resolves the "from" field of an SMS POST: the gateway's configured
// sender wins; without one the message template acts as the sender label.
func smsFrom(msg Message, sender string) string {
	if sender != "" {
		return sender
	}
	return msg.Template
}

// smsBodyFor composes the SMS gateway body for msg and the given sender.
func smsBodyFor(msg Message, sender string) smsPayload {
	return smsPayload{
		To:      msg.Recipient,
		From:    smsFrom(msg, sender),
		Message: string(msg.Payload),
	}
}

// emailBodyFor composes the email gateway body for msg: recipient, template as
// subject and payload as body.
func emailBodyFor(msg Message) emailPayload {
	return emailPayload{
		To:      msg.Recipient,
		Subject: msg.Template,
		Body:    string(msg.Payload),
	}
}

// SMSPayload renders the JSON body of an SMS gateway POST for msg. With no
// configured sender the "from" field carries the message template as the
// sender label.
func SMSPayload(msg Message) ([]byte, error) {
	return json.Marshal(smsBodyFor(msg, ""))
}

// EmailPayload renders the JSON body of an email gateway POST for msg.
func EmailPayload(msg Message) ([]byte, error) {
	return json.Marshal(emailBodyFor(msg))
}

// Send POSTs the message to the gateway. Messages for another channel are a
// hard error (fail over, never a silent success), as are non-2xx responses
// (wrapped with the HTTP status and a capped body excerpt) and
// network/timeout failures. The response body is read but capped at 1KB.
func (g *HTTPGateway) Send(ctx context.Context, msg Message) error {
	if msg.Channel != g.channel {
		return fmt.Errorf("notifications: http gateway: %s gateway cannot deliver %q message", g.channel, msg.Channel)
	}
	var body []byte
	var err error
	switch msg.Channel {
	case "sms":
		body, err = json.Marshal(smsBodyFor(msg, g.sender))
	case "email":
		body, err = EmailPayload(msg)
	default:
		return fmt.Errorf("notifications: http gateway: unsupported channel %q", msg.Channel)
	}
	if err != nil {
		return fmt.Errorf("notifications: http gateway: %s payload: %w", msg.Channel, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("notifications: http gateway: %s request: %w", msg.Channel, err)
	}
	req.Header.Set("Content-Type", "application/json")
	if g.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+g.apiKey)
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return fmt.Errorf("notifications: http gateway: %s POST: %w", msg.Channel, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxGatewayResponse))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("notifications: http gateway: %s responded %s: %s",
			g.channel, resp.Status, strings.TrimSpace(string(respBody)))
	}
	return nil
}

// FailoverSMS delivers SMS through a primary gateway with automatic failover
// to a backup: when the primary fails failureThreshold times the circuit
// opens for openFor and traffic flows to the backup (see CircuitBreaker). The
// circuit state lives in Redis so every API instance agrees on the primary's
// health. It implements Provider; wire it where a single SMS gateway would
// go.
type FailoverSMS struct {
	primary *HTTPGateway
	backup  *HTTPGateway
	breaker *CircuitBreaker
	logger  *slog.Logger
}

// NewFailoverSMS wraps the primary and backup SMS gateways with the breaker.
// The logger may be nil; the breaker may be a Redis-less allow-always breaker
// (dev).
func NewFailoverSMS(primary, backup *HTTPGateway, breaker *CircuitBreaker, logger *slog.Logger) *FailoverSMS {
	return &FailoverSMS{primary: primary, backup: backup, breaker: breaker, logger: logger}
}

// Send tries the primary gateway while the circuit is closed; a primary
// failure is recorded (at the threshold the circuit opens) and the backup is
// tried, its result returned. While the circuit is open the backup is used
// directly, so a down primary is never hammered.
func (f *FailoverSMS) Send(ctx context.Context, msg Message) error {
	allowed, err := f.breaker.Allow(ctx)
	if err != nil {
		if f.logger != nil {
			f.logger.Warn("SMS circuit breaker check failed, using backup", "error", err)
		}
		return f.backup.Send(ctx, msg)
	}
	if !allowed {
		if f.logger != nil {
			f.logger.Warn("SMS circuit open, using backup")
		}
		return f.backup.Send(ctx, msg)
	}
	if err := f.primary.Send(ctx, msg); err != nil {
		if f.logger != nil {
			f.logger.Warn("SMS primary failed, trying backup", "error", err)
		}
		if cerr := f.breaker.RecordFailure(ctx); cerr != nil && f.logger != nil {
			f.logger.Warn("SMS circuit failure not recorded", "error", cerr)
		}
		return f.backup.Send(ctx, msg)
	}
	if err := f.breaker.RecordSuccess(ctx); err != nil && f.logger != nil {
		f.logger.Warn("SMS circuit success not recorded", "error", err)
	}
	return nil
}
