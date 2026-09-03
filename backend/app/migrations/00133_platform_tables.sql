-- +goose Up
-- Stub tables for quality_score_config and platform_settings.
-- Migrations 00122+ only ALTER these tables ADD COLUMN IF NOT EXISTS, so the
-- stubs carry just id + created_at; later migrations add the rest.

CREATE TABLE IF NOT EXISTS quality_score_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS platform_settings;
DROP TABLE IF EXISTS quality_score_config;
