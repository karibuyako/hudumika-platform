-- +goose Up
-- ORDERS-EXTRA surface (backend/ERROR-CODES.md: Orders (search, batch,
-- claims)): rush (hurry-up) timeline stamps, reject reason catalog, damage
-- claims and receipt rows. All new orders columns are nullable so the
-- existing write path (00005) is untouched.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS rush_requested_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rush_replied_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reject_reason_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deadline_at timestamptz;

CREATE TABLE order_damage_claims (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    reporter_user_id uuid,
    description      text NOT NULL,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_damage_claims_order_id ON order_damage_claims (order_id, created_at DESC);

CREATE TABLE order_receipts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    url        text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_receipts_order_id ON order_receipts (order_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS order_receipts;
DROP TABLE IF EXISTS order_damage_claims;
-- The orders ALTERs are intentionally left in place: dropping columns would
-- destroy order history that later milestones (auto-cancel, settlement)
-- read.
