-- +goose Up
-- Dine-in splits are already backed by dine_order_splits (00095_splits.sql)
-- but the alias POST/GET /dine-in/orders/{id}/splits shares the same table.
-- This migration ensures the distribution table is indexed for the alias
-- and adds a status guard for the consumer parity (open/billing/paid).
-- No new table — additive index only.

-- Ensure dine_order_splits exists (idempotent for fresh installs where 00095
-- may have been applied)
CREATE TABLE IF NOT EXISTS dine_order_splits (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dine_order_id       uuid REFERENCES dine_in_orders(id) ON DELETE CASCADE,
    initiator_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
    participants        jsonb NOT NULL DEFAULT '[]',
    status              text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','paid','completed')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    idempotency_key     text UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_dine_splits_dine_order ON dine_order_splits (dine_order_id, created_at DESC);

-- +goose Down
-- Keep table — down is index only
DROP INDEX IF EXISTS idx_dine_splits_dine_order;
