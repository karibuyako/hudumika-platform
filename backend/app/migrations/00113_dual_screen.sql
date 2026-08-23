-- +goose Up
-- GROUP DUAL-SCREEN: pairing + per-merchant dual-screen / QR-ordering config.
CREATE TABLE IF NOT EXISTS dual_screens (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	merchant_id  uuid NOT NULL REFERENCES merchants (id),
	store_id     text,
	paired_token text,
	status       text NOT NULL DEFAULT 'unpaired',
	config       jsonb,
	created_at   timestamptz NOT NULL DEFAULT now(),
	updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Single dual-screen/QR-ordering config row per merchant (single-store model).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dual_screens_merchant ON dual_screens (merchant_id);

-- +goose Down
DROP TABLE IF EXISTS dual_screens;
