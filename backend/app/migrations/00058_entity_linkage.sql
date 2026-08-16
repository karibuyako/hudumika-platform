-- +goose Up
-- Entity linkage (merchant/provider refactor): these tables carried legacy
-- FKs pointing merchant_id/provider_id at users(id) (the old
-- "user-id-as-entity" convention). Write paths now store the real merchants /
-- providers row ids, so the legacy constraints must go. Real FKs to
-- merchants(id)/providers(id) land with the schema-owner migration that
-- follows the refactor (kept separate so old rows remain readable).

ALTER TABLE IF EXISTS group_buy_deals DROP CONSTRAINT IF EXISTS group_buy_deals_merchant_id_fkey;
ALTER TABLE IF EXISTS promotions DROP CONSTRAINT IF EXISTS promotions_merchant_id_fkey;
ALTER TABLE IF EXISTS coupon_campaigns DROP CONSTRAINT IF EXISTS coupon_campaigns_merchant_id_fkey;
ALTER TABLE IF EXISTS loyalty_members DROP CONSTRAINT IF EXISTS loyalty_members_merchant_id_fkey;
ALTER TABLE IF EXISTS membership_tiers DROP CONSTRAINT IF EXISTS membership_tiers_merchant_id_fkey;
ALTER TABLE IF EXISTS voucher_verifications DROP CONSTRAINT IF EXISTS voucher_verifications_merchant_id_fkey;

-- +goose Down
-- Forward-only in production; the down restores the legacy constraints for
-- dev databases that never migrated (best-effort; old rows with user ids
-- re-validate only when they still reference existing users).
ALTER TABLE IF EXISTS group_buy_deals ADD CONSTRAINT group_buy_deals_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES users(id);
ALTER TABLE IF EXISTS promotions ADD CONSTRAINT promotions_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES users(id);
ALTER TABLE IF EXISTS coupon_campaigns ADD CONSTRAINT coupon_campaigns_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES users(id);
ALTER TABLE IF EXISTS loyalty_members ADD CONSTRAINT loyalty_members_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES users(id);
ALTER TABLE IF EXISTS membership_tiers ADD CONSTRAINT membership_tiers_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES users(id);
ALTER TABLE IF EXISTS voucher_verifications ADD CONSTRAINT voucher_verifications_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES users(id);
