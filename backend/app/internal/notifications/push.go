package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	// defaultExpoPushURL is the Expo Push Service send endpoint.
	defaultExpoPushURL = "https://exp.host/--/api/v2/push/send"
	// defaultExpoTimeout bounds a single Expo Push POST.
	defaultExpoTimeout = 10 * time.Second
	// envExpoPushAccessToken carries the Expo Push API access token.
	envExpoPushAccessToken = "EXPO_PUSH_ACCESS_TOKEN"
	// envExpoPushBaseURL overrides the Expo Push send endpoint.
	envExpoPushBaseURL = "EXPO_PUSH_BASE_URL"
)

// ExpoPushProvider delivers 'push' outbox messages to the Expo Push Service
// (https://docs.expo.dev/push-notifications/push-api/): a JSON POST to
// baseURL carrying {to, title, body, sound}, authenticated with the Expo
// access token when one is configured. It implements Provider: every
// unconfirmed delivery (network error, non-2xx, error ticket) is a hard
// error so the outbox retries with backoff.
type ExpoPushProvider struct {
	token      string
	httpClient *http.Client
	baseURL    string
}

// NewExpoPushProvider returns a provider posting to the Expo Push Service.
// An empty accessToken is allowed (dev mode / local mock endpoint): requests
// are sent without an Authorization header.
func NewExpoPushProvider(accessToken string) *ExpoPushProvider {
	return &ExpoPushProvider{
		token:      accessToken,
		httpClient: &http.Client{Timeout: defaultExpoTimeout},
		baseURL:    defaultExpoPushURL,
	}
}

// ExpoProviderFromEnv builds the push provider from the environment: it
// reads EXPO_PUSH_ACCESS_TOKEN and the optional EXPO_PUSH_BASE_URL override.
// When the token is unset it returns (nil, nil) so the caller skips the
// provider (dev mode — the push channel stays on the stub). A set but
// invalid EXPO_PUSH_BASE_URL (not an http(s) URL) is a configuration error.
func ExpoProviderFromEnv(logger *slog.Logger) (*ExpoPushProvider, error) {
	token := strings.TrimSpace(os.Getenv(envExpoPushAccessToken))
	if token == "" {
		return nil, nil
	}
	p := NewExpoPushProvider(token)
	if raw := strings.TrimSpace(os.Getenv(envExpoPushBaseURL)); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("notifications: expo: invalid %s %q: want an http(s) URL", envExpoPushBaseURL, raw)
		}
		p.baseURL = raw
	}
	if logger != nil {
		logger.Info("notifications: expo push provider active", "baseURL", p.baseURL)
	}
	return p, nil
}

// expoMessage is one push delivery as POSTed to the Expo Push Service.
type expoMessage struct {
	To    string `json:"to"`
	Title string `json:"title"`
	Body  string `json:"body"`
	Sound string `json:"sound"`
}

// expoSendResponse is the envelope returned by the Expo send endpoint: one
// per-message ticket under data, each with a status ("ok" or "error").
type expoSendResponse struct {
	Data []struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	} `json:"data"`
}

// pushText resolves the notification title and body for msg: the push
// payload JSON (pushPayload) wins when it carries them, otherwise the
// template acts as the title and the raw payload as the body.
func pushText(msg Message) (title, body string) {
	title, body = msg.Template, string(msg.Payload)
	var p pushPayload
	if json.Unmarshal(msg.Payload, &p) == nil {
		if p.Title != "" {
			title = p.Title
		}
		if p.Body != "" {
			body = p.Body
		}
	}
	return title, body
}

// Send delivers msg to the Expo Push Service. The recipient must be the
// device push token (ExponentPushToken[...] / ExpoPushToken[...]) carried by
// msg.Recipient; the title and body come from the push payload JSON or fall
// back to the template and raw payload. A non-2xx response, an unparsable
// envelope, a missing ticket or a ticket with a status other than "ok" are
// all errors: nothing is confirmed delivered until Expo says "ok".
func (p *ExpoPushProvider) Send(ctx context.Context, msg Message) error {
	if msg.Channel != "push" {
		return fmt.Errorf("notifications: expo: cannot deliver %q message", msg.Channel)
	}
	if strings.TrimSpace(msg.Recipient) == "" {
		return fmt.Errorf("notifications: expo: message has no recipient push token")
	}
	title, body := pushText(msg)
	reqBody, err := json.Marshal(expoMessage{To: msg.Recipient, Title: title, Body: body, Sound: "default"})
	if err != nil {
		return fmt.Errorf("notifications: expo: payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("notifications: expo: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("notifications: expo: POST: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxGatewayResponse))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("notifications: expo: responded %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}

	var envelope expoSendResponse
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		return fmt.Errorf("notifications: expo: bad response envelope: %w", err)
	}
	if len(envelope.Data) == 0 {
		return fmt.Errorf("notifications: expo: response carries no ticket data")
	}
	ticket := envelope.Data[0]
	if ticket.Status != "ok" {
		if ticket.Message != "" {
			return fmt.Errorf("notifications: expo: ticket status %q: %s", ticket.Status, ticket.Message)
		}
		return fmt.Errorf("notifications: expo: ticket status %q", ticket.Status)
	}
	return nil
}

// StubPushProvider is the dev fallback for the push channel: every send
// succeeds. Real delivery (device token registry, per-message ticket
// tracking) is ExpoPushProvider; the stub keeps single-process dev and tests
// working without an Expo account. Deliveries are mirrored into the in-app
// feed by InAppWriter.
type StubPushProvider struct {
	logger *slog.Logger
}

// NewStubPushProvider returns a push provider; logger may be nil.
func NewStubPushProvider(logger *slog.Logger) *StubPushProvider {
	return &StubPushProvider{logger: logger}
}

// Send delivers the message to the Expo Push Service (stubbed: logs and
// returns nil).
func (p *StubPushProvider) Send(ctx context.Context, msg Message) error {
	if p.logger != nil {
		p.logger.Info("notifications: push send (stub)",
			"recipient", msg.Recipient, "template", msg.Template)
	}
	return nil
}

// PushProvider is the former name of StubPushProvider, kept so existing
// callers and integration tests keep compiling.
//
// Deprecated: use StubPushProvider.
type PushProvider = StubPushProvider

// NewPushProvider is the former name of NewStubPushProvider.
//
// Deprecated: use NewStubPushProvider.
func NewPushProvider(logger *slog.Logger) *StubPushProvider {
	return NewStubPushProvider(logger)
}

// pushPayload is the JSON payload carried by a 'push' outbox message: the
// in-app row to create once the push is delivered.
type pushPayload struct {
	UserID   uuid.UUID `json:"userId"`
	Type     string    `json:"type"`
	Title    string    `json:"title"`
	Body     string    `json:"body"`
	DeepLink string    `json:"deepLink"`
}

// InAppWriter mirrors a delivered message into the notifications table so
// every sent push also lands in /notifications/me. It is invoked by the
// delivery pipeline after the provider send succeeds.
type InAppWriter struct {
	store  *PrefStore
	logger *slog.Logger
}

// NewInAppWriter returns an InAppWriter backed by the given store.
func NewInAppWriter(store *PrefStore, logger *slog.Logger) *InAppWriter {
	return &InAppWriter{store: store, logger: logger}
}

// OnSent creates the in-app row for a delivered message. Non-push channels
// are ignored. An unparsable payload or a missing userId is logged and
// skipped: the push already went out, the mirror must never fail delivery.
func (w *InAppWriter) OnSent(ctx context.Context, msg Message) error {
	if msg.Channel != "push" {
		return nil
	}
	var p pushPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		w.logger.Warn("notifications: in-app mirror: bad push payload", "error", err)
		return nil
	}
	if p.UserID == uuid.Nil {
		w.logger.Warn("notifications: in-app mirror: push payload missing userId")
		return nil
	}
	var deepLink *string
	if p.DeepLink != "" {
		deepLink = &p.DeepLink
	}
	if err := w.store.Create(ctx, Notification{
		UserID:   p.UserID,
		Type:     p.Type,
		Title:    p.Title,
		Body:     p.Body,
		DeepLink: deepLink,
	}); err != nil {
		return fmt.Errorf("notifications: in-app mirror: %w", err)
	}
	return nil
}
