-- +goose Up
-- MERCHANT-EXTRA bounded context (API-CONTRACT.yaml /merchants/claim,
-- /merchants/me/settings, /merchants/me/payout-account,
-- /merchants/me/closure-protection): listing claims, store operational
-- settings, payout account and annual closure-protection quota. Chain
-- stores stay in chain_stores (00022) — merchant_store_links is skipped on
-- purpose (the chain table covers stores).

CREATE TABLE merchant_claims (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    claimer_user_id uuid REFERENCES users(id),
    proof           text,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, claimer_user_id)
);

CREATE TABLE store_settings (
    merchant_id         uuid PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
    currency            text NOT NULL DEFAULT 'TZS',
    timezone            text NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
    opening_hours       jsonb NOT NULL DEFAULT '{}',
    accept_while_closed boolean NOT NULL DEFAULT false,
    min_order_tzs       bigint NOT NULL DEFAULT 0,
    preorders_enabled   boolean NOT NULL DEFAULT false,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_payout_accounts (
    merchant_id    uuid PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
    type           text NOT NULL CHECK (type IN ('bank', 'mobile_money')),
    account_number text NOT NULL,
    account_name   text NOT NULL,
    verified       boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE closure_protection (
    merchant_id   uuid PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
    annual_quota  int NOT NULL DEFAULT 2,
    used_closures int NOT NULL DEFAULT 0,
    renewal_date  date,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS closure_protection;
DROP TABLE IF EXISTS merchant_payout_accounts;
DROP TABLE IF EXISTS store_settings;
DROP TABLE IF EXISTS merchant_claims;
