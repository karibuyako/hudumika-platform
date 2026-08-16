/**
 * Pending backend endpoints — documented integration points.
 *
 * The admin console is contract-first: it only calls paths that exist in
 * `backend/API-CONTRACT.yaml` (via `@hudumika/contract`). Several documented
 * workflows (WORKFLOWS.md) and module specs (MODULES.md) reference actions
 * whose endpoints have NOT yet landed in the contract. Those surfaces render
 * full UI (queues, drawers, reason prompts, validation) but the final call
 * resolves to a PENDING_ENDPOINT state instead of a fake network call.
 *
 * Every key here is specified in `admin-web/docs/PENDING-ENDPOINTS.md` so the
 * backend team implements each without skipping. When a spec lands, remove the
 * key, wire the generated client function, and delete the pending branch.
 */
export interface PendingEndpointSpec {
  method: string
  path: string
  body: string
  errors: string[]
  auditPrefix: string
  workflow: string
}

export const PENDING_ENDPOINTS: Record<string, PendingEndpointSpec> = {
  rider_approve: {
    method: 'POST',
    path: '/admin/riders/{riderId}/approval',
    body: '{ decision: approve|request_changes, reason }',
    errors: ['RIDER_NOT_FOUND', 'RIDER_ALREADY_DECIDED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'rider.',
    workflow: 'WORKFLOWS.md #3 — Approve a rider',
  },
  provider_approve: {
    method: 'POST',
    path: '/admin/providers/{providerId}/approval',
    body: '{ decision: approve|request_changes, reason }',
    errors: ['PROVIDER_NOT_FOUND', 'PROVIDER_ALREADY_DECIDED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'provider.',
    workflow: 'WORKFLOWS.md #2 — Approve a provider',
  },
  dispute_resolve: {
    method: 'POST',
    path: '/admin/disputes/{disputeId}/decision',
    body: '{ decision: refund|payout|reject, amountTZS?, reason }',
    errors: ['DISPUTE_ALREADY_DECIDED', 'DISPUTE_NOT_FOUND', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED', 'TWO_PERSON_REQUIRED'],
    auditPrefix: 'dispute.',
    workflow: 'WORKFLOWS.md #4 — Resolve a dispute',
  },
  payout_reconcile: {
    method: 'POST',
    path: '/admin/payouts/{batchId}/reconcile',
    body: '{ outcome: paid|failed|exception, note? }',
    errors: ['PAYOUT_BATCH_NOT_FOUND', 'PAYOUT_ALREADY_RECONCILED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'payout.',
    workflow: 'WORKFLOWS.md #5 — Reconcile payouts',
  },
  cod_decision: {
    method: 'POST',
    path: '/admin/riders/{riderId}/cod/{shiftId}/decision',
    body: '{ status: reconciled|mismatch, note? }',
    errors: ['SHIFT_NOT_FOUND', 'SHIFT_ALREADY_DECIDED', 'COD_RECONCILIATION_UNAVAILABLE', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'cod.',
    workflow: 'WORKFLOWS.md #18 — Reconcile rider COD',
  },
  chain_onboard: {
    method: 'POST',
    path: '/admin/chains/{merchantGroupId}/onboard',
    body: '{ tier, slaLevel?, accountManager? }',
    errors: ['CHAIN_NOT_FOUND', 'CHAIN_ALREADY_ACTIVE', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'chain.',
    workflow: 'WORKFLOWS.md #14 — Onboard an enterprise chain',
  },
  chain_suspend: {
    method: 'POST',
    path: '/admin/chains/{merchantGroupId}/suspend',
    body: '{ reason }',
    errors: ['CHAIN_NOT_FOUND', 'CHAIN_ALREADY_SUSPENDED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED', 'TWO_PERSON_REQUIRED'],
    auditPrefix: 'chain.',
    workflow: 'WORKFLOWS.md #14 — Onboard an enterprise chain (suspend path)',
  },
  export_approve: {
    method: 'POST',
    path: '/admin/data-exports/{jobId}/approval',
    body: '{ decision: approve|reject, reason }',
    errors: ['DATA_EXPORT_NOT_FOUND', 'DATA_EXPORT_ALREADY_DECIDED', 'DATA_EXPORT_RATE_LIMITED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'export.',
    workflow: 'WORKFLOWS.md #16 — Approve an enterprise data export',
  },
  export_rerun: {
    method: 'POST',
    path: '/admin/data-exports/{jobId}/rerun',
    body: '{ reason }',
    errors: ['DATA_EXPORT_IN_PROGRESS', 'DATA_EXPORT_NOT_FOUND', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'export.',
    workflow: 'MODULES.md #22 — Data export queue (re-run)',
  },
  loyalty_config: {
    method: 'PUT',
    path: '/admin/loyalty/config',
    body: '{ tiers[], topUpRewards[] }',
    errors: ['LOYALTY_CONFIG_INVALID', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'loyalty.',
    workflow: 'WORKFLOWS.md #12 — Oversee merchant loyalty config',
  },
  crash_respond: {
    method: 'POST',
    path: '/admin/riders/{riderId}/safety/crash',
    body: '{ outcome: safe|unsafe, note? }',
    errors: ['RIDER_NOT_FOUND', 'SAFETY_EVENT_ALREADY_HANDLED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'safety.',
    workflow: 'WORKFLOWS.md #19 — Respond to a crash alert',
  },
  rest_override: {
    method: 'POST',
    path: '/admin/riders/{riderId}/rest',
    body: '{ action: enforce|relieve, reason }',
    errors: ['RIDER_NOT_FOUND', 'REST_ALREADY_ENFORCED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'rider.',
    workflow: 'WORKFLOWS.md #20 — Enforce or relieve mandatory rest',
  },
  seal_broken_resolve: {
    method: 'POST',
    path: '/admin/handoffs/{handoffId}/seal',
    body: '{ outcome: resealed|damage_claim, reason }',
    errors: ['HANDOFF_NOT_FOUND', 'HANDOFF_ALREADY_DECIDED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'handoff.',
    workflow: 'WORKFLOWS.md #22 — Handle a seal-broken handoff',
  },
  anomaly_resolve: {
    method: 'POST',
    path: '/admin/logistics-anomalies/{anomalyId}/decision',
    body: '{ decision: dismiss|freeze|block, reason }',
    errors: ['ANOMALY_NOT_FOUND', 'ANOMALY_ALREADY_DECIDED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'anomaly.',
    workflow: 'WORKFLOWS.md #24 — Respond to a logistics anomaly',
  },
  order_cancel: {
    method: 'POST',
    path: '/admin/orders/{orderId}/cancel',
    body: '{ reason, refundTZS? }',
    errors: ['ORDER_NOT_CANCELLABLE', 'ORDER_NOT_FOUND', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED', 'TWO_PERSON_REQUIRED'],
    auditPrefix: 'order.',
    workflow: 'WORKFLOWS.md #7 — Handle a stuck order (cancel path)',
  },
  consignment_missing_resolve: {
    method: 'POST',
    path: '/admin/consignments/{consignmentId}/missing',
    body: '{ decision: relocate|declare_lost, reason }',
    errors: ['CONSIGNMENT_NOT_FOUND', 'CONSIGNMENT_ALREADY_DECIDED', 'FORBIDDEN', 'ADMIN_REASON_REQUIRED'],
    auditPrefix: 'consignment.',
    workflow: 'WORKFLOWS.md #21 — Resolve a consignment exception',
  },
}

export const PENDING_ENDPOINT_CODE = 'PENDING_ENDPOINT'

/** Human-readable inline notice rendered when an action needs a missing endpoint. */
export function pendingEndpointNotice(key: string): string {
  const spec = PENDING_ENDPOINTS[key]
  if (!spec) return 'This action is pending backend implementation.'
  return `This action requires ${spec.method} ${spec.path} — pending backend implementation. See docs/PENDING-ENDPOINTS.md (${spec.workflow}).`
}
