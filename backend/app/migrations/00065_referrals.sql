-- +goose Up
-- REFERRALS bounded context (consumer docs/CONTRACT-ADDITIONS.md "Referral —
-- /referrals resource", backend/ERROR-CODES.md generic CONFLICT/NOT_FOUND):
-- every user owns at most one referral row (owner_user_id UNIQUE), minted
-- lazily by GET /referrals/me; referral_claims records each redeemed code.
-- A code is usable exactly once (status active -> claimed, claimed_at set).
-- reward_tzs is the owner's bounty per claim; the contract ReferralReward
-- status stays 'pending' until a crediting flow exists (none in this
-- milestone — PAYOUTS-LEDGER.md).

CREATE TABLE referrals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{5,19}$'),
    owner_user_id      uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    claimed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed')),
    reward_tzs         bigint NOT NULL DEFAULT 0 CHECK (reward_tzs >= 0),
    claimed_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_referrals_owner ON referrals (owner_user_id);

CREATE TABLE referral_claims (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_id      uuid NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
    claimant_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_tzs       bigint NOT NULL CHECK (reward_tzs >= 0),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_referral_claims_referral ON referral_claims (referral_id, created_at DESC);
CREATE INDEX idx_referral_claims_claimant ON referral_claims (claimant_user_id);

-- +goose Down
DROP TABLE IF EXISTS referral_claims;
DROP TABLE IF EXISTS referrals;