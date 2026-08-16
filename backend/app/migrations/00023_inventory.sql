-- +goose Up
-- Inventory & procurement bounded context (backend/DATA-MODEL.md "Inventory
-- and procurement"): stock items, the append-only adjustment log, low-stock
-- alerts, the sync-config master record, suppliers, purchase orders with
-- line items, and supplier returns. Money is bigint TZS only; every status
-- column carries a CHECK constraint. merchant_id references users(id) for
-- this milestone (the merchants bounded context does not exist yet).

CREATE TABLE inventory_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id         uuid NOT NULL REFERENCES users(id),
    name                text NOT NULL,
    sku                 text NOT NULL,
    quantity            int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    low_stock_threshold int NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
    unit                text,
    cost_tzs            bigint NOT NULL DEFAULT 0 CHECK (cost_tzs >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, sku)
);

CREATE INDEX idx_inventory_items_merchant ON inventory_items (merchant_id);

CREATE TABLE inventory_adjustments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL REFERENCES users(id),
    item_id     uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    delta       int NOT NULL,
    reason      text NOT NULL,
    by_user_id  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_adjustments_merchant_created
    ON inventory_adjustments (merchant_id, created_at);

CREATE TABLE inventory_alerts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL REFERENCES users(id),
    item_id     uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    type        text NOT NULL DEFAULT 'low_stock' CHECK (type IN ('low_stock', 'out_of_stock')),
    message     text,
    resolved    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE INDEX idx_inventory_alerts_merchant_unresolved
    ON inventory_alerts (merchant_id, resolved, created_at);

CREATE TABLE inventory_sync_config (
    merchant_id       uuid PRIMARY KEY REFERENCES users(id),
    enabled           boolean NOT NULL DEFAULT false,
    provider          text,
    url               text,
    api_key_encrypted text,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES users(id),
    name          text NOT NULL,
    contact_phone text NOT NULL,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_suppliers_merchant ON suppliers (merchant_id);

CREATE TABLE purchase_orders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL REFERENCES users(id),
    supplier_id uuid NOT NULL REFERENCES suppliers(id),
    status      text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
    total_tzs   bigint NOT NULL DEFAULT 0 CHECK (total_tzs >= 0),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchase_orders_merchant_created
    ON purchase_orders (merchant_id, created_at);

CREATE TABLE purchase_order_items (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    item_id           uuid NOT NULL,
    name_snapshot     text NOT NULL,
    quantity          int NOT NULL CHECK (quantity > 0),
    unit_cost_tzs     bigint NOT NULL DEFAULT 0 CHECK (unit_cost_tzs >= 0),
    received_quantity int NOT NULL DEFAULT 0 CHECK (received_quantity >= 0)
);

CREATE INDEX idx_purchase_order_items_order
    ON purchase_order_items (purchase_order_id);

CREATE TABLE supplier_returns (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       uuid NOT NULL REFERENCES users(id),
    supplier_id       uuid NOT NULL REFERENCES suppliers(id),
    purchase_order_id uuid REFERENCES purchase_orders(id),
    item_id           uuid NOT NULL,
    quantity          int NOT NULL CHECK (quantity > 0),
    reason            text NOT NULL,
    status            text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'accepted', 'rejected', 'received')),
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_returns_merchant_created
    ON supplier_returns (merchant_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS supplier_returns;
DROP TABLE IF EXISTS purchase_order_items;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS suppliers;
DROP TABLE IF EXISTS inventory_sync_config;
DROP TABLE IF EXISTS inventory_alerts;
DROP TABLE IF EXISTS inventory_adjustments;
DROP TABLE IF EXISTS inventory_items;
