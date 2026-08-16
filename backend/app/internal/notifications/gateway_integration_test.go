//go:build integration

// Integration contract for the HTTP notification gateways: a real POST over
// the loopback against an httptest gateway, exercising the same code path the
// delivery worker uses. No database is required.
package notifications

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestGatewayIntegrationSMS(t *testing.T) {
	srv, c := newGatewayServer(t, nil)
	gw, err := NewHTTPGateway(HTTPGatewayConfig{
		URL:     srv.URL + "/sms",
		APIKey:  "integration-sms-key",
		Sender:  "HUDUMIKA",
		Timeout: 5 * time.Second,
	}, "sms")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	msg := sampleSMS()
	if err := gw.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if c.method != "POST" || c.path != "/sms" || c.contentType != "application/json" {
		t.Fatalf("request = %s %s (ct %q), want POST /sms with application/json", c.method, c.path, c.contentType)
	}
	if c.auth != "Bearer integration-sms-key" {
		t.Errorf("authorization = %q, want Bearer integration-sms-key", c.auth)
	}
	var got struct {
		To      string `json:"to"`
		From    string `json:"from"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(c.body, &got); err != nil {
		t.Fatalf("unmarshal captured body: %v", err)
	}
	if got.To != msg.Recipient || got.From != "HUDUMIKA" || got.Message != string(msg.Payload) {
		t.Errorf("body = %+v, want to/from/message envelope", got)
	}
}

func TestGatewayIntegrationEmail(t *testing.T) {
	srv, c := newGatewayServer(t, nil)
	gw, err := NewHTTPGateway(HTTPGatewayConfig{
		URL:     srv.URL + "/mail",
		APIKey:  "integration-mail-key",
		Sender:  "noreply@hudumika.test",
		Timeout: 5 * time.Second,
	}, "email")
	if err != nil {
		t.Fatalf("NewHTTPGateway: %v", err)
	}
	msg := Message{Channel: "email", Recipient: "u@example.com", Template: "otp", Payload: []byte("Your code is 654321")}
	if err := gw.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if c.method != "POST" || c.path != "/mail" || c.contentType != "application/json" {
		t.Fatalf("request = %s %s (ct %q), want POST /mail with application/json", c.method, c.path, c.contentType)
	}
	if c.auth != "Bearer integration-mail-key" {
		t.Errorf("authorization = %q, want Bearer integration-mail-key", c.auth)
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
		t.Errorf("body = %+v, want to/subject/body envelope", got)
	}
}

func TestGatewayIntegrationConstructorRejectsEmptyURL(t *testing.T) {
	for _, channel := range []string{"sms", "email"} {
		if _, err := NewHTTPGateway(HTTPGatewayConfig{}, channel); err == nil {
			t.Errorf("NewHTTPGateway with empty URL for %q must fail", channel)
		}
	}
}
