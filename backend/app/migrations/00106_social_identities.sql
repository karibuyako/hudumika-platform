-- +goose Up
-- Social identities (OAuth): per-user linked social providers (google, apple)
-- for POST /auth/social. The exchange is server-side — the client sends
-- {provider, idToken} (or code), the server validates and links. id_token
-- is stored as a hash placeholder (never plaintext) for audit; the provider
-- user id is the stable link. One identity per (user_id, provider).

CREATE TABLE social_identities (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          text NOT NULL CHECK (provider IN ('google','apple')),
    provider_user_id  text NOT NULL,
    id_token_hash     text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider),
    UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_social_identities_user ON social_identities (user_id);
CREATE INDEX idx_social_identities_provider ON social_identities (provider, provider_user_id);

-- +goose Down
DROP TABLE IF EXISTS social_identities;
