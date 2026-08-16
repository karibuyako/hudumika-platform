-- +goose Up
-- Public discovery (backend/DATA-MODEL.md): cities + service_areas,
-- the configurable service category engine and the public services
-- catalogue. service_areas.polygon stays text until PostGIS lands.

CREATE TABLE cities (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name    text NOT NULL,
    country text NOT NULL DEFAULT 'TZ',
    UNIQUE (country, name)
);

CREATE TABLE service_areas (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    name    text NOT NULL,
    polygon text,
    UNIQUE (city_id, name)
);

CREATE TABLE service_categories_config (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL UNIQUE,
    sort_order int NOT NULL DEFAULT 0,
    active     boolean NOT NULL DEFAULT true
);

CREATE TABLE services (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    description text,
    category_id uuid REFERENCES service_categories_config(id),
    city_id     uuid REFERENCES cities(id),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_services_city_id ON services (city_id);
CREATE INDEX idx_services_category_id ON services (category_id);
CREATE INDEX idx_service_areas_city_id ON service_areas (city_id);

-- +goose Down
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS service_categories_config;
DROP TABLE IF EXISTS service_areas;
DROP TABLE IF EXISTS cities;
