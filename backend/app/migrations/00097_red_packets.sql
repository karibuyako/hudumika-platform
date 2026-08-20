-- +goose Up
-- RED PACKETS (MthShareRedPacket / MthClaimRedPacket / MthListReceivedRedPackets):
-- hongbao-style sharing. creator mints a packet with total_tzs split across
-- count claims; share_code is the UNIQUE lookup key; claimed counts how many
-- have been taken. red_packet_claims is one row per user claim, unique per
-- (red_packet_id, user_id) so double-claims cannot race.

CREATE TABLE IF NOT EXISTS red_packets (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_code        text NOT NULL UNIQUE,
    total_tzs         bigint NOT NULL CHECK (total_tzs > 0),
    count             int NOT NULL CHECK (count > 0),
    claimed           int NOT NULL DEFAULT 0 CHECK (claimed >= 0),
    expires_at        timestamptz,
    status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'expired')),
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_red_packets_share_code ON red_packets (share_code);
CREATE INDEX IF NOT EXISTS idx_red_packets_creator ON red_packets (creator_user_id);
CREATE INDEX IF NOT EXISTS idx_red_packets_status ON red_packets (status);

CREATE TABLE IF NOT EXISTS red_packet_claims (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    red_packet_id     uuid NOT NULL REFERENCES red_packets(id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claimed_tzs       bigint NOT NULL CHECK (claimed_tzs > 0),
    claimed_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (red_packet_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_red_packet_claims_packet ON red_packet_claims (red_packet_id);
CREATE INDEX IF NOT EXISTS idx_red_packet_claims_user ON red_packet_claims (user_id);

-- +goose Down
DROP TABLE IF EXISTS red_packet_claims;
DROP TABLE IF EXISTS red_packets;
