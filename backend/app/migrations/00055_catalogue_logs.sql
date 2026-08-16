-- +goose Up
-- CATALOGUE CHANGE-LOGS + CHAIN-STORE SETTINGS (API-CONTRACT.yaml
-- /catalogue-items/{itemId}/logs and PATCH /merchants/me/stores/{storeId}):
-- append-only per-item change log and per-store operational settings.
-- store_settings (00045) stays MERCHANT-scoped (one row per merchant); the
-- contract wants settings per chain store, so chain_store_settings keys on
-- chain_stores (00022) instead.

CREATE TABLE catalogue_item_logs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    catalogue_item_id uuid NOT NULL REFERENCES catalogue_items(id) ON DELETE CASCADE,
    action            text NOT NULL
                      CHECK (action IN ('created', 'updated', 'deleted', 'price_changed', 'availability_changed')),
    actor_uuid        uuid,
    detail            jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalogue_item_logs_item_created
    ON catalogue_item_logs (catalogue_item_id, created_at DESC);

CREATE TABLE chain_store_settings (
    store_id            uuid PRIMARY KEY REFERENCES chain_stores(id) ON DELETE CASCADE,
    opening_hours       jsonb NOT NULL DEFAULT '{}',
    min_order_tzs       bigint NOT NULL DEFAULT 0 CHECK (min_order_tzs >= 0),
    accept_while_closed boolean NOT NULL DEFAULT false,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS chain_store_settings;
DROP TABLE IF EXISTS catalogue_item_logs;
