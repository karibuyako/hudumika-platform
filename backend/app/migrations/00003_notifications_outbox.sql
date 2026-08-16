-- +goose Up
-- Notification outbox (backend/NOTIFICATIONS.md): every outbound send
-- (SMS/email/push) is committed to this table inside the business transaction
-- and delivered by the outbox worker (internal/notifications). Payloads are
-- encrypted before enqueue (AES-256-GCM, base64(nonce||ciphertext)); the
-- worker retries with exponential backoff and dead-letters at max_attempts.

CREATE TABLE notification_outbox (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         text NOT NULL CHECK (channel IN ('sms', 'email', 'push')),
    recipient       text NOT NULL,
    template        text NOT NULL,
    payload         bytea NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter')),
    attempts        int NOT NULL DEFAULT 0,
    max_attempts    int NOT NULL DEFAULT 8,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_outbox_due ON notification_outbox (status, next_attempt_at);

-- +goose Down
DROP TABLE IF EXISTS notification_outbox;
