-- +goose Up
-- Entertainment events bounded context (CONTRACT-ADDITIONS.md
-- "Entertainment events — /entertainment resource"): events with
-- price tiers (the detail projection), cursor-paginated listings, and
-- idempotent ticket purchases issuing EV-XXXX codes. Tickets carry the
-- contract projection fields as denormalized snapshots so /me renders
-- without joins.
CREATE TABLE events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title        text NOT NULL,
    category     text,
    city_id      text NOT NULL,
    city_name    text NOT NULL,
    venue        text,
    description  text,
    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL CHECK (ends_at > starts_at),
    capacity     int NOT NULL DEFAULT 0 CHECK (capacity >= 0),
    sold_count   int NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
    image_url    text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_city ON events (city_id, created_at, id);
CREATE INDEX idx_events_category ON events (category, created_at, id);

CREATE TABLE event_tiers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name          text NOT NULL,
    price_tzs     int NOT NULL CHECK (price_tzs >= 0),
    available     boolean NOT NULL DEFAULT true,
    remaining     int NOT NULL DEFAULT 0 CHECK (remaining >= 0)
);

CREATE INDEX idx_event_tiers_event ON event_tiers (event_id);

CREATE TABLE event_tickets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id         uuid NOT NULL REFERENCES events(id),
    user_id          uuid NOT NULL REFERENCES users(id),
    code             text NOT NULL UNIQUE,
    tier_name        text NOT NULL,
    price_tzs        int NOT NULL CHECK (price_tzs >= 0),
    qty              int NOT NULL CHECK (qty >= 1),
    total_tzs        bigint NOT NULL CHECK (total_tzs >= 0),
    -- Event snapshot fields from the contract projection.
    event_title      text NOT NULL,
    venue            text,
    starts_at        timestamptz,
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'refunded')),
    idempotency_key  text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_tickets_user_created ON event_tickets (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_event_tickets_user_idempotency ON event_tickets (user_id, idempotency_key);

-- +goose Down
DROP TABLE IF EXISTS event_tickets;
DROP TABLE IF EXISTS event_tiers;
DROP TABLE IF EXISTS events;