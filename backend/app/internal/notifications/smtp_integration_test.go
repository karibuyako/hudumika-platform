//go:build integration

// Integration test for the SMTP email provider: a full provider round-trip
// against the in-test SMTP server (the same fakeSMTPServer the unit tests
// use), driven through SMTPProviderFromEnv. No vendor, no PostgreSQL — the
// delivery happens directly through the provider, so it runs anywhere with
// loopback networking.
package notifications

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestSMTPProviderIntegrationRoundTrip builds the provider from the
// environment pointed at the in-test SMTP server, sends one email and asserts
// the captured envelope and body.
func TestSMTPProviderIntegrationRoundTrip(t *testing.T) {
	fake := newFakeSMTPServer(t)
	t.Setenv(envSMTPHost, "localhost")
	t.Setenv(envSMTPPort, strconv.Itoa(fake.port))
	t.Setenv(envSMTPUser, "integration-user")
	t.Setenv(envSMTPPass, "integration-pass")
	t.Setenv(envSMTPFrom, "ops@hudumika.co.tz")

	provider, err := SMTPProviderFromEnv(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	if err != nil {
		t.Fatalf("provider from env: %v", err)
	}
	if provider == nil {
		t.Fatal("provider = nil, want the SMTP provider")
	}

	msg := Message{
		Channel:   "email",
		Recipient: "customer@example.com",
		Template:  "otp",
		Payload:   []byte(`{"subject":"Your HUDumika code","body":"Your verification code is 123456"}`),
	}
	if err := provider.Send(context.Background(), msg); err != nil {
		t.Fatalf("send: %v", err)
	}

	mails := fake.captured()
	if len(mails) != 1 {
		t.Fatalf("captured %d messages, want 1", len(mails))
	}
	m := mails[0]
	if !m.authSent {
		t.Error("AUTH PLAIN not sent although credentials are configured")
	}
	if !strings.Contains(m.from, "ops@hudumika.co.tz") {
		t.Errorf("MAIL FROM = %q, want the configured sender", m.from)
	}
	if !strings.Contains(m.rcpt, "customer@example.com") {
		t.Errorf("RCPT TO = %q, want the recipient", m.rcpt)
	}
	if !strings.Contains(m.data, "Subject: Your HUDumika code") {
		t.Errorf("data = %q, want the payload subject", m.data)
	}
	if !strings.Contains(m.data, "Your verification code is 123456") {
		t.Errorf("data = %q, want the payload body", m.data)
	}
}

// TestSMTPProviderIntegrationDisabledWithoutHost: an unset EMAIL_SMTP_HOST
// yields (nil, nil) — the chain skips the provider in dev.
func TestSMTPProviderIntegrationDisabledWithoutHost(t *testing.T) {
	t.Setenv(envSMTPHost, "")
	t.Setenv(envSMTPPort, "2525")
	provider, err := SMTPProviderFromEnv(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	if err != nil {
		t.Fatalf("from env: %v", err)
	}
	if provider != nil {
		t.Errorf("provider = %v, want nil without EMAIL_SMTP_HOST", provider)
	}
}
