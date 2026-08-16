-- +goose Up
-- Warehouse stock and fulfillment (API-CONTRACT.yaml
-- /warehouses/{warehouseId}/stock and /warehouses/{warehouseId}/fulfill):
-- per-warehouse per-catalogue-item stock lines with a reserved channel.
-- quantity is the physical on-hand count; reserved is the quantity committed
-- to in-flight fulfillments, so the available-to-promise quantity is
-- quantity - reserved. The (warehouse_id, catalogue_item_id) pair is the
-- stock-line identity; the CHECKs make the negative-stock and negative-
-- reserved invariants database-level (INVENTORY_NEGATIVE_STOCK /
-- WAREHOUSE_STOCK_UNAVAILABLE in the API layer).

CREATE TABLE warehouse_stock (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id      uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    catalogue_item_id uuid NOT NULL,
    quantity          int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    reserved          int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (warehouse_id, catalogue_item_id)
);

CREATE INDEX idx_warehouse_stock_warehouse ON warehouse_stock (warehouse_id);

-- +goose Down
DROP TABLE IF EXISTS warehouse_stock;
