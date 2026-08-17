-- +goose Up
-- CUSTOMER INVOICES (API-CONTRACT.yaml /finance/invoices/{invoiceId} — the
-- customer invoice detail surface, consumer docs/CONTRACT-ADDITIONS.md
-- "Invoices — /finance/invoices"). The merchant invoice table (00030
-- invoices, merchant_id-scoped) stays merchant-owned; customer invoices get
-- their own row per user. items is the JSON line-item array (the contract
-- Invoice carries no items field — the data is stored for a future itemized
-- surface), download_url is where a signed PDF will be served
-- (DownloadInvoice200.downloadUrl). Status enum matches the contract
-- InvoiceStatus subset a customer invoice can reach (issued, paid).

CREATE TABLE customer_invoices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    number       text NOT NULL UNIQUE,
    kind         text CHECK (kind IN ('vat', 'standard')),
    reference_id uuid,
    amount_tzs   bigint NOT NULL CHECK (amount_tzs >= 0),
    status       text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid')),
    issued_at    timestamptz,
    paid_at      timestamptz,
    items        jsonb NOT NULL DEFAULT '[]'::jsonb,
    download_url text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_invoices_user ON customer_invoices (user_id, created_at DESC, id DESC);

-- +goose Down
DROP TABLE IF EXISTS customer_invoices;