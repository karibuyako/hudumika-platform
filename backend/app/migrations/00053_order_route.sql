-- +goose Up
-- ORDER-ROUTE / SCHEDULED-ADVANCE / SHIPMENT-REASSIGN (API-CONTRACT.yaml
-- /orders/{orderId}/route, /orders/me/advance, /admin/shipments/{id}/reassign):
-- orders.scheduled_at marks advance (pre-scheduled) orders; order_route_legs
-- links an order to the trip legs of its journey (per-order status mirror);
-- shipments.trip_id binds a shipment to the trip it is riding so the
-- dispatcher can reassign it between trips.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

CREATE TABLE IF NOT EXISTS order_route_legs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    leg_id       uuid,
    sequence     int NOT NULL,
    mode         text NOT NULL CHECK (mode IN ('first_mile', 'line_haul', 'last_mile')),
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
    completed_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_order_route_legs_order ON order_route_legs (order_id);

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id);
CREATE INDEX IF NOT EXISTS idx_shipments_trip ON shipments (trip_id);

-- +goose Down
DROP TABLE IF EXISTS order_route_legs;
ALTER TABLE shipments DROP COLUMN IF EXISTS trip_id;
ALTER TABLE orders DROP COLUMN IF EXISTS scheduled_at;
