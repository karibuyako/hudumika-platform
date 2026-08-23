-- +goose Up
-- 00116_finance.sql
-- Minimal table backing the merchant finance dispute-holds endpoint.
CREATE TABLE IF NOT EXISTS dispute_holds (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    merchant_id   uuid NOT NULL,
    dispute_id    uuid,
    amount_tzs    bigint NOT NULL DEFAULT 0,
    currency      text NOT NULL DEFAULT 'TZS',
    reason        text,
    status        text NOT NULL DEFAULT 'active',
    released_at   timestamptz,
    released_by   uuid,
    CONSTRAINT dispute_holds_status_check CHECK (status = ANY (ARRAY['active'::text, 'released'::text, 'rejected'::text]))
);

CREATE INDEX IF NOT EXISTS idx_dispute_holds_merchant ON dispute_holds (merchant_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS dispute_holds;
