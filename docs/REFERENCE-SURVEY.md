# Reference Implementation Survey — `~/Desktop/step` + `~/Desktop/step1`

Intensive survey of the working merchant-app reference implementations. Two surfaces:

1. `step1/merchant-app` — React Native (App.js, React Navigation) merchant app, ~130 screens, MSW mocks, Maestro E2E flows, i18n (en/am), barcode scanning, payment providers (M-Pesa, Tigo Pesa, Airtel, EzyPesa, Halotel, bank).
2. `step` — Expo (SDK 57, expo-router, zustand, MSW, Playwright) merchant app, ~60 routes, tabs: dashboard, marketing, orders, products, store, profile; live dashboards (risk, audit, finance, IM, coupons, reviews, support).

## Verification result (Aug 2026)

Re-survey after doc/contract expansion:

- Reference endpoints extracted from both apps' MSW handlers: **274 unique**.
- Covered by `backend/API-CONTRACT.yaml` directly: all, after alias mapping — **0 uncovered** (contract now 303 paths, 173 schemas).
- Alias mapping (reference name → contract name) recorded in the automated check (e.g. `/chat/threads` → `/conversations`, `/campaigns` → `/promotions`, `/products/categories` → `/categories`, provider `/payments/mpesa/initialize` → `/payments/intent`, `/store/*` → `/merchants/me/*` or `/store/*` equivalents).
- Every endpoint referenced in team docs resolves to the contract (validated).

## Round-2 deep survey (data models, screens, infrastructure) — Aug 2026

### New data-model capabilities found (all now in the contract)

| Capability | Reference source | Contract home |
| --- | --- | --- |
| Order `version` + `expectedVersion` optimistic concurrency (`VERSION_CONFLICT`) | step types + orders store | Order schema, /orders/{id}/accept, ERROR-CODES |
| Order `no`, `source` (app/web/phone/pos), `deadlineAt`, `seen`, `freeDelivery`, timestamps acceptedAt/readyAt/completedAt/cancelledAt/settledAt, `rejectReasonCode` | step1 mockData ORDERS + step OrderDto | Order schema |
| Product `originalPriceTZS`, `costTZS` (margin), `zeroStockAction` (hide/show_sold_out), `sort`, `emoji`, `addons[]`, `comboItems[]` | step ProductRow + editor | CatalogueItem schema |
| Barcode formats ean8/code128/code39 (was ean13/upca/qr) + delete-barcode | step1 products.js | BarcodeFormat, /products/{itemId}/barcode/{code} DELETE |
| Campaign types: full_reduction, new_customer, free_delivery, flash, featured, ppc, brand, group_buy, haggle | step CampaignType (13 types) | PromotionType |
| Campaign fields: couponAmountTZS, thresholdTZS, discountRateBps, target (all/new/returning/segment), productIds, groupBuyTargets, haggleEnabled, cpcTZS, impressions/clicks/attributedOrders/attributedRevenue | step Campaign + builder | Promotion schema |
| Coupon kinds percentage/fixed/shipping + maxDiscount | step1 CouponManagement | CouponCampaign schema |
| Quick payment request (merchant → customer phone) | step1 PaymentMethodsScreen | POST /payments/request |
| Expense tracking (ingredients/delivery/packaging/fees/…) + report-transaction-issue | step1 FinanceScreen/TransactionDetail | /finance/expenses, /finance/transactions/{id}/issue |
| Closure protection statuses pending/approved/completed/cancelled/rejected + maxDays 15 | step1 ClosureProtectionScreen | ClosureProtection schema |
| Table `zone`, status idle/occupied/reserved/cleaning, qrToken/qrUrl, reservedUntil, disabled | step TableRow + step1 TableManagement | DineInTable schema |
| Receipt template: 13 field toggles + paperSize/font/copies/logoEmoji/cashierName | step1 ReceiptTemplateScreen | ReceiptTemplate schema |
| Printer purpose receipt/kitchen, paperSize, copies, status pairing | step Printer + step1 PrinterSetup | MerchantDevice schema |
| Store QR kinds: ordering/table/menu/collection/feedback/download/review | step1 QRCodeOrdering | StoreQrCode schema |
| Risk event types refund_ratio/refund_velocity/large_refund/withdrawal_anomaly/login_risk | step RiskEvent | RiskEvent schema |

### Real-time / offline / background architecture (now documented in backend)

- Server event stream: long-poll `GET /events?after=` + WebSocket `/api/ws`, shared cross-tab log, dispatcher merges both.
- Offline mutation queue (cap 200, FIFO replay, drop-on-409/404/403, retry-on-5xx) with idempotency keys.
- Optimistic order mutations with version-conflict retry.
- Sweeper jobs: rush auto-flag (4.5 min), auto-accept, pre-order reminder (15 min), auto-cancel+idempotent refund, campaign ticks, boost notices, onboarding auto-approval (staging), risk engine (refund ratio >15%/wk, velocity ≥3/h, large refund, withdrawal >80% balance, new-device login), closure expiry, scheduled reopen.
- Customer simulator with internal `x-internal-key` (orders/chat/refunds/rush) for E2E.
- RBAC permission names: owner `*`; manager orders:manage/accept, menu:manage, finance:view, redemption, campaigns:manage, team:manage, audit:view, support, store:manage, reviews:reply; staff orders:accept, redemption.

### Screen-level features verified (both apps) — see merchant/OPERATIONS-COVERAGE.md

Dashboard (revenue/pending/balance/quick actions/top products/peak hours/attention cards/live alerts),
Orders (status tabs+counts, filters by date/delivery-type/store, batch accept/reject/print, rush with urgency tiers + ETA reply, pre-orders Today/Upcoming/Past, enterprise, timeline 7-step, search, refunds queue with partial amounts, damage claims, reject/refund reason catalogs, receipts reprint),
Products (list/grid, sort, bulk list/unlist, low-stock banners, editor with emoji palette/variants/addons/combos/videos/zero-stock action, categories with sort, combos with savings %, menus with sync, templates apply-to-stores, videos processing status, assistant suggestions/describe, logs with before→after),
Marketing (13 campaign types, builder wizard, flash sales with countdown, instant discounts, coupons with kinds + verify + stats, bargain with auto-accept/counter-offer, group buy tiers, membership tiers with commission, precision with recommended actions, DianJin keywords/CPC, brand display placements + assets, traffic campaigns with ROI calculator, platform events with terms, self-service packages, analytics with ROAS),
Store (info/hours/decoration poster+brand story/delivery zones+perKmFee/self-pickup slots+discount/multi-store/kitchen camera/qualifications with expiry/table zones+cleaning/QR kinds/dual-screen KDS+pair/compliance score+recheck/closure protection 15-day/receipt templates 13 fields/payment accounts/operating settings incl prep time & max orders/hr/scheduled reopen),
Finance (balance/transactions+issue report/download receipt/settlements T+1/manual settlement/withdraw with fee rules+bank cards/invoices VAT+taxId/daily settlements/periodic payouts/reconciliation export/expenses/download center),
Analytics (business data/customer LTV+churn+freq/segments VIP-Regular-At-Risk-Lost/funnel 6 stages/benchmark radar+suggestions/product margin+satisfaction+addOnRate/distribution by distance/order analytics incl cancel+refund rates/hourly trends+revenue/store score history/diagnostic report health score+risk alerts/market analysis size+price bands/multi-store flags/revenue composition by channel+method+time-of-day/top dishes/forecast with weather),Tasks (anomalies fix-now, violations with fines+appeal, activities join, setup guide 8 steps, risk events review, audit view),
Messages (center with categories important/feature/campaign/marketing/im/system, chat with quick replies, announcements),
Account (2FA, biometric, login activity, sessions, privacy export/delete, change password, register wizard, language en/am or en/zh, currency display).

### Known quirks (reference apps — do not replicate)

- `HourlyRevenueScreen` calls `?date=undefined`; several screens are mock-only (endpoints exist but UI unwired); currency inconsistencies (ETB/TZS/USD mixed); China-market payment methods (WeChat/Alipay) — our market uses M-Pesa/Tigo/Airtel/EzyPesa/Halotel/bank.



## 1. Screen inventory (step1/merchant-app — 130 screens)

| Group | Screens |
| --- | --- |
| Auth/onboarding | Splash, Login, Register, StoreSetupWizard, StoreSetupGuide, Qualification, AccountSettings, SecuritySettings |
| Workbench | Dashboard (today's revenue, pending orders, balance, quick actions, new orders, top products), HourlyRevenue, HourlyTrends, RevenueDetail, StoreScore |
| Orders | Orders (filters), OrderDetail, OrderTimeline, PreOrders, EnterpriseOrders, RushOrder, BatchOrder, OrderSearch, FoodDamage, Refund, OrderAnalytics |
| Products | Products, ProductEditor, CategoryEditor, ComboMeal, VideoManagement, ProductAssistant, ProductTemplates, ProductHistory, MenuManagement, ProductPerformance, ProductReconciliation, Barcode, BarcodeScreen |
| Marketing | Marketing, CampaignBuilder, FlashSale, InstantDiscount, CouponManagement, CouponVerification, BargainCampaign, GroupBuy, Membership, PrecisionMarketing, DianJinPromotion, BrandDisplay, TrafficCampaign, PlatformEvents, SelfServicePromotion, MarketingAnalytics |
| Customers | Reviews, ReviewReply, ReviewAnalytics, PlatformReviewSync, CustomerAnalysis, CustomerSegment, CustomerDistribution, PrecisionMarketing |
| Finance | Finance, BalanceInquiry, TransactionList, TransactionDetail, Settlement, DailySettlement, PeriodicPayout, Withdraw, BankCards, InvoiceManagement, ProductReconciliation, DownloadCenter |
| Analytics | Analytics, BusinessData, TrafficFunnel, CompetitiveBenchmark, MarketAnalysis, CustomerInsights, RevenueComposition, DishSales, DiagnosticReport, MultiStoreInspection |
| Store ops | Store, StoreInfoEditor, StoreDecoration, StorePromotion, DeliverySettings, SelfPickup, BusinessHours, StoreStatus, MultiStore, KitchenCamera, StoreCompliance, DualScreenSettings, TableManagement, QRCodeOrdering, PaymentAccounts, PaymentMethods, ReceiptTemplate, PrinterSetup, OperatingSettings, ClosureProtection |
| Messages | MessageCenter, Chat, NotificationSettings, PlatformNotifications |
| Tasks | TasksDashboard, ProductAnomaly, StoreViolation, ActivitySubmission |
| Profile | Profile, StoreSettings, OrderSettings, PrinterSettings, Wallet, ContactManager, HelpSupport, About |

## 2. API surface (step1/merchant-app mocks — ~200 endpoints)

Key groups beyond our contract:
- **Auth**: `POST /auth/register`, `POST /auth/change-password`, `PUT /auth/profile`
- **Orders**: `GET /orders/search`, `GET /orders/enterprise`, `GET /orders/pre-orders`, `GET /orders/rush`, `GET /orders/:id/timeline`, `POST /orders/batch/accept|reject|print`, `POST /orders/:id/damage` (food damage claim), `PATCH /orders/:id/status`
- **Refunds**: `GET /refunds`, `POST /refunds/:id/approve|reject`
- **Products**: `GET /products/barcode/:barcode`, `POST /products/:id/barcode/generate`, `GET /products/:id/barcodes`, `GET /products/barcode/formats`, `POST /products/barcode/batch`, `GET /products/:id/history`, `POST /products/bulk-update`, `GET/POST/PUT/DELETE /products/combo-meals`, `GET/POST/PUT/DELETE /products/menus`, `GET/POST/DELETE /products/videos`, `PUT /products/:id/specs`, `GET /products/templates`, `POST /products/templates/:id/apply`
- **Analytics**: `GET /analytics/dashboard`, `/analytics/hourly-revenue`, `/analytics/hourly-trends`, `/analytics/traffic-funnel`, `/analytics/competitive-benchmark`, `/analytics/market-analysis`, `/analytics/customer-distribution`, `/analytics/customer-segments`, `/analytics/order-analytics`, `/analytics/product-performance`, `/analytics/dish-sales`, `/analytics/revenue-composition`, `/analytics/store-score`, `/analytics/multi-store`, `/analytics/marketing`, `/analytics/diagnostic-report`, `/analytics/reports/:type/download`, `/analytics/customers`
- **Marketing**: `GET/POST /marketing/campaigns`, `PUT /marketing/campaigns/:id`, `POST /marketing/campaigns/:id/pause`, `/marketing/flash-sales`, `/marketing/instant-discounts`, `/marketing/bargain-campaigns`, `/marketing/coupons`, `/marketing/coupons/:id/stats`, `POST /marketing/coupons/verify`, `/marketing/membership`, `/marketing/precision`, `POST /marketing/precision/:segmentId/send`, `/marketing/dianjin` + toggle, `/marketing/brand-display`, `/marketing/traffic-campaigns/:id/enroll`, `/marketing/events`, `/marketing/self-service` + toggle, `/marketing/group-buy`
- **Finance**: `GET /finance/revenue`, `GET /finance/revenue/:date`, `GET /finance/settlements`, `GET /finance/daily-settlements`, `GET /finance/periodic-payouts`, `GET /finance/transactions`, `GET /finance/bank-cards` + POST + DELETE + PUT default, `GET /finance/invoices` + download, `GET /finance/reconciliation`, `POST /finance/withdraw`, `POST /finance/reports/:type`
- **Payments (provider-level)**: `POST /payments/mpesa|tigopesa|airtel|ezypesa|halotel/initialize`, `GET /payments/*/status/:reference`, `POST /payments/*/reverse`, `POST /payments/bank/transfer`, `POST /payments/:id/refund`, `GET /payments/methods`, `GET /payments/history`, `GET /payments/settlement`
- **Store**: `GET/PUT /store`, `PUT /store/hours`, `PUT /store/decoration`, `GET/PUT /store/delivery-config`, `PUT /store/delivery`, `GET/PUT /store/operating-settings`, `GET /store/qualifications` + POST, `GET /store/compliance`, `GET/POST /store/kitchen-camera` + PATCH, `GET/POST /store/payment-accounts` + DELETE, `GET /store/receipt-templates` + POST/PUT/DELETE, `GET/POST /store/qr-codes` + DELETE, `GET/POST/PUT/DELETE /store/staff`, `GET/POST/PUT/DELETE /store/tables` + PATCH status, `GET /store/dual-screen` + PUT, `GET /store/multi-store`, `POST /store/closure-protection` + DELETE, `GET /store/promotions` + POST
- **Messages**: `GET /messages`, `GET /messages/announcements`, `GET /messages/conversations`, `POST /messages/:id`, `PATCH /messages/:id/read`
- **Reviews**: `GET /reviews`, `GET /reviews/stats`, `POST /reviews/:id/reply`
- **Tasks**: `GET /tasks`, `GET /tasks/anomalies`, `GET /tasks/violations`, `GET /tasks/setup-guide`, `POST /tasks/setup-guide/:stepId/complete`, `POST /tasks/activities`, `PATCH /tasks/:taskId/status`, `GET /tasks/:taskId`
- **Notifications**: `GET /notifications`, `PATCH /notifications/:id/read`, `PUT /notifications/read-all`
- **Health**: `GET /health`

## 3. API surface (step Expo app mocks — ~130 endpoints)

Key additions beyond step1 and our contract:
- **Analytics**: `/analytics/overview`, `/analytics/trend`, `/analytics/funnel`, `/analytics/forecast`, `/analytics/top-dishes`, `/analytics/orders`, `/analytics/benchmark`, `/analytics/diagnostics`, `/analytics/market`, `/analytics/multi-store`, `/analytics/products`, `/analytics/promotions`, `/analytics/report`, `/analytics/revenue-composition`, `/analytics/traffic`
- **Orders**: `GET /orders/receipts`, `GET /orders/print-jobs`, `GET /orders/reject-reasons`, `POST /orders/accept-batch`, `POST /orders/:id/ready`, `POST /orders/:id/complete`, `POST /orders/:id/rush`, `POST /orders/:id/rush-reply`, `POST /orders/:id/seen`, `POST /orders/:id/refund`
- **Products**: `GET /products/assistant/suggestions`, `POST /products/assistant/apply`, `POST /products/assistant/describe`, `GET /products/logs`, `POST /products/stock-adjust`, `GET/POST/PATCH /categories` + `POST /categories/sort`, `GET/POST /templates` + `POST /templates/:id/apply`
- **Store**: `GET /stores`, `GET/PATCH /stores/:id/settings`, `PATCH /stores/:id/menu`, `GET/PATCH /stores/:id/qr-ordering`, `GET /stores/:id/qr`, `GET/PATCH /stores/:id/dual-screen`, `POST /dual-screen/pair`, `GET /stores/:id/compliance` + `POST recheck`, `GET /stores/:id/logs`, `GET /stores/:id/receipt-template`, `GET/POST/PATCH /payment-accounts` + `POST /:id/verify`, `GET/POST/PATCH /printers` + `POST /:id/connect` + `POST /:id/test`, `GET/POST/PATCH /receipt-templates`, `GET/POST/PATCH/DELETE /tables` + `POST /tables/:id/qr`, `GET /closure/status`, `POST /closure/apply`, `POST /closure/cancel`
- **Finance**: `GET /settlements`, `POST /settlements/run`, `POST /settlements/:id/payout`, `GET /ledger`, `POST /ledger/withdraw`, `GET /invoices`, `POST /invoices/:id/issue`, `GET /finance/methods`, `GET /finance/reconciliation`, `GET /finance/revenue-composition`
- **Risk & compliance**: `GET /risk/events`, `POST /risk/:id/review`, `GET /audit`, `GET /staff`, `POST /staff`, `PATCH /staff/:id`, `GET /sessions`, `POST /sessions/:token/revoke`, `GET /privacy/export`, `POST /privacy/delete`
- **Chat**: `GET /chat/threads`, `POST /chat/threads/:id/messages`, `POST /chat/threads/:id/read`, `POST /chat/threads/:id/customer-messages`
- **Marketing**: `GET /campaigns`, `POST /campaigns`, `POST /campaigns/:id/stop`, `GET /campaigns/:id/performance`, `GET /campaigns/platform`, `POST /campaigns/platform/:id/signup`
- **Customers**: `GET /customers/segments`, `POST /customers/segments/:id/coupons`
- **Onboarding**: `GET /onboarding/status`, `POST /onboarding/docs`, `POST /onboarding/profile`, `POST /onboarding/submit`, `POST /onboarding/demo-approve`
- **Redemptions**: `GET /redemptions`, `POST /redemptions`, `POST /redemptions/validate`
- **Misc**: `GET /announcements`, `GET /events`, `GET /experiments`, `GET /riders`, `POST /monitoring/errors`, `GET /support/tickets`, `POST /support/tickets`, `GET /auth/me`, `POST /auth/logout`, `GET /health`

## 4. Cross-cutting capabilities observed

- **Payment providers**: M-Pesa, Tigo Pesa, Airtel, **EzyPesa**, **Halotel**, bank transfer — initialize/status/reverse/refund flows.
- **Barcode subsystem**: formats, generate per product, lookup by barcode, batch import, history.
- **Combo meals + menus**: dedicated resources (combo CRUD; multi-store menu CRUD).
- **Product videos**: dedicated CRUD.
- **Food damage claims**: order damage report.
- **Tasks/risk center**: anomalies, violations, setup guide checklist, activity submissions, risk events review, audit view.
- **Privacy**: data export, account deletion.
- **Sessions**: list + revoke active sessions; change password.
- **Onboarding wizard**: status/docs/profile/submit/demo-approve.
- **Printer management**: connect/test printers; receipt templates with active default.
- **Settlements**: manual run + payout per settlement; ledger; withdraw.
- **Kitchen camera**: store live feed settings.
- **Self-pickup** settings; **store promotions**; **QR codes** (store-level) CRUD.
- **i18n**: en + am (Amharic) in step1 app; en/sw/ar in our docs.

## Round-4 survey — Uber-driver blueprint zips (Aug 2026)

Sources: `~/Downloads/uber-driver-app-blueprint (9).zip` (Next.js, 27 features,
4 phases: core 8 / internal enterprise 7 / advanced 6 / professional tools 6)
and `(10).zip` (Next.js + Drizzle + Postgres, 26 API routes, SPEC.md UI-flow
specification with dark-mode design language, state machine, edge states).

New capabilities extracted and now covered (contract + rider docs):

- Vehicle maintenance (oil/tire/battery/brake/service, mileage, cost,
  predictive `nextDueAt`), rider expenses (fuel/maintenance/insurance/equipment/
  tax_deduction, receipts, deductible), schedule & goals (weekly hours/earnings
  goals, weeklyAvailability, peakHourAlerts), export reports (tax/earnings/
  trips as csv/pdf/json, async job), training center (modules + certificates +
  rewardTZS bonus), trusted emergency contacts (notifiedOnSos, shareLocation),
  fraud security score + alerts, help-center knowledge base, delivery streak,
  support ticket category + urgency, theme toggle (design).
- ub10 enterprise patterns folded into backend docs: bearer-token sessions
  (30-day TTL), idempotent provisioning (`onConflictDoNothing`), atomic state
  transitions with side effects, server-only DB modules, typed end-to-end,
  QA simulator for the 9 edge states, matching engine stub → DISPATCH/AI-LAYER.

Contract grew 339 → 349 paths, 190 → 195 schemas; docs 127 → 128 files.
Verified: 74/74 blueprint items covered; all doc refs resolve to the contract.
