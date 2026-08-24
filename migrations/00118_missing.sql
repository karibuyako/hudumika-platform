-- 00118_missing.sql
-- New tables for the merchant mobile "missing routes" group:
--   products, stores
-- Idempotency for products is supported via an idempotency_key column.

CREATE TABLE IF NOT EXISTS products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     uuid NOT NULL,
    name            text NOT NULL,
    description     text,
    price_cents     bigint NOT NULL DEFAULT 0,
    currency        text NOT NULL DEFAULT 'TZS',
    sku             text,
    active          boolean NOT NULL DEFAULT true,
    idempotency_key text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_merchant ON products (merchant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_idem ON products (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS stores (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    address     text,
    city_id     uuid,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stores_merchant ON stores (merchant_id);
