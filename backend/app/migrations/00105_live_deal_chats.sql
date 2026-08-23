-- +goose Up
-- Live-deal broadcast chats (神抢手-lite): per-session chat threads for
-- marketing live-deal sessions (live_deals table from 00066). Each thread
-- is scoped to a live_deals row; messages are append-only with idempotency
-- replay per key. Unknown sessions are rejected at the API layer (404).

CREATE TABLE live_deal_chats (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES live_deals(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text UNIQUE
);

CREATE INDEX idx_live_deal_chats_session_created ON live_deal_chats (session_id, created_at);
CREATE INDEX idx_live_deal_chats_user ON live_deal_chats (user_id);

-- +goose Down
DROP TABLE IF EXISTS live_deal_chats;
