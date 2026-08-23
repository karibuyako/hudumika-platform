-- +goose Up
-- Printers: merchant-owned point-of-sale / kitchen printers. Idempotency is
-- enforced on create via a unique idempotency_key so duplicate
-- Idempotency-Key headers replay the original row instead of inserting twice.
CREATE TABLE IF NOT EXISTS printers (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     uuid        NOT NULL,
    name            text,
    model           text,
    type            text,
    status          text        NOT NULL DEFAULT 'offline',
    ip              text,
    config          jsonb,
    idempotency_key text        UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_printers_merchant ON printers (merchant_id);

-- +goose Down
DROP TABLE IF EXISTS printers;
