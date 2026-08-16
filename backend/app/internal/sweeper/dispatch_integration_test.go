//go:build integration

// Integration tests for the auto-dispatch job (AutoAssignRiders). They
// require a reachable database (DATABASE_URL) and, for the Redis-dependent
// tests, a reachable Redis (REDIS_URL) — the online set is Redis-only.
// No docker is involved. Only rows created by these tests are touched:
// every insert is tracked and deleted in cleanup, and only this test's own
// rider ids are removed from the shared riders:online set — nothing is
// truncated.
package sweeper

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/store"
)

// testOnlineSetKey mirrors the riders package's riders:online key so this
// test can seed and clean the set without exporting it.
const testOnlineSetKey = "riders:online"

// newPoolSweeper builds a Sweeper over the fixture pool with a quiet
// logger; used by the dispatch and settlement integration tests.
func newPoolSweeper(pool *pgxpool.Pool) *Sweeper {
	return New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Second)
}

// dispatchFixture owns the pool, the Redis client and every row a dispatch
// test inserted, so cleanup deletes exactly those rows and nothing else.
type dispatchFixture struct {
	pool        *pgxpool.Pool
	redis       *store.Redis
	users       []uuid.UUID
	merchants   []uuid.UUID
	riders      []uuid.UUID
	cities      []uuid.UUID
	orders      []uuid.UUID
	settlements []uuid.UUID
	exports     []uuid.UUID
}

func setupDispatch(t *testing.T) *dispatchFixture {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL not set; skipping sweeper dispatch integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	f := &dispatchFixture{pool: pool}
	if url := os.Getenv("REDIS_URL"); url != "" {
		r, err := store.NewRedis(ctx, url)
		if err != nil {
			t.Fatalf("connect redis: %v", err)
		}
		f.redis = r
	}
	t.Cleanup(func() {
		if f.redis != nil {
			for _, id := range f.riders {
				if err := f.redis.Client().ZRem(ctx, testOnlineSetKey, id.String()).Err(); err != nil {
					t.Errorf("cleanup online member %s: %v", id, err)
				}
			}
			f.redis.Close()
		}
		for _, id := range f.exports {
			if _, err := pool.Exec(ctx, `DELETE FROM data_exports WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup export %s: %v", id, err)
			}
		}
		for _, id := range f.settlements {
			if _, err := pool.Exec(ctx, `DELETE FROM daily_settlements WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup settlement %s: %v", id, err)
			}
		}
		// order_events rows cascade away with their order.
		for _, id := range f.orders {
			if _, err := pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup order %s: %v", id, err)
			}
		}
		for _, id := range f.riders {
			if _, err := pool.Exec(ctx, `DELETE FROM riders WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup rider %s: %v", id, err)
			}
		}
		for _, id := range f.cities {
			if _, err := pool.Exec(ctx, `DELETE FROM cities WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup city %s: %v", id, err)
			}
		}
		for _, id := range f.merchants {
			if _, err := pool.Exec(ctx, `DELETE FROM merchants WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup merchant %s: %v", id, err)
			}
		}
		for _, id := range f.users {
			if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup user %s: %v", id, err)
			}
		}
		pool.Close()
	})
	return f
}

func (f *dispatchFixture) newUser(t *testing.T) uuid.UUID {
	t.Helper()
	phone := fmt.Sprintf("+25589%09d%s", time.Now().UnixNano()%1_000_000_000, uuid.NewString()[:4])
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("create user: %v", err)
	}
	f.users = append(f.users, id)
	return id
}

// newCity creates a city row (the merchants/riders city_id FK target).
func (f *dispatchFixture) newCity(t *testing.T) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO cities (name) VALUES ($1) RETURNING id`,
		"sweeper-dispatch-city-"+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatalf("create city: %v", err)
	}
	f.cities = append(f.cities, id)
	return id
}

func (f *dispatchFixture) newMerchant(t *testing.T, owner uuid.UUID, city *uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name, city_id)
		 VALUES ($1, $2, $3) RETURNING id`,
		owner, "sweeper-dispatch-merchant-"+uuid.NewString()[:8], city).Scan(&id); err != nil {
		t.Fatalf("create merchant: %v", err)
	}
	f.merchants = append(f.merchants, id)
	return id
}

func (f *dispatchFixture) newRider(t *testing.T, owner uuid.UUID, city *uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, vehicle, city_id)
		 VALUES ($1, $2, 'motorcycle', $3) RETURNING id`,
		owner, "sweeper-dispatch-rider-"+uuid.NewString()[:8], city).Scan(&id); err != nil {
		t.Fatalf("create rider: %v", err)
	}
	f.riders = append(f.riders, id)
	return id
}

// goOnline adds the rider to the shared Redis online set.
func (f *dispatchFixture) goOnline(t *testing.T, riderID uuid.UUID) {
	t.Helper()
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping online-set seeding")
	}
	if err := f.redis.Client().ZAdd(context.Background(), testOnlineSetKey,
		redis.Z{Score: float64(time.Now().Unix()), Member: riderID.String()}).Err(); err != nil {
		t.Fatalf("seed online rider %s: %v", riderID, err)
	}
}

// newPaidOrder inserts a paid, rider-less order at the given created_at.
func (f *dispatchFixture) newPaidOrder(t *testing.T, customerID, merchantID uuid.UUID, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs, created_at)
		 VALUES ($1, $2, 'paid', 10000, $3) RETURNING id`,
		customerID, merchantID, createdAt).Scan(&id); err != nil {
		t.Fatalf("insert paid order: %v", err)
	}
	f.orders = append(f.orders, id)
	return id
}

// bindRider assigns the rider to the order directly, as if a previous
// assignment had won (used to model already-assigned orders).
func (f *dispatchFixture) bindRider(t *testing.T, orderID, riderID uuid.UUID) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE orders SET rider_id = $1 WHERE id = $2`, riderID, orderID); err != nil {
		t.Fatalf("bind rider to order: %v", err)
	}
}

func (f *dispatchFixture) newInFlightOrder(t *testing.T, customerID, merchantID uuid.UUID, riderID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs, rider_id)
		 VALUES ($1, $2, 'rider_assigned', 10000, $3) RETURNING id`,
		customerID, merchantID, riderID).Scan(&id); err != nil {
		t.Fatalf("insert in-flight order: %v", err)
	}
	f.orders = append(f.orders, id)
	return id
}

func orderRider(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) *uuid.UUID {
	t.Helper()
	var riderID *uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT rider_id FROM orders WHERE id = $1`, orderID).Scan(&riderID); err != nil {
		t.Fatalf("read order %s rider_id: %v", orderID, err)
	}
	return riderID
}

func orderStatus(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM orders WHERE id = $1`, orderID).Scan(&status); err != nil {
		t.Fatalf("read order %s status: %v", orderID, err)
	}
	return status
}

func countAutoDispatchEvents(t *testing.T, pool *pgxpool.Pool, orderID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM order_events
		 WHERE order_id = $1 AND status = 'rider_assigned' AND note = 'auto-dispatch'`, orderID).Scan(&n); err != nil {
		t.Fatalf("count auto-dispatch events for %s: %v", orderID, err)
	}
	return n
}

// TestAutoAssignRidersPicksLeastLoadedSameCityRider: a paid order that has
// waited out the merchant window is bound to the online rider of the same
// city with the fewest in-flight orders; the busy rider and the
// wrong-city rider are passed over; status stays 'paid' and exactly one
// 'rider_assigned' auto-dispatch event is appended (by NULL).
func TestAutoAssignRidersPicksLeastLoadedSameCityRider(t *testing.T) {
	f := setupDispatch(t)
	ctx := context.Background()
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping Redis-dependent dispatch test")
	}
	s := newPoolSweeper(f.pool)

	cityA := f.newCity(t)
	cityB := f.newCity(t)
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t), &cityA)

	idleRider := f.newRider(t, f.newUser(t), &cityA)
	busyRider := f.newRider(t, f.newUser(t), &cityA)
	otherCityRider := f.newRider(t, f.newUser(t), &cityB)
	for _, r := range []uuid.UUID{idleRider, busyRider, otherCityRider} {
		f.goOnline(t, r)
	}
	// The busy rider already carries one in-flight order.
	f.newInFlightOrder(t, f.newUser(t), merchant, busyRider)

	order := f.newPaidOrder(t, customer, merchant, time.Now().Add(-5*time.Minute))

	n, err := s.AutoAssignRiders(ctx)
	if err != nil {
		t.Fatalf("auto assign: %v", err)
	}
	if n != 1 {
		t.Fatalf("assigned = %d, want 1", n)
	}
	if got := orderRider(t, f.pool, order); got == nil || *got != idleRider {
		t.Fatalf("order rider = %v, want %s (least loaded)", got, idleRider)
	}
	if got := orderStatus(t, f.pool, order); got != "paid" {
		t.Errorf("order status = %q, want paid (assignment does not transition)", got)
	}
	if n := countAutoDispatchEvents(t, f.pool, order); n != 1 {
		t.Errorf("auto-dispatch events = %d, want 1", n)
	}
	var by *uuid.UUID
	if err := f.pool.QueryRow(ctx,
		`SELECT by FROM order_events WHERE order_id = $1 AND status = 'rider_assigned'`, order).Scan(&by); err != nil {
		t.Fatalf("read event by: %v", err)
	}
	if by != nil {
		t.Errorf("auto-dispatch event by = %v, want NULL (system)", by)
	}
}

// TestAutoAssignRidersSkipsOfflineRiders: with no online riders the job
// assigns nothing (DISPATCH_NO_RIDER semantics) and leaves the order alone.
func TestAutoAssignRidersSkipsOfflineRiders(t *testing.T) {
	f := setupDispatch(t)
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping Redis-dependent dispatch test")
	}
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	city := f.newCity(t)
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t), &city)
	// Rider exists but never went online.
	f.newRider(t, f.newUser(t), &city)
	order := f.newPaidOrder(t, customer, merchant, time.Now().Add(-5*time.Minute))

	n, err := s.AutoAssignRiders(ctx)
	if err != nil {
		t.Fatalf("auto assign: %v", err)
	}
	if n != 0 {
		t.Fatalf("assigned = %d, want 0", n)
	}
	if got := orderRider(t, f.pool, order); got != nil {
		t.Errorf("order rider = %v, want NULL", got)
	}
}

// TestAutoAssignRidersSkipsFreshOrders: orders inside the merchant's 30s
// dispatch window are left alone.
func TestAutoAssignRidersSkipsFreshOrders(t *testing.T) {
	f := setupDispatch(t)
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping Redis-dependent dispatch test")
	}
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	city := f.newCity(t)
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t), &city)
	rider := f.newRider(t, f.newUser(t), &city)
	f.goOnline(t, rider)

	fresh := f.newPaidOrder(t, customer, merchant, time.Now().Add(-10*time.Second))
	old := f.newPaidOrder(t, customer, merchant, time.Now().Add(-5*time.Minute))

	n, err := s.AutoAssignRiders(ctx)
	if err != nil {
		t.Fatalf("auto assign: %v", err)
	}
	if n != 1 {
		t.Fatalf("assigned = %d, want 1", n)
	}
	if got := orderRider(t, f.pool, fresh); got != nil {
		t.Errorf("fresh order rider = %v, want NULL (inside merchant window)", got)
	}
	if got := orderRider(t, f.pool, old); got == nil || *got != rider {
		t.Errorf("old order rider = %v, want %s", got, rider)
	}
}

// TestAutoAssignRidersSkipsAlreadyAssigned: an order that already has a
// rider is untouched and gains no event.
func TestAutoAssignRidersSkipsAlreadyAssigned(t *testing.T) {
	f := setupDispatch(t)
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping Redis-dependent dispatch test")
	}
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	city := f.newCity(t)
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t), &city)
	rider := f.newRider(t, f.newUser(t), &city)
	f.goOnline(t, rider)

	order := f.newPaidOrder(t, customer, merchant, time.Now().Add(-5*time.Minute))
	f.bindRider(t, order, rider)

	n, err := s.AutoAssignRiders(ctx)
	if err != nil {
		t.Fatalf("auto assign: %v", err)
	}
	if n != 0 {
		t.Fatalf("assigned = %d, want 0", n)
	}
	if got := orderRider(t, f.pool, order); got == nil || *got != rider {
		t.Errorf("order rider = %v, want %s (untouched)", got, rider)
	}
	if n := countAutoDispatchEvents(t, f.pool, order); n != 0 {
		t.Errorf("auto-dispatch events = %d, want 0", n)
	}
}

// TestAutoAssignRidersFallsBackToAnyRiderWhenMerchantHasNoCity: a merchant
// without a city matches ANY online rider.
func TestAutoAssignRidersFallsBackToAnyRiderWhenMerchantHasNoCity(t *testing.T) {
	f := setupDispatch(t)
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping Redis-dependent dispatch test")
	}
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t), nil)
	otherCity := f.newCity(t)
	rider := f.newRider(t, f.newUser(t), &otherCity)
	f.goOnline(t, rider)

	order := f.newPaidOrder(t, customer, merchant, time.Now().Add(-5*time.Minute))

	n, err := s.AutoAssignRiders(ctx)
	if err != nil {
		t.Fatalf("auto assign: %v", err)
	}
	if n != 1 {
		t.Fatalf("assigned = %d, want 1", n)
	}
	if got := orderRider(t, f.pool, order); got == nil || *got != rider {
		t.Errorf("order rider = %v, want %s (any-city fallback)", got, rider)
	}
}

// TestAutoAssignRidersIdempotent: a second run assigns nothing new and
// appends no duplicate event.
func TestAutoAssignRidersIdempotent(t *testing.T) {
	f := setupDispatch(t)
	if f.redis == nil {
		t.Skip("REDIS_URL not set; skipping Redis-dependent dispatch test")
	}
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	city := f.newCity(t)
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t), &city)
	rider := f.newRider(t, f.newUser(t), &city)
	f.goOnline(t, rider)
	order := f.newPaidOrder(t, customer, merchant, time.Now().Add(-5*time.Minute))

	if n, err := s.AutoAssignRiders(ctx); err != nil || n != 1 {
		t.Fatalf("first run: n=%d err=%v, want 1 nil", n, err)
	}
	if n, err := s.AutoAssignRiders(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
	if n := countAutoDispatchEvents(t, f.pool, order); n != 1 {
		t.Errorf("auto-dispatch events = %d after two runs, want 1", n)
	}
}
