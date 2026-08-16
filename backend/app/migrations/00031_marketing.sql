-- +goose Up
-- Marketing bounded context (backend/ERROR-CODES.md "Marketing"): platform
-- traffic events, merchant flash sales, precision segmentation campaigns,
-- DianJin (PPC) campaigns, brand display and self-service promotion toggles.
-- Money is int64 TZS only. merchant_id columns deliberately carry no FK,
-- following the milestone convention (merchant id is the authenticated users
-- row id, same as promotions/catalogues).

CREATE TABLE platform_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    description text,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    status      text NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'active', 'closed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_events_status_starts ON platform_events (status, starts_at);

CREATE TABLE flash_sales (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       uuid NOT NULL,
    item_id           uuid NOT NULL,
    title             text NOT NULL,
    price_tzs         bigint NOT NULL,
    original_price_tzs bigint NOT NULL,
    quantity          int NOT NULL DEFAULT 0,
    sold              int NOT NULL DEFAULT 0,
    starts_at         timestamptz NOT NULL,
    ends_at           timestamptz NOT NULL,
    status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'active', 'ended')),
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_flash_sales_merchant_created ON flash_sales (merchant_id, created_at DESC);

CREATE TABLE precision_campaigns (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    title       text NOT NULL,
    segment     jsonb NOT NULL,
    budget_tzs  bigint NOT NULL DEFAULT 0,
    spent_tzs   bigint NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'paused', 'ended')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_precision_campaigns_merchant_created ON precision_campaigns (merchant_id, created_at DESC);

CREATE TABLE dianjin_campaigns (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    title       text NOT NULL,
    budget_tzs  bigint NOT NULL DEFAULT 0,
    spent_tzs   bigint NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'paused', 'ended')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dianjin_campaigns_merchant_created ON dianjin_campaigns (merchant_id, created_at DESC);

CREATE TABLE brand_display (
    merchant_id uuid PRIMARY KEY,
    enabled     boolean NOT NULL DEFAULT false,
    banner_url  text,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE self_service (
    merchant_id uuid PRIMARY KEY,
    enabled     boolean NOT NULL DEFAULT false,
    features    jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS platform_events;
DROP TABLE IF EXISTS flash_sales;
DROP TABLE IF EXISTS precision_campaigns;
DROP TABLE IF EXISTS dianjin_campaigns;
DROP TABLE IF EXISTS brand_display;
DROP TABLE IF EXISTS self_service;
