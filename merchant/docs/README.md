# HUDumika Merchant Application

One codebase, two surfaces: a single Expo app (Expo/React Native + expo-router) that runs natively on mobile and exports as a static web dashboard (`expo export --platform web`). Both surfaces expose the same feature set from the same screens; the web export suits the full-management desktop surface, the mobile app is the live-orders and quick-actions surface. Both speak to the same backend through the same contract.

## Surfaces

| Surface | Stack | Primary role |
| --- | --- | --- |
| Merchant mobile app | Expo (React Native, expo-router, Expo SecureStore, Expo Notifications, EAS) | Live order queue, accept/advance orders, push notifications, daily sales snapshot, quick catalogue toggles |
| Merchant web dashboard | Same codebase — Expo static web export of the mobile app | Full management: onboarding, catalogue manager, orders, earnings/statements, reviews, notifications, settings |

Feature parity rule: one codebase — every feature is available on both surfaces. Mobile may simplify layout, never capability.

## Feature set (shared)

| Area | Mobile | Web |
| --- | --- | --- |
| OTP auth (role-scoped session; role-switch UI pending) | yes | yes |
| Onboarding: application, verification status, re-submission | view status | full flow |
| Catalogue: item CRUD, options, availability, publish | quick toggles | full manager |
| Orders: accept, advance status, cancel, detail, events | full | full |
| Earnings: payout history, ledger statement | summary | full |
| Reviews: received, report | view | view + report |
| Notifications: center, preferences, push | push + center | center + preferences |
| Support tickets | create/reply | full |
| Payout account and commercial terms | view | view + update |
| Store settings, open/close, closure protection | quick toggles | full manager |
| Dine-in: tables, QR, bills, reservations | live tables + QR | full manager |
| Group buy deals + voucher verification | verify + live updates | full manager |
| Promotions + coupon campaigns | view + pause | full manager |
| Loyalty members, tiers, top-ups | cashier quick actions | full manager |
| Staff accounts + device registry | view | full manager |
| Analytics dashboard + exports | live dashboard | full manager + exports |
| Chain stores + product templates | view | full manager |
| Chain dashboard, bulk operations | view | full manager |
| Inventory, suppliers, purchase orders | view | full manager |
| Staff shifts, attendance, approvals | view | full manager |
| Integrations, webhooks, scheduled reports | view | full manager |
| CRM segments + journeys | view | full manager |

## Stack summary

- App: Expo SDK (React Native 0.86, React 19), TypeScript, expo-router navigation, expo-secure-store for tokens, expo-notifications for push (native), MSW dev mocks behind per-module switches.
- Web: static export of the same Expo app (`expo export --platform web`) — no separate Vite/react-router/TanStack stack.
- Tests: `node:test` + esbuild suites (`tests/run.mjs`, 26 suites in CI), MSW parity + contract suites; E2E via Playwright (`tests/e2e/web-e2e.mjs`).
- Shared: API client typed against `@hudumika/contract` (types generated from `backend/API-CONTRACT.yaml`; the client is hand-rolled, not generated); i18n keys `en` first, `sw`-ready, `ar`-capable.
- Money: TZS integer minor units end-to-end, rendered with thousands separators. Never floats.

## Team documentation index

| Doc | Purpose |
| --- | --- |
| `PRODUCT.md` | Product specification (supported merchant types, modules, acceptance criteria) |
| `README.md` | This index |
| `ARCHITECTURE.md` | Project layouts, shared modules, navigation map, state, environment config |
| `API.md` | Every endpoint the merchant surfaces call, with request/response shapes and UI statuses |
| `NAVIGATION.md` | Navigation blueprint — shipped 7-tab layout (dashboard/orders/products/marketing/store/ops/profile) and the documented 5-tab deviation, screen trees mapped to endpoints, core flows |
| `MESSAGES.md` | Message center: customer conversations, platform messages, order dynamics, reviews |
| `ONBOARDING.md` | Application → verification flow, documents, commercial terms, store claiming |
| `MENU-CATALOGUE.md` | Catalogue management, publish workflow, price change handling |
| `ORDER-FLOW.md` | Order acceptance, status advancement, cancellation, dispute awareness |
| `EARNINGS.md` | Payout history, ledger statement, commission, cycles, holds |
| `PAYMENTS.md` | Settlement mechanics, refunds, payout account, TZS formatting |
| `NOTIFICATIONS.md` | Push setup, notification center, event-to-UI mapping, preferences |
| `LOCALIZATION.md` | i18n (en/sw/ar), bilingual microcopy, local time rendering |
| `SECURITY.md` | Token storage, staff permissions, role switching, masking, logout |
| `TESTING.md` | Unit/component/contract/E2E strategy and per-screen checklist |
| `DEPLOYMENT.md` | EAS builds, web deploy, environments, channels, rollback |
| `ROADMAP.md` | P0–P7 phased plan (incl. P6b–P6e) aligned with root `docs/ROADMAP.md` |
| `STORE-MANAGEMENT.md` | Store settings, open/close, closure protection, payment account, printing |
| `DINE-IN.md` | Tables, QR ordering, bill lifecycle, reservations, dual-screen POS |
| `GROUP-BUY.md` | Deal lifecycle, vouchers, manual + QR verification, extension/re-list |
| `PROMOTIONS.md` | Campaign types, lifecycle, budget, performance, coupon campaigns |
| `MEMBERSHIP-LOYALTY.md` | Loyalty members, top-up rewards, tiers, member transactions |
| `STAFF-AND-DEVICES.md` | Staff roles/permissions, device registry, printer queue |
| `ANALYTICS.md` | Dashboard, traffic, products, revenue, benchmarks, exports |
| `SETTINGS.md` | Order alerts, acceptance method, phone ordering, language, quick actions |
| `MULTI-STORE.md` | Chain stores, per-store settings, product templates, menu sync, chain dashboard/analytics/reports, bulk operations |
| `VERTICALS.md` | Industry strategy: surface mapping, per-vertical capabilities and gaps, out-of-scope list |
| `INVENTORY-SUPPLY-CHAIN.md` | Master inventory, stock adjustments, alerts, sync config, suppliers, purchase orders, supplier returns |
| `INTEGRATIONS-WEBHOOKS.md` | Integration registry, outbound webhooks, delivery health, admin health view |
| `ENTERPRISE-FINANCE.md` | Chain financial view, consolidated exports, corporate payment controls, audit posture |
| `ENTERPRISE-STAFF.md` | Shifts, attendance, performance, commission rules, approval workflow engine |
| `CRM.md` | Customer segments, automated journeys, omnichannel note, privacy rules |
| `AI-AUTOMATION.md` | AI diagnostics (phased), scheduled reports, planned AI capabilities (honest) |
| `ENTERPRISE-COVERAGE.md` | Bullet-by-bullet audit of the enterprise checklist — every item, its status (live/planned/out of scope) and its doc reference |
| `TASKS-RISK.md` | Tasks center (anomalies, violations, activities, setup guide), risk events, merchant audit view |
| `PRIVACY-ACCOUNT.md` | Change password, session management, privacy export, account deletion |
| `OPERATIONS-COVERAGE.md` | Bullet-by-bullet matrix of the Meituan merchant operations checklist (120 operations across 16 sections) — status per operation + doc reference + count table |
| `EDUCATION-SUPPORT.md` | Marketing academy, operation tips, service center, feedback, FAQ, enterprise onboarding |

## Source documents (read before changing anything)

- `docs/SHARED-FLOWS.md` — account/role, payment, cancellation, notification, review rules.
- `docs/GLOSSARY.md` — vocabulary; use these terms exactly (Merchant, Catalogue, Ledger, Payout, Dispute, Ticket, MSW, Contract).
- `docs/DESIGN-SYSTEM.md` — tokens and components; the merchant app implements them as its single shared `src/components` kit (there is no separate `new-public_web` build).
- `backend/API-CONTRACT.yaml` — the only source of endpoint names, schemas, statuses, and error codes.
- `backend/AUTH.md`, `backend/PAYOUTS-LEDGER.md`, `backend/NOTIFICATIONS.md`.

## Standing rules

- No endpoint, field, or status beyond the Contract; propose contract changes first.
- No hardcoded URLs, phones, emails, or ratings — environment-driven config only.
- Every screen implements loading, empty, error, retry, and success states.
- English first release; Swahili-ready and Arabic-capable copy keys.
