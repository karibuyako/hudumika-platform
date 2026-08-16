package notifications

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeExpoServer is an httptest stand-in for the Expo Push Service: it
// records the last request and replies with a fixed status and body.
type fakeExpoServer struct {
	server        *httptest.Server
	authorization string
	lastBody      string
}

// newFakeExpoServer starts the fake Expo endpoint; cleanup is automatic.
func newFakeExpoServer(t *testing.T, status int, body string) *fakeExpoServer {
	t.Helper()
	f := &fakeExpoServer{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.lastBody = string(b)
		f.authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if body != "" {
			_, _ = w.Write([]byte(body))
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

// expoMessageForSend is a 'push' outbox message whose payload JSON carries a
// title and body.
func expoMessageForSend() Message {
	return Message{
		Channel:   "push",
		Recipient: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
		Template:  "order.status",
		Payload:   []byte(`{"userId":"11111111-1111-1111-1111-111111111111","type":"order.status","title":"Order on its way","body":"Your order is being delivered","deepLink":"/orders/123"}`),
	}
}

// sendVia points a provider at the fake endpoint and sends msg.
func (f *fakeExpoServer) sendVia(t *testing.T, p *ExpoPushProvider, msg Message) error {
	t.Helper()
	p.baseURL = f.server.URL
	return p.Send(context.Background(), msg)
}

func TestExpoPushProviderPostsExpectedShape(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"ok"}]}`)
	if err := fake.sendVia(t, NewExpoPushProvider("test-token"), expoMessageForSend()); err != nil {
		t.Fatalf("send: %v", err)
	}
	var got expoMessage
	if err := json.Unmarshal([]byte(fake.lastBody), &got); err != nil {
		t.Fatalf("unmarshal posted body: %v", err)
	}
	if got.To != "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]" {
		t.Errorf("to = %q, want the recipient push token", got.To)
	}
	if got.Title != "Order on its way" {
		t.Errorf("title = %q, want the payload title", got.Title)
	}
	if got.Body != "Your order is being delivered" {
		t.Errorf("body = %q, want the payload body", got.Body)
	}
	if got.Sound != "default" {
		t.Errorf("sound = %q, want %q", got.Sound, "default")
	}
	if fake.authorization != "Bearer test-token" {
		t.Errorf("authorization = %q, want %q", fake.authorization, "Bearer test-token")
	}
}

func TestExpoPushProviderFallsBackToTemplateText(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"ok"}]}`)
	msg := expoMessageForSend()
	msg.Payload = []byte(`not-json`)
	if err := fake.sendVia(t, NewExpoPushProvider(""), msg); err != nil {
		t.Fatalf("send: %v", err)
	}
	var got expoMessage
	if err := json.Unmarshal([]byte(fake.lastBody), &got); err != nil {
		t.Fatalf("unmarshal posted body: %v", err)
	}
	if got.Title != "order.status" {
		t.Errorf("title = %q, want the message template", got.Title)
	}
	if got.Body != "not-json" {
		t.Errorf("body = %q, want the raw payload", got.Body)
	}
	if fake.authorization != "" {
		t.Errorf("authorization = %q, want none with an empty token", fake.authorization)
	}
}

func TestExpoPushProviderOkTicketReturnsNil(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"ok"}]}`)
	if err := fake.sendVia(t, NewExpoPushProvider("t"), expoMessageForSend()); err != nil {
		t.Errorf("send with ok ticket: %v", err)
	}
}

func TestExpoPushProviderErrorTicketReturnsError(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"error","message":"DeviceNotRegistered"}]}`)
	err := fake.sendVia(t, NewExpoPushProvider("t"), expoMessageForSend())
	if err == nil {
		t.Fatal("send with error ticket: want error")
	}
	if !strings.Contains(err.Error(), "DeviceNotRegistered") {
		t.Errorf("error = %v, want the ticket message", err)
	}
}

func TestExpoPushProviderNon2xxReturnsError(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusInternalServerError, `{"errors":[{"code":"API_ERROR"}]}`)
	err := fake.sendVia(t, NewExpoPushProvider("t"), expoMessageForSend())
	if err == nil {
		t.Fatal("send against a 500: want error")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error = %v, want the HTTP status", err)
	}
}

func TestExpoPushProviderEmptyTicketDataIsError(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[]}`)
	if err := fake.sendVia(t, NewExpoPushProvider("t"), expoMessageForSend()); err == nil {
		t.Error("send with no ticket data: want error")
	}
}

func TestExpoPushProviderRejectsEmptyRecipient(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"ok"}]}`)
	msg := expoMessageForSend()
	msg.Recipient = " "
	if err := fake.sendVia(t, NewExpoPushProvider("t"), msg); err == nil {
		t.Error("send with an empty recipient: want error")
	}
}

func TestExpoPushProviderRejectsOtherChannels(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"ok"}]}`)
	msg := expoMessageForSend()
	msg.Channel = "sms"
	if err := fake.sendVia(t, NewExpoPushProvider("t"), msg); err == nil {
		t.Error("send of a non-push message: want error")
	}
}

func TestExpoProviderFromEnvConfigured(t *testing.T) {
	t.Setenv(envExpoPushAccessToken, "env-token")
	t.Setenv(envExpoPushBaseURL, "")
	provider, err := ExpoProviderFromEnv(nil)
	if err != nil {
		t.Fatalf("from env: %v", err)
	}
	if provider == nil {
		t.Fatal("provider = nil, want the configured provider")
	}
	if provider.baseURL != defaultExpoPushURL {
		t.Errorf("baseURL = %q, want the default %q", provider.baseURL, defaultExpoPushURL)
	}
	if provider.token != "env-token" {
		t.Errorf("token = %q, want %q", provider.token, "env-token")
	}
}

func TestExpoProviderFromEnvHonoursBaseURLOverride(t *testing.T) {
	fake := newFakeExpoServer(t, http.StatusOK, `{"data":[{"status":"ok"}]}`)
	t.Setenv(envExpoPushAccessToken, "env-token")
	t.Setenv(envExpoPushBaseURL, fake.server.URL)
	provider, err := ExpoProviderFromEnv(nil)
	if err != nil {
		t.Fatalf("from env: %v", err)
	}
	if provider == nil {
		t.Fatal("provider = nil, want the configured provider")
	}
	if provider.baseURL != fake.server.URL {
		t.Errorf("baseURL = %q, want %q", provider.baseURL, fake.server.URL)
	}
	if err := provider.Send(context.Background(), expoMessageForSend()); err != nil {
		t.Fatalf("send via env provider: %v", err)
	}
}

func TestExpoProviderFromEnvUnsetTokenSkips(t *testing.T) {
	t.Setenv(envExpoPushAccessToken, "")
	t.Setenv(envExpoPushBaseURL, defaultExpoPushURL)
	provider, err := ExpoProviderFromEnv(nil)
	if err != nil {
		t.Fatalf("from env with unset token: %v", err)
	}
	if provider != nil {
		t.Errorf("provider = %v, want nil (dev mode skip)", provider)
	}
}

func TestExpoProviderFromEnvWhitespaceTokenSkips(t *testing.T) {
	t.Setenv(envExpoPushAccessToken, "   ")
	provider, err := ExpoProviderFromEnv(nil)
	if err != nil || provider != nil {
		t.Errorf("whitespace token: provider = %v, err = %v, want (nil, nil)", provider, err)
	}
}

func TestExpoProviderFromEnvInvalidBaseURLFails(t *testing.T) {
	for _, raw := range []string{"://nope", "ftp://exp.host/x", "not a url"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv(envExpoPushAccessToken, "env-token")
			t.Setenv(envExpoPushBaseURL, raw)
			if _, err := ExpoProviderFromEnv(nil); err == nil {
				t.Errorf("base URL %q: want error", raw)
			}
		})
	}
}
