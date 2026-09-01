# Pending backend endpoints — implementation backlog (single source of truth)

Source of truth: `app/src/lib/pending-endpoints.ts` (`PENDING_ENDPOINTS` record). Every key below is a documented integration point that the admin console renders full UI for (queues, drawers, reason prompts, validation) but whose final network call resolves to a `PENDING_ENDPOINT` state because the path does NOT exist in `backend/API-CONTRACT.yaml` yet.

## Purpose

The admin console is contract-first: it only calls paths that exist in `backend/API-CONTRACT.yaml` (via `@hudumika/contract`). Several documented workflows (WORKFLOWS.md) and module specs (MODULES.md) reference actions whose endpoints have not yet landed in the contract. Those surfaces render full UI but the mutation is surfaced with a PENDING_ENDPOINT notice (`pendingEndpointNotice(key)` — "This action requires {METHOD} {path} — pending backend implementation. See docs/PENDING-ENDPOINTS.md ({workflow}).") instead of a fake network call.

The backend team (Team 6) implements each endpoint below without skipping. When a spec lands:

1. Add the path to `backend/API-CONTRACT.yaml`.
2. Regenerate the contract client: `npm run build:contract` (workspace root).
3. Add the MSW mock so the generated client function resolves 200 (the MSW server is generated from the same API-CONTRACT.yaml; `app/src/test/parity.test.ts` is the parity gate).
4. In the app: wire the generated client function, remove the pending branch in the page, delete the key from `PENDING_ENDPOINTS`, and update the page tests.

No key may be deleted from this file or from `PENDING_ENDPOINTS` until the path is live in the contract.

Audit convention for every entry below (per AUDIT.md, entry schema `backend/AUDIT.md`): the mutation writes an audit entry with `actorUserId`, `actorRole`, `action`, `entityType`, `entityId`, `details {before, after, reason}`, `requestId`, and `ipAddress`. The per-endpoint "Audit" lines below list the prefix and the domain-specific `before`/`after` values; `actorUserId`, `actorRole`, `action`, `entityType`, `entityId`, `reason`, `requestId`, `ipAddress` are always present.

Two-person flag convention: an endpoint carries `TWO_PERSON_REQUIRED` (409) in its errors list when the mutation must go through the two-person (4-eyes) approval flow (WORKFLOWS.md workflow 31: the initiating admin creates the approval, a different admin decides, execution is server-driven). Endpoints NOT flagged here never require 4-eyes at the API level, even where a finance sign-off is described in the workflow.

---

## Live — wired 2026-08-29 (16 endpoints, contract live via `admin-pending` tag)

These 16 were previously pending and are now live in `backend/API-CONTRACT.yaml` (tag `admin-pending`) and wired in the admin web. They no longer appear in `PENDING_ENDPOINTS`.

| Key | Endpoint | Page | Contract operationId |
|---|---|---|---|
| `rider_approve` | `POST /admin/riders/{riderId}/approval` | `RidersPage` `/logistics/riders` | `adminRiderApprovalDecision` |
| `provider_approve` | `POST /admin/providers/{providerId}/approval` | `ProvidersPage` `/services/providers` | `adminProviderApprovalDecision` |
| `order_cancel` | `POST /admin/orders/{orderId}/cancel` | `OrdersPage` `/commerce/orders` | `adminCancelOrder` (TWO_PERSON when refund > threshold) |
| `payout_reconcile` | `POST /admin/payouts/{batchId}/reconcile` | `PaymentsPage` `/finance/payments` | `adminPayoutReconcile` |
| `chain_onboard` | `POST /admin/chains/{merchantGroupId}/onboard` | `ChainsPage` `/chains` | `adminChainOnboard` |
| `chain_suspend` | `POST /admin/chains/{merchantGroupId}/suspend` | `ChainsPage` `/chains` | `adminChainSuspend` (TWO_PERSON) |
| `export_approve` | `POST /admin/data-exports/{jobId}/approval` | `DataExportsPage` `/exports` | `adminDataExportDecision` |
| `export_rerun` | `POST /admin/data-exports/{jobId}/rerun` | `DataExportsPage` `/exports` | `adminDataExportRerun` |
| `cod_decision` | `POST /admin/riders/{riderId}/cod/{shiftId}/decision` | `CodReconciliationPage` `/logistics/riders/cod` | `adminRiderCodShiftDecision` |
| `crash_respond` | `POST /admin/riders/{riderId}/safety/crash` | `FleetControlTowerPage` `/operations/fleet-tower` | `adminCrashRespond` |
| `rest_override` | `POST /admin/riders/{riderId}/rest` | `FleetControlTowerPage` `/operations/fleet-tower` | `adminRiderRestOverride` |
| `loyalty_config` | `PUT /admin/loyalty/config` | `LoyaltyPage` `/growth/loyalty` | `adminUpdateLoyaltyConfig` |
| `consignment_missing_resolve` | `POST /admin/consignments/{consignmentId}/missing` | `ConsignmentsPage` `/operations/consignments` | `adminConsignmentMissingDecision` |
| `seal_broken_resolve` | `POST /admin/handoffs/{handoffId}/seal` | `WaybillPage` `/logistics/waybills` | `adminHandoffSealDecision` |
| `anomaly_resolve` | `POST /admin/logistics-anomalies/{anomalyId}/decision` | `ShipmentsPage` `/logistics/shipments` | `adminLogisticsAnomalyDecision` |
| `dispute_resolve` | `POST /admin/disputes/{disputeId}/decision` | `OrdersPage` `/commerce/orders` (disputed drawer) | `adminDisputeDecision` |

All 35 are covered by `packages/contract` `admin-pending` MSW mocks (via `packages/contract/src/mocks.ts` `getAdminPendingMock()`) and by `app/src/test/parity.test.ts` where exercised.

---

## Live — wired 2026-08-29 (35 endpoints, contract live via `admin-pending` tag)

| # | Key | Endpoint | Page |
|---|---|---|---|
| 1 | `rider_approve` | `POST /admin/riders/{riderId}/approval` | `RidersPage` |
| 2 | `provider_approve` | `POST /admin/providers/{providerId}/approval` | `ProvidersPage` |
| 3 | `order_cancel` | `POST /admin/orders/{orderId}/cancel` | `OrdersPage` |
| 4 | `payout_reconcile` | `POST /admin/payouts/{batchId}/reconcile` | `PaymentsPage` |
| 5 | `chain_onboard` | `POST /admin/chains/{merchantGroupId}/onboard` | `ChainsPage` |
| 6 | `chain_suspend` | `POST /admin/chains/{merchantGroupId}/suspend` | `ChainsPage` |
| 7 | `export_approve` | `POST /admin/data-exports/{jobId}/approval` | `DataExportsPage` |
| 8 | `export_rerun` | `POST /admin/data-exports/{jobId}/rerun` | `DataExportsPage` |
| 9 | `cod_decision` | `POST /admin/riders/{riderId}/cod/{shiftId}/decision` | `CodReconciliationPage` |
| 10 | `crash_respond` | `POST /admin/riders/{riderId}/safety/crash` | `FleetControlTowerPage` |
| 11 | `rest_override` | `POST /admin/riders/{riderId}/rest` | `FleetControlTowerPage` |
| 12 | `loyalty_config` | `PUT /admin/loyalty/config` | `LoyaltyPage` |
| 13 | `consignment_missing_resolve` | `POST /admin/consignments/{consignmentId}/missing` | `ConsignmentsPage` |
| 14 | `seal_broken_resolve` | `POST /admin/handoffs/{handoffId}/seal` | `WaybillPage` |
| 15 | `anomaly_resolve` | `POST /admin/logistics-anomalies/{anomalyId}/decision` | `ShipmentsPage` |
| 16 | `dispute_resolve` | `POST /admin/disputes/{disputeId}/decision` | `OrdersPage` |
| 17 | `password_reset` | `POST /admin/password-reset` | `PasswordResetPage` |
| 18 | `scheduled_reports` | `GET/POST /admin/reports/scheduled` | `ScheduledReportsPage` |
| 19 | `quality_scores` | `GET/PUT /admin/quality-scores` | `QualityScorePage` |
| 20 | `settings` | `GET/PUT /admin/settings` | `GeneralSettingsPage` |
| 21 | `gateways` | `GET/PUT /admin/gateways` | `GatewaysPage` |
| 22 | `content_editorial` | `GET/POST /admin/content`, `PATCH /admin/content/{id}/state` | `ContentEditorialPage` |
| 23 | `payroll_run` | `POST /admin/payroll/run` | `PayrollPage` |
| 24 | `payroll_list` | `GET /admin/payroll` | `PayrollPage` |
| 25 | `config_center` | `GET/PUT /admin/config/{domain}` | `ConfigCenterPage` |
| 26 | `admin_users_list` | `GET /admin/admins` | `AdminUsersPage` |
| 27 | `admin_users_create` | `POST /admin/admins` | `AdminUsersPage` |
| 28 | `admin_users_update` | `PATCH /admin/admins/{adminId}` | `AdminUsersPage` |
| 29 | `admin_users_suspend` | `DELETE /admin/admins/{adminId}` | `AdminUsersPage` |
| 30 | `teams_crud` | `GET/POST/PATCH/DELETE /admin/teams` | `TeamsPage` |
| 31 | `policies_crud` | `GET/POST /admin/policies` | `PoliciesPage` |
| 32 | `notifications_scheduled` | `GET/DELETE /admin/notifications/scheduled` | `HelpPage` |
| 33 | `map_traffic` | `GET /admin/map/traffic` | `MapTrafficPage` |
| 34 | `iam_staff_roles` | `GET/POST /admin/staff-roles` | `StaffRolesPage` |

All 35 have contract definitions, generated TS client, MSW mocks, and wired frontend pages. `app/src/lib/pending-endpoints.ts` is `{}` (0 pending).

---

## Pending — 0 endpoints (all 34 wired)

No pending UI remains; every mutation is contract-live and covered by `parity.test.ts`.

## Definition of done for each endpoint

For EVERY key above, implementation must:

1. Add the path to `backend/API-CONTRACT.yaml` (workspace root) with the request/response/error schema exactly as specified in this file.
2. Regenerate the contract client from the workspace root: `npm run build:contract`.
3. Add the MSW mock for the new path so the generated client function resolves 200 (parity gate: `app/src/test/parity.test.ts` runs in CI; new mutations should be added to the parity matrix where the app consumes them).
4. In the app: wire the generated client function into the page, remove the PENDING_ENDPOINT branch (and the `pendingEndpointNotice` rendering), delete the key from `PENDING_ENDPOINTS`, and update the page tests (success path + error-code rendering per the errors list above).
5. Confirm the mutation writes the audit entry (`actorUserId`, `actorRole`, `action`, `entityType`, `entityId`, `details {before, after, reason}`, `requestId`, `ipAddress`) under the prefix listed above, rendered on the entity timeline (AUDIT.md).

Two-person endpoints must additionally render the 409 `TWO_PERSON_REQUIRED` path and route the action through the two-person approval flow (WORKFLOWS.md workflow 31) before execution.

This file is the single source of truth for the pending backlog. It stays in sync with `app/src/lib/pending-endpoints.ts`: every key in the record has a section here, and every section here has a key in the record.
