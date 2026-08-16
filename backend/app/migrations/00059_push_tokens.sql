-- +goose Up
-- Per-user device push-token registry (backend/NOTIFICATIONS.md, documented
-- extension: POST /notifications/me/push-token, DELETE
-- /notifications/me/push-token, GET /notifications/me/push-tokens). The Expo
-- push provider needs an enumerable, indexed per-device registry to target
-- deliveries; tokens live OUTSIDE notification_preferences (00009) — that
-- jsonb holds per-channel event toggles and must stay untouched.

CREATE TABLE push_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       text NOT NULL,
    platform    text NOT NULL DEFAULT 'expo' CHECK (platform IN ('expo', 'apns', 'fcm')),
    device_name text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, token)
);

CREATE INDEX idx_push_tokens_user ON push_tokens (user_id);

-- +goose Down
DROP TABLE IF EXISTS push_tokens;
