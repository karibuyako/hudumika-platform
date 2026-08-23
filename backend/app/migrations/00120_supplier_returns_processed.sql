-- +goose Up
-- Allow supplier returns to be moved into the 'processed' state by merchant
-- operations (process/reject handlers). Additive only: no data is altered.

ALTER TABLE supplier_returns DROP CONSTRAINT IF EXISTS supplier_returns_status_check;
ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_status_check
  CHECK (status = ANY (ARRAY['requested'::text, 'accepted'::text, 'rejected'::text, 'received'::text, 'processed'::text]));

-- +goose Down
ALTER TABLE supplier_returns DROP CONSTRAINT IF EXISTS supplier_returns_status_check;
ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_status_check
  CHECK (status = ANY (ARRAY['requested'::text, 'accepted'::text, 'rejected'::text, 'received'::text]));
