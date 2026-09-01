-- +goose Up
ALTER TABLE live_locations ADD CONSTRAINT uq_live_locations_entity UNIQUE (entity_type, entity_id);
-- +goose Down
ALTER TABLE live_locations DROP CONSTRAINT IF EXISTS uq_live_locations_entity;
