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

## 1. rider_approve

- **Endpoint**: `POST /admin/riders/{riderId}/approval`
- **Request body**: `{ decision: "approve" | "request_changes", reason }` — `decision` required; `reason` required (both outcomes).
- **Expected success response**: `200` → `{ riderId, status: "approved" | "changes_requested" }` (the rider's verification state after the decision).
- **Error codes**:
  - `RIDER_NOT_FOUND` (404) — no rider for `riderId`.
  - `RIDER_ALREADY_DECIDED` (409) — the rider already has a terminal verification state.
  - `FORBIDDEN` (403) — the actor lacks the rider-approval permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `rider.` — `rider.approved` / `rider.changes_requested`; `before`/`after` = rider verification state (e.g. `pending` → `approved`).
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #3 — Approve a rider.
- **UI surface**: Riders module (route `/logistics/riders`, `RidersPage`) — verification drawer on the rider record. Today the drawer renders read-only document/verification state with the note "COD reconciliation and verification decisions ship in a later milestone."; the approve/request-changes decision renders the PENDING_ENDPOINT notice.

## 2. provider_approve

- **Endpoint**: `POST /admin/providers/{providerId}/approval`
- **Request body**: `{ decision: "approve" | "request_changes", reason }` — `decision` required; `reason` required.
- **Expected success response**: `200` → `{ providerId, status: "approved" | "changes_requested" }`.
- **Error codes**:
  - `PROVIDER_NOT_FOUND` (404) — no provider for `providerId`.
  - `PROVIDER_ALREADY_DECIDED` (409) — terminal verification state already set.
  - `FORBIDDEN` (403) — lacks provider-approval permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `provider.` — decision action; `before`/`after` = provider verification state.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #2 — Approve a provider.
- **UI surface**: Providers module (route `/services/providers`, `ProvidersPage`) — verification drawer on the provider record; approval decision renders the PENDING_ENDPOINT notice.

## 3. dispute_resolve

- **Endpoint**: `POST /admin/disputes/{disputeId}/decision`
- **Request body**: `{ decision: "refund" | "payout" | "reject", amountTZS?, reason }` — `decision` required; `amountTZS` required when `decision` is `refund` or `payout` (TZS, integer); `reason` required.
- **Expected success response**: `200` → `{ disputeId, decision, status: "decided" }` — the payout hold is released (or refund ledger entries are created).
- **Error codes**:
  - `DISPUTE_ALREADY_DECIDED` (409) — the dispute already has a decision.
  - `DISPUTE_NOT_FOUND` (404) — no dispute for `disputeId`.
  - `FORBIDDEN` (403) — lacks the dispute-resolution permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
  - `TWO_PERSON_REQUIRED` (409) — decision above the finance threshold; must go through the two-person approval flow (workflow 31) before the decision executes.
- **Audit**: prefix `dispute.` — decision action; `before`/`after` = dispute state (hold → decided) and, on refund, the payout/refund amount.
- **Two-person flag**: YES — `TWO_PERSON_REQUIRED` is in the errors list; above-threshold decisions (refund/payout over the finance threshold) require a second admin's approval before execution.
- **Workflow reference**: WORKFLOWS.md #4 — Resolve a dispute.
- **UI surface**: dispute queue surfaced from Orders/Bookings records and the Payments module (routes `/commerce/orders`, `/bookings`, `/finance/payments`) — decision drawer with amount + reason; the decision action renders the PENDING_ENDPOINT notice.

## 4. payout_reconcile

- **Endpoint**: `POST /admin/payouts/{batchId}/reconcile`
- **Request body**: `{ outcome: "paid" | "failed" | "exception", note? }` — `outcome` required; `note` required when `outcome` is `exception` (variance explanation).
- **Expected success response**: `200` → `{ batchId, outcome, settledAt }` — batch settles; finance sign-off recorded.
- **Error codes**:
  - `PAYOUT_BATCH_NOT_FOUND` (404) — no payout batch for `batchId`.
  - `PAYOUT_ALREADY_RECONCILED` (409) — batch already settled.
  - `FORBIDDEN` (403) — lacks finance payout-reconciliation permission.
  - `ADMIN_REASON_REQUIRED` (422) — `note` missing when required.
- **Audit**: prefix `payout.` — reconciliation action; `before`/`after` = batch settlement state (open → reconciled) with the outcome.
- **Two-person flag**: no — `TWO_PERSON_REQUIRED` is NOT in the errors list. Finance sign-off is recorded in the audit entry per workflow 5, but the endpoint itself is not 4-eyes-gated.
- **Workflow reference**: WORKFLOWS.md #5 — Reconcile payouts.
- **UI surface**: Payments module (route `/finance/payments`, `PaymentsPage`) — payout batch rows with match/exception actions; the reconcile action renders the PENDING_ENDPOINT notice.

## 5. cod_decision

- **Endpoint**: `POST /admin/riders/{riderId}/cod/{shiftId}/decision`
- **Request body**: `{ status: "reconciled" | "mismatch", note? }` — `status` required; `note` required when `status` is `mismatch` (variance explanation).
- **Expected success response**: `200` → `{ shiftId, status: "reconciled" | "mismatch" }` — shift state updates on the rider side.
- **Error codes**:
  - `SHIFT_NOT_FOUND` (404) — no shift for `shiftId` under this rider.
  - `SHIFT_ALREADY_DECIDED` (409) — shift already has a decision.
  - `COD_RECONCILIATION_UNAVAILABLE` (409/empty) — no shifts in range; renders as an empty state.
  - `FORBIDDEN` (403) — lacks the COD-reconciliation permission.
  - `ADMIN_REASON_REQUIRED` (422) — `note` missing when required.
- **Audit**: prefix `cod.` — decision action; `before`/`after` = shift status (`pending` → `reconciled`/`mismatch`) with `expectedTZS`/`collectedTZS`/`varianceTZS` context.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #18 — Reconcile rider COD.
- **UI surface**: Riders module COD reconciliation (route `/logistics/riders/cod`, `CodReconciliationPage`, module 5) — per-shift `expectedTZS` vs `collectedTZS` table with mismatch flags. Today the page is read-only and states "Reconciliation decisions are finance actions (cod.* audit); decision endpoints ship with the backend milestone — this view is read-only."; the reconciled/mismatch decision renders the PENDING_ENDPOINT notice.

## 6. conversation_block

- **Endpoint**: `POST /conversations/{conversationId}/block` (outside the `/admin/*` prefix but staff-only and MFA-gated by contract)
- **Request body**: `{ reason }` — `reason` required, max 500, never client-composed.
- **Expected success response**: `200` → `{ conversationId, status: "blocked" }` — both parties notified (`conversation.blocked`) and receive `CONVERSATION_BLOCKED` on further sends.
- **Error codes**:
  - `CONVERSATION_NOT_FOUND` (404) — no conversation for `conversationId`.
  - `CONVERSATION_ALREADY_BLOCKED` (409) — conversation already in the blocked state.
  - `FORBIDDEN` (403) — lacks the conversation-moderation permission (or MFA missing).
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `conversation.` — block action; `before`/`after` = conversation status (`open`/`archived` → `blocked`); blocked-conversation history is compliance-gated.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #13 — Moderate an abusive conversation.
- **UI surface**: Messages and chat oversight (route `/conversations`, `ConversationsPage`, module 19) — conversation search + masked message history; the block action (reason prompt, max 500) renders the PENDING_ENDPOINT notice. Staff never reply inside the customer-merchant chat.

## 7. chain_onboard

- **Endpoint**: `POST /admin/chains/{merchantGroupId}/onboard`
- **Request body**: `{ tier: "standard" | "enterprise", slaLevel?, accountManager? }` — `tier` required; `slaLevel`/`accountManager` set when defined for the tier.
- **Expected success response**: `200` → `{ merchantGroupId, tier, slaLevel, accountManager, status: "active" }`.
- **Error codes**:
  - `CHAIN_NOT_FOUND` (404) — no merchant group for `merchantGroupId`.
  - `CHAIN_ALREADY_ACTIVE` (409) — chain already active; suspension is the only downgrade path.
  - `FORBIDDEN` (403) — lacks the enterprise-chain permission.
  - `ADMIN_REASON_REQUIRED` (422) — decision reason missing (every chain decision requires a reason).
- **Audit**: prefix `chain.` — onboarding action; `before`/`after` = chain status (`application` → `active`) plus tier/SLA/account-manager assignment.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #14 — Onboard an enterprise chain.
- **UI surface**: Enterprise chains module (route `/chains`, `ChainsPage`, module 20) — chain list with tier/SLA/account-manager view; the onboard action (tier picker + assignments + reason) renders the PENDING_ENDPOINT notice.

## 8. chain_suspend

- **Endpoint**: `POST /admin/chains/{merchantGroupId}/suspend`
- **Request body**: `{ reason }` — `reason` required; never client-composed.
- **Expected success response**: `200` → `{ merchantGroupId, status: "suspended" }` — merchant-group operations disabled.
- **Error codes**:
  - `CHAIN_NOT_FOUND` (404) — no merchant group for `merchantGroupId`.
  - `CHAIN_ALREADY_SUSPENDED` (409) — chain already suspended.
  - `FORBIDDEN` (403) — lacks the suspension permission (ops manager and above).
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
  - `TWO_PERSON_REQUIRED` (409) — suspension must go through the two-person approval flow (workflow 31) before execution.
- **Audit**: prefix `chain.` — suspend action; `before`/`after` = chain status (`active` → `suspended`).
- **Two-person flag**: YES — `TWO_PERSON_REQUIRED` is in the errors list; suspension is 4-eyes-gated.
- **Workflow reference**: WORKFLOWS.md #14 — Onboard an enterprise chain (suspend path).
- **UI surface**: Enterprise chains module (route `/chains`, `ChainsPage`, module 20) — per-chain suspend action with reason prompt; renders the PENDING_ENDPOINT notice.

## 9. export_approve

- **Endpoint**: `POST /admin/data-exports/{jobId}/approval`
- **Request body**: `{ decision: "approve" | "reject", reason }` — `decision` required; `reason` required (both outcomes).
- **Expected success response**: `200` → `{ jobId, decision, status: "queued" | "processing" | "rejected" }` — approved jobs run `queued` → `processing` → `ready`; the requester is notified (`data_export.ready`) with `downloadUrl` + `expiresInSeconds`.
- **Error codes**:
  - `DATA_EXPORT_NOT_FOUND` (404) — no job for `jobId`.
  - `DATA_EXPORT_ALREADY_DECIDED` (409) — job already has an approval decision.
  - `DATA_EXPORT_RATE_LIMITED` (429) — export queue rate limit hit.
  - `FORBIDDEN` (403) — lacks the export-approval (compliance/finance) permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `export.` — approval decision; `before`/`after` = job status (e.g. `queued` → `processing` / `rejected`) plus scope/format context.
- **Two-person flag**: no — `TWO_PERSON_REQUIRED` is NOT in the errors list. WORKFLOWS.md #16 notes that large exports additionally require finance sign-off; that sign-off is a workflow/role control, not a 4-eyes API gate on this endpoint.
- **Workflow reference**: WORKFLOWS.md #16 — Approve an enterprise data export.
- **UI surface**: Data export queue (route `/exports`, `DataExportsPage`, module 22) — job rows with scope/format/status; the approve/reject decision renders the PENDING_ENDPOINT notice.

## 10. export_rerun

- **Endpoint**: `POST /admin/data-exports/{jobId}/rerun`
- **Request body**: `{ reason }` — `reason` required.
- **Expected success response**: `200` → `{ jobId, status: "queued" }` — the failed or expired-`ready` job is resubmitted.
- **Error codes**:
  - `DATA_EXPORT_IN_PROGRESS` (409) — job already running; cannot re-run.
  - `DATA_EXPORT_NOT_FOUND` (404) — no job for `jobId`.
  - `FORBIDDEN` (403) — lacks the export re-run permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `export.` — re-run action; `before`/`after` = job status (`failed`/`ready`(expired) → `queued`).
- **Two-person flag**: no.
- **Workflow reference**: MODULES.md #22 — Data export queue (re-run).
- **UI surface**: Data export queue (route `/exports`, `DataExportsPage`, module 22) — re-run action on `failed` or expired-`ready` rows; renders the PENDING_ENDPOINT notice.

## 11. loyalty_config

- **Endpoint**: `PUT /admin/loyalty/config`
- **Request body**: `{ tiers[], topUpRewards[] }` — `tiers[]` (per tier: `name`, `discountBps`, `thresholdTZS`, `perks`) and `topUpRewards[]` (`thresholdTZS`/`bonusTZS` pairs) both required; values validated against policy limits.
- **Expected success response**: `200` → `{ config: { tiers, topUpRewards }, updatedAt }` — the reviewed config is persisted.
- **Error codes**:
  - `LOYALTY_CONFIG_INVALID` (422) — config fails policy validation (excessive `discountBps`, bonus rates exceeding spend, trivial/unreachable tier thresholds).
  - `FORBIDDEN` (403) — lacks the loyalty-oversight permission.
  - `ADMIN_REASON_REQUIRED` (422) — review reason missing.
- **Audit**: prefix `loyalty.` — config-change action; `before`/`after` = serialized tier/top-up reward config.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #12 — Oversee merchant loyalty config.
- **UI surface**: merchant loyalty config review per workflow 12 — surfaced from the merchant record review flow (Merchants module, route `/commerce/merchants`); flag anomalies or request merchant changes; the config-write action renders the PENDING_ENDPOINT notice.

## 12. crash_respond

- **Endpoint**: `POST /admin/riders/{riderId}/safety/crash`
- **Request body**: `{ outcome: "safe" | "unsafe", note? }` — `outcome` required; `note` records the follow-up (linked support ticket).
- **Expected success response**: `200` → `{ riderId, outcome: "safe" | "unsafe" }` — `safety.crash_acknowledged` (critical) notifies dispatch + emergency contacts.
- **Error codes**:
  - `RIDER_NOT_FOUND` (404) — no rider for `riderId`.
  - `SAFETY_EVENT_ALREADY_HANDLED` (409) — crash event already has an outcome.
  - `FORBIDDEN` (403) — lacks the safety-response permission.
  - `ADMIN_REASON_REQUIRED` (422) — reason/note missing where required.
- **Audit**: prefix `safety.` — crash-response action; `before`/`after` = safety-event state (open → acknowledged) with the outcome.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #19 — Respond to a crash alert.
- **UI surface**: Fleet control tower (route `/operations/fleet-tower`, `FleetControlTowerPage`, module 23) — crash/SOS flags and anomaly counters drill into the rider with safety context; the safe/unsafe outcome action renders the PENDING_ENDPOINT notice. Uncovered orders are reassigned via manual override (workflow 17, which is in the contract).

## 13. rest_override

- **Endpoint**: `POST /admin/riders/{riderId}/rest`
- **Request body**: `{ action: "enforce" | "relieve", reason }` — `action` required; `reason` required (ops manager + rider ops only).
- **Expected success response**: `200` → `{ riderId, forcedRestUntil: ISO string | null }` — `enforce` sets the rest window; `relieve` clears it early.
- **Error codes**:
  - `RIDER_NOT_FOUND` (404) — no rider for `riderId`.
  - `REST_ALREADY_ENFORCED` (409) — enforcement already in place (or not in place for `relieve`).
  - `FORBIDDEN` (403) — lacks the rest-override permission (ops manager + rider ops).
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `rider.` — rest action; `before`/`after` = `forcedRestUntil` (and `continuousDrivingMinutes` context).
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #20 — Enforce or relieve mandatory rest.
- **UI surface**: Fleet control tower / Riders drill-in (routes `/operations/fleet-tower` and `/logistics/riders`, modules 23 + 5) — the rider record shows `forcedRestUntil` and `continuousDrivingMinutes`; the enforce/relieve override renders the PENDING_ENDPOINT notice.

## 14. seal_broken_resolve

- **Endpoint**: `POST /admin/handoffs/{handoffId}/seal`
- **Request body**: `{ outcome: "resealed" | "damage_claim", reason }` — `outcome` required; `reason` required; `resealed` carries the condition photo + note per the custody record.
- **Expected success response**: `200` → `{ handoffId, outcome, sealIntact: true | false }` — the leg advances normally (or the damage/loss claim opens).
- **Error codes**:
  - `HANDOFF_NOT_FOUND` (404) — no handoff for `handoffId`.
  - `HANDOFF_ALREADY_DECIDED` (409) — seal incident already decided.
  - `FORBIDDEN` (403) — lacks the handoff-resolution permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `handoff.` — seal decision; `before`/`after` = seal state (`sealIntact: false` → `true` on reseal / claim reference on damage claim), with `from`/`to` custody context.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #22 — Handle a seal-broken handoff.
- **UI surface**: Hubs & line-haul oversight (route `/operations/consignments`, `ConsignmentsPage`, module 24) — seal-broken incidents show the custody record (`from`/`to`/`at`, `sealIntact: false`) and link to the waybill trail (module 25); the reseal/damage-claim decision renders the PENDING_ENDPOINT notice.

## 15. anomaly_resolve

- **Endpoint**: `POST /admin/logistics-anomalies/{anomalyId}/decision`
- **Request body**: `{ decision: "dismiss" | "freeze" | "block", reason }` — `decision` required; `reason` required; `dismiss` carries a `note` for false positives (GPS drift, clock skew).
- **Expected success response**: `200` → `{ anomalyId, decision, resolved: true }` — dismiss clears the queue row; freeze/block sets the shipment `status: exception` (excluded from dispatch and loading).
- **Error codes**:
  - `ANOMALY_NOT_FOUND` (404) — no anomaly for `anomalyId`.
  - `ANOMALY_ALREADY_DECIDED` (409) — anomaly already decided.
  - `FORBIDDEN` (403) — lacks the anomaly-resolution permission (ops manager, logistics operations, super admin).
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `anomaly.` — decision; `before`/`after` = anomaly state (open → resolved) with the evidence summary (device/GPS comparison, `deviceId`, anomaly type).
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #24 — Respond to a logistics anomaly.
- **UI surface**: Logistics control tower + Reconciliation & custody audit (routes `/logistics/control-tower`, `/logistics/reconciliation`, modules 26/27) — critical exceptions queue and `logistics_anomalies` queue with the evidence panel; the dismiss/freeze/block decision renders the PENDING_ENDPOINT notice.

## 16. order_cancel

- **Endpoint**: `POST /admin/orders/{orderId}/cancel`
- **Request body**: `{ reason, refundTZS? }` — `reason` required; `refundTZS` included when a refund is part of the cancellation.
- **Expected success response**: `200` → `{ orderId, status: "cancelled", refundTZS? }` — order cancelled; refund ledger entries created when `refundTZS` is set.
- **Error codes**:
  - `ORDER_NOT_CANCELLABLE` (409) — order state forbids cancellation.
  - `ORDER_NOT_FOUND` (404) — no order for `orderId`.
  - `FORBIDDEN` (403) — lacks the cancellation permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
  - `TWO_PERSON_REQUIRED` (409) — cancellation with a refund above the finance threshold; must go through the two-person approval flow (workflow 31) before execution.
- **Audit**: prefix `order.` — cancel action; `before`/`after` = order status (e.g. `assigned`/`stuck` → `cancelled`) and refund amount when applicable.
- **Two-person flag**: YES — `TWO_PERSON_REQUIRED` is in the errors list; cancellation with an above-threshold refund is 4-eyes-gated.
- **Workflow reference**: WORKFLOWS.md #7 — Handle a stuck order (cancel path).
- **UI surface**: Orders module + Dispatch monitor (routes `/commerce/orders`, `/operations/dispatch-monitor`, modules 8/10) — stuck/stale dispatch rows offer cancel-with-refund; the cancel action renders the PENDING_ENDPOINT notice (re-queue and manual reassignment remain on the contract).

## 17. consignment_missing_resolve

- **Endpoint**: `POST /admin/consignments/{consignmentId}/missing`
- **Request body**: `{ decision: "relocate" | "declare_lost", reason }` — `decision` required; `reason` required.
- **Expected success response**: `200` → `{ consignmentId, decision, status: "exception_cleared" }` — relocated orders are placed on the next corridor (customer notified with new ETA via `intercity.eta_updated`); declared-loss orders route to the damage-claim path; the queue row clears.
- **Error codes**:
  - `CONSIGNMENT_NOT_FOUND` (404) — no consignment for `consignmentId`.
  - `CONSIGNMENT_ALREADY_DECIDED` (409) — missing-order exception already resolved.
  - `FORBIDDEN` (403) — lacks the consignment-resolution permission.
  - `ADMIN_REASON_REQUIRED` (422) — `reason` missing/empty.
- **Audit**: prefix `consignment.` — resolution decision; `before`/`after` = consignment exception state, with `verifiedOrderIds` vs manifest difference context.
- **Two-person flag**: no.
- **Workflow reference**: WORKFLOWS.md #21 — Resolve a consignment exception.
- **UI surface**: Hubs & line-haul oversight (route `/operations/consignments`, `ConsignmentsPage`, module 24) — missing-order queue (`CONSIGNMENT_MISSING_ORDERS` / `CONSIGNMENT_ORDER_MISMATCH`) with per-order `waybillNumber` + `section`; the relocate/declare-lost decision renders the PENDING_ENDPOINT notice.

---

## Implementation order

Grouped by milestone alignment. Within each group, the order is as listed.

### M4 riders milestone

1. `rider_approve` — unblocks rider onboarding (module 5).
2. `provider_approve` — unblocks provider onboarding (module 4).

### Module milestones

3. `conversation_block` — Messages and chat oversight (module 19).
4. `chain_onboard` — Enterprise chains (module 20).
5. `chain_suspend` — Enterprise chains (module 20; two-person).
6. `export_approve` — Data export queue (module 22).
7. `export_rerun` — Data export queue (module 22).
8. `loyalty_config` — Merchant loyalty oversight (workflow 12).

### Fleet/logistics milestones

9. `dispute_resolve` — finance/dispute queue (modules 8/9/11; two-person above threshold).
10. `payout_reconcile` — payout batches (module 11).
11. `cod_decision` — rider COD reconciliation (module 5).
12. `crash_respond` — fleet control tower safety (module 23).
13. `rest_override` — mandatory-rest enforcement (module 23).
14. `order_cancel` — stuck-order cancellation (modules 8/10; two-person with refund).
15. `seal_broken_resolve` — seal-broken handoffs (module 24).
16. `consignment_missing_resolve` — missing-order queue (module 24).
17. `anomaly_resolve` — logistics anomalies (modules 26/27).

## Definition of done for each endpoint

For EVERY key above, implementation must:

1. Add the path to `backend/API-CONTRACT.yaml` (workspace root) with the request/response/error schema exactly as specified in this file.
2. Regenerate the contract client from the workspace root: `npm run build:contract`.
3. Add the MSW mock for the new path so the generated client function resolves 200 (parity gate: `app/src/test/parity.test.ts` runs in CI; new mutations should be added to the parity matrix where the app consumes them).
4. In the app: wire the generated client function into the page, remove the PENDING_ENDPOINT branch (and the `pendingEndpointNotice` rendering), delete the key from `PENDING_ENDPOINTS`, and update the page tests (success path + error-code rendering per the errors list above).
5. Confirm the mutation writes the audit entry (`actorUserId`, `actorRole`, `action`, `entityType`, `entityId`, `details {before, after, reason}`, `requestId`, `ipAddress`) under the prefix listed above, rendered on the entity timeline (AUDIT.md).

Two-person endpoints (`dispute_resolve` above threshold, `chain_suspend`, `order_cancel` with refund) must additionally render the 409 `TWO_PERSON_REQUIRED` path and route the action through the two-person approval flow (WORKFLOWS.md workflow 31) before execution.

This file is the single source of truth for the pending backlog. It stays in sync with `app/src/lib/pending-endpoints.ts`: every key in the record has a section here, and every section here has a key in the record.
