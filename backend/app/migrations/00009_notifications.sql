-- +goose Up
-- In-app notification feed + per-channel preference toggles
-- (backend/DATA-MODEL.md, backend/NOTIFICATIONS.md). Outbound sends live in
-- notification_outbox (00003); this table is the in-app inbox served by
-- /notifications/me. Sent pushes are mirrored here by the outbox worker's
-- InAppWriter so every delivered message also lands in the feed.

CREATE TABLE notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       text NOT NULL,
    title      text NOT NULL,
    body       text NOT NULL,
    deep_link  text,
    read       boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_user_read ON notifications (user_id, read);

-- Per-event toggles per channel: each jsonb column maps an event key from
-- backend/NOTIFICATIONS.md to a boolean (false = muted on that channel).
CREATE TABLE notification_preferences (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push       jsonb NOT NULL DEFAULT '{}',
    sms        jsonb NOT NULL DEFAULT '{}',
    email      jsonb NOT NULL DEFAULT '{}',
    in_app     jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notifications;
