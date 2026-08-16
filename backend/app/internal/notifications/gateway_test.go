package notifications

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// gatewayCapture records everything one httptest gateway server sees.
type gatewayCapture struct {
	path        string
	method      string
	contentType string
	auth        string
	body        []byte
}

// newGatewayServer spins up an httptest gateway recording the request into c
// and answering with handler (or 200 when nil).
func newGatewayServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *gatewayCapture) {
	t.Helper()
	c := &gatewayCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.path = r.URL.Path
		c.method = r.Method
		c.contentType = r.Header.Get("Content-Type")
		c.auth = r.Header.Get("Authorization")
		c.body, _ = io.ReadAll(r.Body)
		if handler != nil {
			handler(w, r)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, c
}

func sampleSMS() Message {
	return Message{Channel: "sms", Recipient: "+255712345678", Template: "otp", Payload: []byte("Your code is 123456")}
}

func TestNewHTTPGatewayRejectsEmptyURL(t *testing.T) {
	for _, channel := range []string{"sms", "email"} {
		if _, err := NewHTTPGateway(HTTPGatewayConfig{}, channel); err == nil {
			t.Errorf("NewHTTPGateway with empty URL for %q must fail", channel)
		}
	}
}

func TestNewHTTPGatewayRejectsUnknownChannel(t *testing.T) {
	if _, err := NewHTTPGateway(HTTPGatewayConfig{URL: "http://gateway.test"}, "push"); err == nil {
		t.Fatal("NewHTTPGateway with unknown channel must fail")
	}
}

func TestSMSPayloadRoundTrip(t *testing.T) {
	msg := sampleSMS()
	body, err := SMSPayload(msg)
	if err != nil {
		t.Fatalf("SMSPayload: %v", err)
	}
	var got struct {
		To      string `json:"to"`
		From    string `json:"from"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.To != msg.Recipient {
		t.Errorf("to = %q, want %q", got.To, msg.Recipient)
	}
	if got.From != msg.Template {
		t.Errorf("from = %q, want template %q as sender label", got.From, msg.Template)
	}
	if got.Message != string(msg.Payload) {
		t.Errorf("message = %q, want %q", got.Message, string(msg.Payload))
	}
}

func TestEmailPayloadRoundTrip(t *testing.T) {
	msg := Message{Channel: "email", Recipient: "u@example.com", Template: "otp", Payload: []byte("Your code is 654321")}
	body, err := EmailPayload(msg)
	if err != nil {
		t.Fatalf("EmailPayload: %v", err)
	}
	var got struct {
		To      string `json:"to"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.To != msg.Recipient {
		t.Errorf("to = %q, want %q", got.To, msg.Recipient)
	}
	if got.Subject != msg.Template {
		t.Errorf("subject = %q, want %q", got.Subject, msg.Template)
	}
	if got.Body != string(msg.Payload) {
		t.Errorf("body = %q, want %q", got.Body, string(msg.Payload))
	}
}

func TestGatewaySMSSendPostsEnvelope(t *testing.T) {
	srv, c := newGatewayServer(t, nil)
	gw, err := NewHTTPGateway(HTTPGatewayConfig{
		URL:     srv.URL + "/v1/sms",
		APIKey:  "sms-key-123",
		Sender:  "HUDUMIKA",
		Timeout: time.Second,
	}, "sms")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	msg := sampleSMS()
	if err := gw.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if c.path != "/v1/sms" {
		t.Errorf("path = %q, want /v1/sms", c.path)
	}
	if c.method != http.MethodPost {
		t.Errorf("method = %q, want POST", c.method)
	}
	if c.contentType != "application/json" {
		t.Errorf("content-type = %q, want application/json", c.contentType)
	}
	if c.auth != "Bearer sms-key-123" {
		t.Errorf("authorization = %q, want Bearer sms-key-123", c.auth)
	}
	var got struct {
		To      string `json:"to"`
		From    string `json:"from"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(c.body, &got); err != nil {
		t.Fatalf("unmarshal captured body: %v", err)
	}
	if got.To != msg.Recipient {
		t.Errorf("to = %q, want %q", got.To, msg.Recipient)
	}
	if got.From != "HUDUMIKA" {
		t.Errorf("from = %q, want configured sender HUDUMIKA", got.From)
	}
	if got.Message != string(msg.Payload) {
		t.Errorf("message = %q, want %q", got.Message, string(msg.Payload))
	}
}

func TestGatewayEmailSendPostsEnvelope(t *testing.T) {
	srv, c := newGatewayServer(t, nil)
	gw, err := NewHTTPGateway(HTTPGatewayConfig{
		URL:     srv.URL + "/mail",
		APIKey:  "mail-key-456",
		Sender:  "noreply@hudumika.test",
		Timeout: time.Second,
	}, "email")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	msg := Message{Channel: "email", Recipient: "u@example.com", Template: "otp", Payload: []byte("Your code is 654321")}
	if err := gw.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if c.path != "/mail" || c.method != http.MethodPost || c.contentType != "application/json" {
		t.Errorf("request = %s %s (ct %q), want POST /mail with application/json", c.method, c.path, c.contentType)
	}
	if c.auth != "Bearer mail-key-456" {
		t.Errorf("authorization = %q, want Bearer mail-key-456", c.auth)
	}
	var got struct {
		To      string `json:"to"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := json.Unmarshal(c.body, &got); err != nil {
		t.Fatalf("unmarshal captured body: %v", err)
	}
	if got.To != msg.Recipient || got.Subject != msg.Template || got.Body != string(msg.Payload) {
		t.Errorf("body = %+v, want to/subject/body from the message", got)
	}
}

func TestGatewayOmitsAuthorizationWithoutAPIKey(t *testing.T) {
	srv, c := newGatewayServer(t, nil)
	gw, err := NewHTTPGateway(HTTPGatewayConfig{URL: srv.URL, Timeout: time.Second}, "sms")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	if err := gw.Send(context.Background(), sampleSMS()); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if c.auth != "" {
		t.Errorf("authorization = %q, want empty when no API key is configured", c.auth)
	}
}

func TestGatewayFailsOnServerError(t *testing.T) {
	srv, _ := newGatewayServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, "gateway exploded")
	})
	gw, err := NewHTTPGateway(HTTPGatewayConfig{URL: srv.URL, Timeout: time.Second}, "sms")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	err = gw.Send(context.Background(), sampleSMS())
	if err == nil {
		t.Fatal("a 500 response must fail the send (chain failover, never silent success)")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error %q does not carry the status", err)
	}
	if !strings.Contains(err.Error(), "gateway exploded") {
		t.Errorf("error %q does not carry the capped response body", err)
	}
}

func TestGatewaySendTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		io.WriteString(w, "slow")
	}))
	t.Cleanup(srv.Close)
	gw, err := NewHTTPGateway(HTTPGatewayConfig{URL: srv.URL, Timeout: 50 * time.Millisecond}, "sms")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	if err := gw.Send(context.Background(), sampleSMS()); err == nil {
		t.Fatal("a slow gateway must time out")
	}
}

func TestGatewayRejectsWrongChannelMessage(t *testing.T) {
	gw, err := NewHTTPGateway(HTTPGatewayConfig{URL: "http://gateway.test", Timeout: time.Millisecond}, "sms")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	err = gw.Send(context.Background(), Message{Channel: "email", Recipient: "u@example.com", Template: "otp", Payload: []byte("x")})
	if err == nil {
		t.Fatal("a wrong-channel message must fail so the Chain can fail over")
	}
}
