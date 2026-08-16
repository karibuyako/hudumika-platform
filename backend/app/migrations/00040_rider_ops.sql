-- +goose Up
-- RIDER-OPS (backend/DATA-MODEL.md §riders; ERROR-CODES.md §Dispatch and
-- delivery exceptions): rider shift scheduling with clock-in/out and COD
-- cash collection, in-shift breaks, and live trip share invitations.
--
-- rider_shifts.status follows the storage enum (scheduled, active, ended,
-- cancelled, swapped) used by the API mapping layer: ended reads back as the
-- contract "completed" and swapped as "cancelled" (the swapped shift is no
-- longer worked by its original rider). Shift rows are rider-owned and
-- cascade with the riders row.

CREATE TABLE rider_shifts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id           uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    start_at           timestamptz NOT NULL,
    end_at             timestamptz NOT NULL,
    status             text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled', 'swapped')),
    swappable          boolean NOT NULL DEFAULT false,
    swap_requested_at  timestamptz,
    swap_reason        text,
    clocked_in_at      timestamptz,
    clocked_out_at     timestamptz,
    collected_cash_tzs bigint NOT NULL DEFAULT 0 CHECK (collected_cash_tzs >= 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (end_at > start_at)
);

CREATE INDEX idx_rider_shifts_rider_status ON rider_shifts (rider_id, status);
CREATE INDEX idx_rider_shifts_rider_start ON rider_shifts (rider_id, start_at);

-- Breaks are shift-scoped; a break is open while ended_at is NULL (partial
-- unique guarantees at most one open break per shift).
CREATE TABLE rider_breaks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id   uuid NOT NULL REFERENCES rider_shifts(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL,
    ended_at   timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_rider_breaks_open ON rider_breaks (shift_id) WHERE ended_at IS NULL;

-- Trip shares: a rider shares a live order with trusted recipients
-- (recipient phones map to rider rows when a match exists; the contract has
-- no accept/decline surface, so rows stay pending until they expire).
CREATE TABLE trip_shares (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_rider_id        uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    shared_with_rider_id uuid REFERENCES riders(id) ON DELETE CASCADE,
    order_id             uuid NOT NULL,
    status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    expires_at           timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_trip_shares_rider_order ON trip_shares (trip_rider_id, order_id);

-- +goose Down
DROP TABLE IF EXISTS trip_shares;
DROP TABLE IF EXISTS rider_breaks;
DROP TABLE IF EXISTS rider_shifts;
