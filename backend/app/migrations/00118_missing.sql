-- +goose Up
-- Products + Stores backing the merchant mobile app's catalogue/store views.
CREATE TABLE IF NOT EXISTS products (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	merchant_id     uuid NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_idem ON products (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_merchant ON products (merchant_id);

CREATE TABLE IF NOT EXISTS stores (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	merchant_id uuid NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
	name        text NOT NULL,
	address     text,
	city_id     uuid,
	is_active   boolean NOT NULL DEFAULT true,
	created_at  timestamptz NOT NULL DEFAULT now(),
	updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stores_merchant ON stores (merchant_id);

-- +goose Down
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS stores;
