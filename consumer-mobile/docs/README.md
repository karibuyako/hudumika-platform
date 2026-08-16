# HUDumika Customer App — Documentation Index

## Overview

The customer app is the mobile-only client of HUDumika (Swahili for "service"). It supports two
transaction types defined in `PRODUCT.md`:

- **Order** — buying products/meals from a Merchant, delivered by a Rider.
- **Booking** — appointing a skilled Provider (plumber, electrician, cleaner, repairer) to the
  customer's address.

The app never re-implements business logic. The backend (`backend/API-CONTRACT.yaml`) is the single
source of truth for endpoints, schemas, statuses, and error codes; the client renders them.
Super-app features (P6b–P6d) extend ordering with dine-in, group buy, coupon wallet, membership,
and favorites.

## Team documentation index

| Doc | Purpose |
| `MASTER-BLUEPRINT.md`
| `OPERATIONS-COVERAGE.md` | All 140 core consumer operations mapped to endpoints, blueprint sections, priority, and status | The complete build specification — every module, screen, state, transition, API dependency, permission, realtime event, and backend entity |
| --- | --- |
| `PRODUCT.md` | Product spec: navigation, flows, acceptance criteria (do not modify) |
| `ARCHITECTURE.md` | Expo project layout, navigation map, state, API client, env config |
| `API.md` | Every endpoint the app calls, grouped by feature, with UI statuses |
| `ORDER-FLOW.md` | Product order lifecycle: browse → cart → checkout → payment → tracking |
| `BOOKING-FLOW.md` | Service booking lifecycle: search → provider → schedule → pay → confirm |
| `PAYMENTS.md` | Checkout UX per method, intents, error codes, idempotency, TZS breakdown |
| `NOTIFICATIONS.md` | Push setup, in-app center, per-event UI mapping, preferences |
| `LOCALIZATION.md` | i18n architecture (en first, `sw` ready, `ar` capable) |
| `SECURITY.md` | Token storage, sessions, privacy, payment data, deep links |
| `TESTING.md` | Unit, component, MSW contract, E2E tests + per-screen checklist |
| `DEPLOYMENT.md` | EAS builds, TestFlight/Play releases, channels, rollback |
| `ROADMAP.md` | Phased plan aligned with `functionalities/ROADMAP.md` P0–P7 |
| `REVIEWS.md` | Review creation after completion, rating UI, abuse reporting |
| `DINE-IN.md` | QR menu ordering (`hudumika:dinein:table:{id}`), bill flow, table reservations |
| `GROUP-BUY.md` | Group buy deals, voucher wallet, redemption, expiry/refund rules |
| `WALLET-COUPONS.md` | Coupon claim + wallet, checkout application, red packets (planned) |
| `MEMBERSHIP.md` | Platform membership (points/levels), merchant loyalty, consent |
| `CHAT.md` | 1:1 customer ↔ merchant chat, threads, unread badge, archive, blocked state |

Shared docs (read first): `../SHARED-FLOWS.md` (business rules), `../GLOSSARY.md` (vocabulary),
`../DESIGN-SYSTEM.md` (tokens/components), `../ROADMAP.md` (cross-team milestones).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Expo SDK (managed), React Native, TypeScript strict |
| Navigation | React Navigation (native stack + bottom tabs), deep links via Linking |
| Data fetching | TanStack React Query + Zustand (see `ARCHITECTURE.md`) |
| i18n | i18next + `expo-localization` (en first, `sw` ready, `ar` capable) |
| Secure storage | `expo-secure-store` only for tokens (never AsyncStorage) |
| Push | Expo Push Service (FCM/APNs behind it), token per user |
| API mock (dev) | MSW mirroring `backend/API-CONTRACT.yaml` |
| Builds | EAS (dev/staging/prod channels) |

## Key responsibilities

- OTP login (phone/email), session management, role-aware surface redirect.
- City picker + service-area selection; saved addresses and landmarks.
- Discover Merchants and Providers; browse catalogues; search across restaurants, shops, services.
- Ordering products: cart → checkout → payment (M-Pesa, Tigo Pesa, Airtel Money, card, COD) → tracking.
- Booking services: provider selection → schedule → pay → status timeline → completion confirmation.
- Dine-in: QR menu at the table, open bill → pay → close, table reservations.
- Group buy: deal purchase, voucher wallet + redemption display; coupons: claim, wallet, checkout discount.
- Favorites (saved merchants), platform membership (points/levels), merchant loyalty with consent.
- Order/booking history, status timelines from `events`, live rider tracking.
- Reviews after delivery/completion, abuse reporting.
- Support tickets per order/booking; notification center and preferences.
- Every screen ships loading / empty / error / retry / success states.

## Standing rules (from shared docs)

- Use exact statuses, paths, and codes from `backend/API-CONTRACT.yaml` — never invent endpoints.
- All money is TZS integer units; display with thousands separators (`TZS 12,500`).
- No hardcoded URLs, phones, emails, ratings, or store links — environment-driven config only.
- Every mutation sends an `Idempotency-Key`.
- Swahili microcopy may appear as trust chips and footnotes only.
