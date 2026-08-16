# HUDumika Merchant — Operations Coverage Matrix

Bullet-by-bullet audit of the Meituan merchant app operations checklist (120
operations) against `backend/API-CONTRACT.yaml` and the team docs. Status key:

- **LIVE** — endpoint/field exists in the contract today, built per the referenced doc.
- **PLANNED** — documented roadmap item; contract addition required (phase noted).
- **N/A / OUT OF SCOPE** — not applicable to v1 (reason noted).

Every endpoint, status, enum, and error code below is spelled exactly as in the
contract. Anything not listed here is not in the contract and must not be built.

## 1. Order Management

- **Accept order** — LIVE — `POST /orders/{orderId}/accept` (`merchant_accepted`) — ORDER-FLOW.md
- **Reject order with reason** — LIVE — `POST /orders/{orderId}/reject` (`reason` ≤500) — ORDER-FLOW.md
- **Cancel order** — LIVE — `POST /orders/{orderId}/cancel` (`reason` ≤500; fees per SHARED-FLOWS) — ORDER-FLOW.md
- **Refund handling** — LIVE — merchant-visible only; executed via provider webhook (`refund.processed`, `refund` ledger entry) — ORDER-FLOW.md, PAYMENTS.md
- **Order detail with events + live tracking** — LIVE — `GET /orders/{orderId}` (`OrderDetail.items`, `PriceBreakdown`, masked `contactPhone`, `events[]`) + `GET /orders/{orderId}/track` (rider location, `estimateMinutes`) — ORDER-FLOW.md
- **Advance (scheduled) orders** — LIVE — `GET /orders/me/advance?date=` (`scheduledAt`, `order.scheduled_reminder`) — ORDER-FLOW.md
- **Advance status to preparing** — LIVE — `POST /orders/{orderId}/status` (`status: preparing`, optional `note`) — ORDER-FLOW.md
- **Order queue with status filters** — LIVE — `GET /orders/me?status=<OrderStatus>&limit=&cursor=` (cursor pagination) — ORDER-FLOW.md
- **Rush / hurry-up handling** — LIVE — `POST /orders/{orderId}/rush` (customer-owned; merchant renders `rushRequestedAt` banner + `order.rush_requested`) — ORDER-FLOW.md
- **Batch print receipts** — LIVE — `POST /print-jobs` (`jobType: receipt`, `orderIds[]` batch, `copies` 1–5, `deviceId` null = default printer); statuses `queued`/`printing`/`done`/`failed` — ORDER-FLOW.md

## 2. Product Management

- **Add product** — LIVE — `POST /catalogue-items` (`CatalogueItem`: name, `priceTZS`, category required) — MENU-CATALOGUE.md
- **Edit product** — LIVE — `PATCH /catalogue-items/{itemId}` (name, description, `priceTZS`, `available`, `options`) — MENU-CATALOGUE.md
- **Delete product** — LIVE — `DELETE /catalogue-items/{itemId}` (soft-delete 204; history keeps item snapshot) — MENU-CATALOGUE.md
- **List / unlist product** — LIVE — `available` toggle via `PATCH /catalogue-items/{itemId}` — MENU-CATALOGUE.md
- **Inventory / zero-stock** — LIVE — `available: false` blocks selling (`ORDER_ITEM_UNAVAILABLE`); quantities live in master inventory (`/inventory/items`, `/inventory/alerts`) — MENU-CATALOGUE.md, INVENTORY-SUPPLY-CHAIN.md
- **Product specs (options)** — LIVE — `options[]` groups with `choices[]` (`label`, `priceTZS` additive) — MENU-CATALOGUE.md
- **Combos** — LIVE — expressed via the `options` mechanism (bundle price + add-on choices); no dedicated combo resource — MENU-CATALOGUE.md
- **Category management (add / edit / sort / delete)** — LIVE — `POST /categories`, `PATCH /categories/{categoryId}` (`sortOrder`), `DELETE /categories/{categoryId}` (empty only, `CATEGORY_NOT_EMPTY`); `ProductCategory`: `name` ≤80, `sortOrder`, `imageUrl`, `active` — MENU-CATALOGUE.md
- **Product videos** — LIVE — `videoUrl` on `CatalogueItem` (uri, nullable; upload via pre-signed URL pattern) — MENU-CATALOGUE.md
- **Product assistant (AI copy)** — PLANNED — M7e contract addition; card hidden until it ships (AI-AUTOMATION.md)
- **Multi-store product templates & menu sync** — LIVE — `/product-templates` CRUD + `POST /product-templates/{templateId}/apply` (`storeIds`, `overwritePrices`) — MULTI-STORE.md, MENU-CATALOGUE.md
- **Product operation log** — LIVE — `GET /catalogue-items/{itemId}/logs` (`{at, actor, action, before, after}[]`, e.g. `price.updated`) — MENU-CATALOGUE.md
- **Bulk catalogue operations** — LIVE — `POST /catalogue-items/bulk` (max 500), `POST /catalogues/import`, `GET /catalogues/export` — MENU-CATALOGUE.md

## 3. Store & Operations

- **Store info settings** — LIVE — `GET/PATCH /merchants/me` (`MerchantUpdate` now carries `address` ≤300 and `contactPhone`) — STORE-MANAGEMENT.md
- **Open / close store** — LIVE — `isOpen` via `PATCH /merchants/me` and `PUT /merchants/me/settings`; `ORDER_MERCHANT_CLOSED` blocks new orders — STORE-MANAGEMENT.md
- **Store decoration** — LIVE — `coverImageUrl`, `recommendedItemIds`, `announcement` on `StoreSettings` — STORE-MANAGEMENT.md
- **Closure protection** — LIVE — `POST /merchants/me/closure-protection` (`active`, `reason`, `until`; `penaltyExempt`) — STORE-MANAGEMENT.md
- **Multi-store management** — LIVE — `GET /merchants/me/stores`, `PATCH /merchants/me/stores/{storeId}` (`ChainStore`) — MULTI-STORE.md
- **Operating settings** — LIVE — `businessHours` (per `dayOfWeek`, `open`, `close`, `closed`), `acceptanceMethod` (manual/auto), `phoneOrderingHours`, `orderNotificationChannels` on `StoreSettings` — STORE-MANAGEMENT.md, SETTINGS.md
- **Payment account (payout)** — LIVE — `GET /merchants/me/payout-account` (masked `PayoutAccount`), `PUT /merchants/me/payout-account` (`PayoutAccountWrite`, verification required; `PAYOUT_ACCOUNT_VERIFICATION_REQUIRED`; `payout_account.verified` event) — STORE-MANAGEMENT.md
- **Receipt template** — LIVE — `printSettings.receiptTemplate` (`headerText` ≤200, `footerText` ≤200, `showLogo`) — STORE-MANAGEMENT.md
- **Payment method settings** — LIVE — `StoreSettings.acceptedPaymentMethods` enum `[mpesa, tigo_pesa, airtel_money, card, cod]` — STORE-MANAGEMENT.md
- **Printer settings** — LIVE — `printSettings` (`autoPrint`, `copies` 1–5, `labelPrinter`) + device registry (`/devices`) — STORE-MANAGEMENT.md, STAFF-AND-DEVICES.md
- **Delivery settings** — LIVE — `StoreSettings.deliverySettings` (`radiusKm`, `deliveryFeeTZS`, `minimumOrderTZS`, `sameDayCutoff`) — STORE-MANAGEMENT.md
- **Tables / QR / dual-screen POS** — LIVE — `/dine-in/tables` CRUD, `GET /dine-in/tables/{tableId}/qr`, dine-in orders + bills — DINE-IN.md
- **Compliance status** — LIVE — `VerificationState` badge + per-document status from `GET /merchants/me`; gates catalogue/orders/earnings — ONBOARDING.md

## 4. Financial Management

- **Reconciliation** — LIVE — ledger statement vs wallet projection; dashboard-to-ledger totals match (backend M7e exit criterion) — EARNINGS.md, PAYMENTS.md
- **Settlement** — LIVE — `order_earning` created only after `completed`; `commission` deducted at settlement — EARNINGS.md, PAYMENTS.md
- **Payout history** — LIVE — `GET /payouts/me` (statuses `pending`/`processing`/`paid`/`failed`/`exception`) — EARNINGS.md
- **Ledger statement** — LIVE — `GET /payouts/me/statement?from&to` (`LedgerStatement` entries, immutable) — EARNINGS.md
- **Balance / wallet** — LIVE — `GET /wallet` (`withdrawableTZS`, `pendingTZS`, `totalTZS`; projection of the ledger) — EARNINGS.md
- **Withdraw** — LIVE — `POST /wallet/withdrawals` (`amountTZS`; `WITHDRAWAL_BELOW_MINIMUM`, `WITHDRAWAL_RATE_LIMITED`, `WALLET_INSUFFICIENT_BALANCE`) — EARNINGS.md
- **Wallet transactions** — LIVE — `GET /wallet/transactions` (`WalletTransaction.type` enum, signed `amountTZS`) — EARNINGS.md
- **Revenue composition** — LIVE — `GET /analytics/revenue?from&to` (`byChannel[]`: `delivery`/`dine_in`/`group_buy`/`pickup`) — EARNINGS.md, ANALYTICS.md

## 5. Customer & Review

- **View reviews** — LIVE — `GET /reviews/me?targetType=merchant` (`ReviewDetail[]`; counts via `MerchantPublic.rating`, `reviewCount`) — MESSAGES.md
- **Reply to review** — LIVE — `POST /reviews/{reviewId}/reply` (`body` 1–1000; one per review) — MESSAGES.md
- **Modify review reply** — LIVE — `PATCH /reviews/{reviewId}/reply` (edit own reply; edits audited server-side) — MESSAGES.md
- **Report review** — LIVE — `POST /reviews/{reviewId}/report` (`reason` ≤300) — MESSAGES.md
- **Review analytics** — LIVE — `GET /analytics/reviews?from&to` (`ratingAverage`, `reviewCount`, `replyRate`, `trendByDay[]`) — ANALYTICS.md
- **Customer conversations** — LIVE — `/conversations` list/detail/messages, unread count, archive/block — MESSAGES.md
- **Customer segments + journeys (CRM)** — LIVE — `POST /segments` (rules, `memberCount`), `/journeys` (trigger → delayed actions) — CRM.md
- **Cross-platform review sync** — N/A — single platform in v1; partner-platform review sync PLANNED via integrations/webhooks (INTEGRATIONS-WEBHOOKS.md)

## 6. Marketing & Promotion

- **Promotion campaigns** — LIVE — `/promotions` (types `discount`, `spend_based`; lifecycle draft → pending_review → live → paused/rejected/ended) — PROMOTIONS.md
- **Instant discount** — LIVE — promotion type `instant_discount` — PROMOTIONS.md, NAVIGATION.md
- **Coupon campaigns** — LIVE — `POST /coupons` (statuses, `coupon.claimed` digest, `coupon_cost` ledger) — PROMOTIONS.md
- **Bargain** — LIVE — promotion type `bargain` — PROMOTIONS.md
- **Group buy deals** — LIVE — `/group-buys` (deal lifecycle, `group_buy.moderated`, `group_buy.sold`) — GROUP-BUY.md
- **Campaign performance monitoring** — LIVE — `GET /promotions/{promotionId}/performance` (`impressions`, `redeemCount`, `spendTZS`, `attributedRevenueTZS`, `roiPercent`) — PROMOTIONS.md
- **Self-service design (creative/banner)** — PLANNED — contract addition, M7c — PROMOTIONS.md, ROADMAP.md
- **Paid traffic (DianJin PPC, brand display, traffic campaigns)** — PLANNED — contract additions, M7c — ROADMAP.md

## 7. Data Analytics

- **Real-time dashboard** — LIVE — `GET /analytics/dashboard` (`today` tiles, `live` strip) — ANALYTICS.md
- **Business / traffic analysis** — LIVE — `GET /analytics/traffic?from&to` (`byChannel[]` incl. search/category/promotion/group_buy/dine_in_qr) — ANALYTICS.md
- **Industry benchmarks + store score** — LIVE — `GET /analytics/benchmarks` (`merchantScore` 0–100, `percentileRank`, `metrics[]`) — ANALYTICS.md
- **Product performance / dish sales** — LIVE — `GET /analytics/products?from&to` (`unitsSold`, `revenueTZS`, `availabilityRate`) — ANALYTICS.md
- **Revenue analytics + composition** — LIVE — `GET /analytics/revenue?from&to` (`totalTZS`, `byChannel[]`) — ANALYTICS.md
- **Order analytics** — LIVE — dashboard `today.orderCount` + export `reportType: orders` — ANALYTICS.md
- **Market analysis** — LIVE — `GET /analytics/market?category&cityId` (`demandIndex`, `trend` growing/stable/declining, `topSearches[]`, `competitorCount`, `suggestedPriceBandTZS`) — ANALYTICS.md
- **Multi-store inspection** — LIVE — `GET /chain/analytics?from&to` (cross-store performance) — MULTI-STORE.md, ANALYTICS.md
- **AI diagnostics** — PLANNED — `GET /analytics/diagnostics` contract-defined, not built until M7e; card shows "coming in a later release" — ANALYTICS.md, AI-AUTOMATION.md
- **Report downloads** — LIVE — `POST /analytics/reports/export` (`reportType`, `downloadUrl` + `expiresInSeconds`; permissioned + audited) — ANALYTICS.md

## 8. Account & Registration

- **Free store opening** — LIVE — `POST /merchants` (`MerchantApplication` → `LeadCreated`) — ONBOARDING.md
- **Store claiming** — LIVE — `POST /merchants/claim` (`MerchantClaim`: `merchantId`, `contactPhone`, `documentsNote` ≤500; 409 `CLAIM_ALREADY_PENDING`/`CLAIM_LISTING_NOT_FOUND`/`CLAIM_LISTING_OWNED`; leads to verification flow) — ONBOARDING.md
- **Login** — LIVE — `POST /auth/request-otp` + `POST /auth/verify-otp` (role-scoped session; role switch via `GET /users/me/roles` + re-verify) — ONBOARDING.md, SECURITY.md
- **Account recovery** — LIVE — OTP with `purpose: password_reset` — ONBOARDING.md
- **Qualification upload** — LIVE — document upload + per-document status (`missing`/`pending`/`approved`/`rejected`); `VerificationState` gate — ONBOARDING.md
- **Multi-store account** — LIVE — `/merchants/me/stores`; `MerchantStaff.storeId` scopes chain staff to a store — MULTI-STORE.md, STAFF-AND-DEVICES.md

## 9. Coupon & Voucher

- **Manual voucher verify** — LIVE — `POST /vouchers/{voucherCode}/verify` (200 redeemed / 409 `VOUCHER_ALREADY_USED`) — GROUP-BUY.md
- **QR voucher verify** — LIVE — QR scan path to the same verify endpoint — GROUP-BUY.md
- **Verify history** — LIVE — `GET /vouchers/verify-history` — GROUP-BUY.md
- **Voucher extend / re-list** — LIVE — group buy voucher extension and re-list after sellout — GROUP-BUY.md

## 10. Group Buy & Dine-In

- **Group buy deal creation** — LIVE — `POST /group-buys` (draft → pending_review) — GROUP-BUY.md
- **Deal lifecycle management** — LIVE — list/detail, extend, delist, re-list; `group_buy.moderated` / `group_buy.sold` — GROUP-BUY.md
- **Dine-in tables** — LIVE — `/dine-in/tables` CRUD (`DINE_IN_TABLE_IN_USE`) — DINE-IN.md
- **Table QR ordering** — LIVE — `GET /dine-in/tables/{tableId}/qr` (`qrPayload`, `menuUrl`; customer opens `POST /dine-in/orders`) — DINE-IN.md
- **Dine-in bills + dual-screen POS** — LIVE — bill lifecycle open → billing → paid → closed; confirm payment via cashier/terminal — DINE-IN.md
- **Reservations** — LIVE — `/reservations` (requested → confirmed; reminders) — DINE-IN.md

## 11. Membership & Loyalty

- **Member management** — LIVE — `/members` (add via `MEMBER_PHONE_EXISTS` guard) — MEMBERSHIP-LOYALTY.md
- **Top-up rewards** — LIVE — top-ups with bonus (cashier quick action; `TOP_UP_BELOW_THRESHOLD`) — MEMBERSHIP-LOYALTY.md
- **Membership tiers** — LIVE — `/membership-tiers` — MEMBERSHIP-LOYALTY.md
- **Member transactions** — LIVE — member balance/transaction history — MEMBERSHIP-LOYALTY.md

## 12. Education & Training

- **Marketing academy** — PLANNED — content surface, no contract endpoint; plan in EDUCATION-SUPPORT.md
- **Operation tips** — PLANNED — content surface, EDUCATION-SUPPORT.md
- **Courses / enterprise training** — PLANNED — education program with enterprise onboarding, EDUCATION-SUPPORT.md

## 13. Staff & Team

- **Staff management** — LIVE — `/merchants/me/staff` CRUD (roles owner/manager/cashier/kitchen/waiter; `STAFF_LAST_OWNER` guard) — STAFF-AND-DEVICES.md
- **Permissions** — LIVE — `permissions[]` scope strings server-served; `STAFF_ROLE_FORBIDDEN` — STAFF-AND-DEVICES.md
- **Cashier scope** — LIVE — dine-in billing, voucher verify, COD recording (no order accept unless granted) — STAFF-AND-DEVICES.md
- **Shifts** — LIVE — `/staff/shifts` (`SHIFT_OVERLAP`); swap PLANNED (contract addition) — ENTERPRISE-STAFF.md
- **Attendance** — LIVE — `/staff/attendance/clock-in`, `/clock-out`, `/staff/attendance` — ENTERPRISE-STAFF.md
- **Performance + commissions** — LIVE — `GET /staff/performance`, `/staff/commissions` (`per_order`/`per_service`/`per_revenue`, `rateBps`); bonus payouts PLANNED — ENTERPRISE-STAFF.md
- **Approval workflow** — LIVE — `/approvals` (price change, promotion, refund above threshold, inventory adjustment, staff role change, bulk operation) — ENTERPRISE-STAFF.md

## 14. System Settings

- **Order notification settings** — LIVE — `GET/PUT /notifications/me/order-settings` (`voiceAlerts`, `channels[]`, `quietHours`, `autoAcceptWithinSeconds` 30–300) + `GET/PUT /notifications/me/preferences` (`PREFERENCE_INVALID_EVENT`) — SETTINGS.md
- **Acceptance method** — LIVE — `acceptanceMethod` manual/auto (syncs `OrderAlertSettings` + `StoreSettings`) — SETTINGS.md
- **Phone ordering hours** — LIVE — `phoneOrderingHours` (`enabled`, `open`, `close`) — SETTINGS.md
- **Special rules** — LIVE — `StoreSettings.specialRules` free text ≤1000 (custom business rules) — SETTINGS.md, STORE-MANAGEMENT.md
- **Announcement** — LIVE — `StoreSettings.announcement` ≤500 — STORE-MANAGEMENT.md
- **Message & ringtone** — LIVE — `voiceAlerts` server-side; ringtone selection is device-local on mobile (no contract field) — SETTINGS.md
- **Print settings** — LIVE — `printSettings` (`autoPrint`, `copies` 1–5, `labelPrinter`, `receiptTemplate`) — STORE-MANAGEMENT.md
- **Language** — LIVE — `locale` enum `en`/`sw`/`ar` via `PATCH /users/me`; Chinese (zh) PLANNED — SETTINGS.md, LOCALIZATION.md

## 15. Feedback & Support

- **Support tickets** — LIVE — `POST /support/tickets`, `GET /support/tickets/me`, `GET /support/tickets/{ticketId}`, `POST /support/tickets/{ticketId}/messages` — EDUCATION-SUPPORT.md
- **Feedback via tickets** — LIVE — feedback enters through the ticket flow; a dedicated feedback endpoint is PLANNED (proposed contract addition) — EDUCATION-SUPPORT.md
- **Business manager** — PLANNED — service delivery around `ChainAccountAdmin.accountManager`; not a merchant-surface feature yet — EDUCATION-SUPPORT.md
- **Service center + FAQs** — PLANNED — content surfaces, EDUCATION-SUPPORT.md

## 16. Additional Tools

- **Quick actions dashboard** — LIVE — mobile home switches (open/close, acceptance, voice alerts, holiday pause, print) — SETTINGS.md
- **Business recommendations** — PLANNED — AI diagnostics (`GET /analytics/diagnostics`), M7e — ANALYTICS.md
- **Multi-currency** — OUT OF SCOPE — v1 is TZS integer minor units only (LOCALIZATION.md, PAYMENTS.md)
- **Fixed-amount collection QR** — LIVE — `POST /payments/qr` with `amountTZS` set (provider `mpesa`/`tigo_pesa`/`airtel_money`) — EARNINGS.md
- **Variable-amount collection QR** — LIVE — `POST /payments/qr` with `amountTZS: null`; expiry `PAYMENT_QR_EXPIRED` — EARNINGS.md
- **Order payment push** — LIVE — order lifecycle notifications (`order.created`, `order.paid`, `refund.processed`, `payout.paid`) — MESSAGES.md, NOTIFICATIONS.md
- **Terminal / device management** — LIVE — `/devices` registry (printer, pos, kitchen_display, cashier_terminal; `DEVICE_OFFLINE`) — STAFF-AND-DEVICES.md
- **Merchant data overview + export** — LIVE — dashboard, statement, `POST /data/exports` (permissioned + audited) — ANALYTICS.md, SECURITY.md

## Total count

| # | Section | Live | Planned | N/A / Out of scope | Total |
| --- | --- | --- | --- | --- | --- |
| 1 | Order Management | 10 | 0 | 0 | 10 |
| 2 | Product Management | 12 | 1 | 0 | 13 |
| 3 | Store & Operations | 13 | 0 | 0 | 13 |
| 4 | Financial Management | 8 | 0 | 0 | 8 |
| 5 | Customer & Review | 7 | 0 | 1 | 8 |
| 6 | Marketing & Promotion | 6 | 2 | 0 | 8 |
| 7 | Data Analytics | 9 | 1 | 0 | 10 |
| 8 | Account & Registration | 6 | 0 | 0 | 6 |
| 9 | Coupon & Voucher | 4 | 0 | 0 | 4 |
| 10 | Group Buy & Dine-In | 6 | 0 | 0 | 6 |
| 11 | Membership & Loyalty | 4 | 0 | 0 | 4 |
| 12 | Education & Training | 0 | 3 | 0 | 3 |
| 13 | Staff & Team | 7 | 0 | 0 | 7 |
| 14 | System Settings | 8 | 0 | 0 | 8 |
| 15 | Feedback & Support | 2 | 2 | 0 | 4 |
| 16 | Additional Tools | 6 | 1 | 1 | 8 |
|  | **Total** | **108** | **10** | **2** | **120** |

## Reference-app operations (from docs/REFERENCE-SURVEY.md)

All rows are LIVE in `backend/API-CONTRACT.yaml` (survey verified 84/84 features present).

| Feature | Endpoint(s) | Doc |
| --- | --- | --- |
| Order search | `GET /orders/search` | ORDER-FLOW.md |
| Enterprise (B2B) orders | `GET /orders/enterprise` | ORDER-FLOW.md |
| Rush queue + merchant reply | `GET /orders/rush`, `POST /orders/{id}/rush-reply` | ORDER-FLOW.md |
| Order timeline | `GET /orders/{id}/timeline` | ORDER-FLOW.md |
| Batch accept/reject | `POST /orders/batch/accept`, `/orders/batch/reject` | ORDER-FLOW.md |
| Food damage claims | `POST /orders/{id}/damage` | ORDER-FLOW.md |
| Reason catalogs | `GET /orders/reject-reasons`, `GET /refunds/reasons` | ORDER-FLOW.md |
| Refund request queue | `GET /refunds`, `POST /refunds/{id}/approve|reject` | ORDER-FLOW.md |
| Receipt reprint list | `GET /orders/receipts` | ORDER-FLOW.md |
| Barcode subsystem | `/barcodes/formats`, `POST /products/{id}/barcode/generate`, `GET /products/{id}/barcodes`, `GET /barcodes/{code}`, `GET /barcodes/{code}/history`, `POST /barcodes/batch` | MENU-CATALOGUE.md |
| Combo meals | `/combos` CRUD | MENU-CATALOGUE.md |
| Multi-store menus | `/menus` CRUD | MENU-CATALOGUE.md |
| Product videos | `/videos` CRUD | MENU-CATALOGUE.md |
| AI product assistant | `/products/assistant/suggestions`, `/products/assistant/apply` | MENU-CATALOGUE.md |
| Tasks center | `/tasks` (+ anomalies, violations, activities, setup-guide) | TASKS-RISK.md |
| Risk events | `/risk/events`, `POST /risk/{id}/review` | TASKS-RISK.md |
| Merchant audit view | `GET /audit/me` | TASKS-RISK.md |
| Change password | `POST /auth/change-password` | PRIVACY-ACCOUNT.md |
| Session management | `GET /sessions`, `POST /sessions/{token}/revoke` | PRIVACY-ACCOUNT.md |
| Privacy export / deletion | `POST /privacy/export`, `POST /privacy/delete` | PRIVACY-ACCOUNT.md |
| Onboarding wizard | `/onboarding/status`, `/profile`, `/docs`, `/submit` | ONBOARDING.md |
| Platform announcements | `GET /announcements` | SETTINGS.md |
| Client error reporting | `POST /monitoring/errors` | TASKS-RISK.md |
| Bank cards | `/finance/bank-cards` (+ default) | EARNINGS.md |
| Invoices | `/finance/invoices` (+ issue, download) | EARNINGS.md |
| Daily settlements + manual run/payout | `/finance/settlements/daily`, `run`, `{id}/payout` | EARNINGS.md |
| Reconciliation summary | `GET /finance/reconciliation` | EARNINGS.md |
| Platform events + enroll | `/marketing/platform-events`, `POST .../{eventId}/enroll` | PROMOTIONS.md |
| Flash sales | `/marketing/flash-sales` CRUD | PROMOTIONS.md |
| Coupon verify + stats | `POST /marketing/coupons/verify`, `GET /marketing/coupons/{id}/stats` | PROMOTIONS.md |
| Precision marketing | `/marketing/precision`, `POST .../{campaignId}/send` | PROMOTIONS.md |
| DianJin PPC | `/marketing/dianjin`, `PATCH .../{campaignId}/toggle` | PROMOTIONS.md |
| Brand display | `/marketing/brand-display` | PROMOTIONS.md |
| Self-service promotion | `/marketing/self-service` | PROMOTIONS.md |
| Kitchen camera | `GET/PATCH /store/kitchen-camera` | STORE-MANAGEMENT.md |
| Qualifications | `/store/qualifications` | STORE-MANAGEMENT.md |
| Store QR codes | `/store/qr-codes` | STORE-MANAGEMENT.md |
| Receipt templates | `/store/receipt-templates` (+ activate) | STORE-MANAGEMENT.md |
| Store payment accounts | `/store/payment-accounts` | STORE-MANAGEMENT.md |
| Self-pickup | `GET/PUT /store/self-pickup` | STORE-MANAGEMENT.md |
| Compliance recheck | `POST /store/compliance/recheck` | STORE-MANAGEMENT.md |
| Store logs | `GET /store/logs` | STORE-MANAGEMENT.md |
| Hourly trends | `GET /analytics/hourly-trends` | ANALYTICS.md |
| Traffic funnel | `GET /analytics/funnel` | ANALYTICS.md |
| Store score | `GET /analytics/store-score` | ANALYTICS.md |
| Order analytics | `GET /analytics/order-analytics` | ANALYTICS.md |
| Customer insights + distribution | `GET /analytics/customers`, `/analytics/customer-distribution` | ANALYTICS.md |
| Sales forecast | `GET /analytics/forecast` | ANALYTICS.md |
| Top dishes | `GET /analytics/top-dishes` | ANALYTICS.md |
| Payment methods / history / reversal | `GET /payments/methods`, `/payments/history`, `POST /payments/{intentId}/reverse` | EARNINGS.md |
| Assigned riders view | `GET /riders/assigned` | ORDER-FLOW.md |

Rule: when a checklist item is PLANNED, the referenced doc names the contract
addition and milestone — nothing on this matrix is silently absent.

## Round-2 deep survey (docs/REFERENCE-SURVEY.md — data models, screens)

Status key: **LIVE** (in `backend/API-CONTRACT.yaml` today) / **PLANNED** (reference-app capability, contract addition required — flagged in the doc).

| Capability | Contract path / field | Status | Doc |
| --- | --- | --- | --- |
| Order `version` + `expectedVersion` accept | `Order.version`; `POST /orders/{orderId}/accept` body `expectedVersion`; `VERSION_CONFLICT` | LIVE | ORDER-FLOW.md |
| Order identity/read state (`no`, `source`, `deadlineAt`, `seen`, `freeDelivery`, per-status timestamps, `rejectReasonCode`) | `Order.no/source/deadlineAt/seen/freeDelivery/acceptedAt/readyAt/completedAt/cancelledAt/settledAt/rejectReasonCode`; `POST /orders/{orderId}/seen`; `ORDER_AUTO_CANCELLED` | LIVE | ORDER-FLOW.md |
| Rush urgency tiers + ETA reply presets | UI convention over `createdAt`/`rushRequestedAt`/`deliveryEtaMin`; reply via `POST /orders/{orderId}/rush-reply` | PLANNED (no urgency field) | ORDER-FLOW.md |
| Pre-order tabs Today/Upcoming/Past | `GET /orders/me/advance?date=` | LIVE (tabs are date queries) | ORDER-FLOW.md |
| Refund queue partial-amount approval | `GET /refunds`; `POST /refunds/{refundId}/approve|reject` (reason only) | PLANNED (no `amountTZS` on approve) | ORDER-FLOW.md |
| Product pricing/margin/stock-action/display (`originalPriceTZS`, `costTZS`, `zeroStockAction`, `sort`, `emoji`, `addons`, `comboItems`) | `CatalogueItem` fields | LIVE | MENU-CATALOGUE.md |
| Barcode formats ean8/code128/code39 + delete | `BarcodeFormat` enum; `DELETE /products/{itemId}/barcode/{code}` | LIVE | MENU-CATALOGUE.md |
| Product video status/views/duration | `ProductVideo` (no status/views/duration) | PLANNED | MENU-CATALOGUE.md |
| Product history change-type filter | `GET /catalogue-items/{itemId}/logs` (action dot-strings; no filter enum) | LIVE (client grouping) | MENU-CATALOGUE.md |
| Expense tracking | `GET/POST /finance/expenses`; `DELETE /finance/expenses/{expenseId}`; `ExpenseRecord.category` (10 values) | LIVE | EARNINGS.md |
| Transaction issue → ticket | `POST /finance/transactions/{transactionId}/issue` (`amount_mismatch`/`missing_items`/`other`) | LIVE | EARNINGS.md |
| Download receipt per transaction | `GET /orders/receipts` (reprint); finance-row download | PLANNED | EARNINGS.md |
| VAT line in settlements; T+1 note; withdraw fee + ETA; invoice type/taxId/taxRate | `DailySettlement`, `Withdrawal`, `Invoice` (no fields) | PLANNED | EARNINGS.md |
| Full 15-type promotion table + builder fields | `PromotionType` enum; `Promotion` typed fields (`couponAmountTZS`, `thresholdTZS`, `discountRateBps`, `target`, `productIds`, `groupBuyTargets`, `haggleEnabled`, `cpcTZS`) | LIVE | PROMOTIONS.md |
| Coupon kinds + max discount | `CouponCampaign.kind` percentage/fixed/shipping; `maxDiscountTZS` | LIVE | PROMOTIONS.md |
| Flash quantity limit; instant `maxUses`; bargain auto-accept/counter-offer | no fields | PLANNED | PROMOTIONS.md |
| Traffic ROI calculator; platform-event terms; self-service packages | calculator = client tool over `roiPercent`; events + enroll LIVE; packages | PLANNED (packages) | PROMOTIONS.md |
| Campaign performance impressions/clicks/attributedOrders/attributedRevenue + ROAS | `Promotion` fields; `PromotionPerformance`; `GET /analytics/marketing` | LIVE | PROMOTIONS.md |
| Store rank (current/previous/category/score) | `GET /analytics/store-score`, `/analytics/benchmarks`; rank deltas | PLANNED | STORE-MANAGEMENT.md |
| Scheduled reopen (30m/1h/2h/4h/Tomorrow) | server sweeper only | PLANNED | STORE-MANAGEMENT.md |
| Decoration fields (posterColor/posterText/sign/brandStory/tagline; featured ≤6) | `StoreSettings` (cover/announcement/recommendedItemIds) | PLANNED | STORE-MANAGEMENT.md |
| Delivery zones per-zone fee + perKmFee | `deliverySettings` flat block | PLANNED | STORE-MANAGEMENT.md |
| Self-pickup slots + ready notifications + instructions + discount | `SelfPickupConfig` (enabled/pickupReadyMinutes/pickupHours) | PLANNED | STORE-MANAGEMENT.md |
| Operating settings (preparationTime, maxOrdersPerHour, preOrderLeadTime, selfPickupDiscount) | no fields (`acceptanceMethod`/`autoAcceptWithinSeconds` related) | PLANNED | STORE-MANAGEMENT.md |
| Table zones + cleaning + qrToken/qrUrl/reservedUntil | `DineInTable` fields | LIVE | STORE-MANAGEMENT.md, DINE-IN.md |
| Kitchen camera details (recordingDuration, storageUsed, videoQuality, recentClips) | `KitchenCamera` (enabled/streamUrl/publicAccess/lastCheckedAt) | PLANNED | STORE-MANAGEMENT.md |
| Qualifications expiry + renew | `Qualification` (re-upload resets to `pending`) | PLANNED | STORE-MANAGEMENT.md |
| Receipt template 14 field toggles + paperSize/font/copies/logoEmoji | `ReceiptTemplate` | LIVE | STORE-MANAGEMENT.md |
| Payment account status pending/active/disabled | `StorePaymentAccount.verified` + `POST .../{accountId}/verify` | PLANNED (status enum) | STORE-MANAGEMENT.md |
| Quick payment request | `POST /payments/request` | LIVE | STORE-MANAGEMENT.md |
| Closure protection statuses + 15-day cap + reason picker | `ClosureProtection` status/maxDays/daysRemaining; reasons are UI chips | LIVE | STORE-MANAGEMENT.md |
| Customer LTV/churn/frequency; segments VIP/Regular/At-Risk/Lost; distance-band distribution | `GET /analytics/customers`; `/segments`; `customer-distribution` (area-based) | PLANNED (extras) | ANALYTICS.md |
| Funnel incl. carts; benchmark radar + suggestions; product margin/satisfaction/addOnRate; order cancel/refund/delivery metrics; store-score history; diagnostic bundle; market size/price distribution; revenue splits by method/time; dish margin; weather forecast; 30-day report bundle | contract funnel (no `carts`), `BenchmarkSummary`, `ProductPerformance`, `order-analytics`, `store-score`, `diagnostics` (array form), `MarketAnalysis`, `revenue` (channel-only), `top-dishes`, `forecast`, `reports/export` | PLANNED (extras) | ANALYTICS.md |
| Task kinds + deep links; anomaly quick fix; violations fines + appeal; activity types/budget/reach; setup guide 8 steps; risk engine thresholds + types | `/tasks`, `TaskItem.kind`, `SetupStep.deepLink`, `/risk/events` + review, `RiskEvent.type` enum, DATA-MODEL sweeper thresholds | LIVE (fines/appeal/activity-type enums PLANNED) | TASKS-RISK.md |
| MerchantDevice purpose/paperSize/copies; StoreQrCode kinds incl. table/menu/feedback | `MerchantDevice`, `StoreQrCode` | LIVE | STAFF-AND-DEVICES.md, STORE-MANAGEMENT.md |
| Real-time events / offline queue / sweeper jobs | `GET /events`, `/api/ws`, offline queue, DATA-MODEL sweeper list | LIVE (backend) | ARCHITECTURE.md, DATA-MODEL.md |

## Behavioral rules (from the reference contract tests)

Server-enforced rules verified in `tests/contract.test.ts` and `src/mock/sweeper.ts`. Error codes are the HUDumika contract codes (`backend/ERROR-CODES.md`); statuses as asserted by the reference suite.

| Rule | Error code / signal | Doc |
| --- | --- | --- |
| Closed store rejects new orders | `STORE_CLOSED` (409) | ORDER-FLOW.md |
| `acceptWhileClosed` allows scheduled orders only | `STORE_CLOSED` (409) | STORE-MANAGEMENT.md |
| Subtotal below minimum order | `BELOW_MIN_ORDER` (409) | ORDER-FLOW.md |
| Pre-orders disabled + `scheduledAt` | `PREORDERS_DISABLED` (409) | ORDER-FLOW.md |
| `requireNotes: required` without note | `NOTE_REQUIRED` (400) | STORE-MANAGEMENT.md |
| Overdue order auto-cancel (sweeper) | reason code `AUTO_CANCEL` + real, idempotent refund | ORDER-FLOW.md |
| Accept stock decrement exactly once | idempotency key | ORDER-FLOW.md |
| Insufficient stock on accept | `INSUFFICIENT_STOCK` (409) | ORDER-FLOW.md |
| Invalid state move | `INVALID_TRANSITION` (409) | ORDER-FLOW.md |
| Refund amount over total clamped; zero rejected | clamp to total / 400 | ORDER-FLOW.md |
| Refund on cancelled order | `ORDER_CANCELLED` (409) | ORDER-FLOW.md |
| Refund decide before capture | `PAYMENT_NOT_CAPTURED` (409) | ORDER-FLOW.md |
| Refund decide / reject idempotent | single ledger debit / single record | ORDER-FLOW.md |
| Rush within cooldown | `rushCooldownMinutes` — deadline unchanged | ORDER-FLOW.md |
| Rush on completed order | `INVALID_TRANSITION` (409) | ORDER-FLOW.md |
| Reject honesty wording | un-captured: no charge; captured: refunded | ORDER-FLOW.md |
| Pre-order reminder (once, <=15 min) | `preOrderReminderSent` | ORDER-FLOW.md |
| Stale `expectedVersion` | `VERSION_CONFLICT` (409) | ORDER-FLOW.md |
| Free delivery above threshold | `freeDelivery` (fee waived) | ORDER-FLOW.md |
| Equal open/close hours | `HOURS_INVALID` (400) | STORE-MANAGEMENT.md |
| Closure annual quota | `CLOSURE_ANNUAL_QUOTA` (409) | STORE-MANAGEMENT.md |
| Scheduled reopen past timestamp / blocked by protection | `INVALID_REOPEN` (400) / sweeper cancel | STORE-MANAGEMENT.md |
| Un-default the last payment account | `LAST_DEFAULT` (409) | STORE-MANAGEMENT.md |
| Delete in-use receipt template | `RECEIPT_TEMPLATE_IN_USE` (409) | STORE-MANAGEMENT.md |
| Blank review reply | `EMPTY_REPLY` (400) | MESSAGES.md |
| Product create / variants validation | `NAME_REQUIRED` / `INVALID_PRICE` / `INVALID_CATEGORY` / `INVALID_VIDEO_URL` / `INVALID_COMBO` / `INVALID_VARIANTS` (400) | MENU-CATALOGUE.md |
| Bulk stock adjust clamped at 0 | `set` / `delta` | MENU-CATALOGUE.md |
| In-use category delete blocked | 409 (`CATEGORY_NOT_EMPTY`; reference `PRODUCTS_ASSIGNED`) | MENU-CATALOGUE.md |
| Campaign validation (group buy / cpc / discount) | `INVALID_GROUP_BUY` / `INVALID_CPC` / `INVALID_DISCOUNT` (400) | PROMOTIONS.md |
| Campaign attribution + sweeper ticks | orders / revenue / ROAS; impressions / clicks / spend | PROMOTIONS.md |
| Risk engine thresholds | `refund-ratio` / `refund-velocity` / `large-refund` / `withdrawal-anomaly` | TASKS-RISK.md |

