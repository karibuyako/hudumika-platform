-- +goose Up
-- Core identities (backend/DATA-MODEL.md): users, roles, sessions, otp_requests.
-- Money and marketplace tables arrive with their own milestones; merchant_id,
-- provider_id, rider_id columns are added with FK constraints when those
-- tables land.

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone         text NOT NULL UNIQUE,
    email         text UNIQUE,
    full_name     text NOT NULL DEFAULT '',
    avatar_url    text,
    locale        text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'sw', 'ar')),
    password_hash text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('customer', 'merchant', 'provider', 'rider')),
    merchant_id uuid,
    provider_id uuid,
    rider_id    uuid,
    active      boolean NOT NULL DEFAULT true,
    PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role               text NOT NULL,
    access_token_hash  text NOT NULL,
    refresh_token_hash text NOT NULL UNIQUE,
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz,
    device_info        jsonb,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_requests (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel     text NOT NULL CHECK (channel IN ('phone', 'email')),
    destination text NOT NULL,
    purpose     text NOT NULL CHECK (purpose IN ('login', 'signup', 'password_reset', 'verify_role')),
    code_hash   text NOT NULL,
    expires_at  timestamptz NOT NULL,
    attempts    int NOT NULL DEFAULT 0,
    verified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_refresh_hash ON sessions (refresh_token_hash);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_otp_requests_destination ON otp_requests (destination, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS otp_requests;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
