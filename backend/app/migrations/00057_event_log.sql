-- +goose Up
-- Event log: the PostgreSQL-backed event stream fallback for /events when
-- Redis is absent. The bigserial id doubles as the event sequence reported to
-- clients (and compared against by the `after` query parameter), mirroring
-- the milliseconds part of the Redis stream ID in the primary path. The
-- table is append-only; the sequence is monotonic because bigserial ids are
-- allocated from the same global counter across every backend instance.
CREATE TABLE event_log (
    id         bigserial PRIMARY KEY,
    type       text NOT NULL,
    payload    jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_log_id_idx ON event_log (id);

-- +goose Down
DROP TABLE IF EXISTS event_log;
