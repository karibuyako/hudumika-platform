-- +goose Up
-- Merchant staff operations and devices (backend/DATA-MODEL.md §merchant
-- staff and devices): merchant_staff, devices, staff_shifts, attendance and
-- commission_rules. merchant_id is the owning merchant's users row id (same
-- milestone simplification as the catalogues context).

CREATE TABLE merchant_staff (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    role        text NOT NULL DEFAULT 'cashier'
                CHECK (role IN ('owner', 'manager', 'cashier', 'kitchen', 'waiter')),
    phone       text NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, phone)
);

CREATE INDEX idx_merchant_staff_merchant ON merchant_staff (merchant_id);

CREATE TABLE devices (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    type        text NOT NULL CHECK (type IN ('printer', 'pos', 'tablet', 'kiosk')),
    name        text NOT NULL,
    status      text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'disabled')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_merchant ON devices (merchant_id);

CREATE TABLE staff_shifts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    staff_id    uuid NOT NULL REFERENCES merchant_staff(id) ON DELETE CASCADE,
    start_at    timestamptz NOT NULL,
    end_at      timestamptz NOT NULL,
    status      text NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (end_at > start_at)
);

CREATE INDEX idx_staff_shifts_merchant_staff_start ON staff_shifts (merchant_id, staff_id, start_at);

CREATE TABLE attendance (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id    uuid NOT NULL,
    staff_id       uuid NOT NULL REFERENCES merchant_staff(id) ON DELETE CASCADE,
    shift_id       uuid REFERENCES staff_shifts(id) ON DELETE SET NULL,
    clocked_in_at  timestamptz NOT NULL,
    clocked_out_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attendance_staff_clocked_in ON attendance (staff_id, clocked_in_at DESC);
CREATE INDEX idx_attendance_merchant_clocked_in ON attendance (merchant_id, clocked_in_at DESC);

-- Single-winner guarantee for staff self-service clock-in: at most one OPEN
-- (clocked_out_at IS NULL) record per staff. Concurrent clock-in requests
-- race; the constraint decides, and the handler maps the miss to
-- ATTENDANCE_ALREADY_CLOCKED_IN.
CREATE UNIQUE INDEX idx_attendance_open_unique ON attendance (staff_id) WHERE clocked_out_at IS NULL;

CREATE TABLE commission_rules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    rate_bps    int NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    applies_to  text NOT NULL DEFAULT 'delivery'
                CHECK (applies_to IN ('delivery', 'dine_in', 'takeaway')),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_commission_rules_merchant ON commission_rules (merchant_id);

-- +goose Down
DROP TABLE IF EXISTS commission_rules;
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS staff_shifts;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS merchant_staff;
