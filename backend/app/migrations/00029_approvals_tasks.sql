-- +goose Up
-- Approvals (4-eyes workflows), tasks center, risk events and onboarding
-- wizard state (backend/DATA-MODEL.md "Tasks, risk and onboarding").
-- Ownership is per user (owner_user_id); staff surfaces filter by role.

CREATE TABLE approvals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type  text NOT NULL,
    entity_id    uuid,
    action       text NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_by uuid NOT NULL,
    decided_by   uuid,
    reason       text,
    level        int NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz
);

CREATE INDEX idx_approvals_status_created_at ON approvals (status, created_at);

CREATE TABLE tasks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('anomaly', 'violation', 'activity', 'setup_guide', 'general')),
    title         text NOT NULL,
    body          text,
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'blocked')),
    due_at        timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_owner_status ON tasks (owner_user_id, status);

CREATE TABLE risk_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    entity_id   uuid,
    signal      text NOT NULL,
    score       numeric(4, 2) NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
    reviewed_by uuid,
    resolution  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz
);

CREATE TABLE onboarding_profiles (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    step          text NOT NULL DEFAULT 'profile' CHECK (step IN ('profile', 'docs', 'review', 'approved', 'rejected')),
    submitted_at  timestamptz,
    reviewed_at   timestamptz,
    review_note   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_docs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL,
    url           text NOT NULL,
    verified      bool NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS onboarding_docs;
DROP TABLE IF EXISTS onboarding_profiles;
DROP TABLE IF EXISTS risk_events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS approvals;
