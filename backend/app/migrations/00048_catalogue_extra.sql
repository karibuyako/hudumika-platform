-- +goose Up
-- Catalogue bulk milestone (backend/DATA-MODEL.md): multi-store product
-- templates (owned by the merchant, unique per merchant name) and the
-- store activity log read by GET /store/logs (the merchant's own rows plus
-- a best-effort union with audit_logs entries that reference the merchant).

CREATE TABLE product_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    price_tzs   bigint NOT NULL DEFAULT 0 CHECK (price_tzs >= 0),
    category_id uuid REFERENCES product_categories(id),
    options     jsonb NOT NULL DEFAULT '[]',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, name)
);

CREATE TABLE store_logs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    action      text NOT NULL,
    entity      text,
    detail      jsonb,
    actor_uuid  uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_store_logs_merchant_created ON store_logs (merchant_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS store_logs;
DROP TABLE IF EXISTS product_templates;
