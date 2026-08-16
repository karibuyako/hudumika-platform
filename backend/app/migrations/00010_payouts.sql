-- +goose Up
-- Payouts bounded context (backend/DATA-MODEL.md "Payouts (immutable
-- ledger)", backend/PAYOUTS-LEDGER.md). ledger_entries is the single source
-- of truth for every money movement: append-only, never UPDATE/DELETE;
-- corrections are new adjustment entries. The wallet is a projection of the
-- ledger, never a second source of truth.
--
-- account_owner_id intentionally has no FK constraint: users rows belong to
-- migration 00001, which is always applied first, but keeping the immutable
-- money log decoupled from the identity schema mirrors the payments context
-- convention (00007) and avoids any cascade risk on the ledger.

CREATE TABLE ledger_entries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_owner_id uuid NOT NULL,
    account_type     text NOT NULL CHECK (account_type IN ('merchant', 'provider', 'rider')),
    type             text NOT NULL CHECK (type IN ('order_earning', 'booking_earning', 'delivery_fee', 'commission', 'adjustment', 'payout', 'refund', 'bonus')),
    amount_tzs       bigint NOT NULL CHECK (amount_tzs <> 0),
    balance_tzs      bigint NOT NULL,
    reference_type   text,
    reference_id     uuid,
    idempotency_key  text NOT NULL UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_entries_owner_created ON ledger_entries (account_owner_id, created_at DESC);
CREATE INDEX idx_ledger_entries_reference ON ledger_entries (reference_type, reference_id);

CREATE TABLE payout_batches (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle      date NOT NULL UNIQUE,
    status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'settled', 'exception')),
    total_tzs  bigint NOT NULL DEFAULT 0,
    count      int NOT NULL DEFAULT 0,
    settled_at timestamptz
);

CREATE TABLE payout_entries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id          uuid NOT NULL REFERENCES payout_batches(id),
    owner_id          uuid NOT NULL,
    amount_tzs        bigint NOT NULL,
    method            text NOT NULL,
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'exception')),
    gateway_reference text,
    reason            text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    paid_at           timestamptz
);

CREATE INDEX idx_payout_entries_owner_created ON payout_entries (owner_id, created_at DESC);
CREATE INDEX idx_payout_entries_batch ON payout_entries (batch_id);

-- +goose Down
DROP TABLE IF EXISTS payout_entries;
DROP TABLE IF EXISTS payout_batches;
DROP TABLE IF EXISTS ledger_entries;
