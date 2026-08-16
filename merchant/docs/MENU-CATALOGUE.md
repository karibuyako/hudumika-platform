# HUDumika Merchant — Menu and Catalogue

Catalogue management: item CRUD, options, availability, categories, the publish workflow (`replaceMyCatalogue`), barcodes, combo meals, multi-store menus, product videos, and the AI product assistant. Full manager on web; mobile offers availability toggles, barcode scanning, and quick edits.

## Item fields (`CatalogueItem`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | server-assigned |
| `name` | string ≤160 | required |
| `description` | string ≤2000 | optional |
| `priceTZS` | integer ≥0 | required; TZS minor units, integer only |
| `category` | string | required; must match a merchant category (`ProductCategory.name`) |
| `imageUrl` | uri | optional; upload → URL via storage service |
| `videoUrl` | uri | optional; product video, upload via pre-signed URL pattern |
| `available` | boolean | default true; drives `MerchantPublic.isOpen`-independent per-item selling |
| `options` | array | name + `choices[]` (`label`, `priceTZS` each) — size, add-ons, variants |

Option example: name "Size", choices: Small `priceTZS` 0, Large `priceTZS` 2000 — additive price variations on the base `priceTZS`.

## CRUD

| Action | Endpoint | UI notes |
| --- | --- | --- |
| Create | `POST /catalogue-items` | validate required name/priceTZS/category; 422 maps `errors[].field` to form |
| Update | `PATCH /catalogue-items/{itemId}` | partial: name, description, priceTZS, available, options |
| Delete | `DELETE /catalogue-items/{itemId}` | soft-delete (204); confirm dialog; item disappears from public catalogue, order history keeps the item snapshot |
| Read | `GET /catalogues/me` | full item list with `publishedAt` |

Availability: per-item `available` toggle (mobile quick action, web grid toggle); store-level `isOpen` lives on `PATCH /merchants/me` and is separate. Toggles are optimistic with server rollback.

## Draft vs published

| Aspect | Draft | Published |
| --- | --- | --- |
| Signal | local editor state | `Catalogue.publishedAt` non-null |
| Visibility to customers | none | via `GET /catalogues/{merchantId}` (approved items only) |
| Publish | `PUT /catalogues/me` with full `Catalogue` | sets/updates `publishedAt` |

Publish sends the complete `Catalogue` (full replace — the client must send the whole object); success refreshes `publishedAt`, failure shows `ORDER_PRICE_CHANGED` or validation errors and blocks.

## Price change handling (`ORDER_PRICE_CHANGED`)

- Changing `priceTZS` on an item referenced by in-flight orders rejects the publish with `ORDER_PRICE_CHANGED`. UI: banner listing the affected item(s) + in-flight count; retry after the orders complete or the price reverts to the quoted value. Customers are never charged differently from the quoted price (SHARED-FLOWS); identical behavior on mobile and web.

## Categories management

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/categories` | Product categories with sort order | `ProductCategory[]` |
| POST | `/categories` | Create a category | `ProductCategory` / 201 |
| PATCH | `/categories/{categoryId}` | Rename, image, sort order, active | `ProductCategory` |
| DELETE | `/categories/{categoryId}` | Delete an empty category (soft delete) | 204 |

- `ProductCategory`: `id`, `name` (≤80), `sortOrder`, `imageUrl` (nullable), `active` (default true). Item editor picker uses `GET /categories`; the public `category` string matches `ProductCategory.name`.
- Sort writes `sortOrder` (PATCH); duplicates rejected with `CATEGORY_SORT_CONFLICT` (refetch + re-apply). Delete only empty categories (`CATEGORY_NOT_EMPTY` shows the item count and blocks); rename carries items; `active: false` hides without deleting.
- Screen states: list loading skeleton → empty ("No categories yet — add your first") → error + retry → sorted chips; editor saving spinner → success toast → 422 field mapping (`CATEGORY_NOT_FOUND` on stale ids).

## Inventory and zero-stock

- No stock-count field on `CatalogueItem` — the sell-blocking signal is `available: false` (zero-stock); ordering against an unavailable item is rejected (`ORDER_ITEM_UNAVAILABLE`). Toggle via `PATCH /catalogue-items/{itemId}` (mobile "out of stock" quick action, web toggle); restock flips `available: true` with no re-publish.
- Quantity tracking (counts, low-stock alerts) lives in master inventory (`GET /inventory/items`, `GET /inventory/alerts`) — INVENTORY-SUPPLY-CHAIN.md; the two surfaces stay separate.

## Bulk catalogue operations (M9c)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/catalogue-items/bulk` | Bulk create/update items (max 500) | `{jobId, accepted, rejected}` / 202 |
| POST | `/catalogues/import` | Spreadsheet import (max 5000 rows) | `{jobId, status}` / 202 |
| GET | `/catalogues/export` | Export catalogue as spreadsheet | `{downloadUrl, expiresInSeconds}` (900) |

- Bulk body: `items[]` (max 500 `CatalogueItem`), `overwritePrices` (default false); `accepted`/`rejected` counts with per-row reasons on rejected rows. Import: `name`/`priceTZS`/`category` required; job `status` `queued` → `processing` → `completed`/`failed` (poll until terminal). Export: permissioned + audited; `downloadUrl` from the API, never hardcoded. Barcode workflows are a separate subsystem — see below. Variants note: size/color variations are covered by `options`; a dedicated variants resource is not needed in v1.

## Product specs and variations (options, expanded)

`options` is a list of groups; each group has a `name` and `choices[]` (`label`, `priceTZS` each). Patterns: size/variant = one group with exclusive choice (radio); add-ons = one group, multi-choice (checkboxes); multi-spec = several groups (size + extras).

- Choice prices are additive price variations on the base `priceTZS` — the server recomputes order totals; the client never sums base + choices for display of item price. Variation images or stock per choice are not in the contract (proposed gap).

## Barcodes

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/barcodes/formats` | Supported formats | `BarcodeFormat[]` (`code` `ean13`/`upca`/`qr`, `label`) |
| POST | `/products/{itemId}/barcode/generate` | Generate for an item; body `format` | `BarcodeInfo` / 201 |
| GET | `/products/{itemId}/barcodes` | Barcodes for an item | `BarcodeInfo[]` |
| GET | `/barcodes/{code}` | Look up an item by code | `BarcodeLookup` / 404 `BARCODE_NOT_FOUND` |
| GET | `/barcodes/{code}/history` | Scan/print history | `[{at, action: generated|scanned|printed|updated}]` |
| POST | `/barcodes/batch` | Bulk import `entries` (max 2000: `code` + `catalogueItemId`) | `{jobId, accepted, rejected}` / 202 |

- `BarcodeInfo`: `id`, `code`, `format`, `catalogueItemId`, `createdAt`. `BarcodeLookup`: `catalogueItemId`, `name`, `priceTZS`, `available`, `stockOnHand` (nullable) — used by the scan-at-POS quick add.
- Errors: `BARCODE_EXISTS` (code already assigned — show the owning item), `BARCODE_FORMAT_UNSUPPORTED` (422), `BARCODE_BATCH_EXCEEDS_LIMIT` (>2000 — split the import).
- UI: formats picker → generate (per item), barcode list on the item detail, scanner/entry lookup (mobile camera, web input), batch upload with `accepted`/`rejected` summary, history drawer per code. States: loading skeleton → empty ("No barcodes yet — generate one") → error + retry → list/result card; scan mismatch → `BARCODE_NOT_FOUND` with retry.

## Combo meals (`/combos`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/combos` | Combo list | `Combo[]` |
| POST | `/combos` | Create a combo | `Combo` / 201 |
| PATCH | `/combos/{comboId}` | Update a combo | `Combo` |
| DELETE | `/combos/{comboId}` | Delete a combo | 204 |

- `Combo`: `name` ≤160, `description` ≤1000, `items[]` (`catalogueItemId` + `quantity` ≥1), `priceTZS`, `imageUrl` (nullable), `available` (default true), `createdAt`. Errors: `COMBO_NOT_FOUND` (404), `COMBO_ITEM_INVALID` (422 field mapping).
- Editor: item picker with per-item quantities → bundle `priceTZS` (integer TZS) → availability toggle; a combo renders as a single sellable unit in the public catalogue. States: list loading → empty ("No combo meals yet") → error + retry → cards; editor saving spinner → success toast → 422 inline.

## Multi-store menus (`/menus`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/menus` | Menu list | `Menu[]` |
| POST | `/menus` | Create a menu | `Menu` / 201 |
| PUT | `/menus/{menuId}` | Replace a menu | `Menu` |
| DELETE | `/menus/{menuId}` | Delete a menu | 204 |

- `Menu`: `name` ≤160, `storeIds[]`, `sections[]` (`name` + `itemIds[]`), `active` (default true), `createdAt`.
- Errors: `MENU_NOT_FOUND`, `MENU_STORE_INVALID` (store id outside the merchant's chain — 422). Editor: sections reorder + item picker per section, store multi-select from `GET /merchants/me/stores` (MULTI-STORE.md); `active: false` hides the menu without deleting sections.

## Product videos (`/videos`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/videos` | Video list | `ProductVideo[]` |
| POST | `/videos` | Add a video | `ProductVideo` / 201 |
| DELETE | `/videos/{videoId}` | Delete a video | 204 |

- `ProductVideo`: `title` ≤120, `url` (uri), `thumbnailUrl` (nullable), `catalogueItemId` (nullable — null means store-level), `createdAt`. `videoUrl` on `CatalogueItem` remains the item's inline video field. Errors: `VIDEO_NOT_FOUND` (404), `VIDEO_URL_INVALID` (422); uploads use the pre-signed URL pattern — media URLs come from the API, never hardcoded. States: list loading → empty ("No videos yet") → error + retry → thumbnails grid; add form (title + URL + thumbnail + optional item) → saving spinner → success toast.

## Product assistant (AI) (`/products/assistant`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/products/assistant/suggestions` | AI suggestions | `[{type, suggestion, itemId}]` |
| POST | `/products/assistant/apply` | Apply one suggestion | `CatalogueItem` |

- Suggestion `type` enum: `title` / `description` / `price` / `category` / `photo` / `stock`; `itemId` nullable (store-level suggestions). Apply body: `itemId`, `type`, `value` → updated `CatalogueItem`.
- The UI never fabricates suggestions — the card renders only server suggestions, applied per field with review-before-apply. States: suggestions loading skeleton → empty ("No suggestions right now") → error + retry → cards with per-field apply; apply spinner → success toast on the item.

## Product templates and operation log

- `ProductTemplate` CRUD + apply (`POST /product-templates/{templateId}/apply` with `storeIds`, `overwritePrices` default false) covers menu sync across chain stores; per-store deltas survive re-apply when `overwritePrices: false` (MULTI-STORE.md).
- `GET /catalogue-items/{itemId}/logs` returns `{at, actor, action, before, after}[]` — `action` is a dot-scope string (e.g. `price.updated`); every price/availability/options change is logged server-side. UI: read-only "History" drawer (web) / activity list (mobile). The log is per item; a catalogue-wide feed is not in the contract (proposed gap).

## Screen states

- List: loading skeleton → empty ("No items yet — add your first item") → error + retry → grid with category filter. Editor: form loading → 422 inline field mapping → saving spinner → success toast → error + retry. Publish: spinner → success banner (new `publishedAt`) → `ORDER_PRICE_CHANGED` banner → validation list → 429 with `Retry-After`.
- Bulk: submit → 202 spinner → results card (`accepted`/`rejected`, per-row errors); import polls `status`; export shows a link card with expiry countdown. New subsystems (barcodes, combos, menus, videos, assistant) each repeat the same five states in their sections above.

## Business rules

- Menu changes are versioned and auditable server-side (PRODUCT.md); the client exposes only current draft + published state. Money stays integer TZS end-to-end; option prices are integers too.
- MSW mocks for catalogue endpoints must match the contract, including 422 field errors, the `ORDER_PRICE_CHANGED` code, barcode/combo/menu/video payloads, and assistant suggestion shapes.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Round-2 catalogue fields (pricing, stock action, display)

| Field | Type | Notes |
| --- | --- | --- |
| `originalPriceTZS` | integer, nullable | Compare-at price for savings display |
| `costTZS` | integer, nullable | Unit cost; input for margin analytics |
| `zeroStockAction` | enum `hide` / `show_sold_out` | default `show_sold_out` |
| `sort` | integer | default 0; ascending within category |
| `emoji` | string <=8, nullable | List thumbnail fallback |
| `addons[]` | array | `name` <=80 + `priceTZS` + `emoji` <=8 (nullable) |
| `comboItems[]` | array | `catalogueItemId` (uuid) + `quantity` >=1 — inline combo membership |

- **Savings display**: `originalPriceTZS` > `priceTZS` renders the compare-at price struck through with a server-value savings line ("Save TZS 5,000"); money stays integer TZS with separators.
- **Cost and margin**: `costTZS` is an editor field and analytics input (the margin column on the product-performance screen is a contract gap — `ProductPerformance` has no margin field; see ANALYTICS.md). The editor renders cost read-only-adjacent to price; margins are never recomputed into order totals.
- **Zero-stock action**: `available: false` remains the sell-blocking signal (`ORDER_ITEM_UNAVAILABLE`); `zeroStockAction` decides customer-side rendering — `hide` removes the item from the public listing, `show_sold_out` keeps it visible marked sold out. Toggled in the editor; restock flips `available: true` with no re-publish.
- **Sort**: integer sort order within the category; the editor reorder writes `sort` (PATCH). Category-level ordering stays `ProductCategory.sortOrder`.
- **Emoji**: <=8 chars, rendered as the list/grid thumbnail fallback when `imageUrl` is absent; editor offers an emoji palette.
- **Addons**: a flat list (`name`, `priceTZS`, optional `emoji`) distinct from `options` groups; additive on the base `priceTZS` server-side. Addons and options coexist on the same item.
- **ComboItems**: marks an item as a bundle member (`catalogueItemId` + `quantity`); the dedicated `/combos` resource remains the sellable-bundle surface (MENU-CATALOGUE combo section), `comboItems` records membership on the item itself.

## Round-2 barcodes — formats and removal

- Formats catalog now serves `BarcodeFormat` enum `ean13` / `ean8` / `upca` / `code128` / `code39` / `qr` (`GET /barcodes/formats`); generate per item via `POST /products/{itemId}/barcode/generate` with the chosen `format`.
- Delete a single assigned code: `DELETE /products/{itemId}/barcode/{code}` (204) — the item's barcode list (`GET /products/{itemId}/barcodes`) refreshes; a stale code returns 404 (`BARCODE_NOT_FOUND`) with a refetch banner.
- Contract note: `BarcodeInfo.format` (the response shape) still enums `ean13` / `upca` / `qr` while the formats catalog supports six — flag for alignment before rendering ean8/code128/code39 codes from list payloads.

## Round-2 product videos — status and metrics (contract gap)

- The reference app shows `processing` / `failed` status and views/duration on video rows. `ProductVideo` carries only `title`, `url`, `thumbnailUrl`, `catalogueItemId`, `createdAt` — no status, views, or duration fields (contract gap). Until the contract grows these, video rows render without status pills or metrics; upload stays `POST /videos` with no async processing signal.

## Round-2 product history — change-type filter

- `GET /catalogue-items/{itemId}/logs` returns `{at, actor, action, before, after}[]`; `action` is a dot-scope string (e.g. `price.updated`). The reference-app filter chips (price / stock / description / created / updated / deleted / listing) are client-side groupings over those action strings; the contract defines no filter enum (contract gap). UI: filter chips over the fetched log; states loading skeleton → empty ("No history for this item") → error + retry → grouped timeline.

# Round-3 additions — contract-test verified catalogue behavior

Behaviors verified against the reference contract suite (`tests/contract.test.ts`).

## Product create validation

`POST /products` validates before persisting; each failure is a 400 with an exact code (reference suite):

| Condition | Code |
| --- | --- |
| `name` missing | `NAME_REQUIRED` |
| `price` <= 0 | `INVALID_PRICE` |
| unknown `categoryId` | `INVALID_CATEGORY` |
| malformed `videoUrl` | `INVALID_VIDEO_URL` |
| `comboItems[]` references a missing product | `INVALID_COMBO` |

## Specifications (variants)

- `variants[]` (`name`, `price`) round-trip on create and PATCH (create 2, PATCH to 3, values persist).
- Empty variant `name` → 400 `INVALID_VARIANTS`.

## Add-ons

- `addons[]` (`name`, `price`, optional `emoji`) round-trip on create and PATCH.

## Combo meals and zero-stock hide

- A seeded combo (`comboItems[]` with >= 2 bundled items) appears in the customer menu.
- `zeroStockAction: hide` at 0 stock removes the product from the customer menu; `showSoldOut` keeps it listed at 0 stock.

## List / unlist

- `visible: false` hides the product from the customer menu while the merchant list still shows it; `visible: true` restores it.

## Bulk stock adjust

- Bulk stock adjust accepts per-item `{id, set}` (absolute) or `{id, delta}` (relative); a negative delta clamps at 0 stock.

## Categories

- Delete of an in-use category → 409 (reference suite: `PRODUCTS_ASSIGNED`; repo contract code: `CATEGORY_NOT_EMPTY`). Rename and re-sort round-trip; the sort endpoint applies the given `ids[]` order.

## Product operation logs

- Product logs record `product:create` / `product:update` / `product:stock` / `product:delete`; update and stock entries carry `field` + numeric `before` / `after`.

## Templates and multi-store isolation

- A template `draft` strips identity fields (`id`, `merchantId`, `stock`); apply to `storeIds[]` creates the product in the target store only; a bogus store is reported in `failed[]` (never a crash); the applied product is live in that store's menu.
- Per-store menu visibility is isolated: unlisting a product in store 2 never touches store 1's menu.

## Assistant

- `POST /products/assistant/apply` with a `stock` suggestion mutates the product's stock; `POST /products/assistant/describe` generates a description from the item name.
