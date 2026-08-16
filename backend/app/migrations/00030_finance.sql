-- +goose Up
-- Finance bounded context (backend/DATA-MODEL.md "bank_cards / invoices /
-- daily_settlements", backend/ERROR-CODES.md "Finance"): tokenized bank
-- cards, merchant invoices, daily settlement cycles that release captured
-- escrow to merchants (backend/PAYMENTS.md) and reconciliation run records.
--
-- PCI-DSS: card PANs are NEVER stored — bank_cards.token is the provider
-- vault reference only, and only the last-4 digits are kept for display.
-- bank_cards.user_id follows the milestone convention (customer/merchant id
-- is the authenticated users row id); merchant_id columns deliberately carry
-- no FK, mirroring payment_intents.order_id (00007).

CREATE TABLE bank_cards (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token        text NOT NULL,
    brand        text,
    last4        text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
    expiry_month int CHECK (expiry_month BETWEEN 1 AND 12),
    expiry_year  int,
    is_default   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_cards_user_created ON bank_cards (user_id, created_at);

CREATE TABLE invoices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  uuid NOT NULL,
    number       text NOT NULL UNIQUE,
    subtotal_tzs bigint NOT NULL DEFAULT 0,
    tax_tzs      bigint NOT NULL DEFAULT 0,
    total_tzs    bigint NOT NULL DEFAULT 0,
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')),
    issued_at    timestamptz,
    paid_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_merchant_created ON invoices (merchant_id, created_at DESC);

CREATE TABLE daily_settlements (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    cycle_date  date NOT NULL,
    total_tzs   bigint NOT NULL DEFAULT 0,
    count       int NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'paid', 'exception')),
    batch_id    uuid,
    paid_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, cycle_date)
);

CREATE INDEX idx_daily_settlements_cycle ON daily_settlements (cycle_date, status);

CREATE TABLE reconciliation_runs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date   date NOT NULL,
    matched    int NOT NULL DEFAULT 0,
    exceptions int NOT NULL DEFAULT 0,
    status     text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'exception')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS reconciliation_runs;
DROP TABLE IF EXISTS daily_settlements;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS bank_cards;
