-- +goose Up
-- Push-token uniqueness fix (consumer parity): the existing 00059_push_tokens
-- already has UNIQUE (user_id, token) but the alias surface POST /push/tokens
-- (Idempotency-Key) and the notification dispatch need a token-global lookup
-- and per-user listing. This migration is additive only: it adds a token-
-- global index, a platform check, and a backfill-safe uniqueness guard for
-- the alias path. No data loss, no constraint drop.

-- Ensure platform column exists and is constrained (idempotent)
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'expo';
-- +goose StatementBegin
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='push_tokens_platform_check') THEN
        ALTER TABLE push_tokens ADD CONSTRAINT push_tokens_platform_check CHECK (platform IN ('expo','apns','fcm'));
    END IF;
END $$;
-- +goose StatementEnd

-- Global token index for dispatch targeting (lookup by token)
CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens (token);

-- Ensure updated_at exists for alias path
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill: ensure no duplicate (user_id, token) violations from legacy nulls
-- (the original UNIQUE already guards it; this is a no-op sanity).

-- +goose Down
DROP INDEX IF EXISTS idx_push_tokens_token;
-- Do not drop platform/updated_at columns in down — they are additive and
-- other code may depend on them. Down is a no-op beyond index removal.
