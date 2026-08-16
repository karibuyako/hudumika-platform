//go:build integration

// Device pairing and testing integration tests against real PostgreSQL +
// Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'PairDevice|TestDevice' -count=1
//
// This suite only ever touches its own rows: users (phone prefix +255878…),
// the devices and device_tests of those users, and its own Redis pairing
// keys. It never truncates shared tables — the staff-ops suite truncates the
// devices table in another process, so every test re-seeds its own devices.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
	"github.com/hudumika/api-backend/internal/gen"
)

// devPairPhonePrefix identifies every users row this suite inserts.
const devPairPhonePrefix = "+255878"

// devPairSetup wires a persistent server and registers cleanup that removes
// only this suite's rows (users by phone prefix; devices and — via the FK
// cascade — device_tests of those users).
func devPairSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx,
			`DELETE FROM devices WHERE merchant_id IN (SELECT id FROM users WHERE phone LIKE '`+devPairPhonePrefix+`%')`); err != nil {
			t.Logf("cleanup pairing devices: %v", err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+devPairPhonePrefix+`%'`); err != nil {
			t.Logf("cleanup pairing users: %v", err)
		}
	})
	return s, pool
}

// devPairMerchant inserts a users row with a per-run unique phone and
// returns the merchant id and the phone (the token subject).
func devPairMerchant(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", devPairPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert pairing merchant user: %v", err)
	}
	return userID, phone
}

// devPairDevice inserts one device row for the merchant and returns its id.
func devPairDevice(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO devices (merchant_id, type, name, status) VALUES ($1, 'pos', 'Pairing Test', $2) RETURNING id`,
		merchantID, status).Scan(&id); err != nil {
		t.Fatalf("insert pairing device: %v", err)
	}
	return id
}

// devPairDBOnlyServer wires a server over PostgreSQL without Redis, so the
// pairing handler must fall back to the devices column.
func devPairDBOnlyServer(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  24 * time.Hour,
		CORSOrigins: []string{"*"},
		DatabaseURL: os.Getenv("DATABASE_URL"),
	}
	s, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new db-only server: %v", err)
	}
	if s.stores.Redis != nil {
		t.Fatal("db-only server unexpectedly has Redis")
	}
	d, err := db.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	s.SetDB(d)
	t.Cleanup(d.Close)
	return s, d.Pool()
}

// TestPairDeviceGeneratesAndStoresCode: a pair request records the contract
// pairingCode on the devices row, stamps paired_at, and publishes the code
// to Redis device:pair:{deviceId} with the 10-minute TTL.
func TestPairDeviceGeneratesAndStoresCode(t *testing.T) {
	s, pool := devPairSetup(t)
	merchantID, phone := devPairMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	deviceID := devPairDevice(t, pool, merchantID, "online")
	key := pairRedisKey(uuid.UUID(deviceID))
	t.Cleanup(func() {
		if s.stores.Redis != nil {
			_ = s.stores.Redis.Client().Del(context.Background(), key).Err()
		}
	})

	const code = "4c7f2a91"
	rec := authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/pair",
		fmt.Sprintf(`{"pairingCode":%q}`, code), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("pair device = %d (%s)", rec.Code, rec.Body)
	}
	var dev gen.MerchantDevice
	if err := json.NewDecoder(rec.Body).Decode(&dev); err != nil {
		t.Fatalf("decode pair response: %v", err)
	}
	if dev.Id == nil || *dev.Id != newUUID(deviceID.String()) {
		t.Fatalf("pair response device = %+v, want id %s", dev, deviceID)
	}

	var stored string
	var pairedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT pairing_code, paired_at FROM devices WHERE id = $1`, deviceID).Scan(&stored, &pairedAt); err != nil {
		t.Fatalf("read pairing state: %v", err)
	}
	if stored != code {
		t.Fatalf("devices.pairing_code = %q, want %q", stored, code)
	}
	if pairedAt == nil {
		t.Fatal("paired_at not stamped after pairing")
	}

	if s.stores.Redis == nil {
		t.Skip("redis not configured; pairing via the column only")
	}
	ctx := context.Background()
	got, err := s.stores.Redis.Client().Get(ctx, key).Result()
	if err != nil {
		t.Fatalf("redis pairing code missing: %v", err)
	}
	if got != code {
		t.Fatalf("redis pairing code = %q, want %q", got, code)
	}
	ttl, err := s.stores.Redis.Client().TTL(ctx, key).Result()
	if err != nil {
		t.Fatalf("redis pairing ttl: %v", err)
	}
	if ttl <= 0 || ttl > 10*time.Minute {
		t.Fatalf("redis pairing ttl = %s, want ~10m", ttl)
	}
}

// TestPairDeviceAlreadyPairedConflict: pairing completes the pairing, so a
// second pair request for the same device answers 409 CONFLICT.
func TestPairDeviceAlreadyPairedConflict(t *testing.T) {
	s, pool := devPairSetup(t)
	merchantID, phone := devPairMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	deviceID := devPairDevice(t, pool, merchantID, "online")

	rec := authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/pair",
		`{"pairingCode":"a1b2c3d4"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("first pair = %d (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/pair",
		`{"pairingCode":"e5f60718"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-pair = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode re-pair error: %v", err)
	}
	if errBody.Code != "CONFLICT" {
		t.Fatalf("re-pair error code = %q, want CONFLICT", errBody.Code)
	}
	if errBody.Message != "device already paired" {
		t.Fatalf("re-pair message = %q, want %q", errBody.Message, "device already paired")
	}

	var pairedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT paired_at FROM devices WHERE id = $1`, deviceID).Scan(&pairedAt); err != nil {
		t.Fatalf("read paired_at: %v", err)
	}
	if pairedAt == nil {
		t.Fatal("device not paired after the successful pair")
	}
}

// TestTestDeviceQueuesJob: a test request answers the contract status ok and
// records a queued device_tests job plus the last_tested_at stamp.
func TestTestDeviceQueuesJob(t *testing.T) {
	s, pool := devPairSetup(t)
	merchantID, phone := devPairMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	deviceID := devPairDevice(t, pool, merchantID, "online")

	rec := authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/test", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("test device = %d (%s)", rec.Code, rec.Body)
	}
	var resp struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode test response: %v", err)
	}
	if resp.Status != "ok" {
		t.Fatalf("test status = %q, want ok", resp.Status)
	}

	var jobID uuid.UUID
	var jobStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT id, status FROM device_tests WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
		deviceID).Scan(&jobID, &jobStatus); err != nil {
		t.Fatalf("read device_tests: %v", err)
	}
	if jobID == uuid.Nil || jobStatus != "queued" {
		t.Fatalf("device_tests job = %s/%s, want queued", jobID, jobStatus)
	}

	var lastTestedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT last_tested_at FROM devices WHERE id = $1`, deviceID).Scan(&lastTestedAt); err != nil {
		t.Fatalf("read last_tested_at: %v", err)
	}
	if lastTestedAt == nil {
		t.Fatal("last_tested_at not stamped after the test job")
	}
}

// TestTestDeviceDisabledConflict: a disabled device answers 409
// DEVICE_OFFLINE and queues no job.
func TestTestDeviceDisabledConflict(t *testing.T) {
	s, pool := devPairSetup(t)
	merchantID, phone := devPairMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	deviceID := devPairDevice(t, pool, merchantID, "disabled")

	rec := authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/test", "", token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("disabled test = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode disabled error: %v", err)
	}
	if errBody.Code != "DEVICE_OFFLINE" {
		t.Fatalf("disabled error code = %q, want DEVICE_OFFLINE", errBody.Code)
	}

	var jobs int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM device_tests WHERE device_id = $1`, deviceID).Scan(&jobs); err != nil {
		t.Fatalf("count device_tests: %v", err)
	}
	if jobs != 0 {
		t.Fatalf("disabled device queued %d jobs, want 0", jobs)
	}
}

// TestDevicePairingForeignMerchantNotFound: a device owned by another
// merchant (and a device id that does not exist) answers 404 DEVICE_NOT_FOUND
// on both pair and test.
func TestDevicePairingForeignMerchantNotFound(t *testing.T) {
	s, pool := devPairSetup(t)
	ownerID, _ := devPairMerchant(t, pool)
	_, otherPhone := devPairMerchant(t, pool)
	token := tokenFor(t, s, otherPhone, RoleMerchant, false)
	h := s.Router()
	deviceID := devPairDevice(t, pool, ownerID, "online")

	rec := authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/pair",
		`{"pairingCode":"c0ffee01"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign pair = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode foreign pair error: %v", err)
	}
	if errBody.Code != "DEVICE_NOT_FOUND" {
		t.Fatalf("foreign pair error code = %q, want DEVICE_NOT_FOUND", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/test", "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign test = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode foreign test error: %v", err)
	}
	if errBody.Code != "DEVICE_NOT_FOUND" {
		t.Fatalf("foreign test error code = %q, want DEVICE_NOT_FOUND", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/devices/"+uuid.NewString()+"/pair",
		`{"pairingCode":"c0ffee02"}`, token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing pair = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode missing pair error: %v", err)
	}
	if errBody.Code != "DEVICE_NOT_FOUND" {
		t.Fatalf("missing pair error code = %q, want DEVICE_NOT_FOUND", errBody.Code)
	}
}

// TestPairDeviceWorksWithoutRedis: without Redis the pairing still succeeds
// via the devices column.
func TestPairDeviceWorksWithoutRedis(t *testing.T) {
	s, pool := devPairDBOnlyServer(t)
	merchantID, phone := devPairMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()
	deviceID := devPairDevice(t, pool, merchantID, "online")

	rec := authedDo(t, h, http.MethodPost, "/devices/"+deviceID.String()+"/pair",
		`{"pairingCode":"deadbeef"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("pair without redis = %d (%s)", rec.Code, rec.Body)
	}

	var stored string
	if err := pool.QueryRow(context.Background(),
		`SELECT pairing_code FROM devices WHERE id = $1`, deviceID).Scan(&stored); err != nil {
		t.Fatalf("read pairing code: %v", err)
	}
	if stored != "deadbeef" {
		t.Fatalf("devices.pairing_code = %q, want deadbeef", stored)
	}
}
