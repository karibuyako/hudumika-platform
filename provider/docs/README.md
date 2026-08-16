# HUDumika Provider

The provider platform is the **three-sided ecosystem** for skilled services: customers (homeowners/businesses) find and book, providers (individual technicians, small businesses, contracting firms) take jobs and get paid, and platform admins manage onboarding, quality, and disputes — a distinct supply-side operating system from the merchant domain.
 Application

Documentation for the Provider app: skilled professionals (plumbing, electrical, cleaning, appliance/AC repair, painting, carpentry, moving, laundry, beauty, pest control, and future approved trades) who offer services at the customer's location.

## Dual ecosystem

Providers are skilled-service businesses, distinct from food merchants (the Meituan "Dianping Manager" model): they run a service catalog with quotes, proof of service, parts and invoicing, warranties, a technician fleet, parts inventory, B2B contracts with SLAs, recurring plans, and a trust/verification surface — documented in `SERVICE-CATALOG.md`, `TECHNICIANS.md`, `INVENTORY-MATERIALS.md`, `CONTRACTS-SLA.md`, and `TRUST-SAFETY.md`. Provider onboarding, data, and flows never mix with the merchant surface.

The provider app is a **provider operating system**: a distinct supply-side surface with a job state machine (matching → offered → … → settled), a job marketplace with transparent matching, and capability-based team roles — see `NAVIGATION.md` (the app blueprint) and `ROADMAP.md` P9b.

## Two surfaces, one feature set

| Surface | Tech | Primary use |
| --- | --- | --- |
| Provider mobile app | Expo (React Native + TypeScript) | Booking alerts (push), navigation, job status on the move, customer communication, photos |
| Provider web dashboard | React + Vite + TypeScript | Profile, calendar/availability, services, pricing, earnings and statements, tickets |

Both surfaces share the same feature set and the same API contract. The web dashboard is the desktop surface; the mobile app is the field surface.

## Team documentation index

| Doc | Purpose |
| --- | --- |
| `README.md` | This index |
| `NAVIGATION.md` | App blueprint: auth, main tabs, job marketplace, job machine, quotes, team & permissions, screen states |
| `PRODUCT.md` | Product spec (source of truth, do not edit) |
| `ARCHITECTURE.md` | Repo layouts, shared modules, navigation map, state, environment config |
| `API.md` | Every endpoint the provider app calls, with request/response references |
| `ONBOARDING.md` | Application, verification (VerificationState), documents, trade/service areas, reliability score |
| `EDUCATION.md` | Academy: per-trade courses, certification milestones, operations tips (planned) |
| `AVAILABILITY.md` | Weekly schedule (`AvailabilityWindow`), toggle semantics, matching rules |
| `BOOKING-FLOW.md` | Job lifecycle (job machine): marketplace offer → accept → schedule → en route → arrive → diagnose → quote → work → confirm → settle → payout; photos, quote gate, proof of service, on-site payment, follow-up |
| `SERVICE-CATALOG.md` | Service listings, dynamic category configuration + intake questionnaire, upfront estimates, quote flow, final invoicing, parts recording, service warranties |
| `TECHNICIANS.md` | Technician team CRUD, dispatcher console + assignment, capacity management (planned), tool/equipment assignment, rating aggregation |
| `EARNINGS.md` | Earnings dashboard, ledger statement, commission, payout cycle, dispute holds, quality signals and tiers, recurring settlement |
| `PAYMENTS.md` | Settlement mechanics, payout methods, refund awareness, TZS formatting |
| `INVENTORY-MATERIALS.md` | Parts/materials/equipment inventory: stock + thresholds, adjustments, auto-deduction on parts use, tool assignment per technician, material flow |
| `CONTRACTS-SLA.md` | B2B service contracts with SLAs (response/resolution deadlines, escalation), recurring service plans, SLA enforcement on bookings |
| `TRUST-SAFETY.md` | Trust profile and tiers, risk flags, document service, provider verification engine, home-entry safety, multi-dimensional ratings → matching |
| `NOTIFICATIONS.md` | Push setup, notification center, per-event UI mapping, preferences |
| `LOCALIZATION.md` | i18n (en first, sw ready, ar capable), bilingual microcopy, local time |
| `SECURITY.md` | Token storage, role switching, masked fields, location privacy, logout |
| `TESTING.md` | Test strategy, MSW contract tests, per-screen state checklist |
| `DEPLOYMENT.md` | EAS builds, web deploy, environments, releases, rollback |
| `ROADMAP.md` | Phased plan aligned with the cross-team ROADMAP (P0–P7) |

## Verticals

The provider surface serves 10+ service verticals through the `ProviderApplication.trade` enum (15 trades + `other`): home services, beauty, wellness, fitness, education, automotive, pet care, health care, events, and property. Vertical mapping, service packages, and per-vertical plans live in `VERTICALS.md`.

## Shared sources of truth

- `../../backend/API-CONTRACT.yaml` — the only source of endpoint names, schemas, statuses, and error codes. Never invent endpoints; propose contract changes first.
- `../SHARED-FLOWS.md` — cancellation, payment, review, and notification business rules.
- `../GLOSSARY.md` — vocabulary (Provider, Booking, Acceptance window, Reliability score, Payout, Ledger, Dispute, TZS...). Use these terms exactly.
- `../DESIGN-SYSTEM.md` — tokens and shared component kit for both surfaces.

## Stack summary

- Mobile: Expo SDK, React Native, TypeScript, `expo-secure-store`, Expo Push Service, React Navigation.
- Web: React 19, Vite, TypeScript, Tailwind (v4 via `@tailwindcss/vite`), react-router.
- Data: server state libraries over the contract API; `Idempotency-Key` on all mutations that create payment/lifecycle records.
- Testing: Jest + React Native Testing Library (mobile), Vitest + Testing Library (web), MSW in dev for both.
- Mocks: MSW handlers must mirror `backend/API-CONTRACT.yaml` 1:1 (MSW parity); swap in the real API behind `EXPO_PUBLIC_API_URL` / `VITE_API_URL` without UI changes.

## Standing rules

- Money is TZS, integer minor units, rendered with thousands separators (`TZS 12,500`); never float amounts.
- No hardcoded URLs, phones, emails, or ratings anywhere — environment-driven config only.
- Every screen implements loading, empty, error, retry, and success states.
- Timestamps are UTC ISO 8601 from the API; always render local time.
