//go:build integration

// End-to-end tests for the riders Store and OnlineRegistry against real
// PostgreSQL + Redis (docker compose / local dev). Run via
// `go test -tags integration ./internal/riders/ -count=1` with DATABASE_URL
// and REDIS_URL set (e.g. postgres://hudumika:hudumika@localhost:5432/
// hudumika, redis://localhost:6379/0). Setup truncates ONLY the riders table
// and deletes the users it creates, so other contexts' data is untouched.
package riders

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/store"
)

// ridersEnv bundles the real store, registry and their clients for a test.
type ridersEnv struct {
	store    *Store
	registry *OnlineRegistry
	pool     *pgxpool.Pool
	redis    *store.Redis
}

// setup connects to the real dependencies (skipping when either URL is
// unset) and resets ONLY the riders table plus the riders:online set.
func setup(t *testing.T) *ridersEnv {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("REDIS_URL not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "TRUNCATE riders, rider_shifts, rider_breaks, trip_shares, cod_reconciliation_sessions CASCADE"); err != nil {
		t.Fatalf("truncate riders: %v", err)
	}

	r, err := store.NewRedis(ctx, redisURL)
	if err != nil {
		t.Fatalf("new redis: %v", err)
	}
	t.Cleanup(r.Close)
	if err := r.Client().Del(ctx, onlineSetKey).Err(); err != nil {
		t.Fatalf("del %s: %v", onlineSetKey, err)
	}

	return &ridersEnv{
		store:    NewStore(pool),
		registry: NewOnlineRegistry(r),
		pool:     pool,
		redis:    r,
	}
}

// insertUser creates a users row (the riders FK target) and schedules its
// deletion; the riders row cascades away with it.
func insertUser(t *testing.T, env *ridersEnv, phone string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("insert user %s: %v", phone, err)
	}
	t.Cleanup(func() {
		if _, err := env.pool.Exec(context.Background(),
			`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %s: %v", id, err)
		}
	})
	return id
}

// TestApplyAndGetByOwner: an application creates a riders row retrievable by
// owner with all projected fields; users without a row get (nil, nil). The
// city column is a uuid (the planned cities table), so it takes a uuid
// string.
func TestApplyAndGetByOwner(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709000001")
	city := uuid.NewString()

	id, err := env.store.Apply(ctx, userID, "Juma K", city, "motorcycle")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("apply returned nil id")
	}

	rider, err := env.store.GetByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if rider == nil {
		t.Fatal("expected rider, got nil")
	}
	if rider.ID != id {
		t.Fatalf("rider id = %s, want %s", rider.ID, id)
	}
	if rider.Name != "Juma K" || rider.CityID != city || rider.Vehicle != "motorcycle" {
		t.Fatalf("rider fields = %+v", rider)
	}
	if rider.Verification != "pending" {
		t.Fatalf("verification = %q, want pending", rider.Verification)
	}
	if rider.Online {
		t.Fatal("new rider should be offline")
	}
	if rider.Rating != nil {
		t.Fatalf("new rider rating = %v, want nil", *rider.Rating)
	}
	if rider.ReviewCount == nil || *rider.ReviewCount != 0 {
		t.Fatalf("review count = %v, want 0", rider.ReviewCount)
	}

	missing, err := env.store.GetByOwner(ctx, uuid.New())
	if err != nil {
		t.Fatalf("get by owner (absent): %v", err)
	}
	if missing != nil {
		t.Fatalf("expected (nil, nil) for absent user, got %+v", missing)
	}
}

// TestApplyTwiceSameUserIsAlreadyApplied: the unique owner_user_id
// constraint makes a second application fail with ErrAlreadyApplied.
func TestApplyTwiceSameUserIsAlreadyApplied(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709000002")
	city := uuid.NewString()

	if _, err := env.store.Apply(ctx, userID, "Asha", city, "bicycle"); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	_, err := env.store.Apply(ctx, userID, "Asha", city, "bicycle")
	if !errors.Is(err, ErrAlreadyApplied) {
		t.Fatalf("second apply err = %v, want ErrAlreadyApplied", err)
	}
}

// TestUpdateProfileChangesNameAndVehicle: the mutable profile fields are
// persisted and the row keeps its identity.
func TestUpdateProfileChangesNameAndVehicle(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709000003")
	city := uuid.NewString()

	id, err := env.store.Apply(ctx, userID, "Baraka", city, "motorcycle")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if err := env.store.UpdateProfile(ctx, id, "Baraka M", "car"); err != nil {
		t.Fatalf("update profile: %v", err)
	}

	rider, err := env.store.GetByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if rider.ID != id || rider.Name != "Baraka M" || rider.Vehicle != "car" {
		t.Fatalf("rider after update = %+v", rider)
	}

	if err := env.store.UpdateProfile(ctx, uuid.New(), "Ghost", "car"); err == nil {
		t.Fatal("update on a missing rider should error")
	}
}

// TestSetOnlineFlipsDBFlagAndRegistry: SetOnline keeps the durable flag and
// the Redis online set in agreement, and removing the rider drops them both.
func TestSetOnlineFlipsDBFlagAndRegistry(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709000004")

	id, err := env.store.Apply(ctx, userID, "Neema", uuid.NewString(), "motorcycle")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if n, err := env.registry.Count(ctx); err != nil || n != 0 {
		t.Fatalf("online set not empty at start: n=%d err=%v", n, err)
	}

	if err := env.store.SetOnline(ctx, id, true); err != nil {
		t.Fatalf("store set online: %v", err)
	}
	if err := env.registry.SetOnline(ctx, id, true); err != nil {
		t.Fatalf("registry set online: %v", err)
	}
	rider, err := env.store.GetByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if !rider.Online {
		t.Fatal("DB online flag not set")
	}
	if _, err := env.redis.Client().ZScore(ctx, onlineSetKey, id.String()).Result(); err != nil {
		t.Fatalf("rider missing from online set: %v", err)
	}
	if n, err := env.registry.Count(ctx); err != nil || n != 1 {
		t.Fatalf("registry count = %d err=%v, want 1", n, err)
	}

	if err := env.store.SetOnline(ctx, id, false); err != nil {
		t.Fatalf("store set offline: %v", err)
	}
	if err := env.registry.SetOnline(ctx, id, false); err != nil {
		t.Fatalf("registry set offline: %v", err)
	}
	rider, err = env.store.GetByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if rider.Online {
		t.Fatal("DB online flag still set")
	}
	if _, err := env.redis.Client().ZScore(ctx, onlineSetKey, id.String()).Result(); !errors.Is(err, redis.Nil) {
		t.Fatalf("rider still in online set after removal: %v", err)
	}
	if n, err := env.registry.Count(ctx); err != nil || n != 0 {
		t.Fatalf("registry count = %d err=%v, want 0", n, err)
	}
}

// TestCountOnlineMatchesRegistry: the DB count of online riders agrees with
// the Redis online set as riders go on- and offline.
func TestCountOnlineMatchesRegistry(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	u1 := insertUser(t, env, "+255709000005")
	u2 := insertUser(t, env, "+255709000006")

	id1, err := env.store.Apply(ctx, u1, "Pendo", uuid.NewString(), "motorcycle")
	if err != nil {
		t.Fatalf("apply 1: %v", err)
	}
	id2, err := env.store.Apply(ctx, u2, "Eli", uuid.NewString(), "bicycle")
	if err != nil {
		t.Fatalf("apply 2: %v", err)
	}

	for _, id := range []uuid.UUID{id1, id2} {
		if err := env.store.SetOnline(ctx, id, true); err != nil {
			t.Fatalf("store set online %s: %v", id, err)
		}
		if err := env.registry.SetOnline(ctx, id, true); err != nil {
			t.Fatalf("registry set online %s: %v", id, err)
		}
	}
	if n, err := env.store.CountOnline(ctx); err != nil || n != 2 {
		t.Fatalf("db count online = %d err=%v, want 2", n, err)
	}
	if n, err := env.registry.Count(ctx); err != nil || n != 2 {
		t.Fatalf("registry count = %d err=%v, want 2", n, err)
	}

	if err := env.store.SetOnline(ctx, id1, false); err != nil {
		t.Fatalf("store set offline %s: %v", id1, err)
	}
	if err := env.registry.SetOnline(ctx, id1, false); err != nil {
		t.Fatalf("registry set offline %s: %v", id1, err)
	}
	if n, err := env.store.CountOnline(ctx); err != nil || n != 1 {
		t.Fatalf("db count online = %d err=%v, want 1", n, err)
	}
	if n, err := env.registry.Count(ctx); err != nil || n != 1 {
		t.Fatalf("registry count = %d err=%v, want 1", n, err)
	}
}

// TestLocationRoundtripAndTTL: a reported position comes back with the same
// lat/lon and a sane timestamp; the key carries the short TTL. The expiry
// itself is not waited on (no FastForward on real Redis) — the TTL assert
// pins the behaviour instead. Missing keys surface ErrLocationNotFound.
func TestLocationRoundtripAndTTL(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709000007")

	id, err := env.store.Apply(ctx, userID, "Pili", uuid.NewString(), "motorcycle")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	lat, lon := -6.792354, 39.208328
	if err := env.registry.Location(ctx, id, lat, lon); err != nil {
		t.Fatalf("store location: %v", err)
	}
	gotLat, gotLon, at, err := env.registry.GetLocation(ctx, id)
	if err != nil {
		t.Fatalf("get location: %v", err)
	}
	if diff := gotLat - lat; diff > 1e-6 || diff < -1e-6 {
		t.Fatalf("lat = %f, want %f", gotLat, lat)
	}
	if diff := gotLon - lon; diff > 1e-6 || diff < -1e-6 {
		t.Fatalf("lon = %f, want %f", gotLon, lon)
	}
	now := time.Now().UTC()
	if at.Before(now.Add(-time.Minute)) || at.After(now.Add(time.Minute)) {
		t.Fatalf("location timestamp = %v, want around now", at)
	}

	ttl, err := env.redis.Client().TTL(ctx, locationKey(id)).Result()
	if err != nil {
		t.Fatalf("location ttl: %v", err)
	}
	if ttl <= 0 || ttl > locationTTL {
		t.Fatalf("location ttl = %v, want 0 < ttl <= %v", ttl, locationTTL)
	}

	// A rider that never reported a position (or whose key expired) yields
	// ErrLocationNotFound.
	if _, _, _, err := env.registry.GetLocation(ctx, uuid.New()); !errors.Is(err, ErrLocationNotFound) {
		t.Fatalf("get location (never reported) err = %v, want ErrLocationNotFound", err)
	}
	if err := env.redis.Client().Del(ctx, locationKey(id)).Err(); err != nil {
		t.Fatalf("del location key: %v", err)
	}
	if _, _, _, err := env.registry.GetLocation(ctx, id); !errors.Is(err, ErrLocationNotFound) {
		t.Fatalf("get location (after delete) err = %v, want ErrLocationNotFound", err)
	}
}

// TestConcurrentApplyDifferentUsers: ten parallel applications for distinct
// users all succeed and land ten riders rows.
func TestConcurrentApplyDifferentUsers(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	const workers = 10

	userIDs := make([]uuid.UUID, workers)
	for i := 0; i < workers; i++ {
		userIDs[i] = insertUser(t, env, fmt.Sprintf("+2557090000%02d", i+10))
	}

	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i, uid := range userIDs {
		wg.Add(1)
		go func(i int, uid uuid.UUID) {
			defer wg.Done()
			_, err := env.store.Apply(ctx, uid, fmt.Sprintf("Rider %d", i), uuid.NewString(), "motorcycle")
			errs <- err
		}(i, uid)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent apply: %v", err)
		}
	}

	var n int64
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM riders`).Scan(&n); err != nil {
		t.Fatalf("count riders: %v", err)
	}
	if n != workers {
		t.Fatalf("riders rows = %d, want %d", n, workers)
	}
}

// TestConcurrentApplySameUserSingleWinner: ten parallel applications for the
// same user race on the unique constraint; exactly one wins and the rest get
// ErrAlreadyApplied.
func TestConcurrentApplySameUserSingleWinner(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709000020")
	const workers = 10

	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := env.store.Apply(ctx, userID, "Single", uuid.NewString(), "car")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)

	wins, dupes := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrAlreadyApplied):
			dupes++
		default:
			t.Fatalf("unexpected apply error: %v", err)
		}
	}
	if wins != 1 || dupes != workers-1 {
		t.Fatalf("winners = %d, already-applied = %d; want 1 and %d", wins, dupes, workers-1)
	}

	var n int64
	if err := env.pool.QueryRow(ctx,
		`SELECT count(*) FROM riders WHERE owner_user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatalf("count riders: %v", err)
	}
	if n != 1 {
		t.Fatalf("riders rows for user = %d, want 1", n)
	}
}
