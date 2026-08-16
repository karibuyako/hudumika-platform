-- +goose Up
-- ADMIN-LOGISTICS bounded context (API-CONTRACT.yaml
-- /admin/hubs/{hubId}/dashboard, /admin/logistics/control-tower,
-- /admin/shipments/{shipmentId}/escalate, /admin/riders/{riderId}/cod,
-- /admin/risk/cases): hub operations dashboards, the logistics control
-- tower, the shipment escalation registry (incident/safety overrides) and
-- rider COD reconciliation shift sessions.
--
-- cod_reconciliation_sessions is the shift-level COD ledger: each shift
-- records what the rider collected (collected_tzs) versus what the platform
-- expected (expected_tzs). COD order linkage (which orders belong to a shift
-- and were paid cash-on-delivery) lands with the orders payment_method
-- column; until then expected_tzs is seeded by ops and the endpoint returns
-- the sessions with their totals.
--
-- shipment_escalations is the dispatcher escalation registry: only in-transit
-- or exception shipments may be escalated, and the record stays open until
-- ops resolves it.

CREATE TABLE cod_reconciliation_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id      uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    shift_id      uuid,
    started_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    collected_tzs bigint NOT NULL DEFAULT 0,
    expected_tzs  bigint NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled', 'exception')),
    reconciled_by uuid,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cod_sessions_rider_started ON cod_reconciliation_sessions (rider_id, started_at DESC);

CREATE TABLE shipment_escalations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id  uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    escalated_by uuid,
    reason       text NOT NULL,
    status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);

CREATE INDEX idx_shipment_escalations_shipment ON shipment_escalations (shipment_id);
CREATE INDEX idx_shipment_escalations_status ON shipment_escalations (status);

-- +goose Down
DROP TABLE IF EXISTS shipment_escalations;
DROP TABLE IF EXISTS cod_reconciliation_sessions;
