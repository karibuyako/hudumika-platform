-- +goose Up
-- ADMIN-EXTRA bounded context (API-CONTRACT.yaml /admin/banners,
-- /admin/features, /admin/help/articles): banner placements, feature flags
-- and help-center articles.
--
-- The banners placement CHECK mirrors the contract AdminBanner enum
-- (home_top/home_middle/category/checkout/activity), not the older
-- (home,merchant,provider,rider) sketch — the API can only ever write
-- values the contract accepts, so the constraint must admit them.
-- help_articles carries category and published even though the milestone
-- sketch omitted them: the create/update request bodies and both responses
-- require category, and published defaults true per the contract.

CREATE TABLE banners (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title      text NOT NULL,
    image_url  text,
    placement  text NOT NULL CHECK (placement IN ('home_top', 'home_middle', 'category', 'checkout', 'activity')),
    starts_at  timestamptz,
    ends_at    timestamptz,
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_banners_placement_created ON banners (placement, created_at DESC);

CREATE TABLE feature_flags (
    key         text PRIMARY KEY,
    description text NOT NULL DEFAULT '',
    enabled     boolean NOT NULL DEFAULT false,
    rollout     numeric(3,2) NOT NULL DEFAULT 1 CHECK (rollout >= 0 AND rollout <= 1),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE help_articles (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title      text NOT NULL,
    body       text NOT NULL DEFAULT '',
    slug       text NOT NULL UNIQUE,
    category   text NOT NULL DEFAULT '',
    published  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_help_articles_updated ON help_articles (updated_at DESC);

-- Group buy moderation (API-CONTRACT.yaml /admin/group-buys/*): the 00014
-- status CHECK only admits draft/active/delisted/ended, but the decision
-- endpoint transitions deals to pending_review/rejected and DATA-MODEL.md
-- documents the full enum. The added values are strictly additive — the
-- groupbuy store's existing writes ('active', 'delisted') stay valid, and
-- 'active' remains the canonical live state (the store reads it, so the
-- contract name 'live' is mapped, never written). goose runs each migration
-- once, so no idempotency guard is needed here.
ALTER TABLE group_buy_deals
    DROP CONSTRAINT IF EXISTS group_buy_deals_status_check,
    ADD CONSTRAINT group_buy_deals_status_check_admin_extra
        CHECK (status IN ('draft', 'pending_review', 'active', 'extended', 'delisted', 'ended', 'rejected'));

-- +goose Down
ALTER TABLE group_buy_deals DROP CONSTRAINT IF EXISTS group_buy_deals_status_check_admin_extra;
ALTER TABLE group_buy_deals
    ADD CONSTRAINT group_buy_deals_status_check
    CHECK (status IN ('draft', 'active', 'delisted', 'ended'));
DROP TABLE IF EXISTS help_articles;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS banners;
