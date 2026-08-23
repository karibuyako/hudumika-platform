-- +goose Up
-- Saved payment methods (consumer wallet checkout): per-user payment-method
-- registry (method = PaymentIntentCreateMethod enum). The contract list
-- endpoint GET /payments/methods already exists as a static enum view; this
-- table backs the mutations POST /payments/methods, DELETE
-- /payments/methods/{id}, PUT /payments/methods/{id}/default. One default
-- per user enforced by partial unique index (is_default = true). Method
-- details (tokens/pan hints) are encrypted-at-rest placeholders here — the
-- API masks them in responses.

CREATE TABLE payment_methods (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method     text NOT NULL CHECK (method IN ('mpesa','tigo_pesa','airtel_money','ezy_pesa','halotel','card','cod','bank')),
    label      text NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, method)
);

-- One default per user (partial index)
CREATE UNIQUE INDEX idx_payment_methods_user_default ON payment_methods (user_id) WHERE is_default = true;
CREATE INDEX idx_payment_methods_user ON payment_methods (user_id);

-- +goose Down
DROP TABLE IF EXISTS payment_methods;
