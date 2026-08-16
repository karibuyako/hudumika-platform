-- +goose Up
-- Dispatch context (backend/DISPATCH.md): the manual rider-assignment audit
-- trail plus the covering index dispatch scans rely on. The orders table
-- already carries rider_id (00005); this adds the (rider_id, status) index,
-- the seen flag for the new-order badge, and the order_assignments log.

CREATE INDEX IF NOT EXISTS idx_orders_rider_status ON orders (rider_id, status);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS seen boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS order_assignments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    rider_id    uuid NOT NULL,
    assigned_by uuid NOT NULL,
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_assignments_order_id ON order_assignments (order_id);
CREATE INDEX IF NOT EXISTS idx_order_assignments_rider_created ON order_assignments (rider_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS order_assignments;
ALTER TABLE orders DROP COLUMN IF EXISTS seen;
DROP INDEX IF EXISTS idx_orders_rider_status;
