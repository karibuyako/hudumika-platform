-- +goose Up
-- ADMIN-PENDING logistics + rider safety/config (PENDING-ENDPOINTS.md:
-- crash_respond §12, rest_override §13, seal_broken_resolve §14,
-- anomaly_resolve §15, consignment_missing_resolve §17, loyalty_config §11):
-- the logistics anomaly registry (the 00028 handoffs table already exists
-- and gains seal-decision columns here), rider safety events and the
-- mandatory-rest window on riders, the consignment missing-order decision
-- columns (consignments exist from 00041), and the platform admin_config
-- registry that backs the reviewed loyalty config (no admin_config table
-- existed before).

CREATE TABLE logistics_anomalies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id  uuid REFERENCES shipments(id) ON DELETE CASCADE,
    device_id    text,
    anomaly_type text NOT NULL,
    evidence     jsonb NOT NULL DEFAULT '{}',
    status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    decision     text CHECK (decision IN ('dismiss', 'freeze', 'block')),
    decision_note text,
    decided_by   uuid,
    decided_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_logistics_anomalies_status_created ON logistics_anomalies (status, created_at DESC);
CREATE INDEX idx_logistics_anomalies_shipment ON logistics_anomalies (shipment_id);

CREATE TABLE rider_safety_events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id   uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    event_type text NOT NULL DEFAULT 'crash' CHECK (event_type IN ('crash', 'sos')),
    outcome    text CHECK (outcome IN ('safe', 'unsafe')),
    note       text,
    decided_by uuid,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rider_safety_events_rider ON rider_safety_events (rider_id, created_at DESC);

ALTER TABLE riders ADD COLUMN IF NOT EXISTS forced_rest_until timestamptz;

ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS seal_decision text;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS seal_decision_reason text;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS seal_decided_by uuid;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS seal_decided_at timestamptz;

ALTER TABLE consignments ADD COLUMN IF NOT EXISTS missing_decision text;
ALTER TABLE consignments ADD COLUMN IF NOT EXISTS missing_decision_reason text;
ALTER TABLE consignments ADD COLUMN IF NOT EXISTS missing_decided_by uuid;
ALTER TABLE consignments ADD COLUMN IF NOT EXISTS missing_decided_at timestamptz;

-- Enterprise chain accounts (PENDING-ENDPOINTS.md §7/§8 chain_onboard and
-- chain_suspend): one row per chain owner user (merchant_group_id), carrying
-- the tier/SLA/account-manager assignment and the active/suspended lifecycle
-- the /admin/chains mutations drive.
CREATE TABLE chain_accounts (
    merchant_group_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tier              text CHECK (tier IN ('standard', 'enterprise')),
    sla_level         text,
    account_manager   text,
    status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    updated_by        uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chain_accounts_status ON chain_accounts (status);

-- Platform admin config registry: keyed jsonb values (the reviewed loyalty
-- config lives under key 'loyalty'), stamped with the reviewing staff user.
CREATE TABLE admin_config (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL DEFAULT '{}',
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS admin_config;
DROP TABLE IF EXISTS chain_accounts;
ALTER TABLE consignments DROP COLUMN IF EXISTS missing_decided_at;
ALTER TABLE consignments DROP COLUMN IF EXISTS missing_decided_by;
ALTER TABLE consignments DROP COLUMN IF EXISTS missing_decision_reason;
ALTER TABLE consignments DROP COLUMN IF EXISTS missing_decision;
ALTER TABLE handoffs DROP COLUMN IF EXISTS seal_decided_at;
ALTER TABLE handoffs DROP COLUMN IF EXISTS seal_decided_by;
ALTER TABLE handoffs DROP COLUMN IF EXISTS seal_decision_reason;
ALTER TABLE handoffs DROP COLUMN IF EXISTS seal_decision;
ALTER TABLE riders DROP COLUMN IF EXISTS forced_rest_until;
DROP TABLE IF EXISTS rider_safety_events;
DROP TABLE IF EXISTS logistics_anomalies;