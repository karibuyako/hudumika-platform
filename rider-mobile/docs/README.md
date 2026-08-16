# HUDumika RIDER — Mobile App

Delivery partner app for HUDumika. Mobile-only (Expo/React Native, TypeScript). Riders transport products and eligible parcels for orders; the app never handles home-service jobs (those belong to the provider app).

## Overview

The rider app covers the full delivery partner lifecycle:

- Onboarding: application, document upload (National ID, driver's licence, vehicle registration/photo, health certificate, insurance), vehicle selection, background check + verification state tracking, face verification (AI selfie, planned).
- Availability: explicit online/offline state (`PUT /riders/me/availability`).
- Assignments: server-pushed dispatch offers with a 120-second acceptance window, reject-reasons catalog, grab-mode available-orders feed (per-city config), in-transit transfer requests, batch/group-order pickup, batch trips (multi-stop with manual reorder), priority tagging (`Order.priority` `normal`/`express`/`vip` — VIP/express first), promo orders (`Order.promoCode` — bonus on completion).
- Delivery: 7-stage status progression (arrival at pickup/drop-off), proof of delivery (photo/signature/OTP, item-wise confirmation, PDF attachment, drop-off options `hand_to_customer` / `leave_at_door` — leave-at-door requires a GPS-stamped photo POD), failed delivery → return-to-origin, rescheduling, QR/cash COD collection with reconciliation, mid-delivery add-items, live trip sharing.
- Fleet management (Phase 2): task hold, demand heat zones with surge multipliers, fare escalation, shift swap + breaks, rest reminders.
- Performance (Phase 2): scorecard with benchmarks and trends, live leaderboards.
- Safety: SOS button to dispatch + safety ops with acknowledgment; battery-efficient location reporting; trip sharing privacy.
- Money: earnings dashboard, ledger statement, payout status, missions/incentives with rewards, surge/boost breakdown, TZS formatting.
- Engagement: ratings, support tickets, notifications, business mapping (`RiderPrivate.merchantIds`), role-based access.
- Enterprise readiness: production-readiness matrix mapping every Uber/Meituan category (real-time core, dispatch, GPS, payments, safety, notifications, offline resilience, background services, modular architecture, testing, analytics, communication, advanced features) to LIVE/PLANNED status — `ENTERPRISE-READINESS.md`; this pass adds masked calls and destination/rating filters as live, with crash monitoring and smart replies planned.
- Learning and compliance: academy courses, reliability penalties and appeals (planned).
- Vehicle & tools (blueprint pass, live in the contract): vehicle maintenance with predictive `nextDueAt`, rider expenses with deductible tracking + receipts, weekly goals & schedule, async export reports (tax/earnings/trips as CSV/PDF/JSON), training center with certificates + rewards, trusted contacts, security score, help-center knowledge base.
- Deep-pass (Uber-driver blueprint, live in the contract): rider preferences (sounds, auto-accept, long-distance, data saver `wifiOnlyMaps`, destination filters, language — `GET/PUT /riders/me/preferences`), paid restaurant waiting (`waitSeconds` + `FareBreakdown.waitPayTZS` + `itemsChecked`), AI suggested positioning areas (`suggestedAreas[]`), claimable mission rewards (`canClaim`), typed fraud signals, backend push outbox, offline chat queue (`chat_send` via sync/batch) — documented in DISPATCH-FLOW.md, DELIVERY-FLOW.md, EARNINGS.md, PERFORMANCE.md, SECURITY.md, ARCHITECTURE.md.

Key principles from `PRODUCT.md`: no order picking (server assigns), earnings computed server-side, customer phone never exposed directly, payout failures visible and actionable.

## Team documents

| Document | Content |
| --- | --- |
| `PRODUCT.md` | Product spec (source of truth — do not modify) |
| `ARCHITECTURE.md` | Project layout, navigation map, state, API client, config, background services, offline sync engine, data saver, push outbox, offline chat queue |
| `NAVIGATION.md` | Screen blueprint: onboarding, bottom tabs, delivery flow, core flows (shift clock-in/out, tips), preferences, suggested-area chips, claimable missions |
| `API.md` | Every endpoint the rider app calls, from `backend/API-CONTRACT.yaml` |
| `ONBOARDING.md` | Application → verification → approval flow |
| `EDUCATION.md` | Academy: road safety, vehicle maintenance, delivery etiquette, navigation (planned) |
| `DISPATCH-FLOW.md` | Online state, assignment lifecycle, task hold, heat zones + surge, fare escalation, grab-mode available-orders feed, batch/group orders, batch trips + manual reorder, priority tagging, promo orders, reject reasons, transfer, location reporting, missions, rest reminders + breaks, preferences (auto-accept/long-distance/destination filters), suggested positioning areas |
| `DELIVERY-FLOW.md` | 7-stage status progression, POD (item-wise + PDF), paid restaurant wait timer (`waitSeconds`/`waitPayTZS`), item verification (`itemsChecked`), add-items, trip sharing, completing a batch trip, failed delivery/RTO, reschedule, COD + QR collection |
| `PENALTIES-APPEALS.md` | Reliability penalties, warning thresholds, appeals flow (planned) |
| `EARNINGS.md` | Earnings dashboard (incl. avg per trip + top hours), per-order fare breakdown (incl. wait-pay, surge/boost), ledger, zone boosts, trip batch earnings, promo order bonuses, payouts, missions and incentives (claimable rewards), rider level benefits |
| `PERFORMANCE.md` | Scorecard (acceptance/on-time/rating/safety/reliability), avg per trip + online hours + best hours, rider star level (bronze/silver/gold/platinum) with benefits, benchmarks vs team/fleet + percentile, trends, leaderboards (Phase 2) |
| `PAYMENTS.md` | Delivery fee computation, payout method setup, COD + QR collection |
| `NOTIFICATIONS.md` | Push setup, event → UI mapping (incl. SOS, missions, exceptions) |
| `LOCALIZATION.md` | i18n, local time, maps integration |
| `VEHICLE-TOOLS.md` | Vehicle maintenance, expenses, schedule & goals, export reports, training center (all live in the contract) |
| `SECURITY.md` | Tokens, location permission + sharing policy, SOS, trusted contacts (emergency-contact notification flag), security score, typed fraud signals, role separation, device loss |
| `TESTING.md` | Jest/RNTL/MSW/Detox strategy, per-screen checklist (incl. wait-pay, auto-accept, suggested areas, mission claim, offline chat replay) |
| `DEPLOYMENT.md` | EAS builds, store releases, environments, versioning |
| `ROADMAP.md` | Phased delivery aligned with the cross-team roadmap P0–P7 + P10/P10b/P10c rider ops + fleet management |
| `LONG-HAUL-RELAY.md` | Intercity / line-haul / relay operating manual: transport modes, consignment workflow (manifest + segregation sections), handoffs (scan + seal + photo + custody), waybill trail, multi-day trips, relay meeting points, security duties |
| `ENTERPRISE-READINESS.md` | Production-readiness matrix: every Uber/Meituan requirement mapped to LIVE/PLANNED status |

## Phase 2 (intermediate) additions

Fleet management slice (ROADMAP P10c, contract live in `backend/API-CONTRACT.yaml`): task hold/unhold, demand heat zones + surge multipliers, fare escalation, shift swap and breaks, performance scorecard + leaderboards, trip sharing, mid-delivery add-items, item-wise POD + PDF attachments, employment type + availability preferences, role-based access per business mapping, batch trips (multi-stop with drag-and-drop stop reorder and `trip.completed` batch earnings), priority tagging and promo orders (same P10c slice), rich-media in-app chat (image/document/voice/location pins), rider star level (`RiderPerformance.level` bronze → platinum with config-driven `levelBenefits[]`). Planned: behavior scoring (telemetry), WhatsApp integration, data compression, business-specific branded workflows, automated route optimization. Admin-side Phase-2 surfaces (manual override assignment, rider COD reconciliation) live in `admin-web/` docs and are staff-only.

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Expo SDK (managed), React Native |
| Language | TypeScript (strict) |
| Navigation | React Navigation (native stack + bottom tabs) |
| State | Server-state via TanStack Query; auth/online state via context + secure storage |
| API | Typed client generated from `backend/API-CONTRACT.yaml`; MSW in dev |
| Testing | Jest, React Native Testing Library, MSW contract tests, Detox E2E |
| Distribution | EAS Build / EAS Submit (TestFlight, Play internal track) |

## Key responsibilities

1. **Online/offline state** — the rider is only eligible for dispatch when online; state is server-owned (`RiderPrivate.online`), never local-only.
2. **Accepting assignments** — offers arrive as `order.rider_assigned` push + in-app events; accept/reject within 120 s.
3. **Deliveries** — advance `rider_arrived_pickup` → `picked_up` → `delivering` → `rider_arrived_dropoff` → `delivered` via `POST /orders/{orderId}/status` with POD and exception flows (failed delivery/RTO, reschedule, transfer); up to 3 active deliveries.
4. **Earnings** — delivery fee entries land in the ledger on `delivered`; mission rewards land as `bonus` entries; payouts via nightly batch.
5. **Batch trips** — active trips surface the multi-stop sequence with per-stop status; riders drag-and-drop reorder until completion; `trip.completed` summarizes batch earnings (fares + tips + bonuses); VIP/express priority and promo bonuses are server-driven.

## Shared rules (apply everywhere)

- Use status strings, endpoints, and error codes exactly as in `backend/API-CONTRACT.yaml`. Never invent endpoints.
- Money is TZS integer minor units; render with thousands separators (`TZS 12,500`), never floats.
- No hardcoded URLs, phones, or emails — environment-driven config only (`EXPO_PUBLIC_API_URL`).
- Every screen has loading / empty / error / retry / success states.
- English first release, Swahili-ready (`sw`), Arabic-capable (`ar`).
