-- +goose Up
-- RIDER-SELF (backend/DATA-MODEL.md §riders; ERROR-CODES.md §Rider self
-- service): rider-owned preferences, goals, expenses, trusted contacts,
-- security posture, destination filter and safety events. Every table is
-- rider-owned (rider_id references riders(id)) and cascades with the riders
-- row.
--
-- The expense category and safety-event kind CHECK constraints follow the
-- generated contract enums (RiderExpenseCategory, SafetyEventType), not the
-- draft values: the API layer stores contract strings verbatim so reads
-- round-trip without mapping.

CREATE TABLE rider_preferences (
    rider_id      uuid PRIMARY KEY REFERENCES riders(id) ON DELETE CASCADE,
    language      text NOT NULL DEFAULT 'en',
    theme         text NOT NULL DEFAULT 'system',
    notifications jsonb NOT NULL DEFAULT '{}',
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rider_goals (
    rider_id            uuid PRIMARY KEY REFERENCES riders(id) ON DELETE CASCADE,
    weekly_deliveries   int    NOT NULL DEFAULT 0,
    weekly_earnings_tzs bigint NOT NULL DEFAULT 0,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rider_expenses (
    id         uuid PRIMARY KEY,
    rider_id   uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    category   text NOT NULL
               CHECK (category IN ('equipment', 'fuel', 'insurance', 'maintenance', 'other', 'tax_deduction')),
    amount_tzs bigint NOT NULL CHECK (amount_tzs >= 0),
    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rider_expenses_rider_created ON rider_expenses (rider_id, created_at DESC);

CREATE TABLE trusted_contacts (
    id         uuid PRIMARY KEY,
    rider_id   uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    name       text NOT NULL,
    phone      text NOT NULL,
    relation   text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_trusted_contacts_rider ON trusted_contacts (rider_id);

CREATE TABLE rider_security (
    rider_id    uuid PRIMARY KEY REFERENCES riders(id) ON DELETE CASCADE,
    pin_enabled boolean NOT NULL DEFAULT false,
    pin_hash    text,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE destination_filters (
    rider_id   uuid PRIMARY KEY REFERENCES riders(id) ON DELETE CASCADE,
    areas      jsonb NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE safety_events (
    id          uuid PRIMARY KEY,
    rider_id    uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    kind        text NOT NULL
                CHECK (kind IN ('crash_detected', 'fall_detected', 'fatigue_detected', 'rest_enforced', 'threat_detected')),
    lat         numeric(10,7),
    lon         numeric(10,7),
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_safety_events_rider_created ON safety_events (rider_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS safety_events;
DROP TABLE IF EXISTS destination_filters;
DROP TABLE IF EXISTS rider_security;
DROP TABLE IF EXISTS trusted_contacts;
DROP TABLE IF EXISTS rider_expenses;
DROP TABLE IF EXISTS rider_goals;
DROP TABLE IF EXISTS rider_preferences;
