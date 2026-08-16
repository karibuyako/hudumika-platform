-- +goose Up
-- REPORTS and DATA-EXPORTS bounded contexts (API-CONTRACT.yaml /reports and
-- /data/exports): reports persist scheduled report definitions (the
-- contract's cadence enum is normalized to the 5-field schedule_cron the
-- future scheduler consumes), and data_exports is the durable job record for
-- enterprise export requests — for this milestone the job row IS the queue
-- (no worker yet; a worker will flip queued -> processing -> completed/failed
-- and set file_url/rows/error/expires_at/completed_at).
-- Deviation from the planned column list: the contract's ScheduledReport
-- schema declares a required format field (no omitempty), so reports carries
-- a format column to make the definition round-trip honestly.

CREATE TABLE reports (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         text NOT NULL,
    report_type   text NOT NULL,
    format        text NOT NULL DEFAULT 'csv'
                   CHECK (format IN ('csv', 'pdf', 'xlsx')),
    params        jsonb NOT NULL DEFAULT '{}',
    schedule_cron text,
    recipients    jsonb NOT NULL DEFAULT '[]',
    status        text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused')),
    last_run_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_owner_created ON reports (owner_user_id, created_at DESC);

CREATE TABLE data_exports (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope        text NOT NULL,
    format       text NOT NULL CHECK (format IN ('csv', 'json', 'xlsx')),
    status       text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    file_url     text,
    rows         int NOT NULL DEFAULT 0,
    error        text,
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX idx_data_exports_user_created ON data_exports (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS data_exports;
DROP TABLE IF EXISTS reports;
