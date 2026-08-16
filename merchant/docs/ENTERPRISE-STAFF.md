# HUDumika Merchant — Enterprise Staff

Staff scheduling (shifts), attendance (clock-in/out), performance metrics, commission rules, and the approval workflow engine. Backend M9b. Staff accounts, roles, permissions, and RBAC live in STAFF-AND-DEVICES.md — this doc links there instead of duplicating.

## Shifts (`/staff/shifts`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/staff/shifts?from&to` | Shift schedule for a date range (both required) | `StaffShift[]` |
| POST | `/staff/shifts` | Create a shift | `StaffShift` / 201 |
| PATCH | `/staff/shifts/{shiftId}` | Update a shift | `StaffShift` |
| DELETE | `/staff/shifts/{shiftId}` | Delete a shift | 204 |

`StaffShift`: `staffId`, `role` (`MerchantStaffRole`: owner/manager/cashier/kitchen/waiter), `startAt`, `endAt`, `status`, `storeId` (nullable, chain-aware).

| Status | Meaning |
| --- | --- |
| `scheduled` | planned, not started |
| `active` | in progress |
| `completed` | finished |
| `cancelled` | removed from the schedule |

- Overlapping shifts for the same staff member are rejected with `SHIFT_OVERLAP` (409 path — the editor pre-validates against the loaded week and shows a conflict card).
- `SHIFT_IN_PAST` blocks creating shifts in the past; `SHIFT_NOT_FOUND` on stale refs.
- Schedule screen (week calendar): loading skeleton → empty ("No shifts in this range") → error + retry → grid with staff rows × day columns; PATCH/DELETE from the shift editor with confirm dialog.

## Attendance (`/staff/attendance`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/staff/attendance?from&to&staffId` | Records for own staff | `AttendanceRecord[]` |
| POST | `/staff/attendance/clock-in` | Clock in (staff self-service) | `AttendanceRecord` |
| POST | `/staff/attendance/clock-out` | Clock out (staff self-service) | `AttendanceRecord` |

`AttendanceRecord`: `staffId`, `shiftId` (nullable), `clockedInAt`, `clockedOutAt` (nullable), `durationMinutes` (nullable), `source` (`app` / `pos`).

- One open record per staff: clock-in while open → `ATTENDANCE_ALREADY_CLOCKED_IN`; clock-out without open record → `ATTENDANCE_NOT_CLOCKED_IN`.
- Self-service: the staff member's own session clocks in/out from the app (`source: app`) or a registered POS terminal (`source: pos`); managers view the roster (filter by `staffId`, date range).
- Roster screen: loading skeleton → empty ("No records in range") → error + retry → table (clock-in, clock-out, `durationMinutes`, source pill); open records show a live "clocked in" chip.

## Performance metrics (`/staff/performance?from&to`)

`StaffPerformance`: `staffId`, `name`, `ordersProcessed`, `avgHandleTimeMinutes`, `cancellations`, `ratingAverage` (nullable), `attendanceRate`, `commissionTZS`.

- Derived server-side by the analytics job (derived view, not a table); `STAFF_PERFORMANCE_UNAVAILABLE` when the range has no data — render the empty state, never zeros.
- Screen: range picker, sortable table, rating/attendance as server values only; money column `TZS 1,234`.

## Commission rules (`/staff/commissions`)

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/staff/commissions` | Current rules | — | `CommissionRule[]` |
| PUT | `/staff/commissions` | Configure rules | `{rules[]}` | `CommissionRule[]` |

`CommissionRule`: `staffId` (nullable — rule applies to all staff), `type` (`per_order` / `per_service` / `per_revenue`), `rateBps` (basis points), `active` (default true).

- Invalid rule shapes → `COMMISSION_RULE_INVALID` (422 with field errors); `rateBps` is server-validated (0–10,000).
- These are staff-earning rules, separate from the platform commission on orders (`commissionRateBps`, EARNINGS.md) — the UI labels them "staff commission" and never merges the two.
- Editor: loading → rules table (type select, bps input, staff or all-staff toggle, active switch) → saving spinner → success toast → error + retry.

## Approvals (`/approvals`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/approvals` | Submit a request | `ApprovalRequest` / 201 |
| GET | `/approvals?scope&status` | Submitted / inbox / all | `ApprovalRequest[]` |
| POST | `/approvals/{approvalId}/decision` | Approve or reject | `ApprovalRequest` / 409 |

| Field | Values |
| --- | --- |
| `type` | `price_change` / `promotion` / `refund_above_threshold` / `inventory_adjustment` / `staff_role_change` / `bulk_operation` |
| `status` | `pending` / `approved` / `rejected` / `cancelled` |
| body | `summary` ≤300, `amountTZS` (nullable, threshold rules), `refType` / `refId` |

- Flow: submit → `pending` → approver (manager/owner role per RBAC, STAFF-AND-DEVICES.md) decides via `POST /approvals/{approvalId}/decision` with `decision` (`approved` / `rejected`) and `comment` ≤500 (required — `APPROVAL_REASON_REQUIRED`).
- Notifications: `approval.requested` to the approver (in-app + push), `approval.decided` to the requester (in-app).
- Errors: `APPROVAL_NOT_FOUND`, `APPROVAL_ALREADY_DECIDED` (409 — already-decided requests show the decision, no re-vote), `APPROVAL_FORBIDDEN` (non-approver), `APPROVAL_EXPIRED`.
- Decisions are audited (backend/AUDIT.md); refund-above-threshold approvals bind to the refund workflow (ENTERPRISE-FINANCE.md).
- Screens: submit form (type → summary/amount/comment fields per type) and inbox (scopes `submitted` / `inbox` / `all`, status filter) — both: loading skeleton → empty ("No approval requests") → error + retry → rows with type + status pills; decision dialog requires a comment.

## Screen states and rules

- All staff screens: loading / empty / error + retry / success; mutations optimistic with server rollback on 409/422.
- RBAC is server-enforced per role (STAFF-AND-DEVICES.md); 403 surfaces as a disabled action + tooltip, never a silent failure.
- MSW parity: shift statuses and `SHIFT_OVERLAP`, attendance records and clock errors, performance shapes, commission rule enums, approval types/statuses, and decision 409s must match the contract.
