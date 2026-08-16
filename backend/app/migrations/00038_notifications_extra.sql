-- +goose Up
-- NOTIFICATIONS-EXTRA: platform announcement broadcast feed served by
-- GET /announcements (API-CONTRACT.yaml §/announcements) and the merchant
-- order alert / acceptance settings blob (API-CONTRACT.yaml
-- §/notifications/me/order-settings, schema OrderAlertSettings) stored on
-- the 00009 notification_preferences row.

-- Broadcast announcements. Only active rows inside their publish window
-- (starts_at..ends_at; NULL = unbounded) are served, newest first.
CREATE TABLE announcements (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title      text NOT NULL,
    body       text NOT NULL,
    audience   text NOT NULL DEFAULT 'all'
               CHECK (audience IN ('all', 'customers', 'merchants', 'providers', 'riders')),
    active     boolean NOT NULL DEFAULT true,
    starts_at  timestamptz,
    ends_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_announcements_active_starts ON announcements (active, starts_at DESC);

-- Per-user merchant order alert / acceptance settings (OrderAlertSettings)
-- as a JSON blob. The 00009 table keeps its per-channel toggle columns; this
-- column only extends the row, so the notifications package is untouched.
ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS order_settings jsonb NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE notification_preferences DROP COLUMN IF EXISTS order_settings;
DROP TABLE IF EXISTS announcements;
