-- +goose Up
-- SPLITS (MthCreateSplit / MthGetSplit / MthPaySplitShare / MthCompleteSplit):
-- bill-splitting for orders and dine-in orders. initiator is the user who
-- created the split; participants is a jsonb array of {userId, amountTzs};
-- status moves pending -> paid -> completed; idempotency_key makes retries
-- safe (UNIQUE).

CREATE TABLE IF NOT EXISTS splits (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            uuid REFERENCES orders(id) ON DELETE CASCADE,
    initiator_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
    participants        jsonb NOT NULL DEFAULT '[]',
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'completed')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    idempotency_key     text UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_splits_order_id ON splits (order_id);
CREATE INDEX IF NOT EXISTS idx_splits_initiator ON splits (initiator_user_id);
CREATE INDEX IF NOT EXISTS idx_splits_status ON splits (status);

CREATE TABLE IF NOT EXISTS dine_order_splits (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dine_order_id       uuid REFERENCES dine_in_orders(id) ON DELETE CASCADE,
    initiator_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
    participants        jsonb NOT NULL DEFAULT '[]',
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'completed')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    idempotency_key     text UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_dine_order_splits_order ON dine_order_splits (dine_order_id);
CREATE INDEX IF NOT EXISTS idx_dine_order_splits_initiator ON dine_order_splits (initiator_user_id);

-- +goose Down
DROP TABLE IF EXISTS dine_order_splits;
DROP TABLE IF EXISTS splits;
