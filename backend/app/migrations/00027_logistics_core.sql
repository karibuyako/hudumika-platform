-- +goose Up
-- Logistics core (backend/LOGISTICS-OS.md, backend/INTERCITY-LOGISTICS.md,
-- API-CONTRACT.yaml /shipments /containers /vehicles /hubs): consolidation
-- hubs, the vehicle registry, grouping containers, shipments (the physical
-- twin of an order) with packages, and the append-only shipment event ledger
-- that doubles as the custody chain. One order -> one shipment
-- (shipments.order_id is unique; SHIPMENT_ALREADY_EXISTS enforces it).
-- Waybill numbers are server-assigned (WB-<8 hex>) and globally unique.

CREATE TABLE hubs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    city       text,
    city_id    uuid,
    code       text UNIQUE,
    capacity   int NOT NULL DEFAULT 0,
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hub_id      uuid REFERENCES hubs(id),
    plate       text UNIQUE,
    vehicle_type text NOT NULL CHECK (vehicle_type IN ('bike', 'van', 'truck')),
    capacity_kg numeric(10, 2) NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'retired')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE containers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hub_id     uuid REFERENCES hubs(id),
    code       text UNIQUE,
    kind       text NOT NULL DEFAULT 'bag' CHECK (kind IN ('bag', 'cage', 'pallet', 'lockbox', 'refrigerated_unit')),
    section    text CHECK (section IN ('standard', 'fragile', 'cold_chain', 'documents', 'high_value')),
    status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sealed', 'in_transit', 'arrived')),
    sealed_at  timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           uuid UNIQUE,
    waybill_number     text UNIQUE,
    status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'at_hub', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'frozen')),
    origin_hub_id      uuid REFERENCES hubs(id),
    destination_hub_id uuid REFERENCES hubs(id),
    current_location   text,
    custody_hub_id     uuid REFERENCES hubs(id),
    custody_kind       text NOT NULL DEFAULT 'none' CHECK (custody_kind IN ('none', 'hub', 'vehicle', 'rider')),
    vehicle_id         uuid REFERENCES vehicles(id),
    frozen             boolean NOT NULL DEFAULT false,
    frozen_reason      text,
    frozen_at          timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_shipments_status ON shipments (status);
CREATE INDEX idx_shipments_waybill ON shipments (waybill_number);

CREATE TABLE packages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    weight_kg   numeric(10, 2),
    volume_l    numeric(10, 2),
    attributes  jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    status      text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    by          uuid,
    note        text,
    hub_id      uuid REFERENCES hubs(id),
    vehicle_id  uuid REFERENCES vehicles(id),
    lat         numeric(10, 7),
    lon         numeric(10, 7)
);

CREATE INDEX idx_shipment_events_shipment ON shipment_events (shipment_id, at, id);

-- Additive (IF NOT EXISTS): the status held before an ops freeze, so
-- unfreeze resumes the shipment from its pre-freeze state instead of the
-- generic initial state (LOGISTICS-OS.md §27).
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS status_before_freeze text;

-- +goose Down
DROP TABLE IF EXISTS shipment_events;
DROP TABLE IF EXISTS packages;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS containers;
DROP TABLE IF EXISTS vehicles;
DROP TABLE IF EXISTS hubs;
