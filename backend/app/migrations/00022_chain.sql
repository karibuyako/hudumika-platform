-- +goose Up
-- CHAIN bounded context (API-CONTRACT.yaml /chain/* and /bulk-operations):
-- multi-store chains let one merchant owner manage several merchants under a
-- single dashboard, and bulk_operations queues cross-store changes for staff
-- approval before they apply. owner_user_id is the chain owner's users row
-- id — the merchant session subject for this milestone — so chain_stores
-- binds the owner to the merchants they manage, and bulk_operations scopes
-- the operation queue to the same owner.

CREATE TABLE chain_stores (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name          text NOT NULL,
    city_id       uuid REFERENCES cities(id),
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, merchant_id)
);

CREATE INDEX idx_chain_stores_owner_created ON chain_stores (owner_user_id, created_at DESC);

CREATE TABLE bulk_operations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('inventory', 'price_change', 'promotion', 'closure')),
    status        text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
    payload       jsonb NOT NULL DEFAULT '{}',
    reason        text,
    applied_count int NOT NULL DEFAULT 0,
    requested_by  uuid,
    decided_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bulk_operations_owner_created ON bulk_operations (owner_user_id, created_at DESC, id DESC);

-- +goose Down
DROP TABLE IF EXISTS bulk_operations;
DROP TABLE IF EXISTS chain_stores;
