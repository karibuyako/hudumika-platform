# HUDumika Merchant — Navigation Blueprint

Screen-to-screen structure for the mobile app (bottom tab bar, max 5 items) and the web dashboard (persistent left sidebar with the same five sections). Modelled on the Meituan KaiDianBao 5-tab structure, adapted to the Contract. Every node below maps to real contract endpoints; nothing beyond `backend/API-CONTRACT.yaml`.

## Tab structure

Mobile bottom tabs: **Orders | Messages | Store | Marketing | My**.
Web sidebar: same five groups in the same order; the sidebar replaces the tab bar, never adds navigation depth.

## Decision — shipped tab layout (7 tabs, deviation from the 5-tab blueprint)

The app ships with **7 bottom tabs** — dashboard | orders | products | marketing | store | ops | profile
(`src/app/(tabs)/_layout.tsx`) — while this blueprint (and DESIGN-SYSTEM "bottom nav max 5 items")
specifies **Orders | Messages | Store | Marketing | My**. The deviation is intentional and
documented here rather than restructured mid-development:

| Blueprint tab (5) | Shipped tabs (7) | Notes |
| --- | --- | --- |
| Orders | orders | identical scope |
| Messages | dashboard → Messages | message center lives under the dashboard tab (`dashboard/messages.tsx`); no dedicated tab |
| Store | store + products | store operations (tables, bills, inventory, staff, devices) and product management (catalogue, menus, combos) split into two tabs |
| Marketing | marketing | identical scope |
| My | profile + ops | profile (account, finance, settings, support) and ops (shifts, attendance, approvals, tasks, webhooks) split into two tabs |
| — | dashboard | extra tab: business health, analytics, finance, messages, risk — the home surface |

Consolidation to ≤5 tabs (products → store, ops → profile, Messages as its own tab) is planned
post-launch once the primary user paths stabilise; it is a screen-tree move only and involves no
contract changes. Until then the 5-tab names above remain the canonical product vocabulary
used in the trees below.

## Orders

```
Orders
├── Pending            GET /orders/me?status=paid
├── In-progress        GET /orders/me?status=merchant_accepted / preparing
├── Historical         GET /orders/me?status=completed / cancelled / refunded / disputed
│   └── Order Detail   GET /orders/{orderId} → OrderDetail
│       ├── products   items[] (name, quantity, unitPriceTZS snapshot)
│       ├── delivery   deliveryAddress (contactPhone masked)
│       ├── accept     POST /orders/{orderId}/accept
│       ├── reject     POST /orders/{orderId}/reject (reason ≤500)
│       ├── refund     not merchant-triggered; webhook-driven (refund.processed); disputes via ticket
│       └── events     events[] timeline; track GET /orders/{orderId}/track
├── Rush orders        rushRequestedAt banner on the order card (order.rush_requested)
├── Advance orders     GET /orders/me/advance?date=<date> (scheduledAt)
├── Batch print        POST /print-jobs (jobType receipt, orderIds[] multi-select);
│                      history GET /print-jobs?status=; detail GET /print-jobs/{printJobId}
```

Order statuses rendered exactly as `OrderStatus`; filters exclude customer-owned `draft`/`pending_payment`. Details in ORDER-FLOW.md.

## Messages

```
Messages
├── Customer conversations (1:1 chat)
│   ├── List            GET /conversations?status=open | archived | blocked
│   │   └── badge       GET /conversations/unread-count
│   ├── Detail          GET /conversations/{conversationId} (participants, maskedPhone)
│   ├── Chat            GET/POST /conversations/{conversationId}/messages
│   ├── Mark read       POST /conversations/{conversationId}/read
│   ├── Archive         POST /conversations/{conversationId}/archive
│   └── Blocked         staff-only moderation; POST /conversations/{conversationId}/block
├── Platform messages   GET /notifications/me (platform.announcement / platform.campaign)
└── Order dynamics      GET /notifications/me (order.created, order.delivered, ...)
```

Conversation ↔ order linkage: `Conversation.orderId`; created by the customer via `ConversationCreate` (`merchantId`, `orderId`, `subject`, `initialMessage`). Details in MESSAGES.md.

## Store

```
Store
├── Store info          GET/PATCH /merchants/me (address, contactPhone);
│                       GET/PUT /merchants/me/settings
│                       (hours, announcement, cover, recommended items, acceptance,
│                       acceptedPaymentMethods, deliverySettings, specialRules)
├── Product management  GET/PUT /catalogues/me; POST /catalogue-items;
│                       PATCH/DELETE /catalogue-items/{itemId}; GET /catalogue-items/{itemId}/logs;
│                       /categories (GET/POST, PATCH/DELETE /categories/{categoryId});
│                       (options, combos via options, availability, list/unlist, videoUrl)
├── Store decoration    cover image + recommended items from StoreSettings
├── Reviews             rating/reviewCount (MerchantPublic); report POST /reviews/{reviewId}/report
└── Store operations    payout account GET/PUT /merchants/me/payout-account (masked, verified);
                        receipt template + printers (StoreSettings.printSettings, /devices);
                        print jobs GET /print-jobs (history); delivery settings (StoreSettings)
```

## Marketing

```
Marketing
├── Campaigns           POST /promotions; PATCH /promotions/{promotionId};
│                       POST /promotions/{promotionId}/pause;
│                       POST /coupons (coupon campaigns)
│   └── types           discount | spend_based | instant_discount | bargain | coupon | traffic
└── Promotion analytics GET /promotions/{promotionId}/performance
                        (impressions, redeemCount, spendTZS, attributedRevenueTZS, roiPercent)
```

Campaign lifecycle: draft → pending_review → live → paused / rejected / ended (moderation events `promotion.moderated`). Details in PROMOTIONS.md.

## My

```
My
├── Account & qualifications  GET /users/me; GET /merchants/me (VerificationState badge,
│                             document status: missing/pending/approved/rejected)
├── Finance                   GET /wallet (withdrawableTZS, pendingTZS, totalTZS);
│                             GET /wallet/transactions; POST/GET /wallet/withdrawals;
│                             GET /payouts/me; GET /payouts/me/statement;
│                             payout account GET/PUT /merchants/me/payout-account;
│                             collection QR POST /payments/qr (fixed/variable)
├── Data analytics            GET /analytics/dashboard (real-time);
│                             GET /analytics/traffic; GET /analytics/products;
│                             GET /analytics/revenue; GET /analytics/benchmarks;
│                             GET /analytics/reviews; GET /analytics/market?category=
├── Business recommendations  GET /analytics/diagnostics (issues/warnings/opportunities)
├── Settings                  GET/PUT /merchants/me/settings; /merchants/me/staff;
│                             /dine-in/tables + QR; promotions; dual-screen (dine-in)
├── Tasks (also its own tab)  GET /tasks; GET /tasks/anomalies; GET /tasks/violations;
│                             GET /tasks/activities; GET /tasks/setup-guide;
│                             GET /risk/events → POST /risk/{id}/review (TASKS-RISK.md)
├── Privacy & security        POST /auth/change-password; GET /sessions +
│                             POST /sessions/{token}/revoke; POST /privacy/export;
│                             POST /privacy/delete; GET /audit/me (PRIVACY-ACCOUNT.md)
└── Help & feedback           POST /support/tickets; GET /support/tickets/me
```

Money renders as `TZS 12,500`-style integer minor units; balance fields come from the API, never client arithmetic.

## Core flows (compact sequences)

**Store opening** — apply → qualify → approve:
1. `POST /merchants` (`MerchantApplication`) → `LeadCreated` (`submitted`/`under_review`).
2. Upload qualification documents; status per document (`missing`/`pending`/`approved`/`rejected`).
3. Operations decides (`VerificationState`); `lead.reviewed` SMS + in-app notification.
4. `approved` unlocks the dashboard; commercial terms appear in `MerchantPrivate.commercial`.
   On `changes_requested`/`rejected`: `PATCH /merchants/me` + re-upload, or `POST /support/tickets`. Details in ONBOARDING.md.

**Order acceptance** — alert → decide → act:
1. `order.created` push + in-app (or poll `GET /orders/me?status=paid`).
2. Open `GET /orders/{orderId}`: items, totals, masked delivery contact.
3. `POST /orders/{orderId}/accept` → `merchant_accepted`; 409 on stale accept → refetch.
4. Receipt prints via `POST /print-jobs` (`jobType: receipt`, default printer) or `autoPrint`; kitchen label when `labelPrinter` on.
5. `POST /orders/{orderId}/status` with `preparing`; rider dispatch takes over after `rider_assigned`.

**Product publishing** — draft → publish → live:
1. `POST /catalogue-items` (name, `priceTZS`, category, options) → 201.
2. `GET /catalogues/me` → `PUT /catalogues/me` (full replace = draft publish).
3. `publishedAt` set; `available` toggle per item; `PATCH /catalogue-items/{itemId}` for price/stock.
   Publish conflicts surface as `ORDER_PRICE_CHANGED`-style errors; see MENU-CATALOGUE.md.

## Screen states (every node)

Loading skeleton → empty state with CTA → error with retry (429 honors `Retry-After`) → success content with actions disabled where the server forbids them (409 → conflict banner + refetch).

## MSW parity

Mocks must reproduce the navigation payloads: order status filters, conversation statuses and error codes, `VerificationState` gating, wallet/analytics shapes.

## Round-2 additions to the trees (deep survey — `docs/REFERENCE-SURVEY.md`)

New nodes under the existing five tabs; contract paths exact, reference-only screens marked `(gap)`.

```
Orders (extras)
├── Order detail extras       Order.no header; source badge (Order.source app|web|phone|pos);
│                             deadline countdown (deadlineAt, ORDER_AUTO_CANCELLED);
│                             per-status timestamps acceptedAt/readyAt/completedAt/cancelledAt/settledAt;
│                             freeDelivery chip; seen badge + POST /orders/{orderId}/seen;
│                             rush urgency tier pill (Low/Medium/High/Critical — UI convention over
│                             createdAt dwell time; no urgency field, gap) + ETA reply presets
│                             5/10/15/20/30/45 min → POST /orders/{orderId}/rush-reply (message ≤300)
├── Accept concurrency        POST /orders/{orderId}/accept body expectedVersion (Order.version);
│                             VERSION_CONFLICT → banner, refetch, retry once
├── Pre-orders (Today/Upcoming/Past)  GET /orders/me/advance?date= (date-filtered tabs)
└── Refund queue              GET /refunds; approve/reject with reason ≤500;
                              partial-amount approval (gap)
Products
└── Item editor extras        originalPriceTZS (compare-at + savings), costTZS (margin input),
                              zeroStockAction hide|show_sold_out, sort, emoji, addons[],
                              comboItems[]; barcode formats ean8/code128/code39 +
                              DELETE /products/{itemId}/barcode/{code}; video status/views (gap);
                              history change-type filter (client grouping of logs)
Marketing
├── Campaign builder wizard   15 PromotionTypes (discount, spend_based, full_reduction, new_customer,
│                             free_delivery, instant_discount, bargain, haggle, coupon, flash,
│                             featured, traffic, ppc, brand, group_buy); builder fields
│                             couponAmountTZS/thresholdTZS/discountRateBps/target/productIds/
│                             groupBuyTargets/haggleEnabled/cpcTZS
├── Flash sales               /marketing/flash-sales (countdown; quantity limit gap)
├── Instant discounts         maxUses gap (redeemCount/spendTZS server-tracked)
├── Coupons                   kind percentage|fixed|shipping + maxDiscountTZS
├── Bargain                   haggleEnabled; auto-accept/counter-offer (gap)
├── Group buy                 groupBuyTargets tiers (GROUP-BUY.md)
├── Membership                tiers with commission (MEMBERSHIP-LOYALTY.md)
├── Precision marketing       /marketing/precision + send
├── DianJin                   /marketing/dianjin (cpcTZS)
├── Brand display             /marketing/brand-display
├── Traffic                   ROI calculator over performance (roiPercent)
├── Self-service              /marketing/self-service (packages gap)
└── Platform events           /marketing/platform-events + enroll (terms checkbox = UI)
Store (extras)
├── Scheduled reopen          30m/1h/2h/4h/Tomorrow (gap; sweeper exists server-side)
├── Decoration                posterColor/posterText/sign/brandStory/tagline (gap); featured ≤6
├── Delivery zones            per-zone fee + perKmFee (gap)
├── Self-pickup slots         Morning/Afternoon/Evening + ready notifications + instructions (gap)
├── Kitchen camera            recordingDuration/storageUsed/videoQuality/recentClips (gap)
├── Qualifications expiry     + renew (gap; re-upload resets to pending)
├── Table zones + cleaning    DineInTable zone/status cleaning/qrToken/qrUrl/reservedUntil
├── QR kinds                  StoreQrCode ordering|table|menu|collection|feedback|download|review
├── Compliance score          + recheck POST /store/compliance/recheck
├── Closure history           ClosureProtection status pending|approved|completed|cancelled|rejected,
│                             maxDays 15, daysRemaining; reason chips (UI)
└── Quick payment request     POST /payments/request (phone + amountTZS + method)
Finance (extras)
├── Expenses                  GET/POST /finance/expenses; DELETE /finance/expenses/{expenseId}
├── Transaction issue         POST /finance/transactions/{transactionId}/issue → ticket
├── Invoices                  VAT/Standard + taxId + taxRate (gap)
├── Daily settlements         /finance/settlements/daily (+ run, payout)
├── Periodic payouts          /payouts/me (T+1 label gap; payoutCycleDays is contract)
└── Download center           report/invoice downloads (per-transaction receipt gap)
Analytics (extras)
├── Customer LTV + churn      avgLifetimeValue/churnRate/monthlyTrend (gap)
├── Segments                  VIP/Regular/At-Risk/Lost + actions (gap)
├── Funnel                    incl. carts (gap)
├── Benchmark radar           + suggestions with impact (gap)
├── Store score history       monthly series (gap)
└── Market analysis           marketSize/priceDistribution (gap)
Tasks (extras)
├── Anomaly quick fix         modal + resolution notes (PATCH /tasks/{taskId} note ≤500)
└── Violations appeal         fines + appeal (gap)
```
