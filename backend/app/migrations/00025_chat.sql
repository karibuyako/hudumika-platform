-- +goose Up
-- Chat context (backend/SUPPORT.md): a conversation pairs one customer with
-- one merchant account. merchant_id is the merchant's users row id (the JWT
-- subject of their sessions), so participant checks resolve without extra
-- lookups. Unread counters are per side; messages are append-only rows with
-- an (conversation_id, created_at) index backing the keyset paginator.

CREATE TABLE conversations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id      uuid NOT NULL,
    subject          text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived', 'blocked')),
    unread_customer  int NOT NULL DEFAULT 0 CHECK (unread_customer >= 0),
    unread_merchant  int NOT NULL DEFAULT 0 CHECK (unread_merchant >= 0),
    last_message_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_user_id, merchant_id)
);

CREATE TABLE conversation_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_user_id  uuid NOT NULL,
    author_role     text NOT NULL CHECK (author_role IN ('customer', 'merchant')),
    body            text NOT NULL,
    attachment      jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_messages_conversation_created
    ON conversation_messages (conversation_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS conversations;
