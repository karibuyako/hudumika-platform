-- +goose Up
-- Loyalty bounded context (backend/DATA-MODEL.md "Loyalty (merchant-operated)"):
-- merchant-operated membership programs with a TZS prepaid balance,
-- configurable tiers and top-up rewards, and an append-only per-member
-- transaction ledger. Money is bigint TZS, never floating point; every
-- ledger row carries the running balance so balances are never derived by
-- summation (backend/PAYOUTS-LEDGER.md ledger pattern).

CREATE TABLE membership_tiers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES users(id),
    name          text NOT NULL,
    discount_bps  int NOT NULL DEFAULT 0 CHECK (discount_bps >= 0),
    threshold_tzs bigint NOT NULL DEFAULT 0 CHECK (threshold_tzs >= 0),
    perks         jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, name)
);

CREATE INDEX idx_membership_tiers_merchant ON membership_tiers (merchant_id);

CREATE TABLE loyalty_members (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id      uuid NOT NULL REFERENCES users(id),
    customer_user_id uuid REFERENCES users(id),
    name             text NOT NULL,
    phone            text NOT NULL,
    balance_tzs      bigint NOT NULL DEFAULT 0 CHECK (balance_tzs >= 0),
    tier_id          uuid REFERENCES membership_tiers(id),
    total_spend_tzs  bigint NOT NULL DEFAULT 0 CHECK (total_spend_tzs >= 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, phone)
);

CREATE INDEX idx_loyalty_members_merchant_created ON loyalty_members (merchant_id, created_at DESC, id DESC);
CREATE INDEX idx_loyalty_members_phone ON loyalty_members (phone);

-- Append-only per-member ledger: every row stores the member's running
-- balance after the entry, and the id is used as the keyset pagination
-- column (entries are created in a serialized transaction per member).
CREATE TABLE loyalty_transactions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id   uuid NOT NULL REFERENCES loyalty_members(id),
    type        text NOT NULL CHECK (type IN ('top_up', 'bonus', 'redeem', 'spend')),
    amount_tzs  bigint NOT NULL CHECK (amount_tzs <> 0),
    balance_tzs bigint NOT NULL CHECK (balance_tzs >= 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_transactions_member_created ON loyalty_transactions (member_id, created_at DESC, id DESC);

CREATE TABLE membership_top_up_rewards (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES users(id),
    threshold_tzs bigint NOT NULL CHECK (threshold_tzs >= 0),
    bonus_tzs     bigint NOT NULL CHECK (bonus_tzs >= 0),
    UNIQUE (merchant_id, threshold_tzs)
);

CREATE INDEX idx_membership_top_up_rewards_merchant ON membership_top_up_rewards (merchant_id);

-- Platform-wide customer points balance (one row per user).
CREATE TABLE customer_memberships (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    points       int NOT NULL DEFAULT 0 CHECK (points >= 0),
    level        text NOT NULL DEFAULT 'bronze',
    member_since date NOT NULL DEFAULT CURRENT_DATE
);

-- +goose Down
DROP TABLE IF EXISTS customer_memberships;
DROP TABLE IF EXISTS membership_top_up_rewards;
DROP TABLE IF EXISTS loyalty_transactions;
DROP TABLE IF EXISTS loyalty_members;
DROP TABLE IF EXISTS membership_tiers;
