-- +goose Up
CREATE TABLE IF NOT EXISTS admin_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    token_hash  text NOT NULL UNIQUE,
    ip_address  text,
    user_agent  text,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions (token_hash) WHERE active = true;

-- +goose Down
DROP TABLE IF EXISTS admin_sessions;
