# HUDumika Merchant — Enterprise Finance

Multi-store financial visibility: chain dashboard totals, cross-store comparison, consolidated chain report export, corporate payment controls, and audit posture. Chain reporting is backend M9a; budgeting, forecasting, and VAT configuration are honest contract additions, not built.

## Chain dashboard (`GET /chain/dashboard`)

`ChainDashboard`: `date`, `totals`, `stores[]`.

| Group | Fields |
| --- | --- |
| `totals` | `orders`, `revenueTZS`, `activeOrders`, `lowStockAlerts` |
| `stores[]` | per store: `storeId`, `businessName`, `revenueTZS`, `orderCount`, `conversionRate`, `rating`, `isOpen`, `lowStockCount` |

- Totals are server-computed across the chain; the client never sums `stores[]` into `totals` for display.
- The exit criterion (backend M9a): chain totals reconcile with the sum of per-store ledger/wallet figures — the same dashboard-to-ledger rule as ANALYTICS.md at chain scope.
- Screen: loading skeleton → empty chain ("No stores in this group") → error + retry → totals tiles + store table with sortable columns; `lowStockAlerts` links to `/inventory/alerts` (INVENTORY-SUPPLY-CHAIN.md).

## Cross-store analytics (`GET /chain/analytics?from&to`)

- Returns `ChainStorePerformance[]` for the range — the comparison view: revenue, orders, conversion, rating, open state, low-stock count per location.
- UI: date range picker (default current cycle), ranked table + bar comparison chart per DESIGN-SYSTEM analytics chart; states: loading / empty range / error + retry / chart.
- Range validation errors: `ANALYTICS_RANGE_INVALID` (same code family as single-store analytics).

## Consolidated chain report export (`POST /chain/reports`)

| Body field | Values |
| --- | --- |
| `reportType` | `financial` / `operational` / `orders` / `inventory` |
| `from`, `to` | date range (required) |
| `storeIds` | optional — restrict to selected stores |

- Response: `{downloadUrl, expiresInSeconds}` (default 900) — the link is served by the API, never hardcoded.
- Export flow: pick type + range + stores → request → downloading spinner → link card with expiry countdown → open.
- Gating: permissioned (owner/manager) and audited — every export writes an audit entry (backend/AUDIT.md, retention 7 years for money actions).
- Errors: `ANALYTICS_RANGE_INVALID`, `ANALYTICS_REPORT_EXCEEDS_LIMIT` (narrow the range), `ANALYTICS_EXPORT_NOT_READY` (retry with backoff), 403 for non-permissioned roles.

## Budgeting and forecasting — planned (contract addition)

- Not in the contract: no budget setpoints, no forecast endpoints. The finance screen renders no budget charts and no prediction numbers.
- A budgeting/forecasting resource (budget targets, variance vs chain reports, forecast models) is a contract addition; the UI stays honest until it lands.

## Tax — planned (contract addition)

- Today tax is recorded per order as `taxTZS` on `PriceBreakdown` (server-computed, part of the platform fee structure); there is no VAT configuration surface for merchants.
- Configurable VAT rates or tax reporting per merchant are a contract addition — the finance screen shows the recorded `taxTZS` figure only, no client-side tax math.

## Corporate payment controls

- Refunds above a merchant-configured threshold require approval: submit `POST /approvals` with `type: refund_above_threshold` (plus `amountTZS` for threshold rules) → `pending` → manager/owner decides via `POST /approvals/{approvalId}/decision` (`approved` / `rejected` + comment ≤500).
- The refund workflow binds to the decision: the refund executes only after approval (backend M9b approval engine, ENTERPRISE-STAFF.md); requester and approver see `approval.requested` / `approval.decided` notifications.
- Rejected or already-decided requests: `APPROVAL_ALREADY_DECIDED` (409), `APPROVAL_FORBIDDEN` for non-approvers.
- The wallet, ledger statement, withdrawals, and payout account flow are reused as-is from EARNINGS.md — chain finance does not duplicate them.

## Audit trail

- All financial mutations (refunds, adjustments, approval decisions, exports) are server-audited per backend/AUDIT.md: append-only entries with actor, action, before/after money, `requestId`; retention 7 years for money actions; queryable by staff via `GET /admin/audit-logs` (compliance role for sensitive views).
- Merchant clients never see raw audit data; the finance screens surface states and references, not logs.

## Screen states and rules

- Chain dashboard/analytics/export: loading skeleton → empty → error + retry → success; 429 honored with `Retry-After`.
- Money renders `TZS 1,234` with separators everywhere; percentages and ratings come from server values only.
- MSW parity: chain dashboard shapes, `ChainStorePerformance` fields, export response, approval payloads, and error codes (`ANALYTICS_RANGE_INVALID`, `ANALYTICS_REPORT_EXCEEDS_LIMIT`, `APPROVAL_ALREADY_DECIDED`) must match the contract.
