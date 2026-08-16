# HUDumika Provider — Inventory and Materials

Parts, consumables, equipment, and tools the provider business carries. Inventory is the provider-side record behind the material flow: job → material used → inventory deduction → customer charge → provider settlement. Data lives in `provider_inventory` (DATA-MODEL.md); money is integer TZS.

## Item model (`ProviderInventoryItem`)

`GET /providers/me/inventory` lists the business's items; `POST /providers/me/inventory` adds one. Fields:

| Field | Meaning |
| --- | --- |
| `name` (max 120) | Item name |
| `category` | `part` (installed on the job), `consumable` (used up), `equipment`, `tool` |
| `stockOnHand` | Current quantity |
| `lowStockThreshold` (default 5) | Reorder alert line |
| `unitCostTZS` (nullable) | Unit cost for parts pricing and settlement basis |
| `assignedTechnicianId` (nullable) | Tool/equipment checked out to a technician (TECHNICIANS.md) |
| `updatedAt` | UTC timestamp |

Required on create: `name`, `stockOnHand`. Error codes: `INVENTORY_ITEM_NOT_FOUND`, `INVENTORY_NEGATIVE_STOCK`, `INVENTORY_ADJUSTMENT_REASON_REQUIRED` (all in `backend/ERROR-CODES.md`).

## Stock adjustments

`POST /providers/me/inventory/items/{itemId}/adjust` — body `{ delta, reason }`, both required (`delta` signed integer, `reason` max 300):

- Positive delta = stock in (purchase, return, correction); negative = stock out (use, damage, correction).
- `INVENTORY_NEGATIVE_STOCK` blocks any adjustment that would take `stockOnHand` below zero — pick a smaller delta or top up first.
- Every adjustment is logged server-side with `reason` and timestamp; the client shows the reason verbatim in the item's history where surfaced.

## Automatic deduction on parts use

Parts recorded against a booking (`POST /bookings/{bookingId}/parts`, `PartsLine.catalogueItemId` linking to an inventory item) deduct `stockOnHand` automatically — the server subtracts the part's `quantity` when the parts line is recorded. The provider never adjusts stock manually for job use; manual adjustments are for purchases, corrections, and equipment, not for job consumption.

Consequences surfaced in the UI:

- The parts picker on the job offers only items with positive `stockOnHand`.
- A part recorded without an `catalogueItemId` link does not touch inventory (unlinked lines exist for one-off parts).
- `INVENTORY_NEGATIVE_STOCK` on a parts line surfaces as a booking-level error: adjust the line quantity or add stock, then retry.

## Material flow (job → settlement)

1. Job `in_progress` (after quote approval where gated) — the technician records materials used.
2. Parts line recorded → inventory deduction (server-side) → running parts subtotal on the invoice.
3. `POST /bookings/{bookingId}/invoice` folds `partsTZS` into the invoice (labor + trip + parts − discount + tax = `totalTZS`, server-computed).
4. Customer pays on site; invoice flips `paid`; booking completes and settles (`booking_earning` ledger entry, EARNINGS.md).

The cost basis for parts on the invoice is the unit cost at recording time; `unitCostTZS` on the inventory item is the business's cost reference and is never displayed to the customer.

## Tool and equipment assignment

`assignedTechnicianId` (nullable) checks a `tool` or `equipment` item out to one technician. The UI shows:

- Assignment state on the item card ("assigned to <technician name>" or "in storage").
- The dispatcher console (TECHNICIANS.md) and the technician's job detail hint at tools/equipment the technician carries, so the technician can prepare before travel.
- On technician removal or the item being returned, the assignment clears (server-side update via `PATCH`-style item updates — the current contract exposes the field on the item payload; a dedicated return endpoint is not in the contract yet).

## Screen states

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Inventory list | Skeleton rows | "No items yet — add your first part, tool, or equipment" CTA | Retry button; keep last data on refresh failure | Item cards: name, category pill, `stockOnHand` vs `lowStockThreshold`, `TZS unitCostTZS`, assignment |
| Add item | Submitting state | — | `VALIDATION_FAILED` field errors (name, stock); save failure → revert + toast | `201` → item appears; list refetch |
| Adjust stock | In-flight spinner | — | `INVENTORY_ITEM_NOT_FOUND` → refetch; `INVENTORY_NEGATIVE_STOCK` → explain (below-zero blocked), offer top-up; `INVENTORY_ADJUSTMENT_REASON_REQUIRED` → reason field error | Updated `stockOnHand` pill; adjustment reflected |
| Low stock | — | No low-stock items (badge hidden) | Retry | Badge count on the list header; `inventory.low_stock`-style notice where the backend emits it |
| Tool assignment | Loading assignment state | "No tools or equipment" | `TECHNICIAN_NOT_FOUND` → refetch team list | Assigned pill with technician name |

## Cross-cutting

- Money is integer TZS, formatted with thousands separators (`TZS 12,500`); `unitCostTZS` is rendered read-only.
- Never let the client compute stock math for display; render `stockOnHand` from the API and refetch after mutations.
- MSW handlers mirror these endpoints 1:1 with `backend/API-CONTRACT.yaml` (MSW parity); error codes from `backend/ERROR-CODES.md`.

## Vehicle and warehouse inventory (planned)

Vehicle-held stock and multi-warehouse inventory are planned extensions of the single provider inventory (per-location stock records, transfer between locations).
