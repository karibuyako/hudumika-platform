-- +goose Up
-- Store operations context (backend/ERROR-CODES.md §store ops): kitchen
-- camera, qualification documents, store QR codes, receipt templates,
-- payment accounts, self-pickup configuration and compliance rechecks.
-- merchant_id is the owning merchant's users row id (same milestone
-- simplification as the catalogues context).

CREATE TABLE store_kitchen_camera (
    merchant_id uuid PRIMARY KEY,
    enabled     boolean NOT NULL DEFAULT false,
    url         text,
    config      jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_qualifications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  uuid NOT NULL,
    name         text NOT NULL,
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    reason       text
);

CREATE INDEX idx_store_qualifications_merchant ON store_qualifications (merchant_id);

CREATE TABLE store_qr_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    label       text NOT NULL,
    code        text NOT NULL UNIQUE,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_store_qr_codes_merchant ON store_qr_codes (merchant_id);

CREATE TABLE receipt_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    body        text NOT NULL,
    is_active   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, name)
);

CREATE INDEX idx_receipt_templates_merchant ON receipt_templates (merchant_id);

CREATE TABLE payment_accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id    uuid NOT NULL,
    label          text NOT NULL,
    type           text NOT NULL CHECK (type IN ('bank', 'mobile_money')),
    account_number text NOT NULL,
    is_default     boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_accounts_merchant ON payment_accounts (merchant_id);

CREATE TABLE self_pickup_config (
    merchant_id         uuid PRIMARY KEY,
    enabled             boolean NOT NULL DEFAULT false,
    pickup_instructions text,
    minutes_until_ready int NOT NULL DEFAULT 10,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compliance_rechecks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    status      text NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress', 'passed', 'failed')),
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE INDEX idx_compliance_rechecks_merchant ON compliance_rechecks (merchant_id);

-- At most one in-flight recheck per merchant: concurrent requests race and
-- the constraint decides; the handler maps the miss to
-- COMPLIANCE_RECHECK_IN_PROGRESS.
CREATE UNIQUE INDEX idx_compliance_rechecks_open_unique
    ON compliance_rechecks (merchant_id) WHERE status = 'in_progress';

-- +goose Down
DROP TABLE IF EXISTS compliance_rechecks;
DROP TABLE IF EXISTS self_pickup_config;
DROP TABLE IF EXISTS payment_accounts;
DROP TABLE IF EXISTS receipt_templates;
DROP TABLE IF EXISTS store_qr_codes;
DROP TABLE IF EXISTS store_qualifications;
DROP TABLE IF EXISTS store_kitchen_camera;
