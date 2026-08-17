-- +goose Up
-- LIVE DEALS bounded context (API-CONTRACT.yaml /marketing/live-deals,
-- 神抢手-lite): scheduled flash-sale sessions with countdowns. Status is
-- DERIVED from the window at list time (starts_at <= now < ends_at => live;
-- before starts_at => scheduled; from ends_at onward the row is simply not
-- listed) — the stored status column is a convenience projection that a
-- sweep can maintain, never trusted by the reader, mirroring the consumer
-- mock (mock/marketing.ts deriveLiveDealStatus).

CREATE TABLE live_deals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id        uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    title              text NOT NULL,
    description        text NOT NULL DEFAULT '',
    deal_price_tzs     bigint NOT NULL CHECK (deal_price_tzs >= 0),
    original_price_tzs bigint NOT NULL CHECK (original_price_tzs >= 0),
    starts_at          timestamptz NOT NULL,
    ends_at            timestamptz NOT NULL,
    slots_total        int NOT NULL DEFAULT 0 CHECK (slots_total >= 0),
    slots_sold         int NOT NULL DEFAULT 0 CHECK (slots_sold BETWEEN 0 AND slots_total),
    status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

CREATE INDEX idx_live_deals_window ON live_deals (starts_at, ends_at);
CREATE INDEX idx_live_deals_merchant ON live_deals (merchant_id);

-- +goose Down
DROP TABLE IF EXISTS live_deals;