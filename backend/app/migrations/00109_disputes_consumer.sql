-- +goose Up
-- Consumer disputes table is already created in 00070_disputes.sql but the
-- consumer alias POST /disputes (vs admin) needs explicit consumer-facing
-- indexes and a reference_type guard. This migration is additive — no
-- table recreation, only constraint/index backfill.

-- +goose StatementBegin
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='disputes') THEN
        CREATE TABLE disputes (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
            booking_id      uuid REFERENCES bookings(id) ON DELETE SET NULL,
            subject         text NOT NULL,
            description     text,
            status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolving','resolved','dismissed')),
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now()
        );
    END IF;
END $$;
-- +goose StatementEnd

-- Ensure reference columns exist for consumer raises (order vs booking)
-- +goose StatementBegin
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='disputes' AND column_name='booking_id') THEN
        ALTER TABLE disputes ADD COLUMN booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='disputes' AND column_name='reference_type') THEN
        ALTER TABLE disputes ADD COLUMN reference_type text CHECK (reference_type IN ('order','booking'));
    END IF;
END $$;
-- +goose StatementEnd

CREATE INDEX IF NOT EXISTS idx_disputes_user_created ON disputes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes (order_id) WHERE order_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_disputes_order;
-- Do not drop table/columns — additive only
