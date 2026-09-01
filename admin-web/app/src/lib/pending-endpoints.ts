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

export const PENDING_ENDPOINTS: Record<string, PendingEndpointSpec> = {}

export const PENDING_ENDPOINT_CODE = 'PENDING_ENDPOINT'

/** Human-readable inline notice rendered when an action needs a missing endpoint. */
export function pendingEndpointNotice(key: string): string {
  const spec = PENDING_ENDPOINTS[key]
  if (!spec) return 'This action is pending backend implementation.'
  return `This action requires ${spec.method} ${spec.path} — pending backend implementation. See docs/PENDING-ENDPOINTS.md (${spec.workflow}).`
}
