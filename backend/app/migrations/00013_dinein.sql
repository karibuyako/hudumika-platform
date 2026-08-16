-- +goose Up
-- Dine-in bounded context (backend/DATA-MODEL.md "Dine-in"): tables for QR
-- ordering, dine-in orders with server-computed TZS totals (client-supplied
-- amounts are advisory and ignored), and table reservations with a capacity
-- check. Merchant identities land with the merchants milestone, so
-- merchant_id columns are plain uuids for now.

CREATE TABLE dine_in_tables (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id              uuid NOT NULL,
    label                    text NOT NULL,
    capacity                 int NOT NULL DEFAULT 4 CHECK (capacity >= 1),
    active                   boolean NOT NULL DEFAULT true,
    current_dine_in_order_id uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dine_in_tables_merchant_active ON dine_in_tables (merchant_id, active);

CREATE TABLE dine_in_orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id      uuid NOT NULL,
    table_id         uuid NOT NULL REFERENCES dine_in_tables(id),
    customer_user_id uuid REFERENCES users(id),
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_payment', 'paid', 'closed')),
    items            jsonb NOT NULL DEFAULT '[]',
    total_tzs        bigint NOT NULL DEFAULT 0 CHECK (total_tzs >= 0),
    paid_at          timestamptz,
    idempotency_key  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dine_in_orders_customer_created ON dine_in_orders (customer_user_id, created_at DESC);
CREATE INDEX idx_dine_in_orders_table_status ON dine_in_orders (table_id, status);
CREATE UNIQUE INDEX idx_dine_in_orders_customer_idempotency ON dine_in_orders (customer_user_id, idempotency_key);

CREATE TABLE reservations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id      uuid NOT NULL,
    table_id         uuid NOT NULL REFERENCES dine_in_tables(id),
    customer_user_id uuid NOT NULL REFERENCES users(id),
    party_size       int NOT NULL CHECK (party_size BETWEEN 1 AND 50),
    reserved_for     timestamptz NOT NULL,
    status           text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'cancelled', 'seated', 'completed')),
    note             text,
    idempotency_key  text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reservations_customer_created ON reservations (customer_user_id, created_at DESC);
CREATE INDEX idx_reservations_table_status ON reservations (table_id, status);
CREATE UNIQUE INDEX idx_reservations_customer_idempotency ON reservations (customer_user_id, idempotency_key);

-- +goose Down
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS dine_in_orders;
DROP TABLE IF EXISTS dine_in_tables;
