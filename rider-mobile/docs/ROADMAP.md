# HUDumika RIDER — Roadmap

Rider app phases aligned to `functionalities/ROADMAP.md` (P0–P7). Clients wait on the contract only; MSW mocks (`backend/API-CONTRACT.yaml`) keep the team unblocked until backend milestones ship.

## Phases

| Phase | Backend gate | Rider app deliverables |
| --- | --- | --- |
| **P0 — Foundations** | M1 auth + users | App scaffold (Expo + TypeScript + React Navigation), OTP login (`request-otp`/`verify-otp`), session refresh, city picker (`GET /cities`), design tokens from DESIGN-SYSTEM.md, i18n scaffolding (en + sw), MSW setup |
| **P1 — Marketplace** | M2 cities/services/leads/approvals | Rider application (`POST /riders`), document upload, vehicle selection (`motorcycle`/`bicycle`/`car`), delivery zone setup, verification status screen (`VerificationState` polling), `lead.reviewed` notifications |
| **P2 — Transactions** | M3 orders + payments | Order visibility groundwork: `GET /orders/me` + `GET /orders/{orderId}` (read-only for riders); no rider actions yet |
| **P3 — Bookings** | M4 bookings | None (bookings are provider-scoped; rider app confirms exclusion in UI) |
| **P4 — Dispatch** | M5 dispatch | Online/offline toggle (`PUT /riders/me/availability`), offer modal with 120 s acceptance window, accept/reject, pickup flow (`picked_up`), delivery navigation, `delivering` → `delivered` with proof of delivery, `track` read, up-to-3 active deliveries UI, background location task |
| **P5 — Money** | M6 payouts + ledger | Earnings dashboard (today/week/month), ledger statement (`GET /payouts/me/statement`), payout history + statuses (`pending`/`processing`/`paid`/`failed`/`exception`), TZS formatting, payout failure actionability, COD collection recording |
| **P6 — Engagement** | M7 reviews/support/notifications | Ratings view (`RiderPrivate.rating`/`reviewCount` + `review.received`), support tickets (create/list/detail/reply), notification center + preferences, push registration, event → UI mapping per NOTIFICATIONS.md, reliability score explanation |
| **P7 — Admin + launch** | M8 admin API + hardening | Release readiness: security hardening (SECURITY.md), store metadata, TestFlight + Play internal → production, contract test suites green against staging, audit-friendly logging |

## Delivery order within phases

1. P0: skeleton app with real OTP against MSW — unblocks all other lanes.
2. P1: onboarding end-to-end (application → approval simulation) — enables ops testing of `RiderAdmin`.
3. P4: online state → offer → delivery loop — the core product slice; demoable with MSW dispatch.
4. P5: earnings/payouts — required before any real-money pilot.
5. P6: engagement (tickets, notifications) — required before open release.
6. P7: release hardening and launch.

## Dependencies and rules

- Every phase depends on the contract, never a deployed backend (MSW parity is a test gate, TESTING.md).
- Standing rules from `ROADMAP.md` apply: contract-only endpoints, per-screen loading/empty/error/retry/success, idempotency-safe mutations, TZS formatting, English-first + Swahili-ready + Arabic-capable, environment-driven config only.
- Backend gates: M5 dispatch must land before P4 E2E against real backend; M6 before P5 real-data testing.

## Launch definition (rider-specific)

- App in stores (TestFlight + Play internal → production) on both platforms.
- Contract test suites green against staging.
- Dispatch, earnings, and payout flows QA-passed on staging; background location verified on-device.
- Payout failure visibility and support ticket flow confirmed with operations.

## Phase exit criteria

| Phase | Exit criteria |
| --- | --- |
| P0 | OTP login works against MSW + staging; navigation map wired; i18n en/sw present |
| P1 | A mock rider is approved via the app; verification states render correctly |
| P4 | Accept → pickup → delivered happy path passes Detox E2E (TESTING.md) |
| P5 | Statement and payout list match staging ledger; failed payouts actionable |
| P6 | Tickets and notifications end-to-end; preferences persist |
| P7 | Store builds green; rollback plan rehearsed; contract suite green on staging |

## Planned phases — education, penalties, and rider operations

Not part of the P0–P7 commitment; P10 depends on the rider-ops contract slice (already in `API-CONTRACT.yaml` — including tips and rider shifts, which land with the same slice; backend milestone note: dispatch/riders lane post-M9), while P8–P9 depend on contract additions flagged in `EDUCATION.md` and `PENALTIES-APPEALS.md`. P10b rides on the same dispatch/riders lane (grab-mode feed + fare endpoints already in `API-CONTRACT.yaml`; the rest is contract addition). P11b (intercity logistics) rides on the backend M11 logistics lane (spec in `backend/INTERCITY-LOGISTICS.md`). P12 (trust and experience) items are contract additions — all marked planned.

| Phase | Backend gate | Rider deliverables | Exit criteria |
| --- | --- | --- | --- |
| **P8 — Academy** | contract additions: course catalogue/progress, certificates, `course.certified`, business manager contact | Course catalogue (road safety, vehicle maintenance, delivery etiquette, city navigation), progress tracking, certificate screen, feedback via tickets | Road safety course completable end-to-end; certificate visible; `course.certified` notification delivered |
| **P9 — Penalties and appeals** | contract additions: penalty history, `penalty.issued` / `appeal.resolved`, appeal decision payload | Penalty detail + history, warning banners at thresholds, prefilled appeal ticket flow, decision view, score refresh on overrule | E2E: penalty → appeal ticket → decision → notification (TESTING.md) |
| **P10 — Rider operations** | rider ops slice in `backend/API-CONTRACT.yaml` (granular `OrderStatus` values, POD, exceptions, missions, SOS, transfer, tips, rider shifts, order-issue reasons) — backend milestone note: rider-operations endpoints land in the dispatch/riders lane post-M9 (see `backend/ROADMAP.md` milestone note and `backend/DATA-MODEL.md` rider-operations tables); planned: mission claim + daily mission bundles, facial recognition, safety training video + test (EDUCATION.md), in-app navigation, hotspots/heatmap | Full status granularity (`rider_arrived_pickup` → `picked_up` → `delivering` → `rider_arrived_dropoff` → `delivered`), POD photo/signature/OTP with `gpsStamp`, failed delivery → RTO (`failed_delivery` → `returning` → delivered-back), reschedule, transfer request (in-transit only), reject-reasons catalog, throttled location reporting, missions with progress + reward, SOS button with safety-ops acknowledgment, business mapping (`RiderPrivate.merchantIds`), QR collection presentation + cash reconciliation for COD, tips (`POST /orders/{orderId}/tip` → `tip` ledger credit + `tip.received`), rider shifts (`GET /riders/me/shifts?scope=` + clock-in/clock-out with COD cash reconciliation at clock-out, `shift.reminder` 15 min before, `shift.started`/`shift.ended`), order-issue reasons catalog (`GET /orders/issue-reasons` → report-issue ticket) | E2E: 7-stage delivery flow; failed delivery → RTO → returned; POD `POD_OTP_INVALID`; transfer on in-transit order; mission completion → `bonus` ledger credit; SOS → acknowledged; tip → `tip` ledger credit; shift clock-in → cash-mismatch clock-out (`SHIFT_CASH_MISMATCH`) → reconcile → `completed`; issue-report ticket from the reasons catalog (TESTING.md) |
| **P10b — Grab mode, batch orders, referral** | `GET /dispatch/available-orders` + `GET /orders/{orderId}/fare` live in `backend/API-CONTRACT.yaml` (same dispatch/riders lane as P10); planned (contract addition): grab-mode per-city rollout config, automated route optimization (batch multi-stop trips are live in the contract with manual reorder — P10c), rider referral program | Grab-mode "Available orders" feed (offer cards: pickup/drop-off, `distanceKm`, `estimatedEarningsTZS`, `itemsSummary`, `paymentMethod`, `expiresAt` countdown; `OFFER_NOT_FOUND` on expiry), per-order fare breakdown (`FareBreakdown` rows + deep-link from Delivery History; `FARE_NOT_AVAILABLE` hides the row), batch pickup card for grouped orders (existing 3-delivery cap; Meituan 并单/顺路单 pattern), referral program UI (planned — reward lands as a `bonus` ledger entry, PAYOUTS-LEDGER.md) | E2E: grab offer within radius → accept → assignment; offer expiry → `OFFER_NOT_FOUND`; fare breakdown for a completed order matches the ledger; `codFeeTZS` included on COD fare (TESTING.md) |
| **P10c — Fleet management, batch trips, priority** | fleet slice in `backend/API-CONTRACT.yaml` (task hold, heatmap, surge config + fare escalation, shift swap/break, rider performance + leaderboards, trip sharing, add-items, rest reminders) + batch trips (`trips` table, `GET /riders/me/trips` / `GET /riders/me/trips/{tripId}` / `POST /riders/me/trips/{tripId}/reorder`, `trip.completed`), `Order.priority` tagging + `Order.promoCode` promo orders (`PROMO_INVALID`) — backend milestone note: same dispatch/riders lane post-M9 (see `backend/ROADMAP.md`; `backend/DISPATCH.md` dynamic pricing/incentives; `backend/DATA-MODEL.md` order_holds, order_add_item_requests, trip_shares, shift_swap_requests, rider_performance/leaderboards views, trips); planned: behavior scoring, NLP chat, predictive notification timing, AR-glasses hands-free POD (out of scope v1) (telemetry consent), WhatsApp integration, data compression, business-specific branded workflows, automated route optimization | Task hold (`hold`/`unhold`, `HOLD_NOT_ALLOWED`/`HOLD_ALREADY_ACTIVE`), heat zones (`GET /dispatch/heatmap` demandLevel low/medium/high/critical + `surgeMultiplier` + active counts, positioning toward high-demand zones), surge/boost visibility on offers + fares (`FareBreakdown.surgeMultiplier`/`surgeTZS`), fare escalation after n declines (configurable step, cap), vehicle-type factor in dispatch scoring, rest reminders (`rest.reminder` + `break` start/end), shift swap requests (`pending`/`approved`/`declined`/`cancelled`), performance scorecard + benchmarks + trends, live leaderboards (`deliveries`/`rating`/`earnings`/`on_time` × `daily`/`weekly`/`monthly` + `myEntry`), trip sharing (recipients ≤ 5, `includeRoute`, token expiry), mid-delivery add-items (`pending_merchant_approval`), item-wise POD (`itemIds`) + PDF `documentUrl`, employment type + availability preferences (`full_time`/`part_time`, `preferredDays`/`preferredStart`/`preferredEnd`/`maxHoursPerDay`), role-based access per `merchantIds`, active batch trip + Trip summary (multi-stop route, per-stop `pending`/`arrived`/`done`/`failed`, batch `earningsTZS`), drag-and-drop stop reorder (`REORDER_INVALID`/`REORDER_NOT_ALLOWED`), priority badges + deadline/distance sorting (VIP/express first), promo bonus credited on completion | E2E: hold → unhold cycle; heat zone shows `surgeMultiplier`; add-items pending → approved → totals update; trip share token expiry; swap request → approved; break start/end; performance scorecard matches ledger; leaderboard `myEntry` rank; batch trip accept 2 orders → reorder stops → complete → `trip.completed` earnings summary; VIP order sorts first; promo code order → bonus credited; reorder blocked after completion (`REORDER_NOT_ALLOWED`) (TESTING.md) |

| **P11 — AI dispatch, safety, offline-first (Phase 3)** | M10a–M10c in `backend/ROADMAP.md`: M10a predictive dispatch (`GET /dispatch/forecast`, `DispatchOffer.predictedPrepMinutes`/`addressConfidence`, `TrackingEvent.stageEtas`, RL surge ramp), M10b AI safety + CV (`POST /riders/me/safety-events`, crash/fatigue escalation, `RiderShift.forcedRestUntil` + `REST_ENFORCED`, on-device POD verification + guided capture — planned), M10c offline-first + fleet enterprise (`POST /riders/me/sync/batch` + `GET /riders/me/sync/status`, fleet control tower in admin-web, retention-risk/predictive-maintenance models — planned) | Predictive Heat Map + surge-timing hints (DISPATCH-FLOW.md, EARNINGS.md), safety events + crash drill + mandatory rest UI (DELIVERY-FLOW.md), offline sync engine + indicator (ARCHITECTURE.md, NAVIGATION.md), `RiderPrivate.hubId`/`fleetType` display | E2E: 200-event offline backlog syncs with gap detection; crash drill end-to-end; fatigue → `forcedRestUntil` blocks offers; forecast returns zones with confidence (TESTING.md) |

| **P11b — Intercity & line-haul logistics (M11)** | backend M11 logistics lane (live in `backend/API-CONTRACT.yaml`, spec in `backend/INTERCITY-LOGISTICS.md`): `/hubs`, `GET /orders/{id}/route`, `GET /orders/{id}/waybill`, `POST /orders/{id}/legs/{legId}/advance`, `POST /orders/{id}/handoff`, `/linehaul/consignments` (+ depart/arrive), `Order.fulfillmentType`/`waybillNumber`/`routeSegments[]`, `RiderPrivate.transportMode`; third-party carrier registry (`/carriers`) is now contract-live — carrier-leg context surfaces ride on the deep logistics pass (P11d); planned: relay rollout config | Consignment workflow (create from orders → manifest with segregation sections → departure scan → arrival scan with `verifiedOrderIds`), handoff screen (scan + tamper-seal + condition photo + custody record), route/legs view with per-leg ETAs, waybill timeline, multi-day trip UI (Day-1/Day-2 phases, delivery-window promise), relay chain assignments at meeting points, transport-mode role views (`TRANSPORT_MODE_INVALID` guard) | E2E: create → depart → arrive with full manifest verified; missing order `CONSIGNMENT_MISSING_ORDERS`; seal broken `HANDOFF_SEAL_BROKEN`; relay handoff; transport-mode mismatch (TESTING.md) |

| **P11c — Logistics OS (M11b)** | backend Logistics OS lane (live in `backend/API-CONTRACT.yaml`, definitive spec in `backend/LOGISTICS-OS.md`): `/shipments` (+ `/{id}`/`/{id}/custody`/`/{id}/scan`), `/containers`, `/vehicles` (+ `/{id}`), `/routes`, `/trips` (+ `/{id}` PATCH advance), `/linehaul/consignments/{id}/reconcile` + `/replan`, admin `/admin/logistics/control-tower` | Shipment workflow (create from order → package pickup scan → container load/seal → vehicle load), Trip operating surface (manifest summary; START LOADING → DEPART → ARRIVE → UNLOAD), multi-factor handoff verification (`HANDOFF_VERIFICATION_FAILED`), custody ledger view, capacity/compartments (`COMPARTMENT_INCOMPATIBLE`), reconciliation duty (`RECONCILIATION_FAILED` → find missing → close trip), replan duty (`PLAN_NOT_MUTABLE` once departed), specialized courier surfaces (minimum information), anomaly awareness (`SCAN_GPS_MISMATCH`/`SCAN_VEHICLE_STATIC`) | E2E: shipment → scan → seal → trip load/depart/arrive → reconcile; wrong-vehicle handoff blocked; incompatible load rejected; replan after breakdown (TESTING.md) |

| **P11d — Deep logistics pass** | backend deep logistics lane (live in `backend/API-CONTRACT.yaml`; definitive spec `backend/LOGISTICS-OS.md` sections 16–25): `Order.dispatchStrategy`/`fulfillmentSource`, `RiderPrivate.serviceModel`/`fleetAccountId`, `Vehicle.capacity.maxWeightKg`/`maxVolumeL` + per-compartment `usedWeightKg`/`usedVolumeL`, `Package.attributes.weightKg`/`volumeL`, `/warehouses` (+ `/{id}`/`/{id}/stock`/`/{id}/fulfill`), `/carriers` (+ `/{id}`), `/facilities` (+ `/{id}/whitelist`), `/fleet/accounts` (+ `/{id}`), `/delivery-exceptions` (+ `/{id}`), admin `/admin/shipments/{id}/reassign` + `/escalate` | Rider app deliverables: service-model surfaces (`specialized` guaranteed-hours card, `crowdsourced`/`errand` grab feed, `fleet` badge + linkage chip — profile fields only, never editable), facility whitelist status screen + geofenced entry scan (`NOT_WHITELISTED` block + "Request access"), exception report/status screens (18-kind catalog, `open → resolving → resolved/escalated`, `autoReplanned` banner on `plan.replanned`/`plan.optimized`), weight/volume capacity bars on the trip cargo summary + inline `CAPACITY_WEIGHT_EXCEEDED`/`CAPACITY_VOLUME_EXCEEDED` blocks, warehouse pickup context (`fulfillmentSource: warehouse` renders the warehouse pickup point), carrier handoff context (`Consignment.carrierId` + `carrier.handoff_required`); admin-only registries (`/warehouses`, `/carriers`, `/facilities`, `/fleet/accounts`, reassign/escalate) are never called by the app | E2E: whitelisted entry + `NOT_WHITELISTED` blocked; exception report → resolve; auto-replan banner after breakdown; weight-capacity rejection; fleet sub-account provisioning visibility (TESTING.md D1–D7) |

| **P12 — Trust and experience (planned)** | contract additions, all items planned: encrypted in-trip recording (opt-in, end-to-end encrypted, metadata-only upload — SECURITY.md), face verification (AI selfie liveness, EDUCATION.md, ONBOARDING.md), background-check automation (verification statuses), smart replies NLP (chat), in-app navigation (turn-by-turn), real-time translation (chat) | App surfaces render only when the backend contract lands; every item stays marked planned until shipped — no fabricated UI for planned features | E2E per shipped slice (TESTING.md); pending gates block going online (verification, background check) |

Model status honesty per `backend/AI-LAYER.md`: contract fields (forecast, prep-time, stage ETAs, safety events) are live; model quality and scale targets are backend-tracked; telemetry-based features (behavior score, POD verification pipeline, retention risk) are planned.

## Logistics OS phase — complete deliverable list (P11b + P11c)

Backend gate: M11 logistics lane + M11b Logistics OS lane (live in
`backend/API-CONTRACT.yaml`; definitive spec `backend/LOGISTICS-OS.md`, legacy
`backend/INTERCITY-LOGISTICS.md`). Split into two delivery slices with their own
exit criteria.

### P11b — Intercity & line-haul logistics (M11)

Endpoints: `/hubs`, `GET /orders/{id}/route`, `GET /orders/{id}/waybill`,
`POST /orders/{id}/legs/{legId}/advance`, `POST /orders/{id}/handoff`,
`/linehaul/consignments` (+ depart/arrive), `Order.fulfillmentType`/
`waybillNumber`/`routeSegments[]`, `RiderPrivate.transportMode`.

Deliverables:

1. Consignment workflow — create from orders (`POST /linehaul/consignments`
   with hub pickers from `GET /hubs`, `transportMode` picker
   `van|linehaul_bus|linehaul_truck`); manifest grouped by segregation section
   (`standard|fragile|cold_chain|documents|high_value`) with per-order
   `waybillNumber` + `scannedIn`/`scannedOut`; departure scan → `in_transit` +
   `departedAt`; arrival scan with `verifiedOrderIds` (must equal the manifest;
   `CONSIGNMENT_ORDER_MISMATCH` difference list; `CONSIGNMENT_MISSING_ORDERS`
   exception banner → ops runbook).
2. Handoff screen — barcode scan (`scanCode`) → tamper-seal check
   (`sealIntact`) → condition photo → custody record (`from`/`to`/`at`);
   `HANDOFF_SEAL_BROKEN`/`HANDOFF_SCAN_MISMATCH` block the leg + flag ops.
3. Route/legs view — leg timeline (`sequence`, `type`, `mode`, hubs,
   `handledBy`, status pills, per-leg `etaAt`); per-leg advance
   (`start`/`complete`); `LEG_ALREADY_COMPLETED` → refetch.
4. Waybill timeline — append-only trail (`scanned|handoff|loaded|departed|
   arrived|sorted|exception|delivered`) with `location`, `actor`, local time;
   read-only; refresh on `waybill.updated`.
5. Multi-day trip UI — Day-1/Day-2 phases from the leg plan; delivery-window
   promise ("Arrives Day 2, 09:00–14:00"), never a fabricated single ETA.
6. Relay chain assignments at meeting points — normal 120 s offers +
   handoff-based custody transfer.
7. Transport-mode role views — `transportMode` gated surfaces
   (`TRANSPORT_MODE_INVALID` guard).

Exit criteria (E2E, TESTING.md M11 suite): create → depart → arrive with full
manifest verified; missing order `CONSIGNMENT_MISSING_ORDERS`; seal broken
`HANDOFF_SEAL_BROKEN`; relay handoff; transport-mode mismatch never offered.

### P11c — Logistics OS (M11b)

Endpoints: `/shipments` (+ `/{id}`/`/{id}/custody`/`/{id}/scan`), `/containers`,
`/vehicles` (+ `/{id}`), `/routes`, `/trips` (+ `/{id}` PATCH advance),
`/linehaul/consignments/{id}/reconcile` + `/replan`, admin
`/admin/logistics/control-tower`.

Deliverables (each with full per-screen state contract — LONG-HAUL-RELAY.md
section 13):

1. Shipment workflow — create shipment from order (`POST /shipments`,
   `SHIPMENT_ALREADY_EXISTS` guard), package pickup scan (`scanType: pickup`),
   container build + seal (`POST /containers`, `CONTAINER_ALREADY_SEALED`
   guard), vehicle load by compartment (`vehicle_load`).
2. Trip operating surface — `Trip` + `manifestSummary`; six states
   (`planned → loading → in_transit → unloading → completed | cancelled`);
   five advance actions (`start_loading | depart | arrive | start_unloading |
   complete`) via `PATCH /trips/{id}`; `TRIP_ALREADY_ACTIVE`,
   `TRIP_CANNOT_CLOSE` handling.
3. Multi-factor handoff verification — three-step scan (package barcode →
   destination bin/hub → vehicle/rider ID) + seal check + condition photo;
   `HANDOFF_VERIFICATION_FAILED` blocks wrong-vehicle handoffs.
4. Custody ledger view — `GET /shipments/{id}/custody` (append-only;
   actor/device/state/evidence; "where at 15:00?" answers).
5. Capacity/compartments — `Vehicle.capacity.compartments[]` rendering with
   used counts; `VEHICLE_CAPACITY_EXCEEDED` / `COMPARTMENT_INCOMPATIBLE` guards.
6. Reconciliation duty — `POST /linehaul/consignments/{id}/reconcile`;
   `RECONCILIATION_FAILED` → locate missing via custody → re-scan → `matched` +
   `tripClosed: true`; trip cannot close (`TRIP_CANNOT_CLOSE`) until resolved.
7. Replan duty — `POST /linehaul/consignments/{id}/replan`; `PLAN_NOT_MUTABLE`
   once departed.
8. Specialized courier surfaces — seven roles (Local Last-Mile, Pickup,
   Transfer, Long-Distance Driver, Bus/Van Operator, Hub Courier,
   Emergency/Recovery Courier) with minimum-information views
   (SECURITY.md visibility matrix).
9. Anomaly awareness — `SCAN_GPS_MISMATCH` / `SCAN_VEHICLE_STATIC` /
   wrong-hub scan blocks with `requestId`; `logistics.anomaly` critical push;
   ops-owned resolution.
10. Bus-operator UI (Trip A → B: departure, ETA, cargo summary, action buttons)
    and hub-worker UI (Incoming/Outgoing/Exceptions; Receive → Sort → Build
    Container → Load → Unload → Reconcile) — wireframes in LONG-HAUL-RELAY.md.

Exit criteria (E2E, TESTING.md L1–L7 suites): shipment → scan → seal → trip
load/depart/arrive → reconcile close; wrong-vehicle handoff blocked; incompatible
load rejected; replan after breakdown; anomaly blocks; trip-surface state walk.

### P11d — Deep logistics pass

Backend gate: deep logistics lane (live in `backend/API-CONTRACT.yaml`;
definitive spec `backend/LOGISTICS-OS.md` sections 16–25; tables in
`backend/DATA-MODEL.md` — `warehouses`, `warehouse_stock`, `carriers`,
`facilities`, `facility_whitelist`, `fleet_accounts`, `delivery_exceptions`).
Rider-visible endpoints: `/delivery-exceptions` (+ `/{id}`); profile fields
`RiderPrivate.serviceModel` / `fleetAccountId`; order fields
`dispatchStrategy` / `fulfillmentSource`; capacity fields
`maxWeightKg`/`maxVolumeL`/`usedWeightKg`/`usedVolumeL`/`weightKg`/`volumeL`.
The registries (`/warehouses`, `/carriers`, `/facilities`, `/fleet/accounts`) and
the admin reassign/escalate endpoints are **admin/merchant-scoped** — the rider
app consumes them only as context (API.md).

Deliverables (each with full per-screen state contract — LONG-HAUL-RELAY.md
sections 13–19):

1. Service-model surfaces — `serviceModel` chip on Profile; `specialized`
   guaranteed-hours shift card, `crowdsourced`/`errand` available-orders feed,
   `fleet` badge + linkage chip (read-only fields, never in `RiderUpdate`;
   `SERVICE_MODEL_INVALID` guard is admin-side).
2. Fleet linkage visibility — `fleetAccountId` chip; master data never renders
   (SECURITY.md fleet boundaries); `FLEET_ACCOUNT_SUSPENDED` dependent-call
   blocks render with `requestId`.
3. Facility whitelist status screen — grant/revoke trail
   (`facility.whitelist_granted` / `facility.whitelist_revoked`) + last scan
   outcomes; no dedicated rider GET endpoint (honest rendering).
4. Geofenced entry scan at gated facilities — `NOT_WHITELISTED` (403) block +
   "Request access" prefilled ticket; `SCAN_GPS_MISMATCH` outside the geofence;
   `whitelist_or_otp` OTP fallback handled server-side.
5. Exception reporting + status — 18-kind catalog chips, `POST
   /delivery-exceptions` → 201 card; status lifecycle
   `open → resolving → resolved/escalated`; `EXCEPTION_ALREADY_RESOLVED` (409)
   terminal handling.
6. Auto-replan awareness — `autoReplanned` badge + `plan.replanned` /
   `plan.optimized` banner on the trip/consignment screen after a breakdown;
   custody chain unchanged; customer ETA updates via `intercity.eta_updated`.
7. Weight/volume capacity duties — `weightKg`/`volumeL` declaration at package
   creation; trip cargo summary weight/volume bars + per-compartment counters;
   `CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED` inline blocks on
   load scans (never bypassed, never blind-retried).
8. Warehouse pickup context — `fulfillmentSource: warehouse` renders the
   warehouse pickup point on the order detail/first-mile leg; strategy chip
   (`dispatchStrategy`) renders read-only.
9. Carrier handoff context — `Consignment.carrierId` +
   `RouteSegment.handledBy: carrierId` carrier leg pill; `carrier.handoff_required`
   notification; handoff scans use the standard multi-factor flow.
10. Registry exclusion — the app never calls `/warehouses`, `/carriers`,
    `/facilities`, `/fleet/accounts`, or `/admin/shipments/{id}/reassign` +
    `/escalate` (E2E assertion, TESTING.md D7).

Exit criteria (E2E, TESTING.md D1–D7): whitelisted entry at a gated facility;
`NOT_WHITELISTED` blocked + recovery; exception report → resolve lifecycle;
auto-replan banner after breakdown; weight-capacity rejection + recovery;
fleet sub-account provisioning visibility; warehouse/carrier context rendering
with registry-endpoint exclusion asserted.

## Enterprise-final pass (production audit)

Masked calls (`POST /orders/{orderId}/masked-call`), the destination filter
(`PUT`/`DELETE /riders/me/destination-filter`), and the rating filter
(`RiderUpdate.ratingFilterMin`) are live in the contract and documented
(ENTERPRISE-READINESS.md, API.md); the app slices ship with the rider-operations
lane and are E2E-covered in TESTING.md. Planned: crash/error monitoring
(Sentry-style, named in DEPLOYMENT.md) and AI/NLP smart replies in chat.

## Blueprint pass — professional tools (LIVE)

The blueprint reference pass is live in the contract and documented: vehicle maintenance (`GET`/`POST /riders/me/vehicle/maintenance` with predictive `nextDueAt`), rider goals (`GET`/`PUT /riders/me/goals`), expenses (`GET`/`POST /riders/me/expenses`, `deductible` + receipts), export reports (`POST /riders/me/exports` — async job, `EXPORT_IN_PROGRESS`), training center (`GET /riders/me/training` + complete → `certified` certificate + `rewardTZS` bonus credit), trusted contacts (`/riders/me/contacts`, `CONTACT_LIMIT_REACHED`), security score (`GET /riders/me/security`) and help articles (`GET /help/articles`) — see VEHICLE-TOOLS.md, PERFORMANCE.md, SECURITY.md. The training center delivers the P8 academy core (module categories `safety | onboarding | skills | platform` with certificates); academy video courses and the onboarding completion gate stay planned (EDUCATION.md). App slices ship with the rider-operations lane and are E2E-covered in TESTING.md. Theme toggle (dark/light) is a design note in ARCHITECTURE.md (`src/theme/` tokens), applied app-wide.

## Deep-pass features (LIVE)

The Uber-driver blueprint deep pass is live in the contract and documented (no contract additions pending): rider preferences (`GET`/`PUT /riders/me/preferences` — `soundNotifications`, `autoAccept` off by default, `longDistance`, `wifiOnlyMaps` data saver, `destinationFilters[]`, `language`; `PREFERENCES_INVALID`), paid restaurant waiting (`Order.waitSeconds` + `FareBreakdown.waitPayTZS`, `itemsChecked` flag), AI suggested positioning areas (`GET /dispatch/forecast` → `suggestedAreas[]`), claimable mission rewards (`RiderMission.claimed`/`canClaim`; `PROMOTION_NOT_CLAIMABLE` before threshold), typed fraud signals (`gps_spoof`, `rapid_decline`, `impossible_speed`, `multi_device`, `payment_abuse` — feed the security score), the backend push outbox (`push_outbox`, DATA-MODEL.md) and the offline chat queue (`chat_send` actions replayed via `POST /riders/me/sync/batch`). App slices ship with the rider-operations lane and are E2E-covered in TESTING.md.

## Technical lane (backend Phase 2)

Planned backend hardening in `backend/ARCHITECTURE.md` "Scaling and real-time (Phase 2)" — the rider app consumes it through the existing event-stream contract, with no client-side contract changes: WebSocket/Socket.IO channels for location streams and live chat (long-poll `/events` remains the fallback), RabbitMQ/Kafka adapter for high-volume real-time (location pings, event fan-out), Kubernetes auto-scaling of stateless API pods, PostGIS for zone and proximity-based dispatch queries, data compression (edge gzip, batched location payloads, activity-aware throttled pings), and enhanced per-rider-type RBAC (full-time/part-time/vehicle class) enforced server-side. All items are marked planned until the backend milestone ships.
