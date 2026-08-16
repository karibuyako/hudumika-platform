-- +goose Up
-- Integrations and outbound webhook subscriptions (API-CONTRACT.yaml
-- /integrations + /webhooks): connector rows per merchant + provider, the
-- outgoing webhook registry, and the delivery attempt log. The webhook
-- dispatcher owns webhook_deliveries writes (backend/ARCHITECTURE.md
-- external-call discipline); API handlers only read them. merchant_id is
-- the subject user id of the owning session (per-user registries).

CREATE TABLE integrations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          text NOT NULL CHECK (provider IN ('pos', 'erp', 'accounting', 'payroll', 'crm')),
    name              text,
    scope             jsonb,
    status            text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
    config            jsonb,
    disconnected_at   timestamptz,
    disconnect_reason text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, provider)
);

CREATE INDEX idx_integrations_merchant_created ON integrations (merchant_id, created_at DESC, id DESC);

CREATE TABLE webhook_subscriptions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url         text NOT NULL,
    event_types jsonb NOT NULL,
    secret      text NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_subscriptions_merchant_created ON webhook_subscriptions (merchant_id, created_at DESC, id DESC);

CREATE TABLE webhook_deliveries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id  uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    event            text NOT NULL,
    payload          jsonb,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts         int NOT NULL DEFAULT 0,
    last_status_code int,
    last_error       text,
    next_attempt_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    delivered_at     timestamptz
);

CREATE INDEX idx_webhook_deliveries_subscription_created ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at) WHERE next_attempt_at IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_subscriptions;
DROP TABLE IF EXISTS integrations;
