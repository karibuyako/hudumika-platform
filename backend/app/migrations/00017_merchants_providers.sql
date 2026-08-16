-- +goose Up
-- Merchants and providers (backend/DATA-MODEL.md §marketplaces): partner
-- applications with admin approval. owner_user_id is unique so a user can
-- apply exactly once per entity; verification drives the public/private
-- visibility split. city_id references the cities table (00004); the
-- merchant trade enum follows the API contract ProviderApplication.trade
-- (a superset of the DATA-MODEL list) so every contract value inserts.

CREATE TABLE merchants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    business_name       text NOT NULL,
    description         text,
    logo_url            text,
    city_id             uuid REFERENCES cities(id) ON DELETE SET NULL,
    business_type       text CHECK (business_type IN ('restaurant', 'shop', 'grocery', 'pharmacy', 'retail', 'tickets', 'other')),
    verification        text NOT NULL DEFAULT 'pending'
                        CHECK (verification IN ('pending', 'documents_review', 'approved', 'rejected', 'suspended', 'changes_requested')),
    verification_reason text,
    commission_rate_bps int,
    payout_cycle_days   int NOT NULL DEFAULT 3,
    payout_account      text,
    is_open             boolean NOT NULL DEFAULT true,
    rating              numeric(3, 2),
    review_count        int NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_merchants_verification_created ON merchants (verification, created_at DESC, id DESC);
CREATE INDEX idx_merchants_city_id ON merchants (city_id);

CREATE TABLE providers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name                text NOT NULL,
    trade               text NOT NULL CHECK (trade IN ('plumbing', 'electrical', 'cleaning', 'repairs', 'carpentry', 'painting', 'beauty', 'wellness', 'fitness', 'education', 'automotive', 'pet_care', 'health_care', 'events', 'property', 'other')),
    bio                 text,
    avatar_url          text,
    city_id             uuid REFERENCES cities(id) ON DELETE SET NULL,
    base_rate_tzs       bigint,
    verification        text NOT NULL DEFAULT 'pending'
                        CHECK (verification IN ('pending', 'documents_review', 'approved', 'rejected', 'suspended', 'changes_requested')),
    verification_reason text,
    reliability_score   int CHECK (reliability_score BETWEEN 0 AND 100),
    rating              numeric(3, 2),
    review_count        int NOT NULL DEFAULT 0,
    payout_cycle_days   int NOT NULL DEFAULT 7,
    service_areas       jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_providers_verification_created ON providers (verification, created_at DESC, id DESC);
CREATE INDEX idx_providers_city_id ON providers (city_id);

-- +goose Down
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS merchants;
