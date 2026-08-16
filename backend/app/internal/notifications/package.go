// Package notifications implements the outbox delivery pattern for SMS, email
// and push (backend/NOTIFICATIONS.md): a transaction commits a message to the
// outbox table, a background worker claims due rows (FOR UPDATE SKIP LOCKED),
// sends them through a provider chain, and either marks them sent or fails
// them with exponential backoff. Payloads are encrypted (see Encryptor) so
// sensitive content is never stored in plaintext.
package notifications

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/metrics"
)

// Message is the unit of delivery: the channel, recipient and template plus
// the (encrypted) provider payload.
type Message struct {
	Channel   string
	Recipient string
	Template  string
	Payload   []byte
}

// Provider delivers a Message to a single channel. Implementations must
// return an error when delivery is not possible so the caller can retry with
// backoff or fail over to a secondary provider.
type Provider interface {
	Send(ctx context.Context, msg Message) error
}

// Job is a claimed outbox row awaiting delivery.
type Job struct {
	ID          uuid.UUID
	Message     Message
	Attempts    int
	MaxAttempts int
}

// Outbox persists undelivered messages. Enqueue runs inside the business
// transaction; ClaimDue/Complete/Fail are driven by the delivery worker.
type Outbox interface {
	// Enqueue inserts a message for later delivery.
	Enqueue(ctx context.Context, m Message) error
	// ClaimDue atomically claims up to limit due jobs (pending, or stale
	// 'sending' rows whose next_attempt_at has passed) and marks them
	// 'sending'. Concurrent workers never receive the same job.
	ClaimDue(ctx context.Context, workerID string, limit int) ([]Job, error)
	// Complete marks a job as delivered.
	Complete(ctx context.Context, id uuid.UUID) error
	// Fail records a delivery error: attempts is incremented and, unless the
	// retry budget is exhausted (dead_letter), the job returns to 'pending'
	// with next_attempt_at pushed out by backoff.
	Fail(ctx context.Context, id uuid.UUID, errMsg string, backoff time.Duration) error
}

// ---- PostgreSQL outbox ----

// PgOutbox is the durable Outbox backed by notification_outbox.
type PgOutbox struct {
	pool *pgxpool.Pool
}

// NewPgOutbox returns an Outbox bound to the given pool.
func NewPgOutbox(pool *pgxpool.Pool) *PgOutbox {
	return &PgOutbox{pool: pool}
}

// Enqueue inserts a pending row. Call it inside the same transaction as the
// business change so a crash cannot lose the notification.
func (o *PgOutbox) Enqueue(ctx context.Context, m Message) error {
	_, err := o.pool.Exec(ctx,
		`INSERT INTO notification_outbox (channel, recipient, template, payload)
		 VALUES ($1, $2, $3, $4)`,
		m.Channel, m.Recipient, m.Template, m.Payload)
	if err != nil {
		return fmt.Errorf("notifications: enqueue: %w", err)
	}
	return nil
}

// ClaimDue claims up to limit due jobs and marks them 'sending'. Rows left
// 'sending' by a crashed worker are reclaimed once next_attempt_at passes:
// claiming treats a stale 'sending' row exactly like a due 'pending' one.
// The claimed ids are marked in a single batch UPDATE (no N+1).
func (o *PgOutbox) ClaimDue(ctx context.Context, workerID string, limit int) ([]Job, error) {
	rows, err := o.pool.Query(ctx,
		`SELECT id, channel, recipient, template, payload, attempts, max_attempts
		 FROM notification_outbox
		 WHERE (status = 'pending' AND next_attempt_at <= now())
		    OR (status = 'sending' AND next_attempt_at <= now())
		 ORDER BY created_at
		 LIMIT $1
		 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return nil, fmt.Errorf("notifications: claim due: %w", err)
	}
	defer rows.Close()

	jobs := make([]Job, 0, limit)
	ids := make([]uuid.UUID, 0, limit)
	for rows.Next() {
		var (
			id       uuid.UUID
			msg      Message
			attempts int
			maxAtt   int
		)
		if err := rows.Scan(&id, &msg.Channel, &msg.Recipient, &msg.Template, &msg.Payload, &attempts, &maxAtt); err != nil {
			return nil, fmt.Errorf("notifications: claim scan: %w", err)
		}
		jobs = append(jobs, Job{ID: id, Message: msg, Attempts: attempts, MaxAttempts: maxAtt})
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("notifications: claim rows: %w", err)
	}
	if len(jobs) == 0 {
		return nil, nil
	}
	if _, err := o.pool.Exec(ctx,
		`UPDATE notification_outbox SET status = 'sending' WHERE id = ANY($1::uuid[])`, ids); err != nil {
		return nil, fmt.Errorf("notifications: mark sending: %w", err)
	}
	return jobs, nil
}

// Complete marks the job delivered.
func (o *PgOutbox) Complete(ctx context.Context, id uuid.UUID) error {
	if _, err := o.pool.Exec(ctx,
		`UPDATE notification_outbox SET status = 'sent', sent_at = now() WHERE id = $1`, id); err != nil {
		return fmt.Errorf("notifications: complete: %w", err)
	}
	return nil
}

// Fail records one failed attempt. The row becomes 'dead_letter' when the
// retry budget is exhausted, otherwise it returns to 'pending' with
// next_attempt_at pushed out by backoff — so a worker that dies mid-send
// hands its job back to the next cycle.
func (o *PgOutbox) Fail(ctx context.Context, id uuid.UUID, errMsg string, backoff time.Duration) error {
	if _, err := o.pool.Exec(ctx,
		`UPDATE notification_outbox
		 SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
		     attempts = attempts + 1,
		     last_error = $2,
		     next_attempt_at = now() + $3::interval
		 WHERE id = $1`,
		id, errMsg, pgInterval(backoff)); err != nil {
		return fmt.Errorf("notifications: fail: %w", err)
	}
	return nil
}

// PendingCount returns the number of outbox rows awaiting delivery:
// 'pending' plus in-flight 'sending' rows. It feeds the queue_depth gauge
// (queue "notification_outbox") after every worker cycle.
func (o *PgOutbox) PendingCount(ctx context.Context) (int64, error) {
	var n int64
	if err := o.pool.QueryRow(ctx,
		`SELECT count(*) FROM notification_outbox WHERE status IN ('pending', 'sending')`).Scan(&n); err != nil {
		return 0, fmt.Errorf("notifications: pending count: %w", err)
	}
	return n, nil
}

// pgInterval renders a duration as a PostgreSQL interval literal.
func pgInterval(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Second {
		d = time.Second
	}
	if d%time.Minute == 0 {
		return fmt.Sprintf("%d minutes", int64(d/time.Minute))
	}
	return fmt.Sprintf("%d seconds", int64(d/time.Second))
}

// ---- In-memory outbox (tests, dev) ----

type memoryEntry struct {
	job           Job
	status        string
	lastError     string
	nextAttemptAt time.Time
	createdAt     time.Time
}

// MemoryOutbox is an in-memory Outbox for unit tests and single-process dev.
// It mirrors the PgOutbox semantics: claiming marks 'sending', stale
// 'sending' rows are reclaimable once next_attempt_at passes, and Fail pushes
// next_attempt_at out by the backoff.
type MemoryOutbox struct {
	mu   sync.Mutex
	rows map[uuid.UUID]*memoryEntry
	now  func() time.Time
}

// NewMemoryOutbox returns an empty in-memory outbox.
func NewMemoryOutbox() *MemoryOutbox {
	return &MemoryOutbox{rows: make(map[uuid.UUID]*memoryEntry), now: time.Now}
}

// Enqueue inserts a pending row with the default retry budget.
func (o *MemoryOutbox) Enqueue(ctx context.Context, m Message) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	id := uuid.New()
	o.rows[id] = &memoryEntry{
		job:           Job{ID: id, Message: m, MaxAttempts: 8},
		status:        "pending",
		nextAttemptAt: o.now(),
		createdAt:     o.now(),
	}
	return nil
}

// ClaimDue claims due jobs (pending or stale sending) and marks them
// 'sending'.
func (o *MemoryOutbox) ClaimDue(ctx context.Context, workerID string, limit int) ([]Job, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	now := o.now()
	var due []*memoryEntry
	for _, e := range o.rows {
		dueStatus := e.status == "pending" || e.status == "sending"
		if dueStatus && !e.nextAttemptAt.After(now) {
			due = append(due, e)
		}
	}
	sort.Slice(due, func(i, j int) bool { return due[i].createdAt.Before(due[j].createdAt) })
	if len(due) > limit {
		due = due[:limit]
	}
	jobs := make([]Job, 0, len(due))
	for _, e := range due {
		e.status = "sending"
		jobs = append(jobs, e.job)
	}
	return jobs, nil
}

// Complete marks the job delivered.
func (o *MemoryOutbox) Complete(ctx context.Context, id uuid.UUID) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	e, ok := o.rows[id]
	if !ok {
		return fmt.Errorf("notifications: complete unknown job %s", id)
	}
	e.status = "sent"
	return nil
}

// Fail records one failed attempt; the row becomes 'dead_letter' when the
// retry budget is exhausted, otherwise it returns to 'pending' with a
// backoff-delayed next_attempt_at.
func (o *MemoryOutbox) Fail(ctx context.Context, id uuid.UUID, errMsg string, backoff time.Duration) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	e, ok := o.rows[id]
	if !ok {
		return fmt.Errorf("notifications: fail unknown job %s", id)
	}
	e.job.Attempts++
	e.lastError = errMsg
	e.nextAttemptAt = o.now().Add(backoff)
	if e.job.Attempts >= e.job.MaxAttempts {
		e.status = "dead_letter"
	} else {
		e.status = "pending"
	}
	return nil
}

// Status returns the current status of a job. Test helper; not part of the
// Outbox interface.
func (o *MemoryOutbox) Status(ctx context.Context, id uuid.UUID) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	e, ok := o.rows[id]
	if !ok {
		return "", fmt.Errorf("notifications: unknown job %s", id)
	}
	return e.status, nil
}

// ---- Providers ----

// SMSProvider is a stub SMS gateway: every send succeeds unless SimulateOutage
// is set. The real gateway integration lands with the provider milestone.
type SMSProvider struct {
	SimulateOutage bool
}

// Send delivers the message through the (stubbed) SMS gateway.
func (p *SMSProvider) Send(ctx context.Context, msg Message) error {
	if p.SimulateOutage {
		return fmt.Errorf("sms: simulated provider outage")
	}
	return nil
}

// EmailProvider is a stub transactional email gateway.
type EmailProvider struct {
	SimulateOutage bool
}

// Send delivers the message through the (stubbed) email gateway.
func (p *EmailProvider) Send(ctx context.Context, msg Message) error {
	if p.SimulateOutage {
		return fmt.Errorf("email: simulated provider outage")
	}
	return nil
}

// Chain sends through a primary provider and fails over to a fallback on
// error. When both fail the combined error is returned and the caller decides
// on retry/backoff.
type Chain struct {
	primary  Provider
	fallback Provider
	extra    []Provider
	logger   *slog.Logger
}

// NewChain returns a provider chain trying primary first, fallback second.
func NewChain(primary, fallback Provider, logger *slog.Logger) *Chain {
	return &Chain{primary: primary, fallback: fallback, logger: logger}
}

// Add appends additional providers tried after the fallback (e.g. Expo push).
func (c *Chain) Add(providers ...Provider) { c.extra = append(c.extra, providers...) }

// Send tries the primary provider, then the fallback, then any extras.
func (c *Chain) Send(ctx context.Context, msg Message) error {
	firstErr := c.primary.Send(ctx, msg)
	if firstErr == nil {
		return nil
	}
	if c.logger != nil {
		c.logger.Warn("notifications: primary provider failed, trying fallback",
			"channel", msg.Channel, "error", firstErr)
	}
	if err := c.fallback.Send(ctx, msg); err == nil {
		return nil
	} else if len(c.extra) == 0 {
		return fmt.Errorf("notifications: all providers failed: primary=%v, fallback=%w", firstErr, err)
	}
	for _, p := range c.extra {
		if perr := p.Send(ctx, msg); perr == nil {
			return nil
		} else {
			firstErr = perr
		}
	}
	return fmt.Errorf("notifications: all providers failed: %w", firstErr)
}

// ---- Delivery worker ----

const (
	// defaultClaimLimit is the batch size per worker cycle.
	defaultClaimLimit = 10
	// defaultInterval is the poll cadence when NewWorker is given none.
	defaultInterval = 5 * time.Second
	// maxBackoff caps the exponential retry backoff.
	maxBackoff = 10 * time.Minute
)

// pendingCounter is implemented by outboxes that can report their queue
// depth (PgOutbox); the delivery loop feeds queue_depth from it. Optional, so
// in-memory/test outboxes need not implement it.
type pendingCounter interface {
	PendingCount(ctx context.Context) (int64, error)
}

// Worker claims due outbox jobs on a fixed cadence and sends them through a
// provider chain, completing or failing each job. Failures are scheduled with
// exponential backoff (30s, 1m, 2m, … capped at 10m); jobs that exhaust their
// retry budget are dead-lettered.
type Worker struct {
	outbox   Outbox
	provider Provider
	logger   *slog.Logger
	interval time.Duration
	workerID string
	stopOnce sync.Once
	stopCh   chan struct{}
}

// NewWorker returns a worker polling the outbox every interval.
func NewWorker(outbox Outbox, provider Provider, logger *slog.Logger, interval time.Duration) *Worker {
	return &Worker{
		outbox:   outbox,
		provider: provider,
		logger:   logger,
		interval: interval,
		workerID: "worker-" + uuid.NewString()[:8],
		stopCh:   make(chan struct{}),
	}
}

// Start runs the claim/send loop until ctx is cancelled or Stop is called.
// It blocks; run it in a goroutine. The first cycle runs immediately.
func (w *Worker) Start(ctx context.Context) {
	if w.interval <= 0 {
		w.interval = defaultInterval
	}
	w.runOnce(ctx)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		case <-ticker.C:
			w.runOnce(ctx)
		}
	}
}

// Stop stops the loop. Idempotent.
func (w *Worker) Stop() {
	w.stopOnce.Do(func() { close(w.stopCh) })
}

// RunOnce executes a single claim/send cycle. Exposed for tests.
func (w *Worker) RunOnce(ctx context.Context) error {
	return w.runOnce(ctx)
}

func (w *Worker) runOnce(ctx context.Context) error {
	jobs, err := w.outbox.ClaimDue(ctx, w.workerID, defaultClaimLimit)
	if err != nil {
		w.logger.Error("notifications: outbox claim failed", "error", err)
		return err
	}
	for _, job := range jobs {
		if err := w.provider.Send(ctx, job.Message); err != nil {
			w.logger.Warn("notifications: send failed",
				"jobId", job.ID, "channel", job.Message.Channel, "attempts", job.Attempts, "error", err)
			if ferr := w.outbox.Fail(ctx, job.ID, err.Error(), retryBackoff(job.Attempts+1)); ferr != nil {
				w.logger.Error("notifications: marking job failed failed", "jobId", job.ID, "error", ferr)
			}
			continue
		}
		if err := w.outbox.Complete(ctx, job.ID); err != nil {
			w.logger.Error("notifications: completing job failed", "jobId", job.ID, "error", err)
		}
	}
	// Report the remaining depth after processing; a failed count must not
	// break the cycle.
	if pc, ok := w.outbox.(pendingCounter); ok {
		if n, err := pc.PendingCount(ctx); err != nil {
			w.logger.Error("notifications: pending count failed", "error", err)
		} else {
			metrics.Set("notification_outbox", n)
		}
	}
	return nil
}

// retryBackoff schedules the next attempt after a failure: attempt N waits
// 30<<(N-1) seconds (30s, 1m, 2m, 4m, …), capped at maxBackoff.
func retryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 10 {
		// 30<<9 already far exceeds the cap; clamp before shifting to keep
		// the shift well inside int64.
		attempt = 10
	}
	d := time.Duration(30<<uint(attempt-1)) * time.Second
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}

// ---- Payload encryption ----

// Encryptor protects outbox payloads with AES-256-GCM. Every Encrypt call
// draws a fresh random nonce; the output format is
// base64(nonce || ciphertext), safe for opaque text/bytea storage.
type Encryptor struct {
	key [32]byte
}

// NewEncryptor builds an Encryptor from a hex-encoded 32-byte key.
func NewEncryptor(keyHex string) (*Encryptor, error) {
	if keyHex == "" {
		return nil, fmt.Errorf("notifications: encryptor key is empty")
	}
	key, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, fmt.Errorf("notifications: key is not valid hex: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("notifications: AES-256 key must be 32 bytes, got %d", len(key))
	}
	return &Encryptor{key: [32]byte(key)}, nil
}

// Encrypt seals plain with a fresh random nonce and returns
// base64(nonce || ciphertext).
func (e *Encryptor) Encrypt(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(e.key[:])
	if err != nil {
		return nil, fmt.Errorf("notifications: aes cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("notifications: gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("notifications: random nonce: %w", err)
	}
	sealed := gcm.Seal(nil, nonce, plain, nil)
	out := make([]byte, 0, len(nonce)+len(sealed))
	out = append(out, nonce...)
	out = append(out, sealed...)
	return []byte(base64.StdEncoding.EncodeToString(out)), nil
}

// Decrypt opens ct (base64(nonce || ciphertext)) and returns the plain.
func (e *Encryptor) Decrypt(ct []byte) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(string(ct))
	if err != nil {
		return nil, fmt.Errorf("notifications: payload is not valid base64: %w", err)
	}
	block, err := aes.NewCipher(e.key[:])
	if err != nil {
		return nil, fmt.Errorf("notifications: aes cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("notifications: gcm: %w", err)
	}
	if len(raw) < gcm.NonceSize() {
		return nil, fmt.Errorf("notifications: ciphertext too short")
	}
	nonce, sealed := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		return nil, fmt.Errorf("notifications: decrypt: %w", err)
	}
	return plain, nil
}
