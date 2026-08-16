package notifications

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeRow is a pgx.Row that either fails with err or scans raw into the
// first *[]byte destination (the shape ChannelEnabled scans into).
type fakeRow struct {
	err error
	raw []byte
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != 1 {
		return fmt.Errorf("fakeRow: expected 1 destination, got %d", len(dest))
	}
	b, ok := dest[0].(*[]byte)
	if !ok {
		return fmt.Errorf("fakeRow: destination is %T, want *[]byte", dest[0])
	}
	*b = r.raw
	return nil
}

// fakePool implements pgPool for unit tests: every query answers the
// configured row and records the last SQL so column routing can be asserted.
type fakePool struct {
	row       fakeRow
	lastQuery string
}

func (p *fakePool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (p *fakePool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return nil, nil
}

func (p *fakePool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	p.lastQuery = sql
	return p.row
}

// discardLogs silences slog.Default() for the malformed-toggle cases, which
// are expected to warn.
func discardLogs(t *testing.T) {
	t.Helper()
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
}

func TestChannelEnabledMissingRowDefaultsOn(t *testing.T) {
	s := NewPrefStore(&fakePool{row: fakeRow{err: pgx.ErrNoRows}})
	got, err := s.ChannelEnabled(context.Background(), uuid.New(), "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !got {
		t.Fatal("missing row must default to enabled")
	}
}

func TestChannelEnabledExplicitFalse(t *testing.T) {
	s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"otp":false}`)}})
	got, err := s.ChannelEnabled(context.Background(), uuid.New(), "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if got {
		t.Fatal("explicit sms.otp=false must disable the channel")
	}
}

func TestChannelEnabledExplicitTrue(t *testing.T) {
	s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"otp":true}`)}})
	got, err := s.ChannelEnabled(context.Background(), uuid.New(), "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !got {
		t.Fatal("explicit sms.otp=true must enable the channel")
	}
}

func TestChannelEnabledUnknownEventDefaultsOn(t *testing.T) {
	s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"order.accepted":false}`)}})
	got, err := s.ChannelEnabled(context.Background(), uuid.New(), "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !got {
		t.Fatal("an unrelated toggle must not mute an untoggled event")
	}
}

func TestChannelEnabledWildcard(t *testing.T) {
	ctx := context.Background()
	// Wildcard false is the channel-wide default.
	s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"*":false}`)}})
	got, err := s.ChannelEnabled(ctx, uuid.New(), "email", "order.created")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if got {
		t.Fatal(`wildcard "*":false must disable untoggled events`)
	}

	// The exact event beats the wildcard.
	s = NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"*":false,"otp":true}`)}})
	got, err = s.ChannelEnabled(ctx, uuid.New(), "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !got {
		t.Fatal("exact event toggle must win over the wildcard")
	}
	got, err = s.ChannelEnabled(ctx, uuid.New(), "sms", "order.created")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if got {
		t.Fatal("untoggled event must follow the wildcard false")
	}

	// Wildcard true keeps everything on.
	s = NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"*":true}`)}})
	got, err = s.ChannelEnabled(ctx, uuid.New(), "push", "order.created")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !got {
		t.Fatal(`wildcard "*":true must keep events enabled`)
	}
}

func TestChannelEnabledEmptyObjectDefaultsOn(t *testing.T) {
	for _, raw := range []string{`{}`, `null`} {
		s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(raw)}})
		got, err := s.ChannelEnabled(context.Background(), uuid.New(), "push", "order.created")
		if err != nil {
			t.Fatalf("channel enabled (%s): %v", raw, err)
		}
		if !got {
			t.Fatalf("toggle object %s must default to enabled", raw)
		}
	}
}

func TestChannelEnabledMalformedDefaultsOn(t *testing.T) {
	discardLogs(t)
	ctx := context.Background()
	for _, raw := range []string{`not-json`, `"string"`, `[1,2]`, `5`} {
		s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(raw)}})
		got, err := s.ChannelEnabled(ctx, uuid.New(), "sms", "otp")
		if err != nil {
			t.Fatalf("channel enabled (%s): %v", raw, err)
		}
		if !got {
			t.Fatalf("malformed toggle %q must default to enabled", raw)
		}
	}
}

func TestChannelEnabledNonBooleanValueDefaultsOn(t *testing.T) {
	discardLogs(t)
	s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{"otp":"yes","*":"maybe"}`)}})
	got, err := s.ChannelEnabled(context.Background(), uuid.New(), "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !got {
		t.Fatal("a non-boolean toggle value must default to enabled")
	}
}

func TestChannelEnabledUnknownChannelErrors(t *testing.T) {
	s := NewPrefStore(&fakePool{row: fakeRow{raw: []byte(`{}`)}})
	if _, err := s.ChannelEnabled(context.Background(), uuid.New(), "carrier-pigeon", "otp"); err == nil {
		t.Fatal("unknown channel must return an error")
	}
}

func TestChannelEnabledColumnRouting(t *testing.T) {
	ctx := context.Background()
	for channel, column := range map[string]string{
		"push": "push", "sms": "sms", "email": "email", "in_app": "in_app",
	} {
		p := &fakePool{row: fakeRow{raw: []byte(`{"*":false}`)}}
		s := NewPrefStore(p)
		if _, err := s.ChannelEnabled(ctx, uuid.New(), channel, "order.created"); err != nil {
			t.Fatalf("channel enabled (%s): %v", channel, err)
		}
		if p.lastQuery != `SELECT `+column+` FROM notification_preferences WHERE user_id = $1` {
			t.Fatalf("channel %s queried %q, want the %s column", channel, p.lastQuery, column)
		}
	}
}
