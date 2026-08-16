-- +goose Up
-- Audit trail (backend/DATA-MODEL.md "Audit"): append-only log of money,
-- status, identity, and moderation mutations. Written by internal/audit;
-- retention is an ops concern (7 years for money actions).

CREATE TABLE audit_logs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    uuid NOT NULL,
    actor_role  text,
    action      text NOT NULL,
    entity_type text,
    entity_id   text,
    details     jsonb,
    request_id  text,
    ip          text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_actor_time ON audit_logs (actor_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS audit_logs;
