// Package sweeper runs the server-side periodic jobs that keep time-based
// state consistent: it auto-cancels orders whose acceptance deadline
// (deadline_at, set by a rush request) passed, expires group-buy
// vouchers whose validity window closed, reminds customers of due
// pre-orders, ticks promotion/deal statuses, renews closure-protection
// plans and runs the dispatch/settlement/export jobs (dispatch.go,
// settlements.go, expansion.go). Every job is idempotent — its
// guarded WHERE clause means a crash mid-run is healed by the next tick —
// and one failing job never blocks the others.
package sweeper

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/metrics"
	"github.com/hudumika/api-backend/internal/riders"
)

const (
	// defaultInterval is the sweep cadence when New is given none.
	defaultInterval = 30 * time.Second
	// eventBatch caps the number of order_events rows appended per
	// statement, so one huge sweep never builds a giant insert.
	eventBatch = 500
	// autoCancelNote is the event note recorded for every order the
	// sweeper cancels (ERROR-CODES.md: ORDER_AUTO_CANCELLED).
	autoCancelNote = "auto-cancelled: acceptance deadline passed"
)

// Sweeper owns the periodic jobs. It is safe for concurrent use; jobs are
// serialized within one sweep cycle.
type Sweeper struct {
	pool     *pgxpool.Pool
	logger   *slog.Logger
	interval time.Duration

	// mu guards the lazily-built auto-assign registry (dispatch.go); jobs
	// are serialized within a sweep cycle, but RunOnce may be driven from
	// several goroutines in tests.
	mu       sync.Mutex
	registry *riders.OnlineRegistry
}

// New returns a Sweeper bound to the given pool, sweeping every interval.
func New(pool *pgxpool.Pool, logger *slog.Logger, interval time.Duration) *Sweeper {
	return &Sweeper{pool: pool, logger: logger, interval: interval}
}

// Run executes a full sweep immediately, then one every interval, until ctx
// is cancelled. It blocks; run it in a goroutine. A failing job is logged
// and never stops the other jobs or the loop.
func (s *Sweeper) Run(ctx context.Context) {
	if s.interval <= 0 {
		s.interval = defaultInterval
	}
	s.runAll(ctx)
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.logger.Info("sweeper stopped")
			return
		case <-ticker.C:
			s.runAll(ctx)
		}
	}
}

// RunOnce executes a single sweep cycle. Exposed for tests.
func (s *Sweeper) RunOnce(ctx context.Context) error {
	return s.runAll(ctx)
}

// runAll runs every job in order; each job is isolated with its own error
// logging, so one failing job never blocks the others.
func (s *Sweeper) runAll(ctx context.Context) error {
	jobs := []struct {
		name string
		run  func(context.Context) error
	}{
		{"auto-cancel-stale-orders", s.autoCancelStaleOrders},
		{"report-stale-orders", func(ctx context.Context) error {
			n, err := s.CountStaleOrders(ctx)
			if err != nil {
				return err
			}
			metrics.Set("orders_stale", n)
			return nil
		}},
		{"expire-vouchers", s.expireVouchers},
		{"auto-assign-riders", func(ctx context.Context) error {
			_, err := s.AutoAssignRiders(ctx)
			return err
		}},
		{"run-daily-settlements", func(ctx context.Context) error {
			_, err := s.RunDailySettlements(ctx)
			return err
		}},
		{"export-queued-jobs", func(ctx context.Context) error {
			_, err := s.ExportQueuedJobs(ctx)
			return err
		}},
		{"pre-order-reminders", func(ctx context.Context) error {
			_, err := s.SendPreOrderReminders(ctx)
			return err
		}},
		{"tick-promotions", func(ctx context.Context) error {
			_, err := s.TickPromotions(ctx)
			return err
		}},
		{"expire-closure-protection", func(ctx context.Context) error {
			_, err := s.ExpireClosureProtection(ctx)
			return err
		}},
		{"reopen-scheduled-stores", func(ctx context.Context) error {
			_, err := s.ReopenScheduledStores(ctx)
			return err
		}},
	}
	var firstErr error
	for _, job := range jobs {
		if err := job.run(ctx); err != nil {
			s.logger.Error("sweeper job failed", "job", job.name, "error", err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// autoCancelStaleOrders cancels draft/pending_payment/paid orders whose
// acceptance deadline passed and appends a 'cancelled' event (by NULL, note
// autoCancelNote) for each, all in one transaction. The guarded WHERE makes
// the job idempotent: a second run finds nothing to cancel, so no event is
// ever appended twice. The returned ids are looped over in batches.
func (s *Sweeper) autoCancelStaleOrders(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("sweeper: begin auto-cancel tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`UPDATE orders SET status = 'cancelled', cancelled_at = now(), updated_at = now()
		 WHERE status IN ('draft', 'pending_payment', 'paid')
		   AND deadline_at IS NOT NULL
		   AND deadline_at < now()
		 RETURNING id, customer_user_id, merchant_id`)
	if err != nil {
		return fmt.Errorf("sweeper: auto-cancel stale orders: %w", err)
	}
	ids := make([]uuid.UUID, 0, 16)
	for rows.Next() {
		var (
			id       uuid.UUID
			customer *uuid.UUID
			merchant uuid.UUID
		)
		if err := rows.Scan(&id, &customer, &merchant); err != nil {
			rows.Close()
			return fmt.Errorf("sweeper: scan auto-cancelled order: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sweeper: iterate auto-cancelled orders: %w", err)
	}

	for _, batch := range batchIDs(ids, eventBatch) {
		if _, err := tx.Exec(ctx,
			`INSERT INTO order_events (order_id, status, note)
			 SELECT t.id, 'cancelled', $2 FROM unnest($1::uuid[]) AS t(id)`,
			batch, autoCancelNote); err != nil {
			return fmt.Errorf("sweeper: append auto-cancel events: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("sweeper: commit auto-cancel: %w", err)
	}
	if len(ids) > 0 {
		s.logger.Info("sweeper: auto-cancelled stale orders", "count", len(ids))
	}
	return nil
}

// CountStaleOrders returns the number of orders the auto-cancel job would
// cancel: draft/pending_payment/paid orders whose acceptance deadline passed.
// It mirrors the autoCancelStaleOrders guard exactly, so the queue_depth
// gauge (queue "orders_stale") reports the next cycle's candidate count.
func (s *Sweeper) CountStaleOrders(ctx context.Context) (int64, error) {
	var n int64
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*)
		 FROM orders
		 WHERE status IN ('draft', 'pending_payment', 'paid')
		   AND deadline_at IS NOT NULL
		   AND deadline_at < now()`).Scan(&n); err != nil {
		return 0, fmt.Errorf("sweeper: count stale orders: %w", err)
	}
	return n, nil
}

// expireVouchers flips active vouchers whose expiry passed to 'expired'
// (ERROR-CODES.md: VOUCHER_EXPIRED). The guarded WHERE makes it idempotent.
func (s *Sweeper) expireVouchers(ctx context.Context) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE vouchers SET status = 'expired'
		 WHERE status = 'active' AND expires_at < now()`)
	if err != nil {
		return fmt.Errorf("sweeper: expire vouchers: %w", err)
	}
	if count := tag.RowsAffected(); count > 0 {
		s.logger.Info("sweeper: expired vouchers", "count", count)
	}
	return nil
}

// batchIDs splits ids into chunks of at most size, falling back to
// eventBatch when size is not positive.
func batchIDs(ids []uuid.UUID, size int) [][]uuid.UUID {
	if size <= 0 {
		size = eventBatch
	}
	batches := make([][]uuid.UUID, 0, (len(ids)+size-1)/size)
	for i := 0; i < len(ids); i += size {
		end := i + size
		if end > len(ids) {
			end = len(ids)
		}
		batches = append(batches, ids[i:end])
	}
	return batches
}
