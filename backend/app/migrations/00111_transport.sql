-- +goose Up
-- Transport bounded context: city bus, shared bikes (bike-share), and
-- ride-hailing. These endpoints are called by the consumer mobile app but
-- were previously absent from the backend contract, so they returned a raw
-- 404. This migration adds the tables and seeds reference data (routes,
-- stops, vehicles, bikes) so the read endpoints return live data; rides are
-- created at runtime by the customer.

CREATE TABLE bus_routes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    route_number      text NOT NULL,
    route_name        text NOT NULL,
    origin            text NOT NULL,
    destination       text NOT NULL,
    fare_tzs          bigint NOT NULL DEFAULT 0 CHECK (fare_tzs >= 0),
    duration_minutes  int NOT NULL DEFAULT 0,
    frequency_minutes int NOT NULL DEFAULT 0,
    operating_hours   text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bus_stops (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id   uuid NOT NULL REFERENCES bus_routes(id) ON DELETE CASCADE,
    name       text NOT NULL,
    sequence   int NOT NULL DEFAULT 0,
    lat        double precision,
    lon        double precision
);

CREATE TABLE bus_vehicles (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id           uuid NOT NULL REFERENCES bus_routes(id) ON DELETE CASCADE,
    route_number       text NOT NULL,
    plate_number       text NOT NULL,
    lat                double precision,
    lon                double precision,
    heading            double precision NOT NULL DEFAULT 0,
    next_stop_id       uuid,
    next_stop_name     text,
    next_stop_sequence int,
    occupancy          text NOT NULL DEFAULT 'low' CHECK (occupancy IN ('low', 'medium', 'high')),
    last_updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bus_vehicles_route ON bus_vehicles (route_id);

CREATE TABLE bus_reminders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id    uuid NOT NULL,
    route_number text NOT NULL,
    stop_id     uuid NOT NULL,
    stop_name   text NOT NULL,
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, route_id, stop_id)
);

CREATE INDEX idx_bus_reminders_user ON bus_reminders (user_id);

CREATE TABLE bikes (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                  text UNIQUE NOT NULL,
    type                  text NOT NULL DEFAULT 'bike' CHECK (type IN ('bike', 'ebike')),
    status                text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'riding', 'disabled')),
    lat                   double precision,
    lon                   double precision,
    battery_pct           int CHECK (battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100)),
    price_per_minute_tzs  bigint NOT NULL DEFAULT 0 CHECK (price_per_minute_tzs >= 0),
    unlock_fee_tzs        bigint NOT NULL DEFAULT 0 CHECK (unlock_fee_tzs >= 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bikes_status ON bikes (status);

CREATE TABLE bike_rides (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bike_id                   uuid NOT NULL REFERENCES bikes(id),
    bike_code                 text NOT NULL,
    bike_type                 text NOT NULL,
    status                    text NOT NULL DEFAULT 'riding' CHECK (status IN ('riding', 'locked', 'completed')),
    lock_status               text NOT NULL DEFAULT 'unlocked' CHECK (lock_status IN ('unlocked', 'locked')),
    start_at                  timestamptz NOT NULL DEFAULT now(),
    end_at                    timestamptz,
    start_lat                 double precision,
    start_lon                 double precision,
    end_lat                   double precision,
    end_lon                   double precision,
    duration_minutes          int,
    distance_km               double precision,
    fare_tzs                  bigint,
    geofence_violation        boolean NOT NULL DEFAULT false,
    payment_status            text CHECK (payment_status IN ('pending', 'paid', 'failed')),
    payment_method            text,
    fare_unlock_fee_tzs       bigint,
    fare_ride_fee_tzs         bigint,
    fare_geofence_surcharge_tzs bigint,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bike_rides_user_status ON bike_rides (user_id, status);

CREATE TABLE rides (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pickup              text NOT NULL,
    destination         text NOT NULL,
    pickup_coord        jsonb,
    destination_coord   jsonb,
    ride_type           text NOT NULL CHECK (ride_type IN ('express', 'premier', 'taxi')),
    fare_tzs            bigint NOT NULL DEFAULT 0,
    distance_km         double precision NOT NULL DEFAULT 0,
    duration_min        int NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'matching' CHECK (status IN ('matching', 'matched', 'arriving', 'in_ride', 'completed', 'cancelled')),
    driver              jsonb,
    eta_min             int,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rides_user ON rides (user_id, created_at DESC);

-- Seed reference data -------------------------------------------------------

INSERT INTO bus_routes (id, route_number, route_name, origin, destination, fare_tzs, duration_minutes, frequency_minutes, operating_hours)
VALUES
    ('b1000000-0000-0000-0000-000000000001', '14', 'City Center – Ubungo', 'City Center', 'Ubungo', 700, 35, 10, '05:00–22:00'),
    ('b1000000-0000-0000-0000-000000000002', '20', 'Mwenge – Tegeta', 'Mwenge', 'Tegeta', 900, 45, 15, '05:30–21:30');

INSERT INTO bus_stops (route_id, name, sequence, lat, lon) VALUES
    ('b1000000-0000-0000-0000-000000000001', 'City Center Terminal', 1, -6.1630, 35.7510),
    ('b1000000-0000-0000-0000-000000000001', 'Kariakoo', 2, -6.1760, 35.7460),
    ('b1000000-0000-0000-0000-000000000001', 'Ubungo', 3, -6.2140, 35.7480),
    ('b1000000-0000-0000-0000-000000000002', 'Mwenge', 1, -6.1100, 35.7820),
    ('b1000000-0000-0000-0000-000000000002', 'Mikocheni', 2, -6.0900, 35.7400),
    ('b1000000-0000-0000-0000-000000000002', 'Tegeta', 3, -6.0800, 35.7100);

INSERT INTO bus_vehicles (route_id, route_number, plate_number, lat, lon, heading, next_stop_id, next_stop_name, next_stop_sequence, occupancy)
VALUES
    ('b1000000-0000-0000-0000-000000000001', '14', 'TXYZ 401', -6.1700, 35.7480, 20, 'b1000000-0000-0000-0000-000000000001', 'Kariakoo', 2, 'medium'),
    ('b1000000-0000-0000-0000-000000000002', '20', 'TXYZ 712', -6.1000, 35.7600, 200, 'b1000000-0000-0000-0000-000000000002', 'Mikocheni', 2, 'low');

INSERT INTO bikes (code, type, status, lat, lon, battery_pct, price_per_minute_tzs, unlock_fee_tzs) VALUES
    ('BK-1001', 'bike', 'available', -6.1600, 35.7500, NULL, 150, 500),
    ('BK-1002', 'ebike', 'available', -6.1650, 35.7550, 82, 250, 800),
    ('BK-1003', 'ebike', 'available', -6.1550, 35.7450, 64, 250, 800),
    ('BK-1004', 'bike', 'available', -6.1700, 35.7400, NULL, 150, 500),
    ('BK-1005', 'ebike', 'available', -6.1500, 35.7600, 91, 250, 800);

-- +goose Down
DROP TABLE IF EXISTS rides;
DROP TABLE IF EXISTS bike_rides;
DROP TABLE IF EXISTS bikes;
DROP TABLE IF EXISTS bus_reminders;
DROP TABLE IF EXISTS bus_vehicles;
DROP TABLE IF EXISTS bus_stops;
DROP TABLE IF EXISTS bus_routes;
