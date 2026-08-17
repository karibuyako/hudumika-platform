-- +goose Up
-- ADMIN-PENDING disputes (PENDING-ENDPOINTS.md §3 dispute_resolve, contract
-- POST /admin/disputes/{disputeId}/decision): the finance dispute registry.
-- Each dispute opens against an order (and the customer who raised it) and
-- resolves to one of three decisions — refund (money returns to the
-- customer, ledger entry appended), payout (the payout hold is released) or
-- reject (no money moves). status starts open and is terminal once decided:
-- refunded for a refund, resolved for payout/reject. decision_reason,
-- decided_by and decided_at record the deciding staff member.

CREATE TABLE disputes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    order_id        uuid,
    subject         text NOT NULL,
    description     text,
    status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'resolved', 'refunded')),
    decision_reason text,
    decided_by      uuid,
    decided_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_disputes_status_created ON disputes (status, created_at DESC);
CREATE INDEX idx_disputes_order_id ON disputes (order_id);
CREATE INDEX idx_disputes_user_id ON disputes (user_id);

-- +goose Down
DROP TABLE IF EXISTS disputes;