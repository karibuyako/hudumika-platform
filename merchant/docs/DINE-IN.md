# HUDumika Merchant — Dine-in

In-store ordering: table management, QR menus, the dine-in order lifecycle, reservations, and the dual-screen POS concept. Status strings are the exact `DineInOrderStatus` / `ReservationStatus` enums from the contract.

## Tables (CRUD)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/dine-in/tables` | Tables for own store | `DineInTable[]` |
| POST | `/dine-in/tables` | Create (`label` ≤40, `capacity` ≥1, `active`) | `DineInTable` / 201 |
| PATCH | `/dine-in/tables/{tableId}` | Update label/capacity/active | `DineInTable` |
| DELETE | `/dine-in/tables/{tableId}` | Remove a table | 204 |

`DineInTable`: `id`, `label` (e.g. "Table 5"), `capacity` (default 4), `active`, `currentOrderId` (null when free). A table with `currentOrderId` cannot be reused: `DINE_IN_TABLE_IN_USE` on conflict — the UI disables assignment and shows the occupant bill.

Table grid (web) / chip list (mobile, per DESIGN-SYSTEM "dine-in table chip"): loading skeleton → empty ("No tables yet — add your first table") → error + retry → grid with live bill-status dots.

## QR ordering

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/dine-in/tables/{tableId}/qr` | QR payload + menu URL for a table | `{qrPayload, menuUrl}` |

- `qrPayload` is the QR content, e.g. `hudumika:dinein:table:{tableId}`; `menuUrl` is the customer web menu. Both come from the API — never hardcoded.
- Print/preview: render the payload as a QR on the table card; re-fetch when the label changes (QR embeds the table id). Flow: customer scans → `POST /dine-in/orders` (customer side) opens a bill at the table.
- Screen states: loading → QR card → error + retry; "print QR" sends to the registered printer via the print queue.

## Dine-in order lifecycle

```text
open -> billing -> paid -> closed
  \-> cancelled
```

| Method | Path | Purpose | Actor |
| --- | --- | --- | --- |
| POST | `/dine-in/orders` | Open a bill at a table (customer, from QR) | customer |
| GET | `/dine-in/orders/me` | Own dine-in bills, `status` filter | both |
| GET | `/dine-in/orders/{dineInOrderId}` | Bill detail: items, `totals` (PriceBreakdown), `paidAt` | parties only |
| POST | `/dine-in/orders/{dineInOrderId}/confirm-payment` | Merchant confirms a discounted bill payment | merchant |
| POST | `/dine-in/orders/{dineInOrderId}/close` | Close after settlement | merchant |

- `open`: items ordered via QR; new items append to the same bill while open.
- `billing`: customer or waiter requests the bill (`dine_in.bill_requested` push to merchant).
- `paid`: payment confirmed — for mobile-money via webhook; for cash/COD the merchant records receipt via `confirm-payment` (evidence rules per backend/PAYMENTS.md).
- `closed`: `close` completes the table turn; `currentOrderId` clears and the table is free.
- Conflicts: `DINE_IN_TABLE_IN_USE`, `DINE_IN_ORDER_STATUS_CONFLICT` (wrong transition), `DINE_IN_BILL_NOT_PAYABLE` (confirm-payment on a bill that is not billable) — 409s surface as banners, then refetch.
- Money: `totals` is the server-computed `PriceBreakdown`; the cashier never types totals, only confirms.

## Reservations

| Method | Path | Purpose | Actor |
| --- | --- | --- | --- |
| POST | `/reservations` | Reserve a table/queue slot (`merchantId`, `partySize` 1–50, `scheduledFor`, `note` ≤300) | customer |
| GET | `/reservations/me` | Own reservations | customer |
| POST | `/reservations/{reservationId}/cancel` | Cancel | customer |

`ReservationStatus`: `pending` → `confirmed` → `seated` → `completed`; terminal `cancelled`, `no_show`.

- The merchant sees reservation traffic via notifications (`reservation.requested`, `reservation.confirmed`, `reservation.reminder`) and the pending-confirmation list on the dashboard; errors `RESERVATION_TABLE_FULL`, `RESERVATION_TIME_IN_PAST` are customer-side.
- Contract gap: merchant-side reservation management (confirm/seat/no-show transitions, store-wide list) is not yet in `API-CONTRACT.yaml` — propose the addition before building a full reservations manager.

## Dual-screen POS concept

Two surfaces read the same bill events:

| Device type | Role | Sees |
| --- | --- | --- |
| `cashier_terminal` / `pos` | Cashier (`cashier` role) | Bill state, `confirm-payment`, `close`, voucher verify, COD recording |
| `kitchen_display` | Kitchen (`kitchen` role) | Open items per table, print kitchen labels on item add |

Devices register via `/devices` (STAFF-AND-DEVICES.md); new items push a label to the kitchen display/printer queue. Kitchen sees read-only item streams — billing actions are cashier-only (`STAFF_ROLE_FORBIDDEN` elsewhere).

## Screen states

- Tables: loading skeleton / empty / error+retry / grid with status dots.
- QR: loading / render / error+retry / print-success toast.
- Bill detail: loading / empty ("No items") / error+retry / items+totals+timeline; confirm-payment and close disabled when the state machine forbids (409 banner otherwise).
- MSW parity: table CRUD, QR payload shape, bill transitions, and conflict codes must match the contract.
