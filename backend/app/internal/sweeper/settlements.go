// Sweeper settlements: every calendar day the sweeper folds the previous
// day's paid orders into a draft daily_settlement per merchant, and marks
// queued data_exports completed. Both jobs are idempotent: settlements use
// ON CONFLICT (merchant_id, cycle_date) DO NOTHING, exports use a guarded
// status WHERE, so a second run never duplicates work.
package sweeper

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// RunDailySettlements aggregates yesterday's paid orders by merchant and
// inserts one draft daily_settlements row per merchant. Rows already
// present for the (merchant, cycle_date) pair are skipped (0 rows affected)
// — the job is a no-op on re-runs. Returns the number of settlements
// created. cycle_date is yesterday in UTC.
func (s *Sweeper) RunDailySettlements(ctx context.Context) (int, error) {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	yesterday := today.AddDate(0, 0, -1)

	rows, err := s.pool.Query(ctx,
		`SELECT merchant_id, SUM(total_tzs)::bigint, COUNT(*)
		 FROM orders
		 WHERE status = 'paid' AND created_at >= $1 AND created_at < $2
		 GROUP BY merchant_id`,
		yesterday, today)
	if err != nil {
		return 0, fmt.Errorf("sweeper: settlements: aggregate paid orders: %w", err)
	}
	defer rows.Close()

	var merchants []struct {
		id    uuid.UUID
		total int64
		count int
	}
	for rows.Next() {
		var (
			id    uuid.UUID
			total int64
			count int
		)
		if err := rows.Scan(&id, &total, &count); err != nil {
			return 0, fmt.Errorf("sweeper: settlements: scan paid order aggregate: %w", err)
		}
		merchants = append(merchants, struct {
			id    uuid.UUID
			total int64
			count int
		}{id: id, total: total, count: count})
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("sweeper: settlements: iterate paid order aggregates: %w", err)
	}

	inserted := 0
	for _, m := range merchants {
		tag, err := s.pool.Exec(ctx,
			`INSERT INTO daily_settlements (merchant_id, cycle_date, total_tzs, count, status)
			 VALUES ($1, $2, $3, $4, 'draft')
			 ON CONFLICT (merchant_id, cycle_date) DO NOTHING`,
			m.id, yesterday, m.total, m.count)
		if err != nil {
			return 0, fmt.Errorf("sweeper: settlements: insert draft for merchant %s: %w", m.id, err)
		}
		if tag.RowsAffected() > 0 {
			inserted++
		}
	}
	if inserted > 0 {
		s.logger.Info("sweeper: created draft settlements", "count", inserted)
	}
	return inserted, nil
}

// ExportQueuedJobs marks queued data_exports rows completed. There is no
// artifact store yet, so file_url is left NULL — the honest state is "done,
// no file" (documented in migrations/00032; the future export worker will
// fill file_url, rows and expires_at). The guarded WHERE makes the job
// idempotent: a second run finds nothing queued.
func (s *Sweeper) ExportQueuedJobs(ctx context.Context) (int, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE data_exports SET status = 'completed', completed_at = now()
		 WHERE status = 'queued'`)
	if err != nil {
		return 0, fmt.Errorf("sweeper: exports: complete queued jobs: %w", err)
	}
	if n := tag.RowsAffected(); n > 0 {
		s.logger.Info("sweeper: completed queued data exports", "count", n)
	}
	return int(tag.RowsAffected()), nil
}
