-- +goose Up
-- Riders (backend/DATA-MODEL.md §riders): applications, profiles and the
-- online flag used by dispatch scans. city_id references the planned cities
-- table (backend/DATA-MODEL.md §cities) which lands with its own milestone,
-- so the column is a plain uuid until that FK exists.
CREATE TABLE riders (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL,
    city_id       uuid,
    vehicle       text NOT NULL CHECK (vehicle IN ('motorcycle', 'bicycle', 'car')),
    verification  text NOT NULL DEFAULT 'pending'
                  CHECK (verification IN ('pending', 'documents_review', 'approved', 'rejected', 'suspended', 'changes_requested')),
    online        boolean NOT NULL DEFAULT false,
    delivery_zone text,
    rating        numeric(3, 2),
    review_count  int NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_riders_owner_user_id ON riders (owner_user_id);
CREATE INDEX idx_riders_city_online ON riders (city_id, online);

-- +goose Down
DROP TABLE IF EXISTS riders;
