// Package webhooks delivers outbound webhook subscriptions: a worker claims
// due webhook_deliveries rows, POSTs the payload to the subscriber URL signed
// with the subscription's HMAC secret, and retries with exponential backoff
// (ARCHITECTURE.md: every external call has timeout, retry budget, and a
// dead-letter path).
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/metrics"
)

const (
	maxAttempts      = 8
	baseBackoff      = 30 * time.Second
	maxBackoff       = 10 * time.Minute
	claimBatchSize   = 10
	sendTimeout      = 10 * time.Second
	deliveriesTable  = "webhook_deliveries"
	subscriptionsTbl = "webhook_subscriptions"
)

// Backoff returns the exponential backoff for the attempt number, capped.
// Exposed for tests.
func Backoff(attempts int) time.Duration {
	if attempts <= 1 {
		return baseBackoff
	}
	// Shift up to the cap; beyond ~15 attempts the shift would overflow.
	if attempts > 15 {
		return maxBackoff
	}
	d := baseBackoff << uint(attempts-1)
	if d > maxBackoff {
		return maxBackoff
	}
	return d
}

// Delivery is one due webhook job joined with its subscription target.
type Delivery struct {
	ID      uuid.UUID
	URL     string
	Secret  []byte
	Event   string
	Payload []byte
}

// Sign computes the HMAC-SHA256 hex signature over the payload.
func Sign(secret, payload []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

// Worker claims and sends due webhook deliveries.
type Worker struct {
	pool     *pgxpool.Pool
	logger   *slog.Logger
	interval time.Duration
	client   *http.Client
}

func New(pool *pgxpool.Pool, logger *slog.Logger, interval time.Duration) *Worker {
	return &Worker{
		pool:     pool,
		logger:   logger,
		interval: interval,
		client:   &http.Client{Timeout: sendTimeout},
	}
}

// PendingCount returns the number of deliveries awaiting (re)delivery:
// 'pending' or 'failed' rows with a scheduled next attempt. It feeds the
// queue_depth gauge (queue "webhook_deliveries") after every worker cycle.
func (w *Worker) PendingCount(ctx context.Context) (int64, error) {
	var n int64
	if err := w.pool.QueryRow(ctx,
		`SELECT count(*) FROM `+deliveriesTable+`
		 WHERE status IN ('pending', 'failed') AND next_attempt_at IS NOT NULL`).Scan(&n); err != nil {
		return 0, fmt.Errorf("webhooks: pending count: %w", err)
	}
	return n, nil
}

// Run loops claim-send cycles until the context is cancelled.
func (w *Worker) Run(ctx context.Context) {
	w.logger.Info("webhook delivery worker started", "interval", w.interval.String())
	for {
		select {
		case <-ctx.Done():
			w.logger.Info("webhook delivery worker stopped")
			return
		case <-time.After(w.interval):
		}
		processed, err := w.RunOnce(ctx)
		if err != nil {
			w.logger.Error("webhook delivery cycle failed", "error", err)
			continue
		}
		if processed > 0 {
			w.logger.Debug("webhook deliveries processed", "count", processed)
		}
		// Report the remaining depth after processing; a failed count must
		// not break the cycle.
		if n, err := w.PendingCount(ctx); err != nil {
			w.logger.Error("webhook delivery pending count failed", "error", err)
		} else {
			metrics.Set("webhook_deliveries", n)
		}
	}
}

// RunOnce claims due deliveries and sends them. Returns the number processed.
func (w *Worker) RunOnce(ctx context.Context) (int, error) {
	deliveries, err := w.ClaimDue(ctx, claimBatchSize)
	if err != nil {
		return 0, err
	}
	for i := range deliveries {
		if err := w.Send(ctx, deliveries[i]); err != nil {
			w.logger.Error("webhook delivery failed", "delivery", deliveries[i].ID, "error", err)
		}
	}
	return len(deliveries), nil
}

// ClaimDue claims up to limit due deliveries FOR UPDATE SKIP LOCKED and
// bumps attempts/backoff in one transaction, so a crashed worker's jobs are
// retried after the backoff.
func (w *Worker) ClaimDue(ctx context.Context, limit int) ([]Delivery, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("webhooks: begin claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT d.id, s.url, s.secret, d.event, d.payload
		 FROM `+deliveriesTable+` d
		 JOIN `+subscriptionsTbl+` s ON s.id = d.subscription_id
		 WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now()
		 ORDER BY d.created_at
		 LIMIT $1
		 FOR UPDATE OF d SKIP LOCKED`, limit)
	if err != nil {
		return nil, fmt.Errorf("webhooks: claim due: %w", err)
	}
	var out []Delivery
	ids := make([]uuid.UUID, 0, limit)
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.URL, &d.Secret, &d.Event, &d.Payload); err != nil {
			rows.Close()
			return nil, fmt.Errorf("webhooks: scan claim: %w", err)
		}
		out = append(out, d)
		ids = append(ids, d.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("webhooks: iterate claim: %w", err)
	}
	if len(ids) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("webhooks: commit claim: %w", err)
		}
		return nil, nil
	}

	attempts := 1
	backoff := Backoff(attempts)
	if _, err := tx.Exec(ctx,
		`UPDATE `+deliveriesTable+`
		 SET attempts = attempts + 1, next_attempt_at = now() + $1::interval
		 WHERE id = ANY($2)`, fmt.Sprintf("%d seconds", int64(backoff.Seconds())), ids); err != nil {
		return nil, fmt.Errorf("webhooks: mark claiming: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("webhooks: commit claim: %w", err)
	}
	return out, nil
}

// SendRequest POSTs the signed payload to the URL without any persistence.
// Exported for tests and embedders of the delivery path.
func (w *Worker) SendRequest(url string, secret, payload []byte) error {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("webhooks: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hudumika-Signature", "sha256="+Sign(secret, payload))

	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	resp, err := w.client.Do(req.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("webhooks: send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhooks: non-2xx response: %d", resp.StatusCode)
	}
	return nil
}

// Send POSTs the payload signed with the subscription secret. Success (2xx)
// marks the delivery delivered; failures are recorded but the row stays for
// the retry cycle until maxAttempts dead-letters it.
func (w *Worker) Send(ctx context.Context, d Delivery) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.URL, bytes.NewReader(d.Payload))
	if err != nil {
		return fmt.Errorf("webhooks: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hudumika-Signature", "sha256="+Sign(d.Secret, d.Payload))

	resp, err := w.client.Do(req)
	if err != nil {
		return w.recordFailure(ctx, d, 0, err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_, err := w.pool.Exec(ctx,
			`UPDATE `+deliveriesTable+` SET status = 'delivered', last_status_code = $1, delivered_at = now()
			 WHERE id = $2`, resp.StatusCode, d.ID)
		if err != nil {
			return fmt.Errorf("webhooks: mark delivered: %w", err)
		}
		w.logger.Info("webhook delivered", "delivery", d.ID, "url", d.URL, "status", resp.StatusCode)
		return nil
	}

	msg := fmt.Sprintf("non-2xx response: %d", resp.StatusCode)
	return w.recordFailure(ctx, d, resp.StatusCode, msg)
}

func (w *Worker) recordFailure(ctx context.Context, d Delivery, status int, msg string) error {
	_, err := w.pool.Exec(ctx,
		`UPDATE `+deliveriesTable+`
		 SET last_status_code = $1, last_error = $2,
		     status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END
		 WHERE id = $4`, status, msg, maxAttempts, d.ID)
	if err != nil {
		return fmt.Errorf("webhooks: record failure: %w", err)
	}
	return fmt.Errorf("webhooks: delivery %s: %s", d.ID, msg)
}

// EnqueueDelivery inserts a pending delivery for a subscription (used by the
// API layer when a domain event should fan out to the merchant's webhooks).
func EnqueueDelivery(ctx context.Context, pool *pgxpool.Pool, subscriptionID uuid.UUID, event string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("webhooks: marshal payload: %w", err)
	}
	now := time.Now()
	_, err = pool.Exec(ctx,
		`INSERT INTO `+deliveriesTable+` (subscription_id, event, payload, status, next_attempt_at)
		 VALUES ($1, $2, $3, 'pending', $4)`,
		subscriptionID, event, body, now)
	if err != nil {
		return fmt.Errorf("webhooks: enqueue delivery: %w", err)
	}
	return nil
}
