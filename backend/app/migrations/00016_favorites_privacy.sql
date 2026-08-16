-- +goose Up
-- Favorites and privacy surfaces (backend/DATA-MODEL.md "Favorites",
-- "Privacy"): the customer's merchant favorites (merchant rows land with the
-- merchants milestone, so merchant_id is a plain uuid for now) and the
-- durable privacy_requests ledger that backs /privacy/export and
-- /privacy/delete. The unique (user_id, kind) constraint guarantees at most
-- one open export and one open deletion per user.

CREATE TABLE favorites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, merchant_id)
);

CREATE INDEX idx_favorites_user_created ON favorites (user_id, created_at DESC);

CREATE TABLE privacy_requests (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('export', 'deletion')),
    status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, kind)
);

CREATE INDEX idx_privacy_requests_user_kind ON privacy_requests (user_id, kind, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS privacy_requests;
DROP TABLE IF EXISTS favorites;
