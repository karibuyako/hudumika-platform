-- +goose Up
-- Provider preferences (OPERATIONS-COVERAGE #140 preferred providers):
-- per-customer preferred provider set. The consumer app toggles a provider
-- as preferred (PUT /providers/{id}/preference {preferred}) and lists its
-- set (GET /providers/me/preferred). Unique per (user_id, provider_id).

CREATE TABLE provider_preferences (
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id  uuid NOT NULL,
    is_preferred boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider_id)
);

CREATE INDEX idx_provider_preferences_user ON provider_preferences (user_id);
CREATE INDEX idx_provider_preferences_provider ON provider_preferences (provider_id);

-- +goose Down
DROP TABLE IF EXISTS provider_preferences;
