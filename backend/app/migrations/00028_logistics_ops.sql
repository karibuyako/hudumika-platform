-- +goose Up
-- Logistics operations (backend/LOGISTICS-OS.md, backend/INTERCITY-LOGISTICS.md,
-- API-CONTRACT.yaml /trips): a trip is one vehicle departure over a route
-- (origin hub -> destination hub) with a planned departure. The route is
-- decomposed into legs (first_mile + line_haul + last_mile) that must all be
-- completed before the trip can close (TRIP_CANNOT_CLOSE). Handoffs record
-- custody transfers between hubs/vehicles with a tamper-evident seal check
-- (HANDOFF_SEAL_BROKEN); waybill_tracking is the append-only event trail
-- (departed/arrived/handoff/scan) that backs the waybill (GET
-- /orders/{orderId}/waybill) and the customer tracking phases.

CREATE TABLE trips (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code              text UNIQUE NOT NULL,
    vehicle_id        uuid NOT NULL REFERENCES vehicles(id),
    origin_hub_id     uuid NOT NULL REFERENCES hubs(id),
    destination_hub_id uuid NOT NULL REFERENCES hubs(id),
    status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
    planned_departure timestamptz,
    departed_at       timestamptz,
    arrived_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_trips_status ON trips (status);
CREATE INDEX idx_trips_vehicle_status ON trips (vehicle_id, status);

CREATE TABLE trip_legs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    sequence    int NOT NULL,
    mode        text NOT NULL CHECK (mode IN ('first_mile', 'line_haul', 'last_mile')),
    from_hub_id uuid NOT NULL REFERENCES hubs(id),
    to_hub_id   uuid NOT NULL REFERENCES hubs(id),
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
    completed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, sequence)
);

CREATE INDEX idx_trip_legs_trip_sequence ON trip_legs (trip_id, sequence);

CREATE TABLE handoffs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id         uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    leg_id          uuid REFERENCES trip_legs(id) ON DELETE CASCADE,
    from_entity_type text NOT NULL CHECK (from_entity_type IN ('hub', 'vehicle')),
    from_entity_id  uuid NOT NULL,
    to_entity_type  text NOT NULL CHECK (to_entity_type IN ('hub', 'vehicle')),
    to_entity_id    uuid NOT NULL,
    seal_verified   boolean NOT NULL DEFAULT false,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_handoffs_trip ON handoffs (trip_id);
CREATE INDEX idx_handoffs_leg ON handoffs (leg_id);

CREATE TABLE waybill_tracking (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    trip_id     uuid REFERENCES trips(id) ON DELETE CASCADE,
    event       text NOT NULL CHECK (event IN ('departed', 'arrived', 'handoff', 'scan')),
    at          timestamptz NOT NULL DEFAULT now(),
    location    text,
    note        text
);

CREATE INDEX idx_waybill_tracking_shipment_at ON waybill_tracking (shipment_id, at);

-- +goose Down
DROP TABLE IF EXISTS waybill_tracking;
DROP TABLE IF EXISTS handoffs;
DROP TABLE IF EXISTS trip_legs;
DROP TABLE IF EXISTS trips;
