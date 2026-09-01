-- +goose Up
-- Migration 00122: Tables for admin handler deepening (handoffs, facility entries, quality weights, settings, password reset tokens)

-- Extend handoffs table with carrier/consignment references for AdminListHandoffs
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS carrier_id text;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS consignment_id uuid;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'seal_broken'));

-- Facility entries table for AdminListFacilityEntries
CREATE TABLE IF NOT EXISTS facility_entries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL,
    rider_id    uuid NOT NULL REFERENCES users(id),
    rider_name  text,
    scanned_at  timestamptz NOT NULL DEFAULT now(),
    status      text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'denied')),
    lat         real,
    lon         real,
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facility_entries_facility ON facility_entries (facility_id, scanned_at DESC);

-- Quality score weights stored as JSON in quality_score_config
ALTER TABLE quality_score_config ADD COLUMN IF NOT EXISTS weights jsonb NOT NULL DEFAULT '{"cancellationBps":2500,"completionBps":2500,"customerRatingBps":2500,"deliveryTimeBps":2500}';

-- Platform settings: add columns for all sections if they don't exist
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS language text DEFAULT 'sw';
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'Africa/Dar_es_Salaam';
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS order_min_tzs int;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS order_max_delivery_fee_tzs int;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS order_auto_cancel_minutes int;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS booking_max_lead_time_hours int;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS booking_min_cancellation_hours int;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS booking_no_show_fee_tzs int;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS notification_email_enabled boolean DEFAULT true;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS notification_push_enabled boolean DEFAULT true;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS notification_sms_enabled boolean DEFAULT true;

-- Password reset tokens for AdminResetPassword
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id),
    token      text NOT NULL,
    method     text NOT NULL CHECK (method IN ('sms', 'email')),
    expires_at timestamptz NOT NULL,
    used       boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS facility_entries;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS notification_sms_enabled;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS notification_push_enabled;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS notification_email_enabled;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS booking_no_show_fee_tzs;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS booking_min_cancellation_hours;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS booking_max_lead_time_hours;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS order_auto_cancel_minutes;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS order_max_delivery_fee_tzs;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS order_min_tzs;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS timezone;
ALTER TABLE platform_settings DROP COLUMN IF EXISTS language;
ALTER TABLE quality_score_config DROP COLUMN IF EXISTS weights;
ALTER TABLE handoffs DROP COLUMN IF EXISTS status;
ALTER TABLE handoffs DROP COLUMN IF EXISTS consignment_id;
ALTER TABLE handoffs DROP COLUMN IF EXISTS carrier_id;
