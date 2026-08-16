//go:build integration

// Preference-enforcement integration tests for the OTP SMS enqueue path
// against real PostgreSQL + Redis: notification_preferences.sms.otp must be
// consulted before an OTP delivery is enqueued.
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration ./internal/api/ -run 'OtpDelivery|Preference' -count=1
//
// The suite owns only the rows it inserts: its own users, their
// notification_preferences rows and its own notification_outbox rows (phone
// prefix +255948). It never truncates.
package api

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/notifications"
	"github.com/hudumika/api-backend/internal/store"
)

// otpPrefPhonePrefix identifies every users row this suite inserts.
const otpPrefPhonePrefix = "+255948"

var otpPrefPhoneSeq atomic.Int64

// otpPrefPhone builds a per-run unique phone.
func otpPrefPhone() string {
	n := otpPrefPhoneSeq.Add(1)
	return fmt.Sprintf("%s%05d%04d", otpPrefPhonePrefix, time.Now().UnixNano()%100000, n%10000)
}

// otpPrefFixture wires the persistent server with a real PgOutbox and
// Encryptor so enqueueOtpDelivery has a complete delivery pipeline.
func otpPrefFixture(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	s.SetOutbox(notifications.NewPgOutbox(pool))
	enc, err := notifications.NewEncryptor("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("encryptor: %v", err)
	}
	s.SetEncryptor(enc)
	return s, pool
}

// TestOtpDeliveryPreferenceEnforcement: sms.otp=false on the recipient's
// preferences row keeps enqueueOtpDelivery from writing an outbox row; the
// toggle true (or no row at all) creates one; a phone with no users row
// (fresh signup) is always delivered. The OTP request itself never fails.
func TestOtpDeliveryPreferenceEnforcement(t *testing.T) {
	s, pool := otpPrefFixture(t)
	ctx := context.Background()

	phone := otpPrefPhone()
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM notification_outbox WHERE recipient = $1`, phone)
		_, _ = pool.Exec(c, `DELETE FROM notification_preferences WHERE user_id = $1`, userID)
		_, _ = pool.Exec(c, `DELETE FROM users WHERE id = $1`, userID)
	})

	created := store.OtpCreated{RequestID: uuid.NewString(), Code: "123456", ExpiresAt: time.Now().Add(5 * time.Minute)}
	countOutbox := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM notification_outbox WHERE recipient = $1 AND template = 'otp'`, phone).Scan(&n); err != nil {
			t.Fatalf("count outbox: %v", err)
		}
		return n
	}

	// 1. No preferences row: defaults on, the row is enqueued.
	s.enqueueOtpDelivery(ctx, created, "phone", phone)
	if got := countOutbox(); got != 1 {
		t.Fatalf("outbox rows without prefs = %d, want 1", got)
	}

	// 2. sms.otp=false: delivery is skipped, no new row.
	prefs := notifications.NewPrefStore(pool)
	if err := prefs.Upsert(ctx, userID, []byte(`{}`), []byte(`{"otp":false}`), []byte(`{}`), []byte(`{}`)); err != nil {
		t.Fatalf("upsert disabled prefs: %v", err)
	}
	s.enqueueOtpDelivery(ctx, created, "phone", phone)
	if got := countOutbox(); got != 1 {
		t.Fatalf("outbox rows with sms.otp=false = %d, want 1 (delivery skipped)", got)
	}

	// 3. sms.otp=true: delivery proceeds.
	if err := prefs.Upsert(ctx, userID, []byte(`{}`), []byte(`{"otp":true}`), []byte(`{}`), []byte(`{}`)); err != nil {
		t.Fatalf("upsert enabled prefs: %v", err)
	}
	s.enqueueOtpDelivery(ctx, created, "phone", phone)
	if got := countOutbox(); got != 2 {
		t.Fatalf("outbox rows with sms.otp=true = %d, want 2", got)
	}

	// 4. Fresh signup: no users row, always delivered.
	fresh := otpPrefPhone()
	s.enqueueOtpDelivery(ctx, created, "phone", fresh)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM notification_outbox WHERE recipient = $1`, fresh)
	})
	var freshCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notification_outbox WHERE recipient = $1 AND template = 'otp'`, fresh).Scan(&freshCount); err != nil {
		t.Fatalf("count fresh outbox: %v", err)
	}
	if freshCount != 1 {
		t.Fatalf("fresh-signup outbox rows = %d, want 1", freshCount)
	}
}
