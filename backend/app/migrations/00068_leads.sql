-- +goose Up
-- 00068: public leads intake (POST /leads, API-CONTRACT.yaml /leads) plus
-- the persistence shapes the admin-pending endpoints (PENDING-ENDPOINTS.md)
-- need that no earlier milestone migration created:
--   - merchant_groups   (DATA-MODEL.md §merchant_groups) for chain onboard/
--     suspend decisions;
--   - logistics_anomalies (DATA-MODEL.md §logistics_anomalies) for the
--     anomaly decision queue;
--   - loyalty_config: platform-wide loyalty tier/top-up config reviewed and
--     persisted by admin (no merchant owner — the per-merchant loyalty
--     tables in 00021 are merchant-scoped);
--   - safety_events outcome columns (crash respond);
--   - riders rest-override columns;
--   - consignments missing-order exception columns.
-- Everything here is additive (IF NOT EXISTS) so the migration applies on
-- already-migrated databases.

-- 1. Leads: public signup/feedback intake. status starts 'received'; the
--    ops triage transitions are contract values.
CREATE TABLE IF NOT EXISTS leads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type          text NOT NULL CHECK (type IN ('merchant', 'provider', 'rider', 'feedback')),
    name          text NOT NULL,
    phone         text NOT NULL,
    email         text,
    company_name  text,
    city          text,
    message       text,
    source        text,
    topic         text,
    restaurant    text,
    owner         text,
    business_type text,
    outlets       int,
    comment       text,
    trade         text,
    experience    int,
    bio           text,
    vehicle       text,
    availability  text,
    referral      text,
    status        text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'contacted', 'converted', 'dismissed')),
    received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_type_status ON leads (type, status);
CREATE INDEX IF NOT EXISTS idx_leads_received ON leads (received_at DESC);

-- 2. Merchant groups (DATA-MODEL.md §merchant_groups): the enterprise chain
--    identity behind /admin/chains/* decisions. account_manager is the
--    contract's plain-string field (the DATA-MODEL account_manager_user_id
--    FK lands with the real IAM milestone).
CREATE TABLE IF NOT EXISTS merchant_groups (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL,
    tier                text NOT NULL DEFAULT 'standard'
                        CHECK (tier IN ('standard', 'enterprise')),
    sla_level           text,
    account_manager     text,
    monthly_volume_tzs  bigint NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'application'
                        CHECK (status IN ('application', 'active', 'suspended')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_groups_status ON merchant_groups (status);

-- 3. Logistics anomalies (DATA-MODEL.md §logistics_anomalies): the
--    fraud/trust queue the anomaly decision endpoint resolves.
CREATE TABLE IF NOT EXISTS logistics_anomalies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid REFERENCES shipments(id) ON DELETE SET NULL,
    type        text NOT NULL CHECK (type IN ('scan_gps_mismatch', 'scan_vehicle_static', 'wrong_hub_scan', 'scan_before_pickup')),
    severity    text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
    resolved    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logistics_anomalies_resolved ON logistics_anomalies (resolved, created_at DESC);

-- 4. Platform loyalty config: the reviewed tier/top-up-reward config
--    persisted by PUT /admin/loyalty/config (single current row).
CREATE TABLE IF NOT EXISTS loyalty_config (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tiers           jsonb NOT NULL DEFAULT '[]',
    top_up_rewards  jsonb NOT NULL DEFAULT '[]',
    updated_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 5. Crash-respond outcome on safety events (00043 created the base table
--    without a decision marker).
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS outcome text
    CHECK (outcome IN ('safe', 'unsafe'));
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS handled_by uuid;
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS handled_at timestamptz;

-- 6. Mandatory-rest override columns on riders (forced_rest_until is the
--    rest window enforced by POST /admin/riders/{riderId}/rest).
ALTER TABLE riders ADD COLUMN IF NOT EXISTS forced_rest_until timestamptz;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS continuous_driving_minutes int NOT NULL DEFAULT 0;

-- 7. Missing-order exception decision on consignments (the missing-orders
--    queue row: relocating clears it, declaring lost routes to the claim
--    path).
ALTER TABLE consignments ADD COLUMN IF NOT EXISTS exception_decision text
    CHECK (exception_decision IN ('relocate', 'declare_lost'));
ALTER TABLE consignments ADD COLUMN IF NOT EXISTS exception_resolved_at timestamptz;

-- +goose Down
ALTER TABLE consignments DROP COLUMN IF EXISTS exception_resolved_at;
ALTER TABLE consignments DROP COLUMN IF EXISTS exception_decision;
ALTER TABLE riders DROP COLUMN IF EXISTS continuous_driving_minutes;
ALTER TABLE riders DROP COLUMN IF EXISTS forced_rest_until;
ALTER TABLE safety_events DROP COLUMN IF EXISTS handled_at;
ALTER TABLE safety_events DROP COLUMN IF EXISTS handled_by;
ALTER TABLE safety_events DROP COLUMN IF EXISTS outcome;
DROP TABLE IF EXISTS loyalty_config;
DROP TABLE IF EXISTS logistics_anomalies;
DROP TABLE IF EXISTS merchant_groups;
DROP TABLE IF EXISTS leads;