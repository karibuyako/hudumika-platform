-- +goose Up
-- Orders bounded context (backend/DATA-MODEL.md): merchant catalogue,
-- product categories, orders with server-computed TZS totals, item
-- snapshots and the append-only event log.

CREATE TABLE product_categories (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    sort_order  int NOT NULL DEFAULT 0,
    image_url   text,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalogue_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    description text,
    price_tzs   bigint NOT NULL DEFAULT 0 CHECK (price_tzs >= 0),
    category_id uuid REFERENCES product_categories(id),
    image_url   text,
    video_url   text,
    available   boolean NOT NULL DEFAULT true,
    options     jsonb,
    deleted_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalogue_items_merchant_available ON catalogue_items (merchant_id, available);

CREATE TABLE orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    no               text NOT NULL UNIQUE DEFAULT ('HD-' || substr(gen_random_uuid()::text, 1, 8)),
    customer_user_id uuid REFERENCES users(id),
    merchant_id      uuid NOT NULL,
    rider_id         uuid,
    status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_payment', 'paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering', 'delivered', 'completed', 'cancelled', 'refunded', 'failed', 'disputed')),
    subtotal_tzs     bigint NOT NULL DEFAULT 0,
    delivery_fee_tzs bigint NOT NULL DEFAULT 0,
    platform_fee_tzs bigint NOT NULL DEFAULT 0,
    tax_tzs          bigint NOT NULL DEFAULT 0,
    discount_tzs     bigint NOT NULL DEFAULT 0,
    total_tzs        bigint NOT NULL DEFAULT 0,
    delivery_address jsonb,
    note             text,
    idempotency_key  text,
    version          int NOT NULL DEFAULT 1,
    source           text NOT NULL DEFAULT 'app',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_created ON orders (customer_user_id, created_at DESC);
CREATE INDEX idx_orders_merchant_status ON orders (merchant_id, status);
CREATE UNIQUE INDEX idx_orders_customer_idempotency ON orders (customer_user_id, idempotency_key);

CREATE TABLE order_items (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    catalogue_item_id uuid,
    name_snapshot     text NOT NULL,
    quantity          int NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    unit_price_tzs    bigint NOT NULL,
    options           jsonb
);

CREATE INDEX idx_order_items_order_id ON order_items (order_id);

CREATE TABLE order_events (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status   text NOT NULL,
    at       timestamptz NOT NULL DEFAULT now(),
    by       uuid,
    note     text
);

CREATE INDEX idx_order_events_order_id ON order_events (order_id, at);

-- +goose Down
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS catalogue_items;
DROP TABLE IF EXISTS product_categories;
