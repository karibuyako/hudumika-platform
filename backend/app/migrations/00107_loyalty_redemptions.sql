-- +goose Up
-- Loyalty redemptions (REDEMPTION_CATALOG): per-user points redemption
-- ledger for POST /loyalty/redemptions. Each redemption debits the customer's
-- points balance and appends a signed redeem row (mirror of loyalty
-- transactions). Wallet-credit rewards additionally credit the wallet (integer
-- TZS). Idempotency per key — same key replays stored redemption.

CREATE TABLE loyalty_redemptions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward      text NOT NULL CHECK (reward IN ('wallet_credit','delivery_discount','free_delivery')),
    points      integer NOT NULL CHECK (points > 0),
    value_tzs   integer,
    created_at  timestamptz NOT NULL DEFAULT now(),
    idempotency_key text UNIQUE
);

CREATE INDEX idx_loyalty_redemptions_user ON loyalty_redemptions (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS loyalty_redemptions;
