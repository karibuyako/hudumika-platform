//go:build integration

// ChannelEnabled integration tests against real PostgreSQL. They reuse the
// setupNotifications fixture (truncate + fresh user) from
// notifications_integration_test.go, so they run under the same
// DATABASE_URL gate.
package notifications

import (
	"context"
	"testing"
)

// TestChannelEnabledMissingRow: a user with no preferences row has every
// channel/event enabled.
func TestChannelEnabledMissingRow(t *testing.T) {
	pool, userID := setupNotifications(t)
	store := NewPrefStore(pool)

	enabled, err := store.ChannelEnabled(context.Background(), userID, "sms", "otp")
	if err != nil {
		t.Fatalf("channel enabled: %v", err)
	}
	if !enabled {
		t.Fatal("missing preferences row must default to enabled")
	}
}

// TestChannelEnabledUpsertedToggles: explicit false disables exactly that
// channel/event pair; a wildcard "*" becomes the channel default; the exact
// event beats the wildcard; other channels and events stay on.
func TestChannelEnabledUpsertedToggles(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)

	if err := store.Upsert(ctx, userID,
		[]byte(`{}`), []byte(`{"otp":false}`), []byte(`{}`), []byte(`{}`)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// Exact false on the sms channel.
	if enabled, err := store.ChannelEnabled(ctx, userID, "sms", "otp"); err != nil {
		t.Fatalf("channel enabled: %v", err)
	} else if enabled {
		t.Fatal("sms.otp=false must disable delivery")
	}
	// Untoggled event on the same channel stays on.
	if enabled, err := store.ChannelEnabled(ctx, userID, "sms", "order.created"); err != nil {
		t.Fatalf("channel enabled: %v", err)
	} else if !enabled {
		t.Fatal("untoggled sms event must stay enabled")
	}
	// Other channels are untouched.
	if enabled, err := store.ChannelEnabled(ctx, userID, "push", "otp"); err != nil {
		t.Fatalf("channel enabled: %v", err)
	} else if !enabled {
		t.Fatal("push must stay enabled when only sms is toggled")
	}

	// Wildcard: "*":false is the channel default, the exact event wins.
	if err := store.Upsert(ctx, userID,
		[]byte(`{}`), []byte(`{"*":false,"otp":true}`), []byte(`{}`), []byte(`{}`)); err != nil {
		t.Fatalf("upsert wildcard: %v", err)
	}
	if enabled, err := store.ChannelEnabled(ctx, userID, "sms", "otp"); err != nil {
		t.Fatalf("channel enabled: %v", err)
	} else if !enabled {
		t.Fatal("exact otp=true must beat the wildcard")
	}
	if enabled, err := store.ChannelEnabled(ctx, userID, "sms", "order.created"); err != nil {
		t.Fatalf("channel enabled: %v", err)
	} else if enabled {
		t.Fatal("untoggled event must follow the wildcard false")
	}
}

// TestChannelEnabledMalformedColumnDefaultsOn: a jsonb toggle that is not an
// object of booleans must never silence a channel.
func TestChannelEnabledMalformedColumnDefaultsOn(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)

	for _, raw := range []string{`"string"`, `[1,2]`, `5`, `{"otp":"yes"}`} {
		if _, err := pool.Exec(ctx,
			`UPDATE notification_preferences SET sms = $2 WHERE user_id = $1`,
			userID, []byte(raw)); err != nil {
			t.Fatalf("set malformed sms %s: %v", raw, err)
		}
		enabled, err := store.ChannelEnabled(ctx, userID, "sms", "otp")
		if err != nil {
			t.Fatalf("channel enabled (%s): %v", raw, err)
		}
		if !enabled {
			t.Fatalf("malformed toggle %q must default to enabled", raw)
		}
	}
}
