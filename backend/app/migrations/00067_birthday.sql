-- +goose Up
-- BIRTHDAY REWARDS bounded context (API-CONTRACT.yaml /rewards/birthday,
-- consumer docs/CONTRACT-ADDITIONS.md "Birthday reward"): one reward row per
-- user, granted lazily on first GET /rewards/birthday (the contract User DTO
-- carries no birthday field, so the platform treats every registered
-- customer as in-window for this milestone — same rule as the consumer mock).
-- status pending -> claimed (claimed_at set); a sweep can flip expired rows
-- once valid_to passes. reward_tzs is the wallet-credit amount the claim
-- grants (credited by a future wallet flow, PAYOUTS-LEDGER.md).

CREATE TABLE birthday_rewards (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    benefit_type text NOT NULL DEFAULT 'wallet_credit' CHECK (benefit_type IN ('wallet_credit', 'voucher', 'gift')),
    title        text NOT NULL DEFAULT 'Birthday treat',
    description  text,
    reward_tzs   bigint NOT NULL DEFAULT 10000 CHECK (reward_tzs >= 0),
    valid_from   timestamptz NOT NULL,
    valid_to     timestamptz NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired')),
    claimed_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_to > valid_from)
);

CREATE INDEX idx_birthday_rewards_user ON birthday_rewards (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS birthday_rewards;