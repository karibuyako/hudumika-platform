# HUDumika Merchant — Inventory and Supply Chain

Master inventory, stock adjustments, low-stock alerts, multi-channel sync, suppliers, purchase orders (PO), and supplier returns. Backend M9a. Money is TZS integer minor units; quantities are integers.

## Master inventory (`/inventory`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/inventory/items` | Inventory list, chain-wide or per store | `InventoryItem[]` |
| POST | `/inventory/items/{itemId}/adjust` | Adjust stock with a reason | `InventoryItem` / 422 |
| GET | `/inventory/adjustments` | Adjustment history (append-only) | `{id, itemId, delta, reason, storeId, at, by}[]` |
| GET | `/inventory/alerts` | Low-stock / out-of-stock alerts | `InventoryAlert[]` |
| GET | `/inventory/sync-config` | Multi-channel sync configuration | `InventorySyncConfig` |
| PUT | `/inventory/sync-config` | Configure sync (master record) | `InventorySyncConfig` |

`InventoryItem`: `catalogueItemId`, `name`, `storeId` (nullable — one record per item per store when chains), `stockOnHand`, `reserved` (in-flight orders), `available`, `lowStockThreshold` (default 10), `unitCostTZS` (nullable, for COGS), `lastRestockedAt`.

- `available = stockOnHand - reserved`, computed server-side; the client renders it, never recomputes.
- Stock can never go negative — any adjustment that would take `available` below zero fails with `INVENTORY_NEGATIVE_STOCK`; the screen shows a conflict card listing current stock, and retry is the correction path.
- Query filters: `storeId` (per-store view), `lowStockOnly` (default false), cursor pagination.

## Stock adjustments

- `POST /inventory/items/{itemId}/adjust` takes `delta` (signed integer, e.g. `-5`) and `reason` (max 500). Missing reason: `INVENTORY_ADJUSTMENT_REASON_REQUIRED`.
- Every adjustment is append-only history (`GET /inventory/adjustments`: `delta`, `reason`, `storeId`, `at`, `by`) — the UI shows a timeline, never edits.
- PO receiving writes `stock_in` adjustments automatically (see PO receive below); manual adjustments cover write-offs, damage, and counts.
- Adjustments on items with in-flight orders change `reserved` semantics server-side; the client only reflects responses.

## Alerts

`InventoryAlert`: `catalogueItemId`, `name`, `storeId`, `level` (`low` / `out_of_stock`), `stockOnHand`, `suggestedReorderQty`.

- Notifications: `inventory.low_stock` (manager+, in-app + push) and `inventory.out_of_stock` (manager+, in-app) per backend/NOTIFICATIONS.md.
- Alerts screen: loading skeleton → empty ("No low-stock items") → error + retry → rows with level pill, `stockOnHand`, and `suggestedReorderQty` (server-computed — never client-derived).
- Alert rows deep-link to the inventory item; the reorder action prefills a draft purchase order for the item's `suggestedReorderQty`.

## Multi-channel sync (`/inventory/sync-config`)

`InventorySyncConfig`: `enabled` (default false), `masterSource` (`platform` / `pos` / `erp`), `channels[]` (`platform_orders`, `dine_in`, `pos`, `delivery_partners`, `mini_program`), `lastSyncedAt`.

- Master-record rule: exactly one `masterSource` owns stock truth; all other channels follow it. `platform` = HUDumika's own records; `pos`/`erp` masters apply only once the M9a/M9b connector model ships (INTEGRATIONS-WEBHOOKS.md — honest staging applies).
- Disabled config: mutations that depend on sync fail with `INVENTORY_SYNC_DISABLED`; the screen renders a setup CTA instead of the sync table.
- Config editor: loading → toggles (enabled, master source radio, channel checkboxes) → saving spinner → success toast → error + retry; 422 maps field errors.

## Suppliers (`/suppliers`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/suppliers` | Supplier list | `Supplier[]` |
| POST | `/suppliers` | Create (`name`, `contactPhone` required) | `Supplier` / 201 |
| PATCH | `/suppliers/{supplierId}` | Update details | `Supplier` |
| DELETE | `/suppliers/{supplierId}` | Deactivate | 204 |

`Supplier`: `name`, `contactPhone`, `contactEmail`, `categories[]`, `paymentTerms`, `status` (`active` / `suspended`), `createdAt`.

- DELETE is a soft deactivate (204) — history stays; a suspended supplier blocks new POs with `SUPPLIER_SUSPENDED`.
- Contact fields render masked per masking policy (SECURITY.md); no hardcoded contact data.
- Screen states: list (loading → empty "No suppliers yet" → error + retry → status pills) and editor (form → 422 mapping → saving → success toast).

## Purchase orders (`/purchase-orders`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/purchase-orders` | PO list, filter by `status` | `PurchaseOrder[]` |
| POST | `/purchase-orders` | Create a PO (starts `draft`) | `PurchaseOrder` / 201 |
| GET | `/purchase-orders/{purchaseOrderId}` | PO detail | `PurchaseOrder` |
| POST | `/purchase-orders/{purchaseOrderId}/send` | Send a draft PO to the supplier (`draft`→`sent`) | `PurchaseOrder` |
| POST | `/purchase-orders/{purchaseOrderId}/receive` | Record receipt, partial or full | `PurchaseOrder` |
| POST | `/purchase-orders/{purchaseOrderId}/cancel` | Cancel with `reason` ≤500 | `PurchaseOrder` |

Lifecycle: `draft → sent → partially_received → received → closed → cancelled`.

- PO items: `{catalogueItemId, name, quantity, receivedQuantity, unitCostTZS}`; totals: `totalCostTZS`, `expectedArrivalAt`, `storeId` (nullable), `receivedAt`.
- `draft` → `sent` transitions once sent to the supplier (server-enforced state machine; invalid moves → `PURCHASE_ORDER_STATUS_CONFLICT`).
- Cancel only before receipt (`PURCHASE_ORDER_CANCELLED` on already-received attempts); cancellation requires a reason.

### PO receive (E2E: receiving updates stock)

- `POST /purchase-orders/{purchaseOrderId}/receive` with `items[]` (`catalogueItemId`, `quantity`); partial receipts advance `receivedQuantity` and flip status to `partially_received`, final receipt to `received` then `closed`.
- Receiving a quantity above the ordered amount fails with `PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY` (409 path; the dialog blocks over-quantity input).
- Server effects (the exit criterion for backend M9a): stock increases via a `stock_in` inventory adjustment, `unitCostTZS` updates to the received unit cost, COGS derives from the new cost, and the merchant gets the `purchase_order.received` in-app notification.
- Receive screen: item rows with received-quantity inputs → submitting spinner → success card (new status pill, `receivedAt`) → error + retry.

## Supplier returns (`/supplier-returns`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/supplier-returns` | Return items to a supplier | `{id, status, createdAt}` / 201 |

- Body: `supplierId`, `items[]` (`catalogueItemId`, `quantity`), `reason` ≤500 (required).
- Status flow: `pending → processed | rejected`; the merchant sees the pill update (returns list refresh; `SUPPLIER_RETURN_NOT_FOUND` on stale refs).
- Processed returns reduce stock server-side; the client never pre-adjusts.

## Screen states and rules

- Every inventory/procurement screen: loading skeleton → empty state → error + retry → success content; mutations show optimistic state with server rollback on 409/422.
- Money (`unitCostTZS`, `totalCostTZS`) renders as `TZS 1,234` with separators; quantities are plain integers.
- Audit: adjustments and PO mutations are server-audited (backend/AUDIT.md); the client renders no audit data.
- MSW parity: inventory item shapes, alert levels, sync-config values, PO status transitions, and error codes (`INVENTORY_NEGATIVE_STOCK`, `INVENTORY_SYNC_DISABLED`, `SUPPLIER_SUSPENDED`, `PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY`, `PURCHASE_ORDER_STATUS_CONFLICT`, `PURCHASE_ORDER_CANCELLED`) must match the contract.

## Regional warehouses (pre-positioned inventory)

The regional warehouse model delivers **next-day / day-after** service: merchants
bulk-send inventory to target-city warehouses (`warehouse_stock`), and when a
customer in that city orders, the server fulfills from the **nearest serving
warehouse** (`fulfillmentSource: warehouse`) instead of shipping from the
merchant's home store. This is how next-day service works without an express
courier per order (Kuaishou "Extreme Speed" model; backend/LOGISTICS-OS.md
section 19). Money is TZS integer minor units; stock quantities are integers.

### Warehouse registry endpoints (merchant-scoped)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/warehouses` | Regional/shared warehouses for pre-positioned inventory | `Warehouse[]` |
| POST | `/warehouses` | Create a warehouse (merchant team or admin) | 201 `Warehouse` |
| GET | `/warehouses/{warehouseId}` | Warehouse detail with stock levels | `Warehouse` |
| PATCH | `/warehouses/{warehouseId}` | Update warehouse (name, serving cities, status) | `Warehouse` |
| PUT | `/warehouses/{warehouseId}/stock` | Replenish/adjust warehouse stock (merchant bulk inbound) | `Warehouse` |
| POST | `/warehouses/{warehouseId}/fulfill` | Select nearest warehouse to fulfill an order (server-driven, order tag) | 200 `Order` |

`Warehouse` (contract schema):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | — |
| `name` | string (max 120) | e.g. "Dar es Salaam — Kariakoo Forward Stock" |
| `cityId` | uuid | home city of the warehouse |
| `address` | string (max 300) | street address |
| `lat` / `lon` | float, nullable | geolocation (nearest-warehouse selection) |
| `servingCities` | uuid[] | cities this warehouse may fulfill (a warehouse in Dar can serve Dodoma if configured) |
| `stock` | array | `{catalogueItemId, quantity}` — per-item quantity at this warehouse |
| `status` | enum | `active` / `full` / `maintenance` — `maintenance` warehouses are excluded from fulfillment; `full` warns on further inbound |
| `createdAt` | date-time | — |

Errors: `WAREHOUSE_NOT_FOUND` (404), `WAREHOUSE_STOCK_UNAVAILABLE` (409 — the
requested item has no available quantity at the selected warehouse),
`WAREHOUSE_OUT_OF_SERVICE` (409 — status `maintenance`/`full` blocks
fulfillment), `INVENTORY_NEGATIVE_STOCK` (409 — a stock `delta` would take
quantity below zero), `VALIDATION_FAILED` (422).

### Bulk inbound — sending inventory to a target-city warehouse

`PUT /warehouses/{warehouseId}/stock` `{items: [{catalogueItemId, delta}]}` —
the merchant's bulk-inbound action. `delta` is **signed**: positive = inbound
(shipment arrived and was received at the warehouse), negative = write-off or
return.

1. Open the warehouse detail screen → Stock tab → "Send inventory".
2. Pick items from the catalogue and enter quantities (the item picker uses the
   standard catalogue multi-select; quantities are integers, `delta > 0`).
3. Confirm → `PUT /warehouses/{warehouseId}/stock` → 200 `Warehouse` with the
   updated `stock[]`.
4. Negative deltas require a reason in the UI (write-off/return notes are
   captured client-side as part of the flow; the API-level guard is
   `INVENTORY_NEGATIVE_STOCK` for below-zero outcomes).
5. The receiving warehouse's quantity updates; the customer-facing stock
   availability in that city reflects it.

Screen states: item-picker loading → empty ("No catalogue items to send") →
error (`VALIDATION_FAILED` inline per row; `INVENTORY_NEGATIVE_STOCK` conflict
card showing current stock) → retry → success toast + updated `stock[]`.
Mutations are idempotency-keyed (retry never double-counts).

### Warehouse stock visibility

- **Warehouse detail** (`GET /warehouses/{warehouseId}`) renders `stock[]` as a
  table: item name, `quantity`, updated state; filter chips per `status`
  (`active`/`full`/`maintenance`).
- **Warehouse list** (`GET /warehouses`) renders cards: name, city, address,
  `servingCities` count, status pill, total stock units (server-computed —
  never client-summed across warehouses).
- **Cross-reference with store inventory**: merchant-side `inventory_items`
  (store stock) and warehouse stock are **separate records** — the screens
  never mix them; `warehouse_stock` is its own table (backend/DATA-MODEL.md).

### Stock-low alerts at warehouses

`warehouse.stock_low` (merchant + ops, in-app) fires when a warehouse item falls
below its serving threshold. Merchant UI mapping:

- Notification row: "Dar warehouse — {item} is running low (reorder for next-day
  promise)" with a deep link to the warehouse detail.
- The warehouse detail Stock tab shows a low-stock pill on affected rows; the
  "Send inventory" CTA pre-fills the item.
- The alert is informational: the merchant decides when to bulk-send; the
  platform never auto-replenishes.

### Nearest-warehouse fulfillment (how their orders are fulfilled)

- When a customer orders, the server selects the nearest serving warehouse
  (city in `servingCities`, stock available, status `active`) and fulfills via
  `POST /warehouses/{warehouseId}/fulfill` `{orderId}` (order tag — the merchant
  console never calls it directly; it is server-driven).
- Effects: stock is deducted (`warehouse_stock.quantity -= ordered`); the order
  becomes `fulfillmentSource: warehouse`; the customer receives
  `warehouse.fulfilled` (push + in-app) — "ships from a local warehouse"; the
  merchant's store inventory is untouched.
- **Fallback**: if no serving warehouse has the item, the order fulfills from
  the merchant's store as usual (`fulfillmentSource: merchant`) or declines
  with the standard item-unavailable path — never a partial order.
- **Next-day promise mechanics**: a warehouse in the customer's city enables
  "Arrives today" (last-mile leg ETA); a warehouse in a nearby city enables the
  next-day/day-after window ("Arrives Day 2, 09:00–14:00") computed from leg
  ETAs. The merchant sees the promise framing in the warehouse's serving-city
  config; the customer sees only the window (customer ORDER-FLOW.md).
- Fulfillment routing is strategy-pattern dispatch
  (`Order.dispatchStrategy: warehouse`); `DISPATCH_STRATEGY_INVALID` guards
  invalid strategy values server-side.

### Warehouse operations — per-screen state contract

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Warehouse list | card skeletons | "No warehouses" + "Create warehouse" CTA | error card + `requestId` | retry refetches | cards: name, city, address, `servingCities`, status pill |
| Warehouse detail | skeleton | — | 404 `WAREHOUSE_NOT_FOUND` → empty variant | retry | header (name, city, address, status) + Stock tab (`stock[]` rows with low pills) + actions (Send inventory, PATCH settings) |
| Send inventory (bulk inbound) | item-picker skeletons | "No catalogue items to send" | `VALIDATION_FAILED` inline; `INVENTORY_NEGATIVE_STOCK` conflict card | re-submit | 200 → success toast + updated `stock[]` |
| Fulfillment status (server-driven) | — | — | `WAREHOUSE_STOCK_UNAVAILABLE` / `WAREHOUSE_OUT_OF_SERVICE` (surfaced via orders/notifications, never via a merchant-side fulfillment form) | — | order `fulfillmentSource: warehouse` + `warehouse.fulfilled` notification |

### Rules

- Warehouse records are per-merchant-visible via the same registry the admin
  uses (tags `[admin, merchants]`); admin CRUD (module 28) and merchant
  stock/bulk-inbound share the contract — a merchant never sees other merchants'
  warehouse quantities (resource-level scoping).
- `status: maintenance` warehouses never fulfill; inbound to a `full` warehouse
  is allowed with a warning (the warehouse screen explains the `full` pill).
- Audit: warehouse create/update and stock deltas are audited
  (`warehouse.*`, backend/AUDIT.md); the merchant console renders no audit data.
- MSW parity: `Warehouse` shape, stock `{catalogueItemId, delta}` semantics,
  statuses (`active`/`full`/`maintenance`), and error codes
  (`WAREHOUSE_NOT_FOUND`, `WAREHOUSE_STOCK_UNAVAILABLE`, `WAREHOUSE_OUT_OF_SERVICE`,
  `INVENTORY_NEGATIVE_STOCK`) must match the contract.
