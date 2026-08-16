// Expansion jobs: pre-order reminders, promotion and group-buy campaign
// ticks, closure-protection renewal and the scheduled store reopen
// (ReopenScheduledStores — a sweeper-side marker convention in
// store_settings.opening_hours, see reopenStoresBySchedule). Every job
// follows the package pattern: a guarded, idempotent WHERE clause so a
// crash mid-run is healed by the next tick, parameterized SQL, wrapped
// errors, and isolation from the other jobs inside runAll.
package sweeper

import (
	"context"
	"fmt"
)

const (
	// reminderType is the notifications.type written by the pre-order
	// reminder job.
	reminderType = "pre_order_reminder"
	// reminderTitle and reminderBodyPrefix form the reminder text. The
	// order id is appended to the body (notifications has no payload
	// column yet), so the dedup guard below can find the marker again.
	reminderTitle      = "Your order is coming up"
	reminderBodyPrefix = "Reminder: your pre-order is scheduled within 2 hours. Order "

	// scheduledReopenMarker is the jsonb key the scheduled-reopen job
	// reads from store_settings.opening_hours. A merchant (or ops)
	// schedules a reopen by storing {"scheduled_reopen": "<RFC3339>"}.
	// It is a sweeper-side convention only: the merchant app never sets
	// it, and the PATCH /merchants/me/settings upsert REPLACES
	// opening_hours wholesale, so a merchant editing business hours
	// wipes a pending marker — ops must re-set it after hours edits.
	scheduledReopenMarker = "scheduled_reopen"

	// scheduledReopenPattern is the RFC3339 shape accepted for the
	// marker: seconds with optional fractional digits, a Z or ±HH:MM
	// offset, and nothing else. The pattern gates the ::timestamptz
	// cast in the reopen query, so a malformed marker value can never
	// fail the job — it simply never becomes due.
	scheduledReopenPattern = `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$`
)

// SendPreOrderReminders inserts one in-app reminder per customer for
// pre-scheduled (advance) orders whose slot is within the next two hours
// and that are confirmed (paid / merchant_accepted). Delivery is
// best-effort: a single guarded INSERT ... SELECT either inserts all due
// reminders or fails this job only — runAll isolates the failure. The
// job is idempotent because an existing reminder row (type
// pre_order_reminder, order id embedded in the body) makes NOT EXISTS
// fail, so a second run sends nothing twice. Orders without a customer
// are skipped. Returns the number of reminders inserted.
func (s *Sweeper) SendPreOrderReminders(ctx context.Context) (sent int, err error) {
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO notifications (user_id, type, title, body)
		 SELECT o.customer_user_id, 'pre_order_reminder', $1, $2 || o.id::text
		 FROM orders o
		 WHERE o.scheduled_at BETWEEN now() AND now() + interval '2 hours'
		   AND o.status IN ('paid', 'merchant_accepted')
		   AND o.customer_user_id IS NOT NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM notifications n
		     WHERE n.user_id = o.customer_user_id
		       AND n.type = 'pre_order_reminder'
		       AND n.body LIKE '%' || o.id::text || '%'
		   )`,
		reminderTitle, reminderBodyPrefix)
	if err != nil {
		return 0, fmt.Errorf("sweeper: pre-order reminders: %w", err)
	}
	sent = int(tag.RowsAffected())
	if sent > 0 {
		s.logger.Info("sweeper: sent pre-order reminders", "count", sent)
	}
	return sent, nil
}

// TickPromotions advances time-gated campaign statuses (DATA-MODEL.md
// sweeper #5, campaign ticks): draft promotions whose starts_at passed go
// live, live promotions whose ends_at passed are ended, and group-buy
// deals still active past end_at are ended (the 00014 enum allows
// 'ended'). Paused promotions are deliberately untouched — only a human
// resumes a paused campaign. Note the storage enums: promotions (00015)
// store the contract's "active" state as 'live'; group_buy_deals (00014)
// do store 'active'. Every transition is guarded by the current status,
// so a second run transitions nothing. Returns the total rows
// transitioned.
func (s *Sweeper) TickPromotions(ctx context.Context) (changed int, err error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE promotions SET status = 'live', updated_at = now()
		 WHERE status = 'draft' AND starts_at <= now()`)
	if err != nil {
		return 0, fmt.Errorf("sweeper: promotions: activate due drafts: %w", err)
	}
	changed += int(tag.RowsAffected())

	tag, err = s.pool.Exec(ctx,
		`UPDATE promotions SET status = 'ended', updated_at = now()
		 WHERE status = 'live' AND ends_at <= now()`)
	if err != nil {
		return 0, fmt.Errorf("sweeper: promotions: end expired live promotions: %w", err)
	}
	changed += int(tag.RowsAffected())

	tag, err = s.pool.Exec(ctx,
		`UPDATE group_buy_deals SET status = 'ended', updated_at = now()
		 WHERE status = 'active' AND end_at <= now()`)
	if err != nil {
		return 0, fmt.Errorf("sweeper: promotions: end expired deals: %w", err)
	}
	changed += int(tag.RowsAffected())

	if changed > 0 {
		s.logger.Info("sweeper: ticked promotions and deals", "count", changed)
	}
	return changed, nil
}

// ExpireClosureProtection renews closure-protection plans (00045) whose
// renewal date arrived: the used-closures counter resets to zero and the
// renewal date advances 365 days, giving the merchant a fresh annual
// quota. The guarded WHERE makes the job idempotent — a second run finds
// nothing due. Rows without a renewal_date are never matched. Returns the
// number of plans renewed.
func (s *Sweeper) ExpireClosureProtection(ctx context.Context) (renewed int, err error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE closure_protection
		 SET used_closures = 0,
		     renewal_date = renewal_date + interval '365 days',
		     updated_at = now()
		 WHERE renewal_date <= now()`)
	if err != nil {
		return 0, fmt.Errorf("sweeper: closure protection renewal: %w", err)
	}
	renewed = int(tag.RowsAffected())
	if renewed > 0 {
		s.logger.Info("sweeper: renewed closure protection plans", "count", renewed)
	}
	return renewed, nil
}

// ReopenScheduledStores is the DATA-MODEL.md sweeper #10 "scheduled
// reopen" job, previously a documented no-op. The no-op stood because no
// schema marker existed; the job is now implemented on the documented
// sweeper-side marker convention described in reopenStoresBySchedule.
func (s *Sweeper) ReopenScheduledStores(ctx context.Context) (reopened int, err error) {
	return s.reopenStoresBySchedule(ctx)
}

// reopenStoresBySchedule reopens chain stores whose merchant scheduled a
// reopen. The schedule lives in store_settings.opening_hours (00045) as
// the marker {"scheduled_reopen": "<RFC3339>"} (scheduledReopenMarker) —
// a sweeper-side convention only, never written by the merchant API: the
// PATCH /merchants/me/settings upsert replaces opening_hours wholesale,
// so ops/scripts must re-set the marker after any hours edit, and the
// merchant app must not touch the key.
//
// A merchant is due when the marker time has passed AND at least one of
// its chain_stores rows (00022) is inactive (active = false — the state a
// bulk closure or the store toggle writes). Due merchants get every
// inactive chain store flipped back to active and the marker removed, all
// in one statement: a crash mid-run can never leave stores reopened with
// the marker intact (a later run would reopen nothing and the marker
// would linger) or stores closed with the marker gone, and a second run
// finds nothing due. A merchant whose stores are already active keeps its
// marker until it expires by its own time — the job never clears a marker
// for a merchant with no inactive stores, and a malformed marker value
// (scheduledReopenPattern gates the cast) is skipped, never an error.
// Returns the number of chain stores reopened.
func (s *Sweeper) reopenStoresBySchedule(ctx context.Context) (reopened int, err error) {
	var cleared int
	err = s.pool.QueryRow(ctx,
		`WITH due AS (
			SELECT ss.merchant_id
			FROM store_settings ss
			WHERE ss.opening_hours ? 'scheduled_reopen'
			  AND ss.opening_hours ->> 'scheduled_reopen' ~ $1
			  AND (ss.opening_hours ->> 'scheduled_reopen')::timestamptz <= now()
			  AND EXISTS (
				SELECT 1 FROM chain_stores cs
				WHERE cs.merchant_id = ss.merchant_id AND NOT cs.active
			  )
		),
		reopened AS (
			UPDATE chain_stores cs
			SET active = true, updated_at = now()
			WHERE NOT cs.active
			  AND cs.merchant_id IN (SELECT merchant_id FROM due)
			RETURNING cs.id
		),
		cleared AS (
			UPDATE store_settings ss
			SET opening_hours = ss.opening_hours - 'scheduled_reopen', updated_at = now()
			WHERE ss.merchant_id IN (SELECT merchant_id FROM due)
			RETURNING 1
		)
		SELECT
			(SELECT count(*) FROM reopened),
			(SELECT count(*) FROM cleared)`,
		scheduledReopenPattern).Scan(&reopened, &cleared)
	if err != nil {
		return 0, fmt.Errorf("sweeper: scheduled store reopen: %w", err)
	}
	if reopened > 0 {
		s.logger.Info("sweeper: reopened scheduled chain stores", "stores", reopened, "merchants", cleared)
	}
	return reopened, nil
}
