-- +goose Up
-- Support tickets (backend/SUPPORT.md, backend/DATA-MODEL.md): any role can
-- open a ticket; tickets are tagged with the requester's role for routing.
-- The opening message is stored as the first ticket_messages row, so the
-- subject/body of a ticket live on both tables. Messages are append-only.

CREATE TABLE support_tickets (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_user_id  uuid NOT NULL REFERENCES users(id),
    role               text NOT NULL CHECK (role IN ('customer', 'merchant', 'provider', 'rider')),
    subject            text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 160),
    status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_progress', 'resolved', 'closed')),
    priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    assigned_agent_id  uuid REFERENCES users(id),
    order_id           uuid,
    booking_id         uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_tickets_requester_created ON support_tickets (requester_user_id, created_at DESC);
CREATE INDEX idx_support_tickets_status_priority ON support_tickets (status, priority);

CREATE TABLE ticket_messages (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id      uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_user_id uuid NOT NULL REFERENCES users(id),
    author_role    text NOT NULL CHECK (author_role IN ('customer', 'merchant', 'provider', 'rider', 'agent')),
    body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_messages_ticket_created ON ticket_messages (ticket_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS ticket_messages;
DROP TABLE IF EXISTS support_tickets;
