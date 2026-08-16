-- +goose Up
-- BOOKINGS-EXTRA surface (backend/ERROR-CODES.md: bookings; DATA-MODEL.md
-- "booking_quotes / booking_parts / service_invoices / service_warranties"):
-- provider final quotes with line-item parts and proof-of-service capture
-- (photos, signature, notes, customer OTP). Money is int64 TZS only; the
-- quote total is always computed server-side and the OTP is stored only as
-- its SHA-256 hash.

CREATE TABLE booking_quotes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    provider_id uuid NOT NULL,
    amount_tzs  bigint NOT NULL CHECK (amount_tzs > 0),
    valid_until timestamptz,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_quotes_booking_id ON booking_quotes (booking_id, created_at DESC);

CREATE TABLE booking_parts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id      uuid NOT NULL REFERENCES booking_quotes(id) ON DELETE CASCADE,
    name          text NOT NULL,
    quantity      int NOT NULL DEFAULT 1,
    unit_cost_tzs bigint NOT NULL DEFAULT 0,
    total_tzs     bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_booking_parts_quote_id ON booking_parts (quote_id);

CREATE TABLE proof_of_service (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id    uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    submitted_by  uuid,
    media_url     text,
    note          text,
    otp_code_hash text,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS proof_of_service;
DROP TABLE IF EXISTS booking_parts;
DROP TABLE IF EXISTS booking_quotes;
