# HUDumika Functional Product Specification

This folder documents the future HUDumika applications. The public web remains a marketing and routing layer only.

## Application boundaries

| Application | Audience | Surface | Team docs |
| --- | --- | --- | --- |
| Customer app | Customers | Mobile only | `customer/` |
| Merchant app and web | Restaurants, shops, businesses | Mobile and web | `merchant/` |
| Provider app and web | Plumbers, electricians, cleaners, repair professionals and other service providers | Mobile and web | `provider/` |
| Rider app | Delivery partners | Mobile only | `rider/` |
| Admin web | Internal HUDumika operations | Private web, never linked publicly | `admin-web/` (repo root) |
| Backend API | All applications | Private service layer | `backend/` (repo root) |

## Team documentation index

### Shared (this folder)

| Doc | Purpose |
| --- | --- |
| `README.md` | This index + boundaries + principles |
| `SHARED-FLOWS.md` | Account, address, payment, cancellation, notification, review rules |
| `GLOSSARY.md` | Shared vocabulary — read before writing any doc or code |
| `DESIGN-SYSTEM.md` | Color tokens, typography, components, motion, accessibility |
| `ROADMAP.md` | Cross-team milestones and dependencies |

### Backend (`backend/`)

`API-CONTRACT.yaml` (OpenAPI — the single source of truth), `README.md`, `ARCHITECTURE.md`, `DATA-MODEL.md`, `AUTH.md`, `PAYMENTS.md`, `PAYOUTS-LEDGER.md`, `DISPATCH.md`, `NOTIFICATIONS.md`, `REVIEWS-MODERATION.md`, `SUPPORT.md`, `AUDIT.md`, `ERROR-CODES.md`, `TESTING.md`, `DEPLOYMENT.md`, `ROADMAP.md`.

### Apps (`customer/`, `merchant/`, `provider/`, `rider/`)

Each app folder contains: `README.md` (index), `PRODUCT.md`, `ARCHITECTURE.md`, `API.md`, `PAYMENTS.md`, `NOTIFICATIONS.md`, `LOCALIZATION.md`, `SECURITY.md`, `TESTING.md`, `DEPLOYMENT.md`, `ROADMAP.md`, plus role-specific flow docs:

- Customer: `ORDER-FLOW.md`, `BOOKING-FLOW.md`, `REVIEWS.md`, `DINE-IN.md`, `GROUP-BUY.md`, `WALLET-COUPONS.md`, `MEMBERSHIP.md`, `CHAT.md`, `MASTER-BLUEPRINT.md`, `OPERATIONS-COVERAGE.md`
- Merchant: `ONBOARDING.md`, `MENU-CATALOGUE.md`, `ORDER-FLOW.md`, `EARNINGS.md`, `STORE-MANAGEMENT.md`, `DINE-IN.md`, `GROUP-BUY.md`, `PROMOTIONS.md`, `MEMBERSHIP-LOYALTY.md`, `STAFF-AND-DEVICES.md`, `ANALYTICS.md`, `SETTINGS.md`, `MULTI-STORE.md`, `EDUCATION-SUPPORT.md`, `NAVIGATION.md`, `MESSAGES.md`, `VERTICALS.md`, `INVENTORY-SUPPLY-CHAIN.md`, `INTEGRATIONS-WEBHOOKS.md`, `ENTERPRISE-FINANCE.md`, `ENTERPRISE-STAFF.md`, `CRM.md`, `AI-AUTOMATION.md`, `ENTERPRISE-COVERAGE.md`, `OPERATIONS-COVERAGE.md`, `TASKS-RISK.md`, `PRIVACY-ACCOUNT.md`
- Provider: `ONBOARDING.md`, `AVAILABILITY.md`, `BOOKING-FLOW.md`, `EARNINGS.md`, `EDUCATION.md`, `VERTICALS.md`
- Rider: `ONBOARDING.md`, `DISPATCH-FLOW.md`, `DELIVERY-FLOW.md`, `EARNINGS.md`, `EDUCATION.md`, `PENALTIES-APPEALS.md`, `NAVIGATION.md`

### Admin web (`admin-web/`)

`MASTER-BLUEPRINT.md` (full build spec) + `OPERATIONS-COVERAGE.md` (350+ operations mapped) join the doc set below.

`README.md`, `MODULES.md`, `ROLES-PERMISSIONS.md`, `WORKFLOWS.md`, `SECURITY.md`, `ARCHITECTURE.md`, `API.md`, `AUDIT.md`, `TESTING.md`, `DEPLOYMENT.md`, `ROADMAP.md`.

## Product principles

- Customers can order products or book services.
- Merchants can sell products, meals, groceries, pharmacy items, retail products, tickets, and other approved goods.
- Providers can offer appointment-based or on-demand services.
- Riders deliver products and eligible documents or parcels.
- Home-service providers complete jobs; riders do not replace skilled providers.
- Money is held and released according to order or booking completion rules.
- Every role has explicit permissions and separate navigation.
- All important actions must have loading, empty, error, retry, and success states.

## Core statuses

### Order

`draft` → `pending_payment` → `paid` → `merchant_accepted` → `preparing` → `rider_assigned` → `picked_up` → `delivering` → `delivered` → `completed`

Alternative terminal states: `cancelled`, `refunded`, `failed`, `disputed`.

### Booking

`draft` → `pending_payment` → `paid` → `provider_requested` → `provider_accepted` → `scheduled` → `provider_arrived` → `in_progress` → `awaiting_customer_confirmation` → `completed`

Alternative terminal states: `declined`, `cancelled`, `refunded`, `disputed`, `no_show`.

## Shared requirements

- Phone and email verification.
- City and service-area selection.
- Saved addresses and location permissions.
- M-Pesa, Tigo Pesa, Airtel Money, cards, and optional cash-on-delivery.
- Reviews and ratings with moderation.
- Customer support ticket creation.
- Notification preferences.
- Audit history for money, status, identity, and moderation actions.
- Tanzanian currency represented as TZS.
- Swahili-ready copy architecture even when the first release is English.

## Public-web boundary

The public web may:

- Explain products and services.
- Show service categories and marketing content.
- Capture merchant, provider, and rider applications.
- Link to configured app stores when URLs are supplied through environment variables.
- Route visitors to future applications.

The public web must not:

- Contain private admin routes.
- Process real payments.
- Expose customer order history.
- Expose provider, merchant, or rider dashboards.
- Hardcode future production domains or app-store URLs.
