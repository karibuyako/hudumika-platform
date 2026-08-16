-- +goose Up
-- Bookings bounded context (backend/DATA-MODEL.md "Bookings",
-- backend/PAYMENTS.md escrow): customer service bookings with
-- server-computed TZS totals, the append-only event log, and the price
-- column the services catalogue (00004) still lacks. Provider identities
-- land with the providers milestone, so provider_id is a plain uuid for
-- now.

ALTER TABLE services ADD COLUMN IF NOT EXISTS price_tzs bigint NOT NULL DEFAULT 0 CHECK (price_tzs >= 0);

CREATE TABLE bookings (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_user_id  uuid NOT NULL REFERENCES users(id),
    provider_id       uuid NOT NULL,
    service_id        uuid REFERENCES services(id),
    status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_payment', 'paid', 'provider_requested', 'provider_accepted', 'scheduled', 'provider_arrived', 'in_progress', 'awaiting_customer_confirmation', 'completed', 'declined', 'cancelled', 'refunded', 'disputed', 'no_show')),
    scheduled_for     timestamptz NOT NULL,
    duration_minutes  int,
    subtotal_tzs      bigint NOT NULL DEFAULT 0,
    delivery_fee_tzs  bigint NOT NULL DEFAULT 0,
    platform_fee_tzs  bigint NOT NULL DEFAULT 0,
    tax_tzs           bigint NOT NULL DEFAULT 0,
    discount_tzs      bigint NOT NULL DEFAULT 0,
    total_tzs         bigint NOT NULL DEFAULT 0,
    address           jsonb,
    description       text,
    idempotency_key   text,
    version           int NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_customer_created ON bookings (customer_user_id, created_at DESC);
CREATE INDEX idx_bookings_provider_status ON bookings (provider_id, status);
CREATE INDEX idx_bookings_service_id ON bookings (service_id);
CREATE UNIQUE INDEX idx_bookings_customer_idempotency ON bookings (customer_user_id, idempotency_key);

CREATE TABLE booking_events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    status     text NOT NULL,
    at         timestamptz NOT NULL DEFAULT now(),
    by         uuid,
    note       text
);

CREATE INDEX idx_booking_events_booking_id ON booking_events (booking_id, at);

-- +goose Down
DROP TABLE IF EXISTS booking_events;
DROP TABLE IF EXISTS bookings;
ALTER TABLE services DROP COLUMN IF EXISTS price_tzs;
