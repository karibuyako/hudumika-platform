-- +goose Up
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id    uuid NOT NULL,
    action      text NOT NULL,
    entity_type text NOT NULL,
    entity_id   uuid,
    old_value   jsonb,
    new_value   jsonb,
    ip_address  text,
    user_agent  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_entity ON admin_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log (action, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS admin_audit_log;
