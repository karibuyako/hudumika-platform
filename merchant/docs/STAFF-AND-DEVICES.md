# HUDumika Merchant — Staff and Devices

Team accounts (roles, permissions, status) and the device registry (printers, POS, kitchen displays, cashier terminals) that power the dual-screen dine-in workflow and receipt printing.

## Staff accounts

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/merchants/me/staff` | Staff list for own merchant | `MerchantStaff[]` |
| POST | `/merchants/me/staff` | Invite or create (`name`, `phone`, `role`) | `MerchantStaff` / 201 |
| PATCH | `/merchants/me/staff/{staffId}` | Update role or permissions | `MerchantStaff` |
| DELETE | `/merchants/me/staff/{staffId}` | Remove a staff account | 204 |

`MerchantStaff`: `name`, `phone`, `role`, `permissions[]`, `status` (`invited` / `active` / `suspended`), `createdAt`.

### Roles (`MerchantStaffRole`)

| Role | Typical scope | Cashier limitation |
| --- | --- | --- |
| `owner` | everything, incl. staff + settings + wallet | — |
| `manager` | operations, menu, promotions | — |
| `cashier` | dine-in billing, voucher verify, COD recording (glossary: cashier scope) | no order accept unless granted |
| `kitchen` | kitchen display, prep status, label printing | — |
| `waiter` | table/QR support, order visibility | — |

- `permissions` are extra scope strings served by the API (e.g. `orders.accept`); the UI renders exactly the scopes the server returns — never a client-maintained matrix. Granting beyond a role is `PATCH` with the permission added; rejection = `STAFF_ROLE_FORBIDDEN`.
- Lifecycle: invite → `invited` (staff user notified: `staff.invited`) → activation on first login → `active`; suspension via PATCH status (`staff.suspended` notification). Suspended staff lose all actions immediately.
- Errors: `STAFF_NOT_FOUND`, `STAFF_ROLE_FORBIDDEN`, `STAFF_LAST_OWNER` (cannot demote/remove the last `owner` — dialog blocks with explanation).
- Screen states: list (loading skeleton → empty "No staff yet — invite your team" → error + retry → role chips) and editor (invite form with role picker, validation, saving, success toast).

## Staff operations — separate doc

Shifts (scheduling, `SHIFT_OVERLAP`), attendance (clock-in/out self-service), performance metrics, commission rules, and the approval workflow engine (price change, promotion, refund above threshold, inventory adjustment, staff role change, bulk operation) are covered in ENTERPRISE-STAFF.md. RBAC stays here — server-enforced roles and permission scopes apply to every staff screen in both docs.

## Device registry

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/devices` | Registered devices for own merchant | `MerchantDevice[]` |
| POST | `/devices` | Register a device (`type`, `label` ≤80) | `MerchantDevice` / 201 |
| PATCH | `/devices/{deviceId}` | Update device settings | `MerchantDevice` |
| DELETE | `/devices/{deviceId}` | Unregister a device | 204 |

`MerchantDevice`: `id`, `type`, `label`, `status`, `settings` (opaque), `lastSeenAt`.

| DeviceType | Use | Status meaning |
| --- | --- | --- |
| `printer` | order receipts + labels | `online` / `offline` / `error` via `lastSeenAt` heartbeats |
| `pos` | checkout terminal (cashier) | same |
| `kitchen_display` | prep screen (kitchen) | same |
| `cashier_terminal` | dine-in billing + voucher verify | same |

- Registration: pairing code flow from the device (details env-driven); success toast + device card.
- Offline/error devices: `DEVICE_OFFLINE` when a print job targets them — the print dialog offers queue-until-online or fallback; `DEVICE_NOT_FOUND` on stale refs.

## Printer settings and print queue

- Store-level print behavior lives in `StoreSettings.printSettings`: `autoPrint` (print on order/bill automatically), `copies` (1–5, server-validated), `labelPrinter` (kitchen labels on/off). Managed in STORE-MANAGEMENT.md settings form.
- Printer queue concept (glossary): print jobs for order receipts and kitchen labels are queued server-side and delivered to registered `printer` devices. Job failure states: `PRINT_QUEUE_FULL` (retry with backoff), `DEVICE_OFFLINE` (alert + retry).
- Kitchen display flow: a dine-in order item add pushes a label job to the kitchen printer/display; kitchen staff see the stream read-only (DINE-IN.md dual-screen POS).

## Screen states and rules

- Devices: loading skeleton → empty ("No devices registered") → error + retry → cards with status dots (success green / offline muted / error danger per DESIGN-SYSTEM status pill rules).
- Actions are owner/manager-only; `STAFF_ROLE_FORBIDDEN` surfaces as a disabled action + tooltip, never as a silent failure.
- MSW parity: staff roles/statuses, permission scopes, device types/statuses, and `PRINT_QUEUE_FULL` payloads must match the contract.
