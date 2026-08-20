-- +goose Up
-- GROUP ORDERS (MthCreateGroupOrder / MthGetGroupOrder / MthAddGroupOrderItem
-- / MthRemoveGroupOrderItem / MthFinalizeGroupOrder):
-- collaborative ordering. group_orders is the header; group_order_items holds
-- item jsonb payloads. IF NOT EXISTS so the migration is additive on the
-- legacy owner_id/title schema (hudumika DB) and fresh on staging.

CREATE TABLE IF NOT EXISTS group_orders (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
    status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'finalized', 'completed', 'cancelled')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    finalized_at      timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Legacy compatibility: if the table was already created with the old
-- owner_id/title shape, add the new columns without failing.
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS creator_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS title text;

-- Backfill creator_user_id from legacy owner_id when needed.
UPDATE group_orders SET creator_user_id = owner_id WHERE creator_user_id IS NULL AND owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_group_orders_creator ON group_orders (creator_user_id);
CREATE INDEX IF NOT EXISTS idx_group_orders_status ON group_orders (status);

CREATE TABLE IF NOT EXISTS group_order_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_order_id  uuid NOT NULL REFERENCES group_orders(id) ON DELETE CASCADE,
    item            jsonb NOT NULL DEFAULT '{}'
);

-- Legacy compatibility for already-existing group_order_items with product_id etc.
ALTER TABLE group_order_items ADD COLUMN IF NOT EXISTS item jsonb NOT NULL DEFAULT '{}';
ALTER TABLE group_order_items ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE group_order_items ADD COLUMN IF NOT EXISTS quantity integer;
ALTER TABLE group_order_items ADD COLUMN IF NOT EXISTS added_by uuid;

CREATE INDEX IF NOT EXISTS idx_group_order_items_order ON group_order_items (group_order_id);

-- +goose Down
DROP TABLE IF EXISTS group_order_items;
DROP TABLE IF EXISTS group_orders;
