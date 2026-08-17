-- +goose Up
-- Intercity travel bounded context (CONTRACT-ADDITIONS.md "Travel — /travel
-- resource"): a daily-repeating schedule between cities, plus customer
-- travel bookings with server-computed TZS totals. Each row is a fixed
-- route: depart_minutes is the departure offset from local midnight of the
-- REQUESTED date, so search (GET /travel/options?date=) issues concrete
-- departure/arrival timestamps for that day — the same semantics as the
-- consumer mock (mock/travel.ts optionFor). Mode accepts bus/ferry/flight
-- plus train (the consumer mock ships train as a mock-only extension until
-- the contract enum grows; OPERATIONS-COVERAGE #59/#60).
CREATE TABLE travel_options (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_city_id        text NOT NULL,
    origin_city_name      text NOT NULL,
    destination_city_id   text NOT NULL,
    destination_city_name text NOT NULL,
    mode                  text NOT NULL CHECK (mode IN ('bus', 'ferry', 'flight', 'train')),
    provider              text NOT NULL,
    operator              text,
    depart_minutes        int NOT NULL CHECK (depart_minutes BETWEEN 0 AND 1439),
    duration_minutes      int NOT NULL CHECK (duration_minutes > 0),
    price_tzs             bigint NOT NULL CHECK (price_tzs >= 0),
    seats_available       int NOT NULL CHECK (seats_available >= 0),
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_travel_options_route ON travel_options (origin_city_id, destination_city_id, mode);

CREATE TABLE travel_bookings (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    option_id            uuid NOT NULL REFERENCES travel_options(id),
    user_id              uuid NOT NULL REFERENCES users(id),
    -- Snapshots of the exact departure the user saw at booking time
    -- (mock/travel.ts records them the same way).
    mode                 text NOT NULL,
    origin_city_name     text NOT NULL,
    destination_city_name text NOT NULL,
    departure_at         timestamptz NOT NULL,
    seat_count           int NOT NULL CHECK (seat_count BETWEEN 1 AND 20),
    contact_phone        text NOT NULL,
    total_tzs            bigint NOT NULL CHECK (total_tzs >= 0),
    status               text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'completed')),
    idempotency_key      text,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_travel_bookings_user_created ON travel_bookings (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_travel_bookings_user_idempotency ON travel_bookings (user_id, idempotency_key);

-- +goose Down
DROP TABLE IF EXISTS travel_bookings;
DROP TABLE IF EXISTS travel_options;