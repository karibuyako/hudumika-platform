package notifications

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultSMTPPort is used when EMAIL_SMTP_PORT is unset.
	defaultSMTPPort = 587
	// defaultSMTPFrom is the envelope sender when EMAIL_SMTP_FROM is unset.
	defaultSMTPFrom = "noreply@hudumika.co.tz"
	// defaultSMTPTimeout bounds the SMTP connection dial.
	defaultSMTPTimeout = 10 * time.Second

	envSMTPHost = "EMAIL_SMTP_HOST"
	envSMTPPort = "EMAIL_SMTP_PORT"
	envSMTPUser = "EMAIL_SMTP_USER"
	envSMTPPass = "EMAIL_SMTP_PASS"
	envSMTPFrom = "EMAIL_SMTP_FROM"
)

// SMTPProvider delivers 'email' outbox messages through a plain SMTP relay
// (stdlib net/smtp, no HTTP vendor), joining the notification chain alongside
// the HTTP email gateway. Payload decryption is a later pipeline concern; the
// provider sends the payload as it receives it.
type SMTPProvider struct {
	host    string
	port    int
	user    string
	pass    string
	from    string
	timeout time.Duration
}

// NewSMTPProvider returns a provider dialing host:port. An empty from falls
// back to the default envelope sender.
func NewSMTPProvider(host string, port int, user, pass, from string) *SMTPProvider {
	if from == "" {
		from = defaultSMTPFrom
	}
	return &SMTPProvider{
		host:    host,
		port:    port,
		user:    user,
		pass:    pass,
		from:    from,
		timeout: defaultSMTPTimeout,
	}
}

// SMTPProviderFromEnv builds the provider from the environment: EMAIL_SMTP_HOST
// is required to enable it, EMAIL_SMTP_PORT defaults to 587, EMAIL_SMTP_USER
// and EMAIL_SMTP_PASS enable AUTH PLAIN, and EMAIL_SMTP_FROM defaults to
// noreply@hudumika.co.tz. An empty host returns (nil, nil) so the caller skips
// the provider (dev mode — the email channel stays on the gateway/stub); only
// a malformed EMAIL_SMTP_PORT is an error.
func SMTPProviderFromEnv(logger *slog.Logger) (*SMTPProvider, error) {
	host := strings.TrimSpace(os.Getenv(envSMTPHost))
	if host == "" {
		return nil, nil
	}
	port := defaultSMTPPort
	if raw := strings.TrimSpace(os.Getenv(envSMTPPort)); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("notifications: smtp: invalid %s %q: want a port 1-65535", envSMTPPort, raw)
		}
		port = n
	}
	p := NewSMTPProvider(host, port,
		strings.TrimSpace(os.Getenv(envSMTPUser)),
		os.Getenv(envSMTPPass),
		strings.TrimSpace(os.Getenv(envSMTPFrom)))
	if logger != nil {
		logger.Info("notifications: smtp provider active", "host", host, "port", port, "from", p.from)
	}
	return p, nil
}

// smtpText resolves the subject and body for msg: the email payload JSON's
// subject and body fields win when the payload parses, otherwise the subject
// is the generic "HUDumika notification" and the body is the raw payload
// string.
func smtpText(msg Message) (subject, body string) {
	subject, body = "HUDumika notification", string(msg.Payload)
	var p struct {
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if json.Unmarshal(msg.Payload, &p) == nil {
		if p.Subject != "" {
			subject = p.Subject
		}
		if p.Body != "" {
			body = p.Body
		}
	}
	return subject, body
}

// Send delivers msg as a plain-text email through the SMTP relay: dials
// host:port (bounded by the dial timeout), AUTH PLAIN when credentials are
// configured, then MAIL FROM / RCPT TO / DATA / QUIT. The connection is closed
// on every path (deferred Close plus Quit); every failure is wrapped so the
// chain can fail over or back off.
func (p *SMTPProvider) Send(ctx context.Context, msg Message) error {
	addr := net.JoinHostPort(p.host, strconv.Itoa(p.port))
	conn, err := net.DialTimeout("tcp", addr, p.timeout)
	if err != nil {
		return fmt.Errorf("notifications: smtp: dial %s: %w", addr, err)
	}
	defer conn.Close()

	client, err := smtp.NewClient(conn, p.host)
	if err != nil {
		return fmt.Errorf("notifications: smtp: connect to %s: %w", addr, err)
	}
	defer client.Close()

	if p.user != "" {
		auth := smtp.PlainAuth("", p.user, p.pass, p.host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("notifications: smtp: auth: %w", err)
		}
	}
	if err := client.Mail(p.from); err != nil {
		return fmt.Errorf("notifications: smtp: mail from %q: %w", p.from, err)
	}
	if err := client.Rcpt(msg.Recipient); err != nil {
		return fmt.Errorf("notifications: smtp: rcpt to %q: %w", msg.Recipient, err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("notifications: smtp: data: %w", err)
	}
	subject, body := smtpText(msg)
	text := fmt.Sprintf("To: %s\r\nSubject: %s\r\n\r\n%s", msg.Recipient, subject, body)
	if _, err := writer.Write([]byte(text)); err != nil {
		writer.Close()
		return fmt.Errorf("notifications: smtp: write message: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("notifications: smtp: finish message: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("notifications: smtp: quit: %w", err)
	}
	return nil
}
