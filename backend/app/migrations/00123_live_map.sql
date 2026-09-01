-- +goose Up
-- Rider/vehicle live location tracking
CREATE TABLE IF NOT EXISTS live_locations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('rider', 'vehicle')),
    entity_id   uuid NOT NULL,
    lat         double precision NOT NULL,
    lon         double precision NOT NULL,
    speed_kmh   real,
    heading     real,
    accuracy_m  real,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_locations_entity ON live_locations (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_live_locations_updated ON live_locations (updated_at DESC);

-- Geofence definitions
CREATE TABLE IF NOT EXISTS geofences (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    type        text NOT NULL CHECK (type IN ('hub_zone', 'delivery_zone', 'restricted_zone', 'surge_zone')),
    boundary    jsonb NOT NULL, -- GeoJSON polygon or circle
    active      boolean NOT NULL DEFAULT true,
    metadata    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geofences_active ON geofences (active) WHERE active = true;

-- Geofence events (entry/exit)
CREATE TABLE IF NOT EXISTS geofence_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    geofence_id uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('rider', 'vehicle')),
    entity_id   uuid NOT NULL,
    event_type  text NOT NULL CHECK (event_type IN ('entry', 'exit')),
    lat         double precision NOT NULL,
    lon         double precision NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_geofence ON geofence_events (geofence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_entity ON geofence_events (entity_type, entity_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS geofence_events;
DROP TABLE IF EXISTS geofences;
DROP TABLE IF EXISTS live_locations;
