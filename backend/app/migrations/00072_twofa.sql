-- +goose Up
-- TOTP two-factor enrollment for staff sessions (AUTH.md, API-CONTRACT.yaml
-- /auth/2fa/*): per-user TOTP secrets plus rotating single-use recovery
-- codes. Only the SHA-256 hashes of recovery codes are persisted; the
-- plaintext is returned to the client exactly once at issue time.

CREATE TABLE twofa_secrets (
    user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_base32 text NOT NULL,
    enabled       boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE twofa_recovery_codes (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  text NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, code_hash)
);

CREATE INDEX idx_twofa_recovery_codes_user_used ON twofa_recovery_codes (user_id, used_at);

-- +goose Down
DROP TABLE IF EXISTS twofa_recovery_codes;
DROP TABLE IF EXISTS twofa_secrets;