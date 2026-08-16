// Dispatch auto-matching: the sweeper binds paid orders that outlived the
// merchant's 30s response window to the least-loaded online rider of the
// merchant's city. The online set lives in Redis only (riders:online,
// OnlineRegistry) — there is deliberately no DB fallback (DISPATCH_NO_RIDER
// semantics: no online rider means the order simply waits). Assignment is a
// guarded UPDATE (status='paid' AND rider_id IS NULL), so concurrent sweeper
// instances never double-assign; the loser of the race logs nothing and the
// next sweep re-checks.
package sweeper

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/riders"
	"github.com/hudumika/api-backend/internal/store"
)

const (
	// autoDispatchGrace is the window a merchant gets to act on a paid
	// order before the auto-assigner steps in.
	autoDispatchGrace = 30 * time.Second
	// autoAssignLimit caps the orders examined per sweep run.
	autoAssignLimit = 20
	// autoAssignNote is the order_events note recorded for every
	// auto-assigned order.
	autoAssignNote = "auto-dispatch"
)

// inFlightStatuses are the order statuses that count as a rider's current
// workload when picking the least-loaded candidate.
var inFlightStatuses = []string{"rider_assigned", "picked_up", "delivering"}

// assignableOrder is one paid, unassigned order plus its merchant's city
// (orders carry no city; the merchants join supplies it).
type assignableOrder struct {
	id         uuid.UUID
	merchantID uuid.UUID
	totalTZS   int64
	cityID     *uuid.UUID
}

// AutoAssignRiders matches assignable paid orders to riders: candidates are
// the online riders (Redis riders:online) of the merchant's city — any
// online rider when the merchant has no city — and the winner is the one
// with the fewest in-flight orders (rider_assigned/picked_up/delivering).
// It returns the number of orders assigned this run. Idempotent: the
// guarded UPDATE re-checks status and rider_id, so a second run assigns
// nothing new.
func (s *Sweeper) AutoAssignRiders(ctx context.Context) (assigned int, err error) {
	reg := s.onlineRegistry(ctx)
	if reg == nil {
		// The online set is Redis-only; without REDIS_URL there is
		// nothing to dispatch to (DISPATCH_NO_RIDER semantics).
		s.logger.Debug("sweeper: auto-assign skipped: REDIS_URL unset, online set is Redis-only")
		return 0, nil
	}
	online, err := reg.OnlineRiderIDs(ctx)
	if err != nil {
		return 0, fmt.Errorf("sweeper: auto-assign: list online riders: %w", err)
	}
	if len(online) == 0 {
		s.logger.Debug("sweeper: auto-assign: no riders online; orders wait")
		return 0, nil
	}

	cities, err := s.riderCities(ctx, online)
	if err != nil {
		return 0, err
	}
	orders, err := s.assignableOrders(ctx)
	if err != nil {
		return 0, err
	}

	for _, o := range orders {
		candidates := matchCity(o.cityID, cities)
		if len(candidates) == 0 {
			s.logger.Debug("sweeper: auto-assign: no online rider for order city; order waits",
				"orderId", o.id, "merchantId", o.merchantID)
			continue
		}
		riderID, err := s.leastLoadedRider(ctx, candidates)
		if err != nil {
			return 0, err
		}
		if riderID == uuid.Nil {
			continue
		}
		ok, err := s.assign(ctx, o.id, riderID)
		if err != nil {
			return 0, err
		}
		if ok {
			assigned++
		}
	}
	if assigned > 0 {
		s.logger.Info("sweeper: auto-assigned riders", "count", assigned)
	}
	return assigned, nil
}

// onlineRegistry returns the Redis-backed rider registry used by
// auto-assign, opening its own connection from REDIS_URL on first use (the
// sweeper predates the API server's store wiring, so it does not share that
// client). nil when REDIS_URL is unset or Redis is unreachable — the job
// then degrades to a no-op rather than failing the whole sweep.
func (s *Sweeper) onlineRegistry(ctx context.Context) *riders.OnlineRegistry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.registry != nil {
		return s.registry
	}
	url := os.Getenv("REDIS_URL")
	if url == "" {
		return nil
	}
	r, err := store.NewRedis(ctx, url)
	if err != nil {
		s.logger.Warn("sweeper: auto-assign: redis unavailable; skipping dispatch", "error", err)
		return nil
	}
	s.registry = riders.NewOnlineRegistry(r)
	return s.registry
}

// assignableOrders returns paid orders that have waited out the merchant's
// dispatch window and are still rider-less, oldest first, capped per run.
// The merchants LEFT JOIN supplies the order's city (orders have none); a
// missing or city-less merchant falls back to ANY online rider in
// matchCity.
func (s *Sweeper) assignableOrders(ctx context.Context) ([]assignableOrder, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT o.id, o.merchant_id, o.total_tzs, m.city_id
		 FROM orders o
		 LEFT JOIN merchants m ON m.id = o.merchant_id
		 WHERE o.status = 'paid' AND o.rider_id IS NULL
		   AND o.created_at < now() - interval '30 seconds'
		 ORDER BY o.created_at, o.id
		 LIMIT $1`, autoAssignLimit)
	if err != nil {
		return nil, fmt.Errorf("sweeper: auto-assign: list assignable orders: %w", err)
	}
	defer rows.Close()

	out := make([]assignableOrder, 0, autoAssignLimit)
	for rows.Next() {
		var o assignableOrder
		if err := rows.Scan(&o.id, &o.merchantID, &o.totalTZS, &o.cityID); err != nil {
			return nil, fmt.Errorf("sweeper: auto-assign: scan assignable order: %w", err)
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sweeper: auto-assign: iterate assignable orders: %w", err)
	}
	return out, nil
}

// riderCities loads the city of every online rider id in one query; riders
// without a row are simply absent from the map and never match a city.
func (s *Sweeper) riderCities(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]*uuid.UUID, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, city_id FROM riders WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("sweeper: auto-assign: list rider cities: %w", err)
	}
	defer rows.Close()

	out := make(map[uuid.UUID]*uuid.UUID, len(ids))
	for rows.Next() {
		var (
			id   uuid.UUID
			city *uuid.UUID
		)
		if err := rows.Scan(&id, &city); err != nil {
			return nil, fmt.Errorf("sweeper: auto-assign: scan rider city: %w", err)
		}
		out[id] = city
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sweeper: auto-assign: iterate rider cities: %w", err)
	}
	return out, nil
}

// matchCity keeps the riders whose city matches the merchant's. A merchant
// without a city (NULL city_id, or no merchants row at all) falls back to
// ANY online rider — documented deviation: dispatch stays possible for
// city-less merchants.
func matchCity(merchantCity *uuid.UUID, cities map[uuid.UUID]*uuid.UUID) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(cities))
	for id, city := range cities {
		if merchantCity == nil || (city != nil && *city == *merchantCity) {
			out = append(out, id)
		}
	}
	return out
}

// leastLoadedRider returns the candidate with the fewest in-flight orders;
// candidates with none (absent from the GROUP BY) beat any busy rider.
// Equal loads resolve deterministically by rider id.
func (s *Sweeper) leastLoadedRider(ctx context.Context, candidates []uuid.UUID) (uuid.UUID, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT rider_id, count(*) FROM orders
		 WHERE rider_id = ANY($1) AND status = ANY($2)
		 GROUP BY rider_id ORDER BY count(*), rider_id`,
		candidates, inFlightStatuses)
	if err != nil {
		return uuid.Nil, fmt.Errorf("sweeper: auto-assign: load counts: %w", err)
	}
	defer rows.Close()

	loads := make(map[uuid.UUID]int, len(candidates))
	for rows.Next() {
		var (
			riderID uuid.UUID
			n       int
		)
		if err := rows.Scan(&riderID, &n); err != nil {
			return uuid.Nil, fmt.Errorf("sweeper: auto-assign: scan load count: %w", err)
		}
		loads[riderID] = n
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, fmt.Errorf("sweeper: auto-assign: iterate load counts: %w", err)
	}

	best := uuid.Nil
	bestLoad := int(^uint(0) >> 1)
	for _, id := range candidates {
		if n := loads[id]; n < bestLoad {
			best, bestLoad = id, n
		}
	}
	return best, nil
}

// assign binds the rider to the order via a guarded UPDATE (0 rows means
// another instance already assigned it — ORDER_STATUS_CONFLICT semantics —
// and the caller simply moves on) and appends the 'rider_assigned'
// auto-dispatch event in the same transaction.
func (s *Sweeper) assign(ctx context.Context, orderID, riderID uuid.UUID) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("sweeper: auto-assign: begin tx for %s: %w", orderID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE orders SET rider_id = $1, updated_at = now()
		 WHERE id = $2 AND status = 'paid' AND rider_id IS NULL`,
		riderID, orderID)
	if err != nil {
		return false, fmt.Errorf("sweeper: auto-assign: update order %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, note) VALUES ($1, 'rider_assigned', $2)`,
		orderID, autoAssignNote); err != nil {
		return false, fmt.Errorf("sweeper: auto-assign: append event for %s: %w", orderID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("sweeper: auto-assign: commit %s: %w", orderID, err)
	}
	return true, nil
}
