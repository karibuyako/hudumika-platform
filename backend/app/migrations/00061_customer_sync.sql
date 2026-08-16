-- +goose Up
-- CUSTOMER OFFLINE SYNC (ARCHITECTURE.md offline contract extended to
-- customers): the per-customer high-water mark behind the documented-
-- extension POST /sync/batch replay endpoint (customer_sync.go). One row per
-- customer user; there is no per-event storage in this milestone — the
-- client drops events with seq <= last_seq, exactly like the rider sync
-- state (00044_rider_ops2.sql rider_sync_state).
CREATE TABLE customer_sync_state (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS customer_sync_state;
