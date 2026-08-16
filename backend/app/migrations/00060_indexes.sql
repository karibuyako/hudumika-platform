-- +goose Up
-- Performance audit (00060_indexes): hot read paths EXPLAIN-verified as
-- missing a usable index. Every statement is idempotent. The audit found
-- idx_payment_intents_order_id and idx_notifications_user_read (user_id,
-- read) already cover their paths, so no duplicates are created here.
--
-- idx_orders_status_created: the rider dispatch pool (rider_id IS NULL AND
--   status IN (...) ORDER BY created_at) and the assigned-order lists used
--   to scan the whole unassigned set and sort by created_at.
-- idx_orders_created_id: the admin order list (ORDER BY created_at DESC,
--   id DESC LIMIT 100) had no index path at all.
-- idx_orders_customer_scheduled: advance-order listing filters the
--   customer's scheduled_at window and orders by scheduled_at DESC.
-- idx_conversations_{customer,merchant}_activity: the chat list orders by
--   COALESCE(last_message_at, created_at) DESC; the expression index makes
--   the keyset paginator index-backed on both participant sides.

CREATE INDEX IF NOT EXISTS idx_orders_status_created
    ON orders (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_created_id
    ON orders (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_customer_scheduled
    ON orders (customer_user_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_customer_activity
    ON conversations (customer_user_id, COALESCE(last_message_at, created_at) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_merchant_activity
    ON conversations (merchant_id, COALESCE(last_message_at, created_at) DESC, id DESC);

-- +goose Down
DROP INDEX IF EXISTS idx_orders_status_created;
DROP INDEX IF EXISTS idx_orders_created_id;
DROP INDEX IF EXISTS idx_orders_customer_scheduled;
DROP INDEX IF EXISTS idx_conversations_customer_activity;
DROP INDEX IF EXISTS idx_conversations_merchant_activity;
