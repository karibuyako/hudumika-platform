# Customer App — Dine-in and Reservations

Glossary terms: dine-in, dine-in table, dine-in order, reservation. Dine-in is in-store ordering
via QR menus — no rider, no delivery address, bill settled at the table. Reservations book a
table or queue slot ahead of time.

## QR menu scanning

| Step | Detail |
| --- | --- |
| 1. Scan | Camera reads the table QR; payload format `hudumika:dinein:table:{tableId}` |
| 2. Validate | Accept only the exact prefix `hudumika:dinein:table:` with a well-formed UUID; anything else opens the app root (no arbitrary navigation, per `SECURITY.md`) |
| 3. Resolve | `GET /dine-in/tables/{tableId}/qr` returns `qrPayload` + `menuUrl`; the app loads the merchant catalogue from the table context |
| 4. Gate | `DINE_IN_TABLE_NOT_FOUND` → "Table not found" error card; `DINE_IN_TABLE_IN_USE` → "Table has an open bill" banner |

- Every resolved target is refetched via API before render (deep-link rule from `SECURITY.md`).
- `menuUrl` is a browser fallback; the app never orders through it.

## Opening a dine-in order

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Table menu | `GET /catalogues/{merchantId}` | Item cards with `priceTZS`, options; `available: false` disabled |
| 2 | Basket | local (Zustand) | `{catalogueItemId, quantity, options}`; quantity ≥ 1 |
| 3 | Open bill | `POST /dine-in/orders` | `Idempotency-Key` (shared rule). Body `DineInOrderCreate` (`merchantId`, `tableId`, `items[]`). 201 → `DineInOrder` (`open`). 422 → `VALIDATION_FAILED` with `errors[]`; `DINE_IN_TABLE_IN_USE` → conflict banner |
| 4 | Kitchen | — | Merchant-side printing/KDS; customer stays on `open` |

## Bill flow

`DineInOrderStatus`: `open` → `billing` → `paid` → `closed` (terminal `cancelled`).

| Step | Who | Detail |
| --- | --- | --- |
| Open | customer | `POST /dine-in/orders`; bill lines from `items[]` (`name`, `quantity`, `unitPriceTZS`) |
| Request bill / pay | customer | App pay action triggers the payment flow and notifies the merchant (`dine_in.bill_requested` push/in-app) |
| Billing → paid | merchant / webhook | `POST /dine-in/orders/{id}/confirm-payment` (merchant, incl. discounts); app renders `paid` + `paidAt` |
| Close | merchant | `POST /dine-in/orders/{id}/close`; app renders `closed` ("Bill settled") |

- The app never mutates dine-in status — it renders `DineInOrder.status` and refetches on
  notification. `dine_in.paid` is merchant-side; the customer refetches on pull-to-refresh or
  deep link.
- `DINE_IN_BILL_NOT_PAYABLE` → "Bill cannot be paid yet" toast + refetch;
  `DINE_IN_ORDER_STATUS_CONFLICT` → stale action; refetch detail.

## Split / pay at table

- One open dine-in order per table today (`DineInTable.currentOrderId`; `DINE_IN_TABLE_IN_USE`).
- Split-bill between diners is **planned** — it requires a contract addition; until then the app
  renders the single bill and its `totals.totalTZS`.

## Dine-in order history

- `GET /dine-in/orders/me` (`?status` filter) → bill cards: table label, merchant, status pill,
  `totals.totalTZS`, `paidAt` local time.
- Tap → `GET /dine-in/orders/{dineInOrderId}`; 403/404 → "not visible" (parties only);
  `DINE_IN_ORDER_NOT_FOUND` → removed state.

## Table reservations

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Reserve form | Merchant detail → "Reserve a table" | `partySize` 1–50, `scheduledFor` (UTC ISO), optional `note` ≤300 |
| 2 | Create | `POST /reservations` | 201 → `Reservation` (`pending`). 422 → `RESERVATION_TIME_IN_PAST`; `RESERVATION_TABLE_FULL` → full state |
| 3 | List mine | `GET /reservations/me` | Upcoming first; status chips |
| 4 | Cancel | `POST /reservations/{reservationId}/cancel` | 409 → `RESERVATION_NOT_CANCELLABLE` → toast + refetch |

Reservation statuses: `pending`, `confirmed`, `seated`, `completed`, `cancelled`, `no_show`.
Reminders: `reservation.requested` / `reservation.confirmed` / `reservation.reminder` — push +
in-app to both parties (see `NOTIFICATIONS.md`).

## Per-screen states

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| QR scan | Camera spinner | — | Invalid payload → app root | Rescan | Table menu |
| Table menu | Skeleton items | "No items available" | `DINE_IN_TABLE_NOT_FOUND` card | Retry | Item grid |
| Bill detail | Skeleton | — | Error + retry | Retry | Lines + totals + pay |
| Dine-in history | Skeleton | "No dine-in bills yet" | Error + retry | Retry | Bill cards + pills |
| Reservations list | Skeleton | "No reservations yet" | Error + retry | Retry | Cards + status chips |

Error codes: `DINE_IN_TABLE_NOT_FOUND`, `DINE_IN_TABLE_IN_USE`, `DINE_IN_ORDER_NOT_FOUND`,
`DINE_IN_ORDER_STATUS_CONFLICT`, `DINE_IN_BILL_NOT_PAYABLE`, `RESERVATION_NOT_FOUND`,
`RESERVATION_NOT_CANCELLABLE`, `RESERVATION_TABLE_FULL`, `RESERVATION_TIME_IN_PAST`.
