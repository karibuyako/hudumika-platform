-- +goose Up
-- Extend loyalty_redemptions so merchant-group (loyalty) redemptions can be
-- recorded against a specific merchant and member, and listed per merchant.
-- Existing columns (user_id, reward, points, value_tzs, idempotency_key) and
-- their semantics are retained for backward compatibility with the consumer
-- /loyalty/redemptions flow.

ALTER TABLE loyalty_redemptions
  ADD COLUMN IF NOT EXISTS merchant_id uuid REFERENCES merchants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES loyalty_members(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS reason text;

-- Allow the group/merchant redemption reward types in addition to the
-- consumer-facing reward types already constrained on the table.
ALTER TABLE loyalty_redemptions
  DROP CONSTRAINT IF EXISTS loyalty_redemptions_reward_check;

ALTER TABLE loyalty_redemptions
  ADD CONSTRAINT loyalty_redemptions_reward_check
  CHECK (reward = ANY (ARRAY[
    'wallet_credit'::text,
    'delivery_discount'::text,
    'free_delivery'::text,
    'points_redemption'::text,
    'merchant_credit'::text
  ]));

CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_merchant ON loyalty_redemptions (merchant_id, created_at DESC);

-- +goose Down
ALTER TABLE loyalty_redemptions DROP CONSTRAINT IF EXISTS loyalty_redemptions_reward_check;
ALTER TABLE loyalty_redemptions
  ADD CONSTRAINT loyalty_redemptions_reward_check
  CHECK (reward = ANY (ARRAY['wallet_credit'::text,'delivery_discount'::text,'free_delivery'::text']));
ALTER TABLE loyalty_redemptions DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE loyalty_redemptions DROP COLUMN IF EXISTS member_id;
ALTER TABLE loyalty_redemptions DROP COLUMN IF EXISTS reason;
DROP INDEX IF EXISTS idx_loyalty_redemptions_merchant;
