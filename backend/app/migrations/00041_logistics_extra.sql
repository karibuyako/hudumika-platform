-- +goose Up
-- Logistics extra registry (LOGISTICS-EXTRA, API-CONTRACT.yaml /routes
-- /warehouses /carriers /facilities /linehaul/consignments
-- /delivery-exceptions): transport routes/corridors between hubs, the
-- regional warehouse registry, the third-party carrier registry, secure
-- facilities, line-haul consignments (batches of orders on a route/carrier)
-- and the delivery-exception catalog.
--
-- The consignment state machine is assembling -> sealed -> departed ->
-- arrived (seal is an ops-side action; the contract surface drives
-- create/depart/arrive). Consignment codes are server-assigned (CN-<8 hex>)
-- and unique.

CREATE TABLE routes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_hub_id     uuid,
    destination_hub_id uuid,
    distance_km       numeric(8, 2) NOT NULL DEFAULT 0,
    duration_minutes  int NOT NULL DEFAULT 0,
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT routes_pair_unique UNIQUE (origin_hub_id, destination_hub_id)
);

CREATE TABLE warehouses (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    city        text,
    capacity_kg numeric(10, 2) NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'out_of_service')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE carriers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    mode       text NOT NULL CHECK (mode IN ('linehaul', 'air', 'rail')),
    regions    jsonb NOT NULL DEFAULT '[]',
    status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    kind       text NOT NULL DEFAULT 'hub' CHECK (kind IN ('hub', 'depot', 'rest_stop')),
    hub_id     uuid,
    city       text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consignments (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code               text UNIQUE,
    origin_hub_id      uuid,
    destination_hub_id uuid,
    route_id           uuid REFERENCES routes(id),
    carrier_id         uuid REFERENCES carriers(id),
    status             text NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling', 'sealed', 'departed', 'arrived')),
    capacity_kg        numeric(10, 2) NOT NULL DEFAULT 0,
    weight_kg          numeric(10, 2) NOT NULL DEFAULT 0,
    order_ids          jsonb NOT NULL DEFAULT '[]',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_consignments_status ON consignments (status);
CREATE INDEX idx_consignments_created ON consignments (created_at, id);

CREATE TABLE delivery_exceptions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL,
    kind        text NOT NULL DEFAULT 'other' CHECK (kind IN ('delay', 'damage', 'address', 'weather', 'other')),
    description text,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE INDEX idx_delivery_exceptions_status ON delivery_exceptions (status);
CREATE INDEX idx_delivery_exceptions_shipment ON delivery_exceptions (shipment_id, created_at, id);

-- +goose Down
DROP TABLE IF EXISTS delivery_exceptions;
DROP TABLE IF EXISTS consignments;
DROP TABLE IF EXISTS facilities;
DROP TABLE IF EXISTS carriers;
DROP TABLE IF EXISTS warehouses;
DROP TABLE IF EXISTS routes;
