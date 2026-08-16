-- +goose Up
-- Device pairing and testing (backend/DATA-MODEL.md §merchant staff and
-- devices): pairing_code / paired_at / last_tested_at on devices, and
-- device_tests — the durable record of each /devices/{deviceId}/test job
-- (queued until a worker delivers it; the row is the record).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS pairing_code text;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS paired_at timestamptz;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;

CREATE TABLE device_tests (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'passed', 'failed')),
    detail      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_device_tests_device_created ON device_tests (device_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS device_tests;

ALTER TABLE devices DROP COLUMN IF EXISTS last_tested_at;

ALTER TABLE devices DROP COLUMN IF EXISTS paired_at;

ALTER TABLE devices DROP COLUMN IF EXISTS pairing_code;
