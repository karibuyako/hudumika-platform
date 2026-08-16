-- +goose Up
-- MARKETING-EXTRA bounded context (API-CONTRACT.yaml /experiments, /journeys,
-- /segments): client feature experiments, automated customer journeys and
-- CRM customer segments. Steps and rules are jsonb; rollout is a 0..1
-- fraction (numeric(3,2)) matching the /experiments contract "0–1".

CREATE TABLE experiments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    variant    text NOT NULL,
    rollout    numeric(3,2) NOT NULL DEFAULT 0 CHECK (rollout >= 0 AND rollout <= 1),
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journeys (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    trigger_event text NOT NULL,
    steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE segments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    rules      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS experiments;
DROP TABLE IF EXISTS journeys;
DROP TABLE IF EXISTS segments;
