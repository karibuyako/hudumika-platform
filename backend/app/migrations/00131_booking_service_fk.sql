-- +goose Up
-- Bookings can reference provider-created services (provider_services),
-- not only rows in the platform services catalog. The application layer
-- validates the service via bookings.GetService (services, then
-- provider_services fallback) and returns SERVICE_NOT_FOUND for unknown
-- ids, so the database FK to services(id) is dropped; it would otherwise
-- reject every legitimate provider-service booking with a 500.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_service_id_fkey;

-- +goose Down
-- Re-adding the constraint fails while provider-service bookings exist;
-- delete or migrate those rows first.
ALTER TABLE bookings ADD CONSTRAINT bookings_service_id_fkey
  FOREIGN KEY (service_id) REFERENCES services(id);
