-- +goose Up
-- Allow coupon campaigns to be stopped by merchants (POST /campaigns/{id}/stop).
ALTER TABLE coupon_campaigns DROP CONSTRAINT IF EXISTS coupon_campaigns_status_check;
ALTER TABLE coupon_campaigns ADD CONSTRAINT coupon_campaigns_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'live'::text, 'ended'::text, 'stopped'::text]));

-- +goose Down
ALTER TABLE coupon_campaigns DROP CONSTRAINT IF EXISTS coupon_campaigns_status_check;
ALTER TABLE coupon_campaigns ADD CONSTRAINT coupon_campaigns_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'live'::text, 'ended'::text]));
