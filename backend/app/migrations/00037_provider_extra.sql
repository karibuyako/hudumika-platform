-- +goose Up
-- Provider self-service context (backend/DATA-MODEL.md provider sections):
-- the provider service catalog, weekly availability, team (technicians,
-- certifications, staff), parts/equipment inventory, recurring service
-- plans, B2B service contracts, documents, portfolio and capabilities.
-- Every child table cascades with its providers row; ownership is enforced
-- in the store by provider_id scoping.
--
-- Column deviations from the DATA-MODEL prose are deliberate:
--   * provider_availability stores the full weekly schedule as one jsonb
--     map (day "0".."6" -> window) so PUT availability merges atomically;
--   * provider_portfolio / provider_capabilities are 1:1 upsert rows per
--     provider (the contract PUT portfolio / capability catalog);
--   * service_contracts.plan_id links a contract to a provider_service_plans
--     row so PLAN_IN_USE can block plan deletion while a contract exists;
--   * provider_documents.type additionally accepts 'export' so provider
--     export jobs share the documents table (PROVIDER_EXPORT_IN_PROGRESS).

CREATE TABLE provider_services (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id      uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name             text NOT NULL,
    description      text,
    trade            text,
    duration_minutes int NOT NULL DEFAULT 60 CHECK (duration_minutes >= 15),
    pricing          jsonb NOT NULL DEFAULT '{}'::jsonb,
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_services_provider ON provider_services (provider_id);

CREATE TABLE provider_availability (
    provider_id uuid PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    weekly      jsonb NOT NULL DEFAULT '{}'::jsonb,
    timezone    text NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_technicians (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id        uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name               text NOT NULL,
    phone              text NOT NULL,
    trade              text NOT NULL,
    skills             jsonb NOT NULL DEFAULT '[]'::jsonb,
    status             text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'on_job', 'offline')),
    current_booking_id uuid,
    rating             numeric(3, 2),
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_technicians_provider ON provider_technicians (provider_id);

CREATE TABLE provider_certifications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    type         text NOT NULL,
    number       text NOT NULL,
    issuer       text,
    issued_at    date,
    expiry_date  date,
    document_url text,
    verified     boolean NOT NULL DEFAULT false,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (expiry_date IS NULL OR issued_at IS NULL OR expiry_date > issued_at)
);
CREATE INDEX idx_provider_certifications_provider ON provider_certifications (provider_id);

CREATE TABLE provider_staff (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name         text NOT NULL,
    phone        text NOT NULL,
    role         text NOT NULL CHECK (role IN ('owner', 'dispatcher', 'technician', 'supervisor')),
    capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_staff_provider ON provider_staff (provider_id);

CREATE TABLE provider_inventory (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id            uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name                   text NOT NULL,
    category               text NOT NULL DEFAULT 'part' CHECK (category IN ('part', 'consumable', 'equipment', 'tool')),
    stock_on_hand          int NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
    low_stock_threshold    int NOT NULL DEFAULT 5,
    unit_cost_tzs          bigint,
    assigned_technician_id uuid REFERENCES provider_technicians(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_inventory_provider ON provider_inventory (provider_id);

CREATE TABLE provider_service_plans (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id    uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name           text NOT NULL,
    service_id     uuid NOT NULL REFERENCES provider_services(id),
    frequency      text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'annually')),
    price_tzs      bigint NOT NULL DEFAULT 0 CHECK (price_tzs >= 0),
    active         boolean NOT NULL DEFAULT true,
    customer_count int NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_service_plans_provider ON provider_service_plans (provider_id);

CREATE TABLE service_contracts (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id            uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    organization_name      text NOT NULL,
    locations              jsonb NOT NULL DEFAULT '[]'::jsonb,
    covered_services       jsonb NOT NULL DEFAULT '[]'::jsonb,
    sla_response_minutes   int NOT NULL,
    sla_resolution_minutes int,
    pricing                jsonb NOT NULL DEFAULT '{}'::jsonb,
    coverage_area          jsonb NOT NULL DEFAULT '[]'::jsonb,
    working_hours          text,
    escalation_rules       text,
    plan_id                uuid REFERENCES provider_service_plans(id) ON DELETE SET NULL,
    status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'expired', 'cancelled')),
    created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_contracts_provider ON service_contracts (provider_id);

CREATE TABLE provider_documents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    type        text NOT NULL CHECK (type IN ('identity', 'license', 'certificate', 'insurance', 'tax', 'registration', 'vehicle', 'background_check', 'training', 'export')),
    url         text NOT NULL,
    status      text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'verified', 'rejected', 'expiring', 'expired', 'queued', 'ready', 'failed')),
    expiry_date date,
    verified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_documents_provider ON provider_documents (provider_id);

CREATE TABLE provider_portfolio (
    provider_id uuid PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    bio         text,
    specialties jsonb NOT NULL DEFAULT '[]'::jsonb,
    media       jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_capabilities (
    provider_id  uuid PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS provider_capabilities;
DROP TABLE IF EXISTS provider_portfolio;
DROP TABLE IF EXISTS provider_documents;
DROP TABLE IF EXISTS service_contracts;
DROP TABLE IF EXISTS provider_service_plans;
DROP TABLE IF EXISTS provider_inventory;
DROP TABLE IF EXISTS provider_staff;
DROP TABLE IF EXISTS provider_certifications;
DROP TABLE IF EXISTS provider_technicians;
DROP TABLE IF EXISTS provider_availability;
DROP TABLE IF EXISTS provider_services;
