-- +goose Up
-- Closure protection status (GET /closure/status). The table is created with
-- IF NOT EXISTS so this is a safe no-op when the live schema already defines
-- it. Keyed by merchant_id (one row per store).
CREATE TABLE IF NOT EXISTS closure_protection (
    merchant_id    uuid                     NOT NULL PRIMARY KEY,
    annual_quota   integer                  NOT NULL DEFAULT 2,
    used_closures  integer                  NOT NULL DEFAULT 0,
    renewal_date   date                     ,
    updated_at     timestamp with time zone NOT NULL DEFAULT now(),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
);

-- +goose Down
-- Intentionally a no-op: closure_protection is a pre-existing production table;
-- this migration only guarantees its presence. Do not drop it on rollback.
