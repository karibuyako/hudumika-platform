-- +goose Up
-- ADMIN-CONFIG bounded context (API-CONTRACT.yaml /admin/templates,
-- /admin/staff-roles, /admin/sla-rules, /admin/commission-rules,
-- /admin/two-person-approvals): the platform configuration registry plus
-- the 4-eyes (two-person) approval workflow for dangerous staff actions.
--
-- Every column the contract reads or writes is stored; columns the
-- milestone sketch omits (subject/variables on templates, description and
-- system on roles, alertBeforeMinutes on SLA rules, reason/payload/comment
-- on approvals, entity_type on commission overrides) are added so the API
-- never drops request data (see admin_config.go honest mapping notes).

CREATE TABLE admin_templates (
    key        text PRIMARY KEY,
    title      text NOT NULL DEFAULT '',
    subject    text,
    body       text NOT NULL DEFAULT '',
    variables  jsonb NOT NULL DEFAULT '[]',
    channel    text NOT NULL DEFAULT 'sms'
               CHECK (channel IN ('sms', 'email', 'push', 'in_app')),
    active     boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    description text NOT NULL DEFAULT '',
    permissions jsonb NOT NULL DEFAULT '[]',
    system      boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sla_rules (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_type          text NOT NULL,
    response_minutes     int NOT NULL DEFAULT 0,
    resolution_minutes   int NOT NULL DEFAULT 0,
    alert_before_minutes int NOT NULL DEFAULT 15,
    priority             text NOT NULL DEFAULT 'normal',
    active               boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sla_rules_active_created ON sla_rules (active, created_at DESC);

CREATE TABLE two_person_approvals (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action           text NOT NULL,
    entity_type      text NOT NULL,
    entity_id        uuid NOT NULL,
    reason           text NOT NULL DEFAULT '',
    payload          jsonb,
    requested_by     uuid NOT NULL,
    approved_by      uuid,
    decision_comment text,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    decided_at       timestamptz
);

CREATE INDEX idx_two_person_approvals_status_created
    ON two_person_approvals (status, created_at DESC);

CREATE TABLE platform_commission_rules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    applies_to  text NOT NULL DEFAULT 'delivery'
                CHECK (applies_to IN ('delivery', 'dine_in', 'takeaway', 'category')),
    category_id uuid,
    entity_type text CHECK (entity_type IN ('merchant', 'provider')),
    entity_id   uuid,
    rate_bps    int NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_commission_rules_active
    ON platform_commission_rules (active, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS platform_commission_rules;
DROP TABLE IF EXISTS two_person_approvals;
DROP TABLE IF EXISTS sla_rules;
DROP TABLE IF EXISTS staff_roles;
DROP TABLE IF EXISTS admin_templates;
