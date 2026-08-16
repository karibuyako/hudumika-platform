# HUDumika Merchant — Enterprise Coverage Matrix

Bullet-level audit of the enterprise-readiness checklist against the contract and
team docs. Status key: **LIVE** (in `backend/API-CONTRACT.yaml` today), **PLANNED**
(contract addition documented, phase-gated), **OUT OF SCOPE** (not planned for v1).

## I. Core enterprise capabilities

### 1. Multi-store & chain management

| Requirement | Status | Where |
| --- | --- | --- |
| Unified dashboard across stores | LIVE — `GET /chain/dashboard` | MULTI-STORE.md |
| Centralized product/service + price sync across locations | LIVE — product templates (`/product-templates`, apply w/ `overwritePrices`) + bulk `price_update` | MULTI-STORE.md, MENU-CATALOGUE.md |
| Bulk operations (price, promotions) across selected/all stores | LIVE — `POST /bulk-operations` (price_update, availability, promotion_apply, catalogue_sync; approval-gated) | MULTI-STORE.md |
| Cross-store analytics (sales, costs, performance) | LIVE — `GET /chain/analytics` (ChainStorePerformance) | MULTI-STORE.md, ANALYTICS.md |
| Centralized account management (one enterprise identity) | LIVE — merchant groups (`merchant_groups` + chain_stores), admin `GET /admin/chain` | MULTI-STORE.md, admin MODULES.md §20 |
| Chain-wide consolidated reporting | LIVE — `POST /chain/reports` (financial/operational/orders/inventory) | ENTERPRISE-FINANCE.md |

### 2. Supply chain & inventory

| Requirement | Status | Where |
| --- | --- | --- |
| Multi-channel inventory sync (POS, mini-program, partners) | LIVE — `GET/PUT /inventory/sync-config` (enabled, masterSource, channels) | INVENTORY-SUPPLY-CHAIN.md |
| Centralized master inventory | LIVE — `/inventory/items` (stockOnHand/reserved/available, per store) | INVENTORY-SUPPLY-CHAIN.md |
| Automated stock alerts with suggested reorder | LIVE — `GET /inventory/alerts` (low/out_of_stock, suggestedReorderQty) + `inventory.low_stock`/`inventory.out_of_stock` events | INVENTORY-SUPPLY-CHAIN.md, NOTIFICATIONS.md |
| Supplier management | LIVE — `/suppliers` CRUD (active/suspended) | INVENTORY-SUPPLY-CHAIN.md |
| Purchase order creation, send, tracking | LIVE — `POST /purchase-orders`, `POST .../{id}/send` (draft→sent), list/detail, statuses to closed/cancelled | INVENTORY-SUPPLY-CHAIN.md |
| Receiving & returns | LIVE — `POST .../{id}/receive` (partial/full; updates stock + unitCostTZS) + `POST /supplier-returns` | INVENTORY-SUPPLY-CHAIN.md |
| Inventory costing (COGS, valuation) | LIVE — `unitCostTZS` on inventory items, updated on receiving | INVENTORY-SUPPLY-CHAIN.md |
| Automated replenishment (AI, sales velocity) | PARTIAL — suggestions via `suggestedReorderQty` in alerts; AI-driven forecasting PLANNED (M9c, contract addition) | INVENTORY-SUPPLY-CHAIN.md, AI-AUTOMATION.md |

### 3. Enterprise financial management

| Requirement | Status | Where |
| --- | --- | --- |
| Multi-entity accounting (stores/legal entities) | PARTIAL — chain dashboard + consolidated reports LIVE; per-entity books PLANNED (contract addition) | ENTERPRISE-FINANCE.md |
| Advanced reconciliation across channels | PARTIAL — payout reconciliation LIVE (backend PAYOUTS-LEDGER.md); channel-level matching PLANNED | ENTERPRISE-FINANCE.md, backend/PAYOUTS-LEDGER.md |
| Budgeting & forecasting | PLANNED — contract addition, M9c | ENTERPRISE-FINANCE.md |
| Tax management (auto calc + reporting) | PLANNED — platform fee/VAT config, contract addition | ENTERPRISE-FINANCE.md |
| Audit trails for all financial transactions | LIVE — immutable `audit_logs` + ledger; every money mutation audited | backend/AUDIT.md, backend/PAYOUTS-LEDGER.md |
| Corporate payment controls (policies, approvals, anomaly detection) | PARTIAL — approval-gated refunds (`/approvals` refund_above_threshold) + reasons LIVE; spend policies & anomaly detection PLANNED | ENTERPRISE-FINANCE.md, ENTERPRISE-STAFF.md |

### 4. Staff & permissions

| Requirement | Status | Where |
| --- | --- | --- |
| Granular RBAC (manager, cashier, kitchen, delivery) | LIVE — `/merchants/me/staff` roles owner/manager/cashier/kitchen/waiter + permissions array | STAFF-AND-DEVICES.md |
| Multi-level approval workflows | LIVE — `/approvals` (price_change, promotion, refund_above_threshold, inventory_adjustment, staff_role_change, bulk_operation) with comment + audit; multi-step chains PLANNED | ENTERPRISE-STAFF.md |
| Staff scheduling & shift management | LIVE — `/staff/shifts` (startAt/endAt, role, SHIFT_OVERLAP); shift swapping PLANNED (contract addition) | ENTERPRISE-STAFF.md |
| Performance tracking | LIVE — `GET /staff/performance` (orders, handle time, cancellations, rating, attendance, commission) | ENTERPRISE-STAFF.md |
| Commission & bonus calculation | PARTIAL — `/staff/commissions` (per_order/per_service/per_revenue, rateBps) LIVE; bonus payouts PLANNED | ENTERPRISE-STAFF.md |
| Time & attendance (clock-in/out + reports) | LIVE — `/staff/attendance` (clock-in/clock-out, source app/pos, duration) | ENTERPRISE-STAFF.md |

### 5. System integrations

| Requirement | Status | Where |
| --- | --- | --- |
| ERP integration | PARTIAL — integration registry `/integrations` (provider erp) LIVE; connector implementations PLANNED M9b | INTEGRATIONS-WEBHOOKS.md |
| Full API access for third parties | LIVE — the OpenAPI contract is the API; documented in backend/API-CONTRACT.yaml | backend/README.md |
| POS integration | PARTIAL — registry + `/devices` (pos) LIVE; certified POS connectors PLANNED | INTEGRATIONS-WEBHOOKS.md, STAFF-AND-DEVICES.md |
| Accounting software sync (QuickBooks/Xero/local) | PARTIAL — registry (provider accounting) LIVE; connectors PLANNED | INTEGRATIONS-WEBHOOKS.md |
| HR/payroll integration | PARTIAL — registry (provider payroll) LIVE; connector PLANNED | INTEGRATIONS-WEBHOOKS.md |
| Custom webhooks (real-time pushes) | LIVE — `/webhooks` subscriptions (signed events), `/webhooks/deliveries` (retry ≤8, failing status), admin health view | INTEGRATIONS-WEBHOOKS.md |

### 6. AI & automation

| Requirement | Status | Where |
| --- | --- | --- |
| AI business insights (aggregation, anomaly detection, recommendations) | PARTIAL — `GET /analytics/diagnostics` contract-defined, phased M7e; anomaly detection PLANNED | AI-AUTOMATION.md |
| Automated report generation (daily/weekly/monthly) | LIVE — `/reports` scheduled reports (cadence, csv/xlsx/pdf, email recipients, report.ready) | AI-AUTOMATION.md |
| AI customer service (auto-replies) | PLANNED — chat auto-reply config, contract addition | AI-AUTOMATION.md, MESSAGES.md |
| Predictive analytics (forecasting, demand, inventory) | PLANNED — M9c, contract addition | AI-AUTOMATION.md |
| Automated marketing (AI campaign suggestions/execution) | PLANNED — M9c, contract addition | AI-AUTOMATION.md, PROMOTIONS.md |
| 24/7 automated operations agents | PLANNED — long-term vision (CatPaw equivalent), not in contract | AI-AUTOMATION.md |

### 7. Enterprise data & security

| Requirement | Status | Where |
| --- | --- | --- |
| Data privacy & compliance (GDPR, CCPA, local) | LIVE practices — Tanzania PDPA 2022 + GDPR-aligned; consent + masking | SECURITY.md, CRM.md |
| Private/on-premise deployment | PLANNED — enterprise option, cloud-only today | SECURITY.md, backend/DEPLOYMENT.md |
| Data ownership & full export | LIVE — `POST /data/exports` (all/orders/customers/catalogue/financial; csv/xlsx/json; permissioned + audited) | SECURITY.md |
| Advanced/customizable dashboards | PARTIAL — analytics dashboards LIVE; custom widget dashboards PLANNED | ANALYTICS.md |
| Benchmarking vs industry averages | LIVE — `GET /analytics/benchmarks` (store score, percentile) | ANALYTICS.md |
| Custom reporting (selected metrics, scheduled) | LIVE — `/reports` scheduled reports with filters + storeIds | ANALYTICS.md, AI-AUTOMATION.md |

### 8. CRM at scale

| Requirement | Status | Where |
| --- | --- | --- |
| Unified customer view (all stores/channels) | PLANNED — unified profile contract addition, M9c | CRM.md |
| Advanced segmentation | LIVE — `POST /segments` (rules, memberCount) | CRM.md |
| Omnichannel marketing | PARTIAL — push/SMS/email/in-app channels LIVE via notifications; external channels (WeChat-style) PLANNED | CRM.md, backend/NOTIFICATIONS.md |
| Enterprise-wide loyalty with tiers | PARTIAL — merchant loyalty (`/members`, `/membership-tiers`) LIVE; chain-wide loyalty PLANNED | MEMBERSHIP-LOYALTY.md, CRM.md |
| Automated customer journeys | LIVE — `/journeys` (trigger → delayed push/sms/coupon/email; draft/active/paused) | CRM.md |
| Private domain traffic | PLANNED — long-term; consent + masking apply | CRM.md |

### 9. Multi-platform & multi-device

| Requirement | Status | Where |
| --- | --- | --- |
| PC/Mac desktop application | PLANNED — web dashboard is browser-based today; native desktop app roadmap | INTEGRATIONS-WEBHOOKS.md, ARCHITECTURE.md |
| Mobile app (full functionality) | LIVE — Expo app; see NAVIGATION.md | ARCHITECTURE.md |
| Cloud/browser access | LIVE — React + Vite web dashboard | ARCHITECTURE.md |
| Cross-device sync | LIVE — server-side sessions; resume on any device after re-auth | ARCHITECTURE.md, SECURITY.md |
| Multiple languages | LIVE — en/sw/ar (LOCALIZATION.md); Chinese (zh) PLANNED | LOCALIZATION.md |

### 10. Enterprise support & onboarding

| Requirement | Status | Where |
| --- | --- | --- |
| Dedicated account manager | LIVE data model — `ChainAccountAdmin.accountManager`; service delivery planned | EDUCATION-SUPPORT.md, admin MODULES.md §20 |
| Priority 24/7 enterprise support | PLANNED — support SLAs exist per ticket priority; enterprise 24/7 tier planned | EDUCATION-SUPPORT.md, backend/SUPPORT.md |
| Structured training & onboarding | PLANNED — academy exists as content plan; enterprise training program planned | EDUCATION-SUPPORT.md |
| Implementation consulting | PLANNED — professional services, roadmap | EDUCATION-SUPPORT.md |
| SLA guarantees (uptime, response) | LIVE data model — `slaLevel` on chain accounts; operational SLA monitoring planned | EDUCATION-SUPPORT.md, admin MODULES.md §20 |

## II. Industry verticals (all 10)

Full vertical-by-vertical capability mapping (surface, gaps, phase) lives in
`VERTICALS.md` (merchant) and `provider/VERTICALS.md`. Summary of the most
material sub-items:

| Vertical | Sub-items that are LIVE | Key PLANNED items | OUT OF SCOPE v1 |
| --- | --- | --- | --- |
| A. Retail | multi-category, variants (options), bulk import/export, supplier mgmt, returns (refunds + supplier returns) | barcode scanning, shelf mgmt, supplier catalogs, retail POS connector, self-checkout/kiosk | — |
| B. Beauty/wellness | appointment booking, service menu/packages, commission rules, retail inventory | staff-to-appointment assignment, client history/notes, waitlist, salon tool connectors | — |
| C. Hotels | reservation mgmt (restaurant-grade), guest folio via dine-in bill | room status, housekeeping, group booking, check-in/out, dynamic pricing, channel mgmt, AI pricing | OTA channel managers |
| D. Medical/health | appointment booking (GDPR/PDPA notes) | compliance tools, treatment-plan pricing, medical inventory via master inventory | HIPAA-grade records, insurance claims, e-prescriptions, telemedicine |
| E. Pet services | appointments, service packages, inventory | pet profiles (history/allergies), boarding check-in/out, weight/health tracking | — |
| F. Fitness | tiered membership (loyalty), service packages | class scheduling, member check-in, class booking + waitlist, instructor mgmt, equipment maintenance | — |
| G. Automotive | service appointment booking, parts inventory, packages | vehicle history, warranty tracking | — |
| H. Education | — | course mgmt, enrollment/attendance, instructor mgmt, classroom scheduling, progress tracking | — |
| I. Events/weddings | event booking, packages (options) | venue mgmt, vendor coordination (partial via suppliers), guest lists/RSVPs | — |
| J. Real estate | — | listings, viewing scheduling, tenant mgmt, maintenance requests, rent collection | — |

## III. Enterprise ecosystem (vision products)

| Meituan product | HUDumika equivalent today |
| --- | --- |
| Enterprise Edition | Chain accounts (`merchant_groups`, tier/SLA/account manager) + corporate expense approvals (planned) |
| CatPaw AI | `/analytics/diagnostics` (M7e) + `/reports` + automation roadmap (AI-AUTOMATION.md) |
| QianNiuHua (instant retail) | Chain + bulk ops + inventory sync (MULTI-STORE.md, INVENTORY-SUPPLY-CHAIN.md) |
| JiBai AI (hotels) | Planned hotel vertical (VERTICALS.md C) |
| Ke Man Man (beauty) | Planned beauty vertical (VERTICALS.md B) |
| Retail Manager | Retail vertical (VERTICALS.md A) + `/inventory/*` |
| Hotel Merchant | Planned hotel vertical (VERTICALS.md C) |

## Rule

When a checklist item is marked PLANNED, the responsible doc names the contract
addition and the milestone (M9a/M9b/M9c) — nothing on this matrix is silently absent.
