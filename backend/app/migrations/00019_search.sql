-- +goose Up
-- Unified search bounded context: per-user recent search queries. The
-- table backs /search/history (GET recent searches, DELETE clear) and the
-- best-effort query recording on every successful /search. Rows cascade
-- with the user and are pruned to the newest 50 per user by the handler.

CREATE TABLE search_history (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_history_user_created ON search_history (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS search_history;
