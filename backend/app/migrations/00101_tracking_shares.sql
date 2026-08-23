-- +goose Up
-- View-only tracking shares (OPERATIONS-COVERAGE #77 trip-share parity):
-- a customer shares live order tracking via a short-lived token link
-- (hudumika://track-share/{token}). The token is the primary key
-- (ts_{order}_{random}, unguessable), not a UUID — the recipient resolves it
-- to an order id without ownership checks. Shares expire (default 2h) and are
-- resolved idempotently; the same Idempotency-Key replays the stored token.

CREATE TABLE tracking_shares (
    token      text PRIMARY KEY,
    order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text UNIQUE
);

CREATE INDEX idx_tracking_shares_order ON tracking_shares (order_id);
CREATE INDEX idx_tracking_shares_user ON tracking_shares (user_id);
CREATE INDEX idx_tracking_shares_expires ON tracking_shares (expires_at);

-- +goose Down
DROP TABLE IF EXISTS tracking_shares;
