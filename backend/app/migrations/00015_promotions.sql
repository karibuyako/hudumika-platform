-- +goose Up
-- Promotions and coupons bounded context (backend/DATA-MODEL.md
-- "Promotions and coupons"). Promotion rules (discount %, spend thresholds,
-- bargain floors) live in the rules jsonb; spend and budget are TZS bigints.
-- Merchant identities are users.id for this milestone (catalogueMerchantID
-- convention, internal/api/catalogues.go).

CREATE TABLE promotions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES users(id),
    type          text NOT NULL CHECK (type IN ('discount', 'spend_based', 'instant_discount', 'bargain', 'coupon', 'traffic')),
    title         text NOT NULL,
    description   text,
    rules         jsonb NOT NULL DEFAULT '{}'::jsonb,
    budget_tzs    bigint CHECK (budget_tzs IS NULL OR budget_tzs >= 0),
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'live', 'paused', 'rejected', 'ended')),
    starts_at     timestamptz NOT NULL,
    ends_at       timestamptz NOT NULL,
    redeem_count  int NOT NULL DEFAULT 0 CHECK (redeem_count >= 0),
    spend_tzs     bigint NOT NULL DEFAULT 0 CHECK (spend_tzs >= 0),
    reject_reason text,
    performance   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

CREATE INDEX idx_promotions_merchant_status ON promotions (merchant_id, status);
CREATE INDEX idx_promotions_status_ends ON promotions (status, ends_at);

CREATE TABLE coupon_campaigns (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       uuid NOT NULL REFERENCES users(id),
    title             text NOT NULL,
    discount_tzs      bigint NOT NULL DEFAULT 0 CHECK (discount_tzs >= 0),
    minimum_spend_tzs bigint NOT NULL DEFAULT 0 CHECK (minimum_spend_tzs >= 0),
    quantity          int NOT NULL CHECK (quantity > 0),
    claimed_count     int NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
    valid_until       timestamptz NOT NULL,
    status            text NOT NULL DEFAULT 'live' CHECK (status IN ('draft', 'live', 'ended')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_coupon_campaigns_merchant_status ON coupon_campaigns (merchant_id, status);
CREATE INDEX idx_coupon_campaigns_merchant_created ON coupon_campaigns (merchant_id, created_at DESC);

CREATE TABLE coupons (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id     uuid NOT NULL REFERENCES coupon_campaigns(id) ON DELETE CASCADE,
    code            text NOT NULL UNIQUE,
    customer_user_id uuid REFERENCES users(id),
    status          text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'claimed', 'used', 'expired', 'void')),
    claimed_at      timestamptz,
    used_at         timestamptz,
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_coupons_campaign_status ON coupons (campaign_id, status);
CREATE INDEX idx_coupons_customer_status ON coupons (customer_user_id, status);
-- One claim per (campaign, user): NULL customer_user_id rows (pre-generated
-- vouchers) stay unrestricted because NULLs never collide in a unique index.
CREATE UNIQUE INDEX idx_coupons_campaign_customer ON coupons (campaign_id, customer_user_id) WHERE customer_user_id IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS coupons;
DROP TABLE IF EXISTS coupon_campaigns;
DROP TABLE IF EXISTS promotions;
