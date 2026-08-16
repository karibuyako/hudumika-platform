# HUDumika Merchant — Testing

Unit + component tests per surface, MSW contract tests against `backend/API-CONTRACT.yaml`, E2E for the core happy path, and a per-screen state checklist.

## Test stack

The app standardizes on `node:test` (Node's built-in runner) for every Node-side
suite — unit, contract, and store-level — bundled by esbuild via `tests/run.mjs`.
No Jest / React Native Testing Library, no Vitest: there is exactly one runner
and one bundle for all non-browser tests, and CI executes the same command as a
local `npm test`.

| Layer | Stack | Runs via |
| --- | --- | --- |
| Contract tests (mock backend ↔ API contract) | `node:test` + MSW node | `tests/run.mjs` → `tests/contract.test.ts` |
| Store-level tests (zustand stores vs in-app MSW handlers) | `node:test` + MSW node | `tests/run.mjs` → `tests/store.test.ts` |
| Unit tests (helpers, money/date/locale) | `node:test` | `tests/run.mjs` (same bundle) |
| Contract mocks | MSW — `src/mock/handlers/*`, Node-safe by design | `setupServer` inside tests (web dev uses `msw/browser`) |
| Web E2E | Playwright | `tests/e2e/web-e2e.mjs` (standalone script) |
| Formatting | money/date/locale helpers | asserted inside the node:test suites |

## Stack decision (store-level tests)

- **Runner:** `node:test` + esbuild bundling via `tests/run.mjs` (`--alias:@=<src>`,
  `node --test` over `tests/.build/*.mjs`). The default suite is
  `contract.test.ts` + `store.test.ts` (+ any future `tests/*.test.ts`), so CI's
  `node tests/run.mjs` runs everything.
- **Why not Jest/RNTL:** no new dependencies (`node:test` ships with Node,
  esbuild is already a devDependency), the in-app MSW mock backend is Node-safe
  so tests import the exact handlers the app runs against in dev, and CI runs
  the same bundle with no separate runner config to drift.
- **Store tests** (`tests/store.test.ts`) exercise real zustand store actions
  against the MSW handlers and assert on resulting store state (loading flags,
  optimistic updates, server-confirmed rows). `tests/shims.ts` (imported first)
  sets `EXPO_PUBLIC_API_URL`, patches `navigator.onLine`, and provides
  `localStorage`/`sessionStorage` so the shared `@/api/client` behaves exactly
  as it does on device.
- **Conventions:** deterministic — `db.reset()` + `seedDatabase()` before the
  suite, `setToken()` in `beforeEach`, no `.only`, no skipped tests; money
  assertions are integer TZS or cents-exact (no float drift); fire-and-forget
  store PATCHes are polled against the mock db before asserting server state.

## MSW contract tests (both surfaces)

- MSW handlers are generated/kept in parity with `backend/API-CONTRACT.yaml`: same paths, statuses, error codes, schemas.
- Contract test suite: for each merchant-called endpoint, assert mock shape against the OpenAPI schema (request validation + response fixtures), including:
  - Auth: 401 on bad OTP, 429 rate limit with `Retry-After`.
  - Orders: accept 409 when status is not `paid`; advance rejection for rider-owned states; cancel with `reason`; reject codes (`ORDER_ALREADY_REJECTED`, `ORDER_REJECT_AFTER_ACCEPTANCE`); `rushRequestedAt`; advance-order day list; masked `contactPhone`.
  - Catalogue: 422 field errors; publish `ORDER_PRICE_CHANGED`; item operation logs shape.
  - Payouts: statuses pending/processing/paid/failed/exception; ledger entry types.
  - Wallet: projection fields; withdrawal 409/`WITHDRAWAL_BELOW_MINIMUM`; `WalletTransaction.type` enum.
  - Dine-in: table CRUD; QR payload (`qrPayload`, `menuUrl`); bill transitions open→billing→paid→closed; `DINE_IN_TABLE_IN_USE` / `DINE_IN_BILL_NOT_PAYABLE`.
  - Group buy: deal state machine incl. extend/delist/relist; voucher statuses; verify 409 codes; verify-history results.
  - Promotions: statuses; `PROMOTION_CONFLICT_ACTIVE`; performance shape; coupon statuses.
  - Loyalty: `MEMBER_PHONE_EXISTS`, `TOP_UP_BELOW_THRESHOLD`, tier payloads.
  - Staff/devices: roles/statuses; `STAFF_LAST_OWNER`; device statuses; `PRINT_QUEUE_FULL`.
  - Analytics: dashboard `today`/`live`; channel enums; export response; diagnostics placeholder; review analytics; market analysis payloads.
  - Print jobs: statuses queued/printing/done/failed; `PRINT_DEVICE_OFFLINE`; `PRINT_JOB_EMPTY`; categories CRUD + `CATEGORY_NOT_EMPTY`/`CATEGORY_SORT_CONFLICT`; payout account masked read + `PAYOUT_ACCOUNT_VERIFICATION_REQUIRED`; `PaymentQr` fixed/variable + `PAYMENT_QR_EXPIRED`.
  - Chain: dashboard totals/stores shapes; cross-store analytics; report export response.
  - Bulk operations: type/status enums; per-store `results[]`; `BULK_OPERATION_REQUIRES_APPROVAL` gate.
  - Inventory: item/adjustment/alert shapes; sync-config values; `INVENTORY_NEGATIVE_STOCK`, `INVENTORY_SYNC_DISABLED`.
  - Procurement: PO status transitions; receive/cancel; `PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY`; `SUPPLIER_SUSPENDED`; returns statuses.
  - Staff ops: shift statuses + `SHIFT_OVERLAP`; attendance clock errors; performance shape; commission rules; approval decision 409s (`APPROVAL_ALREADY_DECIDED`).
  - Integrations/webhooks: provider/status enums; disconnect 204; delivery statuses/attempts; subscription status `failing`; backoff timings.
  - Reports/CRM: scheduled report payloads; segment `memberCount`; journey actions; `SEGMENT_RULES_INVALID`, `JOURNEY_TRIGGER_INVALID`.
  - Data export: job statuses; `DATA_EXPORT_IN_PROGRESS`, `DATA_EXPORT_RATE_LIMITED`.
  - Notifications: `deepLink` routing; preferences PUT; order-settings PUT (`autoAcceptWithinSeconds` bounds).
- CI gate: contract tests run against staging with the same fixtures when the real API is up.

## E2E happy path (catalogue publish → order accept)

1. Login via OTP (mocked or sandbox) → onboarding approved.
2. Create an item (`POST /catalogue-items`) → publish catalogue (`PUT /catalogues/me`) → assert `publishedAt` set and item visible in `GET /catalogues/me`.
3. Incoming order appears (seeded `paid` order) → merchant accepts (`POST /orders/{orderId}/accept`) → status becomes `merchant_accepted`.
4. Advance to `preparing`, then assert rider-owned actions disappear after `rider_assigned`.
5. Cancel path: a second seeded order cancelled with fee visible pre-confirmation.
6. Earnings: after seed `completed` order, statement shows `order_earning` + `commission` entries.

Run this as a Maestro flow on mobile and Playwright on web; same scenario name and steps.

Automation split (`tests/e2e/web-e2e.mjs`, `npm run test:e2e`): the Playwright
web script runs against the exported `dist/` and automates a subset of the
catalog below — login, order accept/reject, advance pre-orders, batch print,
order detail, history filters, rush handling, refund decision, coupon
redemption, risk center, demand forecast, offline queue flush, event channel
health, finance load (~14 checks). The remaining scenarios are enforced by the
contract/store suites (`tests/run.mjs`) at the API level and by the per-screen
checklist; the full 40-scenario catalog is the manual E2E gate for release.
The web script is not part of CI (it needs a browser + the exported build);
CI runs the contract/store/bundle suites instead.

## E2E scenarios (full feature set)

| # | Scenario | Steps and assertions |
| --- | --- | --- |
| 1 | QR → dine-in pay → close | Seed table; fetch QR (`GET /dine-in/tables/{id}/qr`) and assert `qrPayload` + `menuUrl`; open bill via `POST /dine-in/orders`; merchant confirms payment (`confirm-payment`); assert `paid`; `close`; assert table `currentOrderId` cleared |
| 2 | Group buy deal → voucher verify | Create deal → `pending_review` → seed moderation approval (`live`); seed purchased voucher (`unused`); verify by code (`POST /vouchers/{voucherCode}/verify`) → 200 redeemed; verify again → 409 `VOUCHER_ALREADY_USED`; assert both rows in `verify-history` |
| 3 | Coupon redemption on order | Seed coupon campaign with `claimedCount`; seed order with coupon discount applied; assert `discountTZS` in `PriceBreakdown`, `coupon_cost` wallet transaction, `COUPON_ALREADY_USED` on second use |
| 4 | Withdrawal request | Seed wallet with withdrawable balance; request `POST /wallet/withdrawals` → 201 `pending`; assert balance decreased by amount; attempt over-balance → `WALLET_INSUFFICIENT_BALANCE`; below minimum → `WITHDRAWAL_BELOW_MINIMUM` |
| 5 | Staff permission enforcement | Create `cashier` staff; cashier session can confirm dine-in payment + verify voucher; attempting accept order → 403 (`STAFF_ROLE_FORBIDDEN` path); suspend staff → all actions 403; last owner removal blocked (`STAFF_LAST_OWNER`) |
| 6 | Analytics dashboard vs ledger | Seed completed orders + dine-in paid + group buy redeemed; assert dashboard `orderCount`/`revenueTZS`/`dineInCount`/`groupBuyCount` equal sum of matching `settlement`/`group_buy_settlement` wallet transactions (dashboard-to-ledger reconciliation, backend M7e exit criterion) |
| 7 | Bulk price update across 2 stores → approval → partial/failed | Create a store-scoped chain; `POST /bulk-operations` `price_update` for both stores with `requiresApproval`; seed one store as failing (e.g. item soft-deleted → per-store `ok: false`); approve via `/approvals/{id}/decision`; poll `GET /bulk-operations/{id}` → status `partial` (or `failed`), `results[]` shows `ok`/`error` per store; assert unapproved request is gated by `BULK_OPERATION_REQUIRES_APPROVAL` |
| 8 | PO receive → stock + COGS updated | Create supplier + draft PO (`unitCostTZS` known); send; `POST /purchase-orders/{id}/receive` partial → assert status `partially_received` and inventory `stockOnHand`/`unitCostTZS` changed (adjustment history shows `stock_in`); receive over quantity → `PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY`; full receive → `received` → `closed` |
| 9 | Webhook delivery retry → failing status | Create subscription; seed a failing event with `attempts` under 8 → assert delivery `retrying` with `nextRetryAt`; seed 5 consecutive errors → subscription `status: failing`; owner gets `webhook.delivery_failed` notification; admin `GET /admin/webhooks?failingOnly=true` includes it |
| 10 | Clock-in/out → attendance record | Staff member session `POST /staff/attendance/clock-in` → record with `clockedInAt`, `source: app`; second clock-in → `ATTENDANCE_ALREADY_CLOCKED_IN`; `clock-out` → `clockedOutAt` + `durationMinutes`; `GET /staff/attendance?staffId` shows the pair; clock-out without open record → `ATTENDANCE_NOT_CLOCKED_IN` |
| 11 | Segment creation → member count | Seed completed orders with spend; `POST /segments` with spend/frequency rules → 201 with `memberCount` > 0; invalid rules → `SEGMENT_RULES_INVALID` (422); journey `POST /journeys` with push/coupon actions → 201 `draft`; activate → `active`; invalid trigger → `JOURNEY_TRIGGER_INVALID` |
| 12 | Batch print receipts | Seed 2 `paid` orders; multi-select both → `POST /print-jobs` (`jobType: receipt`, `orderIds[]` ×2) → 201 with `status: queued`; poll `GET /print-jobs/{printJobId}` → `printing` → `done` with `completedAt`; seed an offline device target → `PRINT_DEVICE_OFFLINE` alert + retry; empty selection → `PRINT_JOB_EMPTY` |
| 13 | Category CRUD + delete guard | `POST /categories` → 201; `PATCH /categories/{categoryId}` rename/re-sort → 200; duplicate `sortOrder` → `CATEGORY_SORT_CONFLICT`; seed an item in the category → `DELETE /categories/{categoryId}` → `CATEGORY_NOT_EMPTY` (item count shown); empty category delete → 204; stale id → `CATEGORY_NOT_FOUND` |
| 14 | Payout account change → verification | No account → `GET /merchants/me/payout-account` → `PAYOUT_ACCOUNT_NOT_SET`; `PUT /merchants/me/payout-account` (`PayoutAccountWrite`) → 200 masked (`accountMasked`) with `verified: false`; seed verification → `payout_account.verified` notification → masked view `verified: true`; unsupported provider → `PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED` (422) |
| 15 | Fixed vs variable collection QR | `POST /payments/qr` with `amountTZS: 25000` → `PaymentQr` with amount + `merchantRef` + `expiresAt`; with `amountTZS: null` → `amountTZS: null` (variable); seed expired QR → scan → `PAYMENT_QR_EXPIRED` → regenerate flow |

## Per-screen checklist

Every screen documents and tests five states. Required matrix (checklist per screen):

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Login / OTP | sending indicator, resend countdown | — | wrong code 401, rate-limit 429 | resend/retry | session routed to correct surface |
| Onboarding status | status poll skeleton | no application → apply CTA | network/session | retry | approved → dashboard unlock |
| Catalogue list | skeleton | "No items yet" | fetch error | retry | grid + publishedAt badge |
| Item editor | form load | — | 422 field errors | re-submit | saved toast |
| Publish | publishing spinner | — | `ORDER_PRICE_CHANGED` banner | retry publish | publishedAt refresh |
| Orders queue | skeleton | "No new orders" | fetch error | retry | rows with accept CTA |
| Order detail | skeleton | — | 403/404 handled | retry | items/totals/timeline |
| Accept/advance | in-flight spinner | — | 409 conflict banner | refetch | status pill updated |
| Earnings history | skeleton | "No payouts yet" | fetch error | retry | status pills |
| Statement | skeleton | empty range | fetch error | retry | entries + balances |
| Notifications | skeleton | "No notifications" | fetch error | retry | list + unread badges |
| Preferences | skeleton | — | fetch error | retry | saved toast |
| Tickets | skeleton | "No tickets" | fetch error | retry | thread + reply |
| Store settings | skeleton | — | fetch error | retry | saved toast; closure-protection card |
| Tables | skeleton | "No tables yet" | fetch error | retry | grid + status dots |
| QR view | skeleton | — | fetch error | retry | payload render + print toast |
| Bill detail | skeleton | "No items" | fetch error | retry | confirm-payment/close actions |
| Deal list/editor | skeleton | "No deals" | 422 field errors | retry | campaign pills + preview card |
| Voucher verify | camera/input load | — | 409 reason card | rescan/retry | success card + history row |
| Promotion editor | skeleton | "No campaigns" | conflict banner | retry | budget card + pause toggle |
| Member list/top-up | skeleton | "No members yet" | `TOP_UP_BELOW_THRESHOLD` | retry | balance + bonus toast |
| Staff list/invite | skeleton | "No staff yet" | `STAFF_ROLE_FORBIDDEN` | retry | role chips + invite toast |
| Devices | skeleton | "No devices registered" | `DEVICE_OFFLINE` alert | retry | status dots + pairing toast |
| Wallet/withdraw | skeleton | "No withdrawals yet" | insufficient/minimum errors | retry | success card + history |
| Analytics dashboard | skeleton | "No activity yet today" | fetch error | retry | tiles + live strip |
| Order alert settings | skeleton | — | fetch error | retry | saved toast (manual/auto) |
| Print jobs | skeleton | "No print jobs" | `PRINT_DEVICE_OFFLINE` alert | retry | status pills + error card |
| Categories | skeleton | "No categories yet" | `CATEGORY_SORT_CONFLICT` banner | retry | sorted chips + editor toast |
| Payout account | skeleton | `PAYOUT_ACCOUNT_NOT_SET` CTA | fetch error | retry | masked card + verified pill |
| Collection QR | generator load | — | `PAYMENT_QR_PROVIDER_UNSUPPORTED` | regenerate | QR card + expiry countdown |
| Templates (chains) | skeleton | "No templates" | 422/conflict | retry | apply summary + overwritePrices |

## Test conventions

- Money assertions: integers and exact `TZS 1,234` format — no float math in tests or code.
- Timestamps: fixtures in UTC; assertions in local time via the i18n formatter.
- Mutation tests: assert optimistic UI + server rollback on error (409/422/network).
- Locale tests: `en` (default), `sw` (real keys), `ar` (RTL render, `en` fallback for empty keys).
- Accessibility: state transitions announced (screen readers) — asserted in component tests on mobile and web.

## Rules

- No test hardcodes URLs, phones, emails, or ratings — fixtures come from env and the contract.
- Contract drift (mock vs `API-CONTRACT.yaml`) fails CI before any surface release.

## E2E — reference-app operations (docs/REFERENCE-SURVEY.md)

| # | Scenario | Flow |
| --- | --- | --- |
| 16 | Batch order ops | Select 2 new orders → `POST /orders/batch/accept` → both advance → `BatchResult{accepted:2}`; batch reject with reason → both rejected |
| 17 | Barcode workflow | `POST /products/{id}/barcode/generate` (ean13) → scan/lookup `GET /barcodes/{code}` → product card → stock adjust → history shows `generated`/`scanned` |
| 18 | Combo → order | Create combo → customer order includes combo item + components → order detail renders bundle |
| 19 | Flash sale lifecycle | Create draft → `scheduled` → `live` (flash_sale.live) → order at discounted price → `ended` |
| 20 | Invoice + download | Request invoice → issue → `GET /finance/invoices/{id}/download` → PDF URL (expiry) |
| 21 | Task resolution | Seed anomaly task → fix item stock → task `done` → audit/me shows the event |
| 22 | Refund queue decision | Customer refund request pending → approve with reason → payment intent refunded → customer notified |
| 23 | Precision marketing | Segment with members → create campaign → send → `sentCount` increments, coupons issued |
| 24 | Privacy export | `POST /privacy/export` → job ready → download URL; deletion request returns `estimatedDays` |

## E2E — round-2 deep survey (docs/REFERENCE-SURVEY.md)

| # | Scenario | Flow |
| --- | --- | --- |
| 25 | Version-conflict accept | Two clients fetch the same `paid` order (`version` v1); client A accepts with `expectedVersion` v1 → 200 (`merchant_accepted`); client B accepts with the stale `expectedVersion` v1 → 409 `VERSION_CONFLICT` → B shows the conflict banner, refetches (fresh `version`), retries once → 200 or `ORDER_STATUS_CONFLICT` if already advanced; assert no double-accept |
| 26 | Expense create/delete | `POST /finance/expenses` (category + `amountTZS` + `incurredAt`) → 201; list shows the row with a category pill; `DELETE /finance/expenses/{expenseId}` → 204; stale id → 404 with refetch banner |
| 27 | Quick payment request | `POST /payments/request` (phone + `amountTZS` + method `mpesa`) → 201 `{requestId, status: sent}`; unsupported method value → 422 `VALIDATION_FAILED` field mapping |
| 28 | Transaction issue → ticket | `POST /finance/transactions/{transactionId}/issue` (`amount_mismatch` + description) → 201 `{ticketId, status: open}`; the ticket opens in the support thread; stale transaction id → 404 |
| 29 | Coupon kind percentage redemption | Create `CouponCampaign` with `kind: percentage` (`discountRateBps` + `maxDiscountTZS`); customer redeems over `minimumSpendTZS` → discount applied within the cap; `kind: shipping` → order carries `freeDelivery: true`; second redemption → `COUPON_ALREADY_USED` |
| 30 | Scheduled reopen | Gated on the scheduled-reopen contract addition (contract gap, STORE-MANAGEMENT.md) — no mock fabricates it; until it ships, E2E covers the `isOpen` toggle and the closure-protection expiry sweeper (active protection → expired + notification, `penaltyExempt` clears) |

## E2E — server-enforced order rules (contract-test parity)

| # | Scenario | Flow |
| --- | --- | --- |
| 31 | Closed-store gate | Close the store → internal order creation → 409 `STORE_CLOSED`; set `orderReceiving.acceptWhileClosed: true` → scheduled order accepted, immediate order still 409 `STORE_CLOSED` |
| 32 | NOTE_REQUIRED | Set `requireNotes: required` → order without note → 400 `NOTE_REQUIRED`; with note → 200 and note persisted; `optional` passes without a note |
| 33 | INSUFFICIENT_STOCK accept | Force low stock; accept an order exceeding it → 409 `INSUFFICIENT_STOCK`, order stays `new`; accept decrements stock exactly once (replay with a different idempotency key does not double-decrement) |
| 34 | Version-conflict double accept | Client A accepts with `expectedVersion` v1 → 200; client B with stale v1 → 409 `VERSION_CONFLICT` (`details.currentVersion`) → refetch → retry once → 200; assert no double-accept |
| 35 | Refund idempotency | Request refund on a completed order → decide twice → exactly one refund record and one ledger debit; double reject → one refund record |
| 36 | LAST_DEFAULT | Store with a single payment account → `isDefault: false` → 409 `LAST_DEFAULT` (account unchanged); delete the default → remaining account auto-assigned as default (`newDefault` reported) |
| 37 | Scheduled reopen sweeper | Past `scheduledReopenAt` → 400 `INVALID_REOPEN` (field never set); future timestamp → sweeper reopens the store, clears the field, logs `store:reopen`, notifies; active closure protection blocks the reopen (cancelled, logged, "Scheduled reopen cancelled" notification) |
| 38 | Free delivery threshold | Set `freeDeliveryThresholdTZS`; cart subtotal >= threshold → `freeDelivery: true`, `deliveryFeeTZS` 0; below → fee charged |
| 39 | Pre-order reminder flag | Pre-order within 15 min of slot → reminder sent once, `preOrderReminderSent` persisted on the order row |
| 40 | Review reply delete | `POST /reviews/{reviewId}/reply` → 201; `PATCH` edit → 200; blank text → 400 `EMPTY_REPLY`; `DELETE /reviews/{reviewId}/reply` → 204, reply gone, `reviews:reply-delete` audited |
