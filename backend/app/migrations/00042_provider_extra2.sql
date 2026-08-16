-- +goose Up
-- PROVIDER-EXTRA2: the provider trust/risk profile (provider_trust, a 1:1
-- row per provider lazily created on first read) and the copilot exchange
-- log (provider_copilot_log, an append-only transcript of the rule-based
-- v1 copilot; the real model lands later and the table is version-agnostic
-- jsonb so both request and response shapes stay backward compatible).
CREATE TABLE provider_trust (
    provider_id      uuid PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    score            numeric(4, 2) NOT NULL DEFAULT 0,
    reviews_count    int NOT NULL DEFAULT 0,
    completion_rate  numeric(5, 2) NOT NULL DEFAULT 0,
    badges           jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_copilot_log (
    id         uuid PRIMARY KEY,
    provider_id uuid NOT NULL,
    request    jsonb NOT NULL,
    response   jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_copilot_log_provider ON provider_copilot_log (provider_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS provider_copilot_log;
DROP TABLE IF EXISTS provider_trust;
