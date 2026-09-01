-- +goose Up
ALTER TABLE admin_teams ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE admin_policies ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_admin_teams_active ON admin_teams (id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_policies_active ON admin_policies (id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users (id) WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_admin_teams_active;
DROP INDEX IF EXISTS idx_admin_policies_active;
DROP INDEX IF EXISTS idx_admin_users_active;
ALTER TABLE admin_users DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE admin_policies DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE admin_teams DROP COLUMN IF EXISTS deleted_at;
