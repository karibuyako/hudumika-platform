-- +goose Up
-- Payments bounded context (backend/DATA-MODEL.md "Payments",
-- backend/PAYMENTS.md). payment_intents track a single payment attempt;
-- payment_transactions is the append-only log of every provider call and
-- webhook (raw body + verification result).
--
-- NOTE: order_id intentionally has no FK constraint: the orders table is
-- created by a sibling migration (00005_orders.sql) that may not be applied
-- when this migration runs in a parallel agent build. Referential integrity
-- is enforced by the application layer instead.

CREATE TABLE payment_intents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           uuid,
    booking_id         uuid,
    method             text NOT NULL CHECK (method IN ('mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel', 'card', 'cod', 'bank')),
    amount_tzs         bigint NOT NULL,
    status             text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
    provider_reference text,
    idempotency_key    text NOT NULL UNIQUE,
    paid_at            timestamptz,
    refunds            jsonb NOT NULL DEFAULT '[]',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_intents_order_id ON payment_intents (order_id);
CREATE INDEX idx_payment_intents_status_created ON payment_intents (status, created_at);

CREATE TABLE payment_transactions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- intent_id is nullable: webhooks with an invalid signature carry an
    -- untrusted payload that may not resolve to an intent, and the attempt
    -- must still be logged.
    intent_id  uuid REFERENCES payment_intents(id),
    provider   text NOT NULL,
    action     text NOT NULL,
    status     text NOT NULL,
    payload    jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_transactions_intent ON payment_transactions (intent_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS payment_transactions;
DROP TABLE IF EXISTS payment_intents;
