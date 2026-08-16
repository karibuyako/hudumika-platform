# HUDumika Merchant — Multi-Store (Chain)

One merchant account owning multiple store locations: chain store list, per-store settings/verification/open state, product templates, and menu management across locations.

## Chain stores

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/merchants/me/stores` | Chain store list | `ChainStore[]` |
| PATCH | `/merchants/me/stores/{storeId}` | Update a store's settings | `ChainStore` |

`ChainStore`: `id`, `businessName`, `city`, `serviceAreas`, `isOpen`, `verification` (per-store `VerificationState`), `closureProtection`.

| Field | Per-store behavior |
| --- | --- |
| `isOpen` | each location opens/closes independently |
| `verification` | each location passes verification on its own (`pending`, `documents_review`, `approved`, `rejected`, `suspended`, `changes_requested`) |
| `closureProtection` | per-location pause without penalty (STORE-MANAGEMENT.md) |

- PATCH body is `StoreSettingsUpdate` — per-store hours, announcement, acceptance, phone ordering, print settings.
- Store switcher (web header / mobile drawer): current store chip + list; all data screens scope to the selected store (server-side scoping — no client-side filtering of other stores' data).
- Screen states: list (loading skeleton → empty "No stores yet" → error + retry → cards with open/verification pills) and editor (form loading → 422 field mapping → saving → success toast).

## Product templates

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/product-templates` | Template list | `ProductTemplate[]` |
| POST | `/product-templates` | Create (`name` ≤160, `items`) | `ProductTemplate` / 201 |
| PATCH | `/product-templates/{templateId}` | Update a template | `ProductTemplate` |
| DELETE | `/product-templates/{templateId}` | Delete a template | 204 |
| POST | `/product-templates/{templateId}/apply` | Apply to stores | 204 |

`ProductTemplate`: `name`, `items[]` (`catalogueItemId`, `priceTZS`, `available`), `appliedStoreIds`, `createdAt`.

### Apply semantics

| Body field | Meaning |
| --- | --- |
| `storeIds` (required) | target chain stores |
| `overwritePrices` (default false) | false = keep per-store prices for existing items, template fills only what is missing; true = overwrite existing prices with the template's |

- Apply is server-side: 204 on success; the client refetches the template (updates `appliedStoreIds`) and the affected store catalogues.
- Editing a template never mutates stores implicitly — a new `apply` is required; the UI shows "template changed — re-apply to N stores" banner comparing `appliedStoreIds` vs current apply targets.

## Menu management across locations

- Per-store catalogues use the standard catalogue endpoints scoped to the active store (MENU-CATALOGUE.md); templates are the bulk path for chains.
- Workflow: author the menu once as a template → apply to selected stores → per-store price/availability tuning via `PATCH /catalogue-items/{itemId}` (re-apply with `overwritePrices: false` respects those deltas).
- Price/availability changes on applied items are visible in the template editor (they are the source of the next apply); item operation logs (`GET /catalogue-items/{itemId}/logs`) give the audit trail per store (MENU-CATALOGUE.md).

## Screen states and rules

- Template editor: loading → form (name, items table with price/available toggles) → saving → success → error + retry; delete requires confirm dialog (204 no-body).
- Apply dialog: store multi-select, `overwritePrices` radio (per DESIGN-SYSTEM radio-card pattern), summary of what will change, 422/conflict handling (e.g. `ITEM_NOT_FOUND` when a referenced item was soft-deleted).
- MSW parity: chain store shapes, verification values, template create/apply semantics (including `overwritePrices` default), and 204s must match the contract.

## Unified chain dashboard (`GET /chain/dashboard`)

`ChainDashboard`: `date`, `totals` (`orders`, `revenueTZS`, `activeOrders`, `lowStockAlerts`), `stores[]` (per store: `storeId`, `businessName`, `revenueTZS`, `orderCount`, `conversionRate`, `rating`, `isOpen`, `lowStockCount`).

- Totals are server-computed across the chain — the client never sums `stores[]` (ENTERPRISE-FINANCE.md).
- States: loading skeleton → empty ("No stores in this group") → error + retry → totals tiles + store table; `lowStockAlerts` links to `/inventory/alerts` (INVENTORY-SUPPLY-CHAIN.md).

## Cross-store analytics (`GET /chain/analytics?from&to`)

- Returns `ChainStorePerformance[]` for the range: revenue, order count, conversion, rating, open state, low-stock count per location.
- Screen: date range picker, ranked comparison table + chart; states: loading / empty range / error + retry; `ANALYTICS_RANGE_INVALID` on bad ranges.

## Chain-wide report export (`POST /chain/reports`)

- Body: `reportType` (`financial` / `operational` / `orders` / `inventory`), `from`, `to`, optional `storeIds`.
- Response: `{downloadUrl, expiresInSeconds}` (default 900) — permissioned and audited; errors `ANALYTICS_RANGE_INVALID`, `ANALYTICS_REPORT_EXCEEDS_LIMIT`, `ANALYTICS_EXPORT_NOT_READY` (ENTERPRISE-FINANCE.md).

## Bulk operations (`/bulk-operations`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/bulk-operations` | Apply an operation across stores | `BulkOperation` / 202 |
| GET | `/bulk-operations` | History and status | `BulkOperation[]` |
| GET | `/bulk-operations/{bulkOperationId}` | Detail with per-store results | `BulkOperation` |

- `type`: `price_update` / `availability` / `promotion_apply` / `catalogue_sync`; body carries `storeIds[]` and `payload`.
- `status`: `queued` → `processing` → `completed` / `partial` / `failed`; `results[]` per store (`storeId`, `ok`, `error`).
- Approval gating: when `requiresApproval`, the request must pass the approval workflow (`/approvals`, `type: bulk_operation`) before execution — `BULK_OPERATION_REQUIRES_APPROVAL` surfaces until the decision lands (ENTERPRISE-STAFF.md).
- Detail screen: progress pills, per-store result table with errors, retry path for `failed`/`partial` (re-POST scoped to failing stores); states: loading skeleton → empty ("No bulk operations") → error + retry → results.

## Centralized account management

- Chain accounts are `merchant_groups` (tier `standard` / `enterprise`, SLA level, account manager, monthly volume) — one account, many stores.
- Staff: `GET /admin/chain` lists enterprise chain accounts (`ChainAccountAdmin`: `merchantGroupId`, `name`, `storesCount`, `tier`, `slaLevel`, `accountManager`, `monthlyVolumeTZS`, `status`), staff-only (403 otherwise).
- Chain owners see the group-level surfaces (dashboard, bulk ops, inventory sync config, scheduled reports) on both surfaces; per-store data stays server-scoped to the selected store.
