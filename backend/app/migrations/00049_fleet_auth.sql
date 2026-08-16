-- +goose Up
-- FLEET-ACCOUNTS (backend/DATA-MODEL.md §fleet; API-CONTRACT.yaml
-- /fleet/accounts): fleet master accounts owned by a users row. One master
-- account per owner (UNIQUE owner_user_id → 409 CONFLICT on a second
-- create). status follows the contract enum (active, suspended) and is
-- enforced at the storage layer like every other status column.

CREATE TABLE fleet_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fleet_name    text NOT NULL,
    vehicle_count integer NOT NULL DEFAULT 0 CHECK (vehicle_count >= 0),
    status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
    city          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id)
);

CREATE INDEX idx_fleet_accounts_owner ON fleet_accounts (owner_user_id);

-- +goose Down
DROP TABLE fleet_accounts;
