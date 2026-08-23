-- +goose Up
-- Coupon suggestions are read-only (POST /coupons/suggest ranks the wallet
-- coupons by discountTZS vs minimumSpendTZS). No new table — the existing
-- coupon_campaigns / coupons tables (00015,00031) already carry the data.
-- This migration adds a suggestion-audit table so the advisory chip can be
-- traced (which coupons were considered, which was suggested) per request.
-- The API is stateless — the audit is fire-and-forget.

CREATE TABLE coupon_suggestions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id     uuid,
    subtotal_tzs    integer NOT NULL CHECK (subtotal_tzs >= 0),
    suggested_coupon_id uuid,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_coupon_suggestions_user ON coupon_suggestions (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS coupon_suggestions;
