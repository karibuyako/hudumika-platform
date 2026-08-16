-- +goose Up
-- SWEEP (REMAINING-501 closure): tables and columns the sweep handlers need
-- that no milestone migration created. Everything here is additive; the two
-- status CHECK rewrites only extend the allowed enums ('held' for rider-held
-- orders, 'paused' for paused bookings) and never narrow them.
--
-- 1. Order holds: HoldOrder/UnholdOrder move an order to/from 'held'. The
--    original CHECK was created in 00005_orders.sql; the rewrite keeps every
--    existing value and adds 'held'.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status = ANY (ARRAY[
        'draft', 'pending_payment', 'paid', 'merchant_accepted', 'preparing',
        'rider_assigned', 'picked_up', 'delivering', 'delivered', 'completed',
        'cancelled', 'refunded', 'failed', 'disputed', 'held'
    ]::text[]));

-- 2. Booking pauses: PauseBooking moves a booking to/from 'paused'.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status = ANY (ARRAY[
        'draft', 'pending_payment', 'paid', 'provider_requested',
        'provider_accepted', 'scheduled', 'provider_arrived', 'in_progress',
        'awaiting_customer_confirmation', 'completed', 'declined', 'cancelled',
        'refunded', 'disputed', 'no_show', 'paused'
    ]::text[]));

-- 3. AssignBookingTechnician: the assigned technician on a booking. The
--    column is additive and idempotent (IF NOT EXISTS) so the migration
--    applies even where an earlier change already added it.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_id uuid REFERENCES provider_staff(id);

-- 4. Rider tips (TipRider): an immutable record of a customer tip on an
--    order. Money is integer TZS; the rider column is nullable because a tip
--    can be recorded before a rider is assigned (best-effort reconciliation
--    happens at settlement, out of scope here).
CREATE TABLE tips (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id   uuid NOT NULL,
    rider_id   uuid REFERENCES riders(id),
    amount_tzs bigint NOT NULL CHECK (amount_tzs > 0),
    method     text,
    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tips_order ON tips (order_id);

-- 5. Delivery proofs (SubmitProofOfDelivery): photo/signature/OTP capture
--    for an order delivery. The submitted value is stored (a photo URL, a
--    signature data URL, or an OTP hash — never a plaintext OTP).
CREATE TABLE delivery_proofs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      uuid NOT NULL,
    type          text NOT NULL CHECK (type IN ('photo', 'signature', 'otp')),
    value         text NOT NULL,
    document_url  text,
    dropoff_option text,
    gps_stamp     jsonb,
    verified      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_delivery_proofs_order ON delivery_proofs (order_id);

-- 6. Expenses (List/Create/DeleteExpense): owner-scoped expense records.
CREATE TABLE expenses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category      text NOT NULL,
    amount_tzs    bigint NOT NULL CHECK (amount_tzs >= 0),
    incurred_at   timestamptz NOT NULL,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_owner_incurred ON expenses (owner_user_id, incurred_at);

-- 7. SOS alerts (CreateSosAlert): rider emergency alerts to dispatch and
--    safety ops.
CREATE TABLE sos_alerts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         text NOT NULL CHECK (type IN ('safety', 'medical', 'mechanical', 'other')),
    note         text,
    lat          double precision,
    lon          double precision,
    status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sos_alerts_status_created ON sos_alerts (status, created_at);

-- 8. Service warranties (IssueServiceWarranty): warranty issued on booking
--    completion with an optional follow-up schedule.
CREATE TABLE service_warranties (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    valid_days  integer NOT NULL CHECK (valid_days > 0),
    coverage    text,
    follow_up_at timestamptz,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'claimed')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_warranties_booking ON service_warranties (booking_id);

-- 9. Service invoices (IssueServiceInvoice): the final labor+parts+trip
--    invoice for a booking.
CREATE TABLE service_invoices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    labor_tzs    bigint NOT NULL CHECK (labor_tzs >= 0),
    parts_tzs    bigint NOT NULL DEFAULT 0 CHECK (parts_tzs >= 0),
    trip_fee_tzs bigint NOT NULL DEFAULT 0 CHECK (trip_fee_tzs >= 0),
    tax_tzs      bigint NOT NULL DEFAULT 0 CHECK (tax_tzs >= 0),
    discount_tzs bigint NOT NULL DEFAULT 0 CHECK (discount_tzs >= 0),
    total_tzs    bigint NOT NULL CHECK (total_tzs >= 0),
    note         text,
    status       text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
    issued_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_invoices_booking ON service_invoices (booking_id);

-- 10. Refund requests (ListRefundRequests, ApproveRefundRequest,
--     RejectRefundRequest, AdminRefundDecision): the customer-initiated
--     queue with the finance decision recorded on the row.
CREATE TABLE refunds (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        uuid NOT NULL,
    customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_tzs      bigint NOT NULL CHECK (amount_tzs > 0),
    reason          text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
    decision_reason text,
    decision_by     uuid,
    decided_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_refunds_customer_created ON refunds (customer_user_id, created_at DESC);
CREATE INDEX idx_refunds_status_created ON refunds (status, created_at DESC);

-- 11. User status (AdminSetUserStatus): active/suspended flag on users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended'));

-- 12. Store payment account verification (VerifyStorePaymentAccount).
ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;

-- 13. Facility rider whitelists (PutFacilityWhitelist): fixed-rider
--     credential access for secure facilities.
CREATE TABLE facility_whitelists (
    facility_id uuid NOT NULL,
    rider_id    uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (facility_id, rider_id)
);

-- +goose Down
DROP TABLE IF EXISTS facility_whitelists;

ALTER TABLE payment_accounts DROP COLUMN IF EXISTS verified;
ALTER TABLE users DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS refunds;
DROP TABLE IF EXISTS service_invoices;
DROP TABLE IF EXISTS service_warranties;
DROP TABLE IF EXISTS sos_alerts;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS delivery_proofs;
DROP TABLE IF EXISTS tips;

ALTER TABLE bookings DROP COLUMN IF EXISTS technician_id;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status = ANY (ARRAY[
        'draft', 'pending_payment', 'paid', 'provider_requested',
        'provider_accepted', 'scheduled', 'provider_arrived', 'in_progress',
        'awaiting_customer_confirmation', 'completed', 'declined', 'cancelled',
        'refunded', 'disputed', 'no_show'
    ]::text[]));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status = ANY (ARRAY[
        'draft', 'pending_payment', 'paid', 'merchant_accepted', 'preparing',
        'rider_assigned', 'picked_up', 'delivering', 'delivered', 'completed',
        'cancelled', 'refunded', 'failed', 'disputed'
    ]::text[]));
