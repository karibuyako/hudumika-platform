-- +goose Up
-- RIDER-OPS2 (backend/DATA-MODEL.md §riders; ERROR-CODES.md §Dispatch and
-- delivery exceptions): vehicle maintenance records, rider missions and
-- incentives, the training center, the offline-sync high-water mark, rider
-- report exports, and (in Redis, not here) the daily check-in. Every table is
-- rider-owned and cascades with the riders row, except training_modules
-- (catalog content, not rider-owned) and rider_training_progress which
-- references it.
--
-- vehicle_maintenance.kind follows the CONTRACT VehicleMaintenance.type enum
-- (oil_change, tire_pressure, battery_health, brake_service, general_service)
-- so the storage value round-trips through the API without a mapping layer;
-- the task brief's draft storage kinds (service/repair/inspection/other) were
-- replaced by the contract values for exactly that reason (see the package
-- comment in rider_ops2.go). description maps to the contract notes,
-- odometer_km to mileageKm and scheduled_at to performedAt. status is
-- storage-only (scheduled/in_progress/completed): the contract schema has no
-- status field.
--
-- rider_missions.kind (bonus/streak/challenge/reward) is storage-only too:
-- the contract RiderMission schema has no kind field, so it is never
-- serialized. progress/target map to completedDeliveries/targetDeliveries and
-- expires_at to endsAt.

CREATE TABLE vehicle_maintenance (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id     uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('oil_change', 'tire_pressure', 'battery_health', 'brake_service', 'general_service')),
    description  text,
    odometer_km  numeric(10, 2),
    scheduled_at timestamptz NOT NULL,
    status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vehicle_maintenance_rider_created ON vehicle_maintenance (rider_id, created_at DESC, id);

CREATE TABLE rider_missions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id   uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    kind       text NOT NULL DEFAULT 'bonus' CHECK (kind IN ('bonus', 'streak', 'challenge', 'reward')),
    title      text NOT NULL,
    reward_tzs bigint NOT NULL DEFAULT 0 CHECK (reward_tzs >= 0),
    progress   int NOT NULL DEFAULT 0 CHECK (progress >= 0),
    target     int NOT NULL DEFAULT 1 CHECK (target > 0),
    claimed    boolean NOT NULL DEFAULT false,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rider_missions_rider ON rider_missions (rider_id);

-- Training catalog: global rows (not rider-owned), ordered by sort_order.
CREATE TABLE training_modules (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title      text NOT NULL,
    content    text NOT NULL DEFAULT '',
    required   boolean NOT NULL DEFAULT false,
    sort_order int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per rider+module; the unique pair is the completion marker.
CREATE TABLE rider_training_progress (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id     uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    module_id    uuid NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (rider_id, module_id)
);

-- Offline-sync high-water mark: the last server-acknowledged sequence per
-- rider. There is no per-event storage in this milestone; the client drops
-- events with seq <= last_seq (see the package comment in rider_ops2.go).
CREATE TABLE rider_sync_state (
    rider_id   uuid PRIMARY KEY REFERENCES riders(id) ON DELETE CASCADE,
    last_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rider report exports: the job row IS the queue in this milestone — no
-- worker flips queued to completed, so statuses stay honest. scope is the
-- contract reportType; format is validated but not persisted (no column).
CREATE TABLE rider_exports (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id   uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    scope      text NOT NULL,
    status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'completed', 'failed')),
    file_url   text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rider_exports_rider_created ON rider_exports (rider_id, created_at DESC, id);

-- +goose Down
DROP TABLE IF EXISTS rider_exports;
DROP TABLE IF EXISTS rider_sync_state;
DROP TABLE IF EXISTS rider_training_progress;
DROP TABLE IF EXISTS training_modules;
DROP TABLE IF EXISTS rider_missions;
DROP TABLE IF EXISTS vehicle_maintenance;
