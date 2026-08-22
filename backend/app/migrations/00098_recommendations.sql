-- +goose Up
-- Recommendations: behavior event log for candidate generation, ranking and cold/warm start.
-- The event stream is the warm-start signal: view, search, cart add, heart, order paid, booking.
-- Daypart is server-computed to avoid client clock skew; lat/lon/city are denormalized for fast candidate filtering.
-- recommendation_impressions is the A/B + feedback loop surface (Phase 2).

CREATE TABLE user_behavior_events (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type  text NOT NULL CHECK (event_type IN ('view_merchant','search','cart_add','heart','order_paid','booking')),
    merchant_id uuid,
    query       text,
    city_id     uuid,
    lat         double precision,
    lon         double precision,
    daypart     text NOT NULL CHECK (daypart IN ('breakfast','lunch','dinner','late','unknown')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ube_user_created ON user_behavior_events (user_id, created_at DESC);
CREATE INDEX idx_ube_merchant_city ON user_behavior_events (merchant_id, city_id);
CREATE INDEX idx_ube_user_type ON user_behavior_events (user_id, event_type);

CREATE TABLE recommendation_impressions (
    id           bigserial PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_ids jsonb NOT NULL,
    reasons      jsonb,
    city_id      uuid,
    lat          double precision,
    lon          double precision,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ri_user_created ON recommendation_impressions (user_id, created_at DESC);

-- Backfill order_paid from existing orders (warm-start signal instantly available).
-- Daypart derived from created_at hour in Africa/Dar_es_Salaam.
INSERT INTO user_behavior_events (user_id, event_type, merchant_id, city_id, daypart, created_at)
SELECT
    o.customer_user_id,
    'order_paid',
    o.merchant_id,
    m.city_id,
    CASE
        WHEN EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') BETWEEN 6 AND 10 THEN 'breakfast'
        WHEN EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') BETWEEN 11 AND 14 THEN 'lunch'
        WHEN EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') BETWEEN 17 AND 21 THEN 'dinner'
        ELSE 'late'
    END,
    o.created_at
FROM orders o
JOIN merchants m ON m.id = o.merchant_id
WHERE o.customer_user_id IS NOT NULL
  AND o.status NOT IN ('cancelled','refunded','failed');

-- +goose Down
DROP TABLE IF EXISTS recommendation_impressions;
DROP TABLE IF EXISTS user_behavior_events;
