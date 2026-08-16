-- +goose Up
-- Consignment operations (API-CONTRACT.yaml
-- /linehaul/consignments/{consignmentId}/reconcile and .../replan): the
-- reconcile stamp records the last full manifest scan on the consignment
-- and consignment_reconciliations is the append-only log of reconciled
-- scans (the matched count plus the missing manifest ids; '[]' on a full
-- match).

ALTER TABLE consignments ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

CREATE TABLE consignment_reconciliations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    consignment_id uuid NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
    matched        int NOT NULL DEFAULT 0,
    missing        jsonb NOT NULL DEFAULT '[]',
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_consignment_reconciliations_consignment
    ON consignment_reconciliations (consignment_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS consignment_reconciliations;
ALTER TABLE consignments DROP COLUMN IF EXISTS reconciled_at;
