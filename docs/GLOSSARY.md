# HUDumika Glossary

Shared vocabulary across all teams. If a term is not here, ask and add it — never invent a second term for the same concept.

| Term | Definition |
| --- | --- |
| HUDumika | Platform brand. "Huduma" is Swahili for "service". |
| Customer | End user who orders products or books services through the customer app. |
| Merchant | Business (restaurant, shop, grocery, pharmacy, retail, tickets) selling products/meals via the platform. |
| Provider | Skilled professional (plumber, electrician, cleaner, repairer) offering services at the customer's location. |
| Rider | Delivery partner who transports products and eligible parcels. Riders do not replace providers. |
| Admin / Staff | Internal HUDumika operations user (super admin, ops manager, agents, finance, compliance). |
| App | One deployable client: customer app, merchant app/web, provider app/web, rider app, admin web. |
| Public web | Marketing and lead-capture site (new-public_web). Never contains transactional flows. |
| Order | Product/meal purchase flow with a merchant (and optionally a rider). |
| Booking | Appointment or on-demand service flow with a provider. |
| Catalogue | A merchant's published list of items (name, price, options, availability). |
| Catalogue item | One sellable unit in a merchant's catalogue. |
| Intent / Payment intent | Server-side record of a payment attempt (created → pending → paid/failed/refunded). |
| Ledger | Immutable, append-only record of every money movement per earner. |
| Payout | Cash-out of ledger balance to an earner (bank or mobile money). |
| Payout batch | Nightly group of payouts for one cycle (draft → processing → settled/exception). |
| Batch exception | A payout that failed and needs finance review. |
| Commission | Platform's share of an order/booking, set per merchant/provider on approval. |
| Delivery fee | Fee charged to the customer for rider delivery; also the rider's earning basis. |
| Platform fee | Service fee on orders/bookings; server-computed, never client-supplied. |
| TZS | Tanzanian shilling; money stored as integer minor units (1 TZS = 1 unit). |
| Dispatch | Server-side assignment of riders to orders and providers to bookings. |
| Dispatch queue | Redis-backed queue of orders waiting for a rider / bookings waiting for a provider. |
| Acceptance window | Time a rider/provider has to accept an assignment before the next candidate is tried. |
| Availability | Provider weekly schedule (day + start/end) or rider online/offline state. |
| Service area | Geographic zone (polygon) within a city where a service or delivery is offered. |
| OTP | One-time password for phone/email verification (login, signup, role verify). |
| Role switching | Same person using multiple roles (e.g. customer and merchant); sessions never mix data. |
| Session | Authenticated, role-scoped token pair (access + refresh). |
| MFA | Multi-factor authentication, required for all staff (admin) logins. |
| RBAC | Role-based access control; enforced server-side on every route. |
| MSW | Mock Service Worker; client-side API mock that must match the OpenAPI contract. |
| Contract | `backend/API-CONTRACT.yaml` — the OpenAPI spec every client and mock follows. |
| Idempotency key | Client-supplied key that makes retries safe (no double charges, no double inserts). |
| State machine | Allowed status transitions for orders and bookings, enforced server-side. |
| Order/booking event | Append-only record of each status transition (status, at, by, note). |
| Completion | Order `completed` or booking `completed`; the moment payouts become eligible. |
| Dispute | Customer-initiated money hold after a problem; payout held until review. |
| No-show | Provider did not arrive for a scheduled booking; reliability event. |
| Reliability score | 0–100 per provider/rider from cancellations, no-shows, late arrivals. |
| Rating average | Computed from published reviews; never hardcoded marketing values. |
| Review state | pending → published / hidden / deleted. |
| Ticket | Support request with append-only messages and SLAs. |
| SLA | Response/resolution target per ticket priority. |
| Audit log | Immutable record of identity, money, status, and moderation actions. |
| Request ID | UUID on every request; appears in logs, errors, and audit entries. |
| Deep link | Link into a specific app screen (order, booking, ticket, statement). |
| Localization | i18n architecture; first release English, Swahili-ready (`sw`), Arabic-capable (`ar`). |
| EAS | Expo Application Services (build/submit) for the mobile apps. |
| Dine-in | In-store ordering at a merchant via QR-code menus and tables; separate from delivery orders. |
| Dine-in table | Physical table with a QR payload linking to the store's menu. |
| Dine-in order | Bill opened at a table (open → billing → paid → closed). |
| Reservation | Customer booking of a table/queue slot (pending → confirmed → seated → completed). |
| Group buy | Discounted deal bundle purchased in advance by customers (e.g. TZS 50,000 meal for TZS 35,000). |
| Group buy deal | One merchant's group buy offering (draft → pending_review → live → delisted/ended). |
| Voucher | Redemption unit issued when a group buy deal is purchased; verified by code or QR at the merchant. |
| Voucher verification | Merchant marking a voucher redeemed (unused → redeemed); history is logged. |
| Promotion | Merchant campaign: discount, spend-based, instant discount, bargain, coupon, or traffic. |
| Coupon | Redeemable discount entitlement (claimed by a customer, used on an order). |
| Coupon wallet | Customer-held list of available/used/expired coupons. |
| Bargain campaign | Customer-driven price negotiation ("haggle") promotion with a merchant-set floor price. |
| Traffic campaign | Platform-wide promotion the merchant buys into for exposure. |
| Promotion ROI | Attributed revenue vs promotion spend (redeem_count, spend_tzs, roiPercent). |
| Loyalty member | Customer registered in a merchant's own membership program (tiers, top-ups). |
| Membership tier | Merchant-configured level (discount basis points, thresholds, perks). |
| Top-up reward | Bonus balance credited when a member tops up above a threshold. |
| Customer membership | Platform-wide customer program (points + level, bronze/silver/gold). |
| Merchant staff | Roles within a merchant: owner, manager, cashier, kitchen, waiter. |
| Cashier scope | Staff role restricted to dine-in billing, voucher verification, and COD recording. |
| Device registry | Registered merchant hardware: printers, POS, kitchen display, cashier terminal. |
| Printer queue | Print jobs for order receipts and kitchen labels, delivered to registered printers. |
| Merchant wallet | Balance projection from the ledger (withdrawable/pending/total) for withdrawals. |
| Withdrawal | Merchant cash-out from wallet to the linked payout account. |
| Store settings | Hours, announcement, cover image, recommended items, acceptance method, print settings. |
| Acceptance method | manual vs auto-accept for incoming orders (auto within `autoAcceptWithinSeconds`). |
| Phone ordering | Phone-call orders accepted during configured hours. |
| Closure protection | Pause operations without penalty (used for holidays/renovation). |
| Chain store | One merchant account owning multiple store locations with per-store settings. |
| Product template | Reusable product set applied across chain stores. |
| Product operation log | Append-only history of product changes (price, stock, availability). |
| Advance order | Pre-scheduled order (scheduledAt) delivered at a future time. |
| Rush request | Customer "hurry up" tap on an active order; pushes the merchant and records an event. |
| Analytics dashboard | Merchant's real-time daily business overview. |
| Industry benchmark | Merchant metrics vs category averages (store score, percentile). |
| Diagnostic report | AI-generated merchant insights (issues, warnings, opportunities). |
| Report export | Permissioned, logged analytics export (revenue, products, traffic, orders). |
| Red packet | (Planned) platform subsidy wallet credit distributed during campaigns. |
| Conversation | 1:1 chat thread between a customer and a merchant (one per customer+merchant, plus per order). |
| Chat message | Message in a conversation; authors are customer, merchant_staff, or system. |
| Message center | Merchant/customer inbox: customer conversations, platform messages, order dynamics. |
| Platform message | Broadcast to users: announcements, campaign notices, policy updates (notification types platform.announcement / platform.campaign). |
| Order dynamics | New-order alerts and status-change notifications aggregated in the message center. |
| Conversation block | Moderation action (staff only, reason required) that freezes a chat thread and notifies both parties. |
| Chain / merchant group | One enterprise identity owning multiple stores; unified dashboard, bulk ops, chain reports. |
| Bulk operation | One action (price update, availability, promotion apply, catalogue sync) applied across selected stores, approval-gated. |
| Master inventory | Single stock record per item that all channels (orders, dine-in, POS) follow. |
| Stock adjustment | Signed inventory change with a reason (stock_in, sale, writeoff, return); append-only history. |
| Low-stock alert | Threshold-based notification with suggested reorder quantity. |
| Supplier | Vendor tracked for purchasing; status active/suspended. |
| Purchase order (PO) | Order to a supplier (draft → sent → partially_received → received → closed/cancelled). |
| PO receiving | Recording delivered quantities against a PO; updates stock and unit cost. |
| COGS | Cost of goods sold; tracked via unit_cost_tzs for inventory valuation. |
| Approval request | Multi-level workflow (price change, promotion, refund above threshold, inventory, staff role, bulk op) requiring a manager/owner decision with comment. |
| Shift | Scheduled working period for a staff member (scheduled → active → completed/cancelled). |
| Attendance record | Clock-in/clock-out pair per staff (app or POS); feeds performance metrics. |
| Commission rule | Staff earning rule (per_order, per_service, per_revenue) in basis points. |
| Integration | Connected external system (POS, ERP, accounting, payroll, delivery partner, mini-program) with status. |
| Webhook subscription | Outbound HTTPS callback for platform events (order.created etc.), signed with a secret. |
| Webhook delivery | One delivery attempt (success/failed/retrying); health monitor marks subscriptions failing. |
| Scheduled report | Recurring report (daily/weekly/monthly; csv/xlsx/pdf) delivered to email recipients. |
| Customer segment | CRM group built from rules (spend, frequency, location); enables targeted campaigns. |
| Customer journey | Automated trigger → delayed actions (push/sms/coupon/email) for a segment. |
| Data export | Enterprise request for full data (all/orders/customers/catalogue/financial) as csv/xlsx/json; permissioned and audited. |
| Vertical | Industry configuration of the platform (retail, beauty, hotels, health, pets, fitness, automotive, education, events, property). |
| Enterprise order | B2B/corporate order with company name, cost center, billing reference. |
| Rush order | Customer "hurry up" request on an active order; merchant replies via rush-reply. |
| Food damage claim | Merchant report of order issue (spilled, missing, wrong item, packaging) with images and compensation tracking. |
| Refund request | Customer-initiated refund in the merchant queue (pending → approved/rejected with reason). |
| Barcode | Machine-readable code (ean13, upca, qr) per catalogue item; generate, lookup, batch import, history. |
| Combo meal | Bundle of catalogue items sold as one product. |
| Menu | Multi-store menu resource: sections of items applied across selected chain stores. |
| Product video | Video attached to a product (or store) with thumbnail. |
| Product assistant | AI suggestions for product titles, descriptions, prices, categories, photos, stock. |
| Task center | Merchant queue: product anomalies, store violations, activity submissions, setup guide steps. |
| Risk event | Detected irregular activity (refund patterns, velocity) requiring merchant review. |
| Setup guide | Onboarding checklist steps with deep links to complete store setup. |
| Bank card | Merchant bank card for withdrawals; multiple cards, one default. |
| Invoice | Billing document requested by the merchant (draft → requested → issued → paid). |
| Daily settlement | Per-day settlement record (open → settled → paid); manual run for finance. |
| Reconciliation | Order-to-payment matching summary with exceptions. |
| Platform event | Platform-run traffic campaign a merchant enrolls into. |
| Flash sale | Time-limited discount on selected items (draft → scheduled → live → ended). |
| Precision marketing | Targeted campaign sent to a customer segment (coupon/discount/message). |
| DianJin | Pay-per-click advertising campaign with budget and bid. |
| Brand display | Paid brand awareness campaign (impressions, budget). |
| Self-service promotion | Merchant-controlled promotion with design and optional homepage exposure. |
| Kitchen camera | Live kitchen feed configuration (stream URL, public access). |
| Qualification | Business license/permit document with verification status. |
| Store QR code | Store-level QR (ordering, collection, download, review). |
| Receipt template | Reusable receipt layout (header/footer/logo); one active default. |
| Store payment account | Collection account (mobile money/bank) for the store; multiple allowed. |
| Self-pickup | Customer pickup option with ready minutes and hours. |
| Privacy export | Personal data export request per data-protection law. |
| Account deletion | Erasure request with confirmation and estimated days. |
| Session management | List and revoke active sessions for the user. |
| Onboarding wizard | Guided store setup: profile → documents → submit → review. |
| EzyPesa / Halotel | Additional payment providers alongside M-Pesa, Tigo Pesa, Airtel Money. |
