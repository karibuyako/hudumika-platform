-- +goose Up
-- Group buy bounded context (backend/DATA-MODEL.md "Group buy"): merchant
-- deals with a capped quantity, customer vouchers minted on purchase, and
-- the append-only merchant verification log. Money is bigint TZS, never
-- floating point; every status column carries a CHECK constraint.

CREATE TABLE group_buy_deals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id        uuid NOT NULL REFERENCES users(id),
    title              text NOT NULL,
    description        text,
    original_price_tzs bigint NOT NULL CHECK (original_price_tzs >= 0),
    deal_price_tzs     bigint NOT NULL CHECK (deal_price_tzs >= 0),
    quantity_total     int NOT NULL CHECK (quantity_total > 0),
    quantity_sold      int NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0 AND quantity_sold <= quantity_total),
    start_at           timestamptz NOT NULL,
    end_at             timestamptz NOT NULL,
    status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'delisted', 'ended')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (end_at > start_at)
);

CREATE INDEX idx_group_buy_deals_status_end ON group_buy_deals (status, end_at);
CREATE INDEX idx_group_buy_deals_merchant ON group_buy_deals (merchant_id);

CREATE TABLE vouchers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     uuid NOT NULL REFERENCES group_buy_deals(id),
    user_id     uuid NOT NULL REFERENCES users(id),
    code        text NOT NULL UNIQUE,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'used', 'expired', 'refunded')),
    expires_at  timestamptz NOT NULL,
    redeemed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vouchers_user_id ON vouchers (user_id);
CREATE INDEX idx_vouchers_deal_id ON vouchers (deal_id);

CREATE TABLE voucher_verifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id  uuid NOT NULL REFERENCES vouchers(id),
    merchant_id uuid NOT NULL REFERENCES users(id),
    action      text NOT NULL CHECK (action IN ('verify', 'redeem')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_voucher_verifications_merchant_created ON voucher_verifications (merchant_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS voucher_verifications;
DROP TABLE IF EXISTS vouchers;
DROP TABLE IF EXISTS group_buy_deals;
