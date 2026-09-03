-- +goose Up
-- Staff roles (admin/staff/finance/ops/compliance) must be grantable in the
-- roles table: session_roles.go accepts them and routePolicy routes /admin/*
-- to them, but the original CHECK only allowed the four app roles, so every
-- staff verify-otp failed with ROLE_NOT_ACTIVE.

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_role_check;
ALTER TABLE roles ADD CONSTRAINT roles_role_check
  CHECK (role IN ('customer', 'merchant', 'provider', 'rider', 'staff', 'admin', 'finance', 'ops', 'compliance'));

-- +goose Down
-- Restore only when no staff-family rows exist; otherwise the re-added
-- CHECK would reject existing rows.
-- ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_role_check;
-- ALTER TABLE roles ADD CONSTRAINT roles_role_check
--   CHECK (role IN ('customer', 'merchant', 'provider', 'rider'));
