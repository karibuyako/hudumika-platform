package notifications

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
)

// capturedMail is one message received by fakeSMTPServer: the envelope
// commands plus the DATA body, and whether AUTH was attempted.
type capturedMail struct {
	from     string
	rcpt     string
	data     string
	authSent bool
}

// fakeSMTPServer is a minimal in-memory SMTP server for tests: it speaks just
// enough of the protocol (220 greeting, 250 for EHLO/MAIL/RCPT/DATA, 354,
// 250 after the dot, 221 QUIT) and records every transaction it sees.
type fakeSMTPServer struct {
	ln    net.Listener
	port  int
	mu    sync.Mutex
	mails []capturedMail
}

// newFakeSMTPServer starts the server on 127.0.0.1 and registers its cleanup.
func newFakeSMTPServer(t *testing.T) *fakeSMTPServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("smtp test server listen: %v", err)
	}
	f := &fakeSMTPServer{ln: ln, port: ln.Addr().(*net.TCPAddr).Port}
	t.Cleanup(func() { ln.Close() })
	go f.serve()
	return f
}

func (f *fakeSMTPServer) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

// handle serves one SMTP session. Commands are matched case-insensitively;
// DATA collects lines until a lone dot.
func (f *fakeSMTPServer) handle(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	reply := func(format string, args ...any) {
		fmt.Fprintf(conn, format+"\r\n", args...)
	}
	reply("220 fake ESMTP hudumika")
	var (
		from, rcpt string
		authSent   bool
	)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		raw := strings.TrimRight(line, "\r\n")
		verb := raw
		if idx := strings.IndexAny(verb, " "); idx >= 0 {
			verb = verb[:idx]
		}
		switch strings.ToUpper(verb) {
		case "EHLO":
			reply("250-fake ESMTP")
			reply("250 AUTH PLAIN")
		case "HELO":
			reply("250 fake ESMTP")
		case "AUTH":
			authSent = true
			reply("235 ok")
		case "MAIL":
			from = raw
			reply("250 ok")
		case "RCPT":
			rcpt = raw
			reply("250 ok")
		case "DATA":
			reply("354 go ahead")
			var data strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if strings.TrimRight(l, "\r\n") == "." {
					break
				}
				data.WriteString(l)
			}
			f.mu.Lock()
			f.mails = append(f.mails, capturedMail{from: from, rcpt: rcpt, data: data.String(), authSent: authSent})
			f.mu.Unlock()
			reply("250 ok")
		case "QUIT":
			reply("221 bye")
			return
		default:
			reply("500 unrecognised command")
		}
	}
}

// mails returns a copy of the captured messages.
func (f *fakeSMTPServer) captured() []capturedMail {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]capturedMail(nil), f.mails...)
}

// smtpProviderFor points a provider at the fake server. The host is
// "localhost" so smtp.PlainAuth works over the unencrypted test connection
// (Go's special case); the listener is bound to 127.0.0.1.
func smtpProviderFor(f *fakeSMTPServer, user, pass string) *SMTPProvider {
	return NewSMTPProvider("localhost", f.port, user, pass, "")
}

// smtpMessageForSend is an 'email' outbox message whose payload JSON carries a
// subject and body.
func smtpMessageForSend() Message {
	return Message{
		Channel:   "email",
		Recipient: "customer@example.com",
		Template:  "order.status",
		Payload:   []byte(`{"subject":"Order on its way","body":"Your order is being delivered"}`),
	}
}

func TestSMTPProviderSendDeliversMessage(t *testing.T) {
	fake := newFakeSMTPServer(t)
	p := smtpProviderFor(fake, "", "")
	if err := p.Send(context.Background(), smtpMessageForSend()); err != nil {
		t.Fatalf("send: %v", err)
	}
	mails := fake.captured()
	if len(mails) != 1 {
		t.Fatalf("captured %d messages, want 1", len(mails))
	}
	m := mails[0]
	if !strings.Contains(m.from, "noreply@hudumika.co.tz") {
		t.Errorf("MAIL FROM = %q, want the default sender", m.from)
	}
	if !strings.Contains(m.rcpt, "customer@example.com") {
		t.Errorf("RCPT TO = %q, want the recipient", m.rcpt)
	}
	if m.authSent {
		t.Error("AUTH sent although no credentials are configured")
	}
	if !strings.Contains(m.data, "To: customer@example.com") {
		t.Errorf("data = %q, want the To header", m.data)
	}
	if !strings.Contains(m.data, "Subject: Order on its way") {
		t.Errorf("data = %q, want the payload subject", m.data)
	}
	if !strings.Contains(m.data, "Your order is being delivered") {
		t.Errorf("data = %q, want the payload body", m.data)
	}
}

func TestSMTPProviderSendWithAuth(t *testing.T) {
	fake := newFakeSMTPServer(t)
	p := smtpProviderFor(fake, "relay-user", "relay-pass")
	if err := p.Send(context.Background(), smtpMessageForSend()); err != nil {
		t.Fatalf("send with auth: %v", err)
	}
	mails := fake.captured()
	if len(mails) != 1 {
		t.Fatalf("captured %d messages, want 1", len(mails))
	}
	if !mails[0].authSent {
		t.Error("AUTH PLAIN not sent although credentials are configured")
	}
}

func TestSMTPProviderSendFallsBackToRawPayload(t *testing.T) {
	fake := newFakeSMTPServer(t)
	p := smtpProviderFor(fake, "", "")
	msg := smtpMessageForSend()
	msg.Payload = []byte("plain-raw-payload")
	if err := p.Send(context.Background(), msg); err != nil {
		t.Fatalf("send: %v", err)
	}
	mails := fake.captured()
	if len(mails) != 1 {
		t.Fatalf("captured %d messages, want 1", len(mails))
	}
	m := mails[0]
	if !strings.Contains(m.data, "Subject: HUDumika notification") {
		t.Errorf("data = %q, want the generic subject", m.data)
	}
	if !strings.Contains(m.data, "plain-raw-payload") {
		t.Errorf("data = %q, want the raw payload as body", m.data)
	}
	if strings.Contains(m.data, "order.status") {
		t.Errorf("data = %q, want no template in the message", m.data)
	}
}

func TestSMTPProviderSendConnectionFailure(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	p := NewSMTPProvider("127.0.0.1", port, "", "", "")
	err = p.Send(context.Background(), smtpMessageForSend())
	if err == nil {
		t.Fatal("send to a closed port: want error")
	}
	if !strings.Contains(err.Error(), "smtp: dial") {
		t.Errorf("error = %v, want the wrapped dial error", err)
	}
}

func TestSMTPProviderSendNonEmailRecipientStillAttempts(t *testing.T) {
	fake := newFakeSMTPServer(t)
	p := smtpProviderFor(fake, "", "")
	msg := smtpMessageForSend()
	msg.Recipient = "not-an-email"
	if err := p.Send(context.Background(), msg); err != nil {
		t.Fatalf("send: %v", err)
	}
	mails := fake.captured()
	if len(mails) != 1 {
		t.Fatalf("captured %d messages, want 1", len(mails))
	}
	if !strings.Contains(mails[0].rcpt, "not-an-email") {
		t.Errorf("RCPT TO = %q, want the attempted recipient", mails[0].rcpt)
	}
}

func TestSMTPProviderFromEnvConfigured(t *testing.T) {
	t.Setenv(envSMTPHost, "smtp.example.com")
	t.Setenv(envSMTPPort, "")
	t.Setenv(envSMTPUser, "env-user")
	t.Setenv(envSMTPPass, "env-pass")
	t.Setenv(envSMTPFrom, "")
	p, err := SMTPProviderFromEnv(nil)
	if err != nil {
		t.Fatalf("from env: %v", err)
	}
	if p == nil {
		t.Fatal("provider = nil, want the configured provider")
	}
	if p.host != "smtp.example.com" {
		t.Errorf("host = %q, want %q", p.host, "smtp.example.com")
	}
	if p.port != defaultSMTPPort {
		t.Errorf("port = %d, want the default %d", p.port, defaultSMTPPort)
	}
	if p.user != "env-user" || p.pass != "env-pass" {
		t.Errorf("user/pass = %q/%q, want env-user/env-pass", p.user, p.pass)
	}
	if p.from != defaultSMTPFrom {
		t.Errorf("from = %q, want the default %q", p.from, defaultSMTPFrom)
	}
}

func TestSMTPProviderFromEnvPortAndFromOverride(t *testing.T) {
	t.Setenv(envSMTPHost, "smtp.example.com")
	t.Setenv(envSMTPPort, "2525")
	t.Setenv(envSMTPFrom, "sender@hudumika.co.tz")
	p, err := SMTPProviderFromEnv(nil)
	if err != nil {
		t.Fatalf("from env: %v", err)
	}
	if p == nil {
		t.Fatal("provider = nil, want the configured provider")
	}
	if p.port != 2525 {
		t.Errorf("port = %d, want 2525", p.port)
	}
	if p.from != "sender@hudumika.co.tz" {
		t.Errorf("from = %q, want %q", p.from, "sender@hudumika.co.tz")
	}
}

func TestSMTPProviderFromEnvEmptyHostSkips(t *testing.T) {
	t.Setenv(envSMTPHost, "")
	t.Setenv(envSMTPPort, "999")
	p, err := SMTPProviderFromEnv(nil)
	if err != nil || p != nil {
		t.Errorf("empty host: provider = %v, err = %v, want (nil, nil)", p, err)
	}
}

func TestSMTPProviderFromEnvWhitespaceHostSkips(t *testing.T) {
	t.Setenv(envSMTPHost, "   ")
	p, err := SMTPProviderFromEnv(nil)
	if err != nil || p != nil {
		t.Errorf("whitespace host: provider = %v, err = %v, want (nil, nil)", p, err)
	}
}

func TestSMTPProviderFromEnvMalformedPortFails(t *testing.T) {
	for _, raw := range []string{"not-a-port", "-1", "70000"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv(envSMTPHost, "smtp.example.com")
			t.Setenv(envSMTPPort, raw)
			if _, err := SMTPProviderFromEnv(nil); err == nil {
				t.Errorf("port %q: want error", raw)
			}
		})
	}
}
