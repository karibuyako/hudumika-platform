# HUDumika Rider — Enterprise Readiness (Production Audit)

Complete mapping of the rider app against real Uber/Meituan production
requirements. Status key: **LIVE** (contract + documented), **PLANNED**
(milestone + contract addition named), **LONG-TERM** (capacity target, not v1).

## A. Real-time core

| Uber requirement | HUDumika | Status |
| --- | --- | --- |
| WebSocket/streaming engine | WS `/api/ws` + long-poll `/events` (ARCHITECTURE) | LIVE |
| Live driver tracking loop | `POST /riders/me/location` throttled (5–10 s) + activity pause | LIVE |
| Real-time order sync | ServerEvent stream → dispatcher (order.updated, payment.captured…) | LIVE |
| Live chat | conversations + WS push | LIVE |

## B. Dispatch / matching engine

| Requirement | Status |
| --- | --- |
| Order–rider matching (proximity, workload, reliability, rating, vehicle) | LIVE — DISPATCH.md scoring |
| ML acceptance-probability matching | PLANNED (M10a, AI-LAYER.md) |
| Destination filter (Uber "go home") | LIVE — `PUT /riders/me/destination-filter` (`maxDetourKm`) |
| Rider preferences + auto-accept | LIVE — `GET/PUT /riders/me/preferences` (`autoAccept` off by default, `longDistance`, `destinationFilters[]`) |
| AI suggested positioning areas | LIVE — `GET /dispatch/forecast` → `suggestedAreas[]` (map chips) |
| Rating filter (customer rating floor) | LIVE — `RiderUpdate.ratingFilterMin` |
| Surge pricing logic + fare escalation | LIVE — surge config + escalation after n declines |
| Manual override (dispatcher) | LIVE — `/admin/orders/{id}/assign-rider` |

## C. GPS tracking + live map

| Requirement | Status |
| --- | --- |
| Real-time location updates | LIVE |
| Demand heat map + surge zones | LIVE — `/dispatch/heatmap` |
| Predictive heat map (15-min) | LIVE — `/dispatch/forecast` |
| Turn-by-turn navigation (external maps) | LIVE |
| In-app navigation / traffic overlay | PLANNED |

## D. Payments + financial system

| Requirement | Status |
| --- | --- |
| Driver wallet + ledger (immutable) | LIVE — ledger + statement |
| Tips, incentives, bonuses, surge | LIVE — tip/bonus/surge ledger entries |
| Restaurant wait-pay | LIVE — `Order.waitSeconds` + `FareBreakdown.waitPayTZS` (paid waiting) |
| COD collection + shift-end reconciliation | LIVE — clock-out `SHIFT_CASH_MISMATCH` guard + admin `/admin/riders/{id}/cod` |
| Payouts (weekly/monthly cycles) | LIVE — payout batches + withdraw |
| Multi-currency | OUT OF SCOPE v1 (TZS only) |

## E. Safety system

| Requirement | Status |
| --- | --- |
| SOS / emergency button | LIVE — `/sos` (rate-limited, ops acknowledge) |
| Live trip sharing | LIVE — `/riders/me/trips/{orderId}/share` |
| Crash/fall detection + "Are you OK?" countdown + auto-SOS + order reassignment | LIVE — safety events + DISPATCH escalation |
| Fatigue detection → alerts → mandatory rest | LIVE — `SafetyEvent` fatigue + `forcedRestUntil` (`REST_ENFORCED`) |
| Masked calls (VoIP number privacy) | LIVE — `/orders/{id}/masked-call` |
| Identity verification / re-verification | LIVE — VerificationState; re-verify flow (AUTH.md) |
| Incident reporting | LIVE — tickets + issue-reasons |
| In-trip recording / smart helmet | PLANNED / LONG-TERM |

## F. Notifications

| Requirement | Status |
| --- | --- |
| Push (FCM/APNs via Expo) | LIVE — NOTIFICATIONS.md |
| Push delivery outbox | LIVE — backend `push_outbox` queue with retries (pending/sent/failed) |
| Background wake + silent updates | LIVE — event stream + push handlers |
| Smart/timed notifications | PLANNED |
| 30+ event types mapped to UI | LIVE |

## G. Offline + network resilience

| Requirement | Status |
| --- | --- |
| Offline mode (orders, POD, status) | LIVE — offline queue |
| Idempotent batch sync with sequence numbers + gap detection | LIVE — `/riders/me/sync/batch` + `/sync/status` (highWaterMark) |
| Retry/backoff on reconnect | LIVE — queue flush + idempotency keys |
| Offline chat queue | LIVE — `chat_send` actions queued offline, replayed via `/riders/me/sync/batch` |
| Data compression | LIVE — gzip + throttled payloads |

## H. Background services

| Requirement | Status |
| --- | --- |
| Background GPS tracking (battery-aware) | LIVE — ARCHITECTURE (activity pause, 5–10 s pings) |
| Sync engine wake triggers (connectivity/foreground/timer) | LIVE |
| Push wake for new offers | LIVE |
| Fraud/risk engine (sweeper) | LIVE — refund/withdrawal/login/order-delay/inactivity anomalies |
| Typed fraud signals | LIVE — `gps_spoof`, `rapid_decline`, `impossible_speed`, `multi_device`, `payment_abuse` feed the security score |

## I. Modular architecture

| Requirement | Status |
| --- | --- |
| Feature-first modules + code ownership boundaries | LIVE — ARCHITECTURE (screens/api/state/i18n per feature) |
| Independently deployable services | LIVE — backend bounded contexts as microservices |
| RIBs-style plugin isolation | ADAPTED — feature folders + MSW-per-feature handlers |

## J. Testing & reliability

| Requirement | Status |
| --- | --- |
| Unit + contract tests (MSW parity) | LIVE — TESTING.md |
| E2E (Detox/Playwright) per flow | LIVE |
| Crash reporting + monitoring | PLANNED — Sentry-style integration named in DEPLOYMENT/ROADMAP |
| Version conflicts + idempotency guards | LIVE — `VERSION_CONFLICT` retry, idempotency keys |

## K. Analytics & ML

| Requirement | Status |
| --- | --- |
| Driver behavior analytics (speeding/hard-braking) | PLANNED (telemetry consent) |
| Demand prediction + smart dispatch | LIVE (forecast) / PLANNED (ML matching) |
| Smart replies (AI chat) | PLANNED (NLP) |
| Predictive retention + maintenance | PLANNED — predictive-maintenance `nextDueAt` contract field LIVE; model quality backend-tracked (AI-LAYER.md) |

## L. Communication

| Requirement | Status |
| --- | --- |
| In-app chat (customer + dispatch) | LIVE — conversations, `dispatch` role |
| Masked VoIP calls | LIVE — `/orders/{id}/masked-call` |
| Rich media (images/pins/voice) | LIVE — typed attachments |
| Support ticketing | LIVE |
| Real-time translation | PLANNED |

## M. Advanced driver features

| Requirement | Status |
| --- | --- |
| Multi-order batching + trip summary | LIVE — trips + reorder |
| Heat maps + surge visibility | LIVE |
| Driver preferences (zones, hours, rating floor, destination filter) | LIVE |
| Missions/challenges + leaderboards | LIVE — missions with claimable rewards (`RiderMission.canClaim`/`claimed`; `PROMOTION_NOT_CLAIMABLE` guard) + leaderboards |
| Edge/system-event states (13 mapped) | LIVE — NAVIGATION "System events" section |

## N. Rider productivity tools (blueprint pass)

| Requirement | Status |
| --- | --- |
| Vehicle maintenance + expenses | LIVE — `GET`/`POST /riders/me/vehicle/maintenance` (predictive `nextDueAt`) + `GET`/`POST /riders/me/expenses` (receipts, `deductible`) |
| Goals & schedule | LIVE — `GET`/`PUT /riders/me/goals` (`hoursGoalPerWeek`, `earningsGoalTZS`, `weeklyAvailability`, `peakHourAlerts`) |
| Export reports | LIVE — `POST /riders/me/exports` (tax/earnings/trips × csv/pdf/json, async `jobId`/`status`) |
| Training certificates | LIVE — `GET /riders/me/training` + `POST .../{moduleId}/complete` → `certified` + `certificateUrl` + `rewardTZS` |
| Trusted contacts | LIVE — `GET`/`POST /riders/me/contacts`, `DELETE /{contactId}` (SOS + location-consent only) |
| Security score | LIVE — `GET /riders/me/security` (0–100 + `alerts[]`) |
| Help articles | LIVE — `GET /help/articles` (search + categories) |
| Theme toggle (dark/light) | LIVE (design) — `src/theme/` tokens, ARCHITECTURE.md |

## O. Intercity & multi-leg logistics (M11 logistics lane) — full audit

| Requirement | Status |
| --- | --- |
| Hub-and-spoke network (`/hubs` consolidation centers) | LIVE — hub list + create; `HUB_NOT_FOUND` / `HUB_FULL` guards |
| Multi-leg route planning (`Order.routeSegments[]`: first_mile / linehaul / hub_transfer / last_mile / return) | LIVE — `GET /orders/{id}/route` + per-leg advance |
| Line-haul consignments + batch manifests with segregation sections | LIVE — `/linehaul/consignments` (+ depart/arrive) with `standard`/`fragile`/`cold_chain`/`documents`/`high_value` sections |
| Custody handoffs (barcode scan + tamper-seal check + condition photo + custody record) | LIVE — `POST /orders/{id}/handoff`; `HANDOFF_SEAL_BROKEN`/`HANDOFF_SCAN_MISMATCH` block the leg |
| Waybill trail (append-only events across legs) | LIVE — `GET /orders/{id}/waybill` |
| Multi-day delivery promise (per-leg ETAs, Day-1/Day-2 phases, delivery windows) | LIVE — `intercity.eta_updated` + leg-plan rendering |
| Transport-mode role separation (local vs line-haul vs relay views) | LIVE — `RiderPrivate.transportMode` gated views (`TRANSPORT_MODE_INVALID`) |
| Relay mode (sequential rider handoffs) | PLANNED — handoff contract live; relay rollout config + meeting-point scheduling planned |
| Third-party carrier integrations (bus/truck lines) | PLANNED — carrier onboarding and settlement planned |

## P. Logistics OS (M11b) — full audit

| Requirement | Status |
| --- | --- |
| Shipment/package/container twin (`/shipments` + `/{id}`/custody/scan, `/containers`) | LIVE — one order → one shipment → GS1-style packages (`SHIPMENT_ALREADY_EXISTS`); pickup scan → container load/seal (`CONTAINER_ALREADY_SEALED`) → vehicle load |
| Trip operating surface (`/trips` + PATCH advance) | LIVE — driver sees `Trip` + `manifestSummary`, never individual orders; six states (`planned → loading → in_transit → unloading → completed | cancelled`); five advance actions (`start_loading | depart | arrive | start_unloading | complete`); `TRIP_ALREADY_ACTIVE` / `TRIP_CANNOT_CLOSE` |
| Vehicle registry with compartment capacity (`/vehicles` + `/{id}`) | LIVE — `Vehicle.capacity.compartments[]` (`standard`/`fragile`/`cold_chain`/`documents`/`high_value` with `capacity`/`used`), `temperatureCapable`, `securityCapability`, `permittedRoutes`, `status`; PATCH by admin/fleet owner |
| Route corridors (`/routes`) | LIVE — `Route` (`name`, hubs, `estimatedHours`, `scheduledDepartures`, `permittedVehicles`, `active`); create admin-only |
| Multi-factor handoff verification + custody ledger | LIVE — three-step scan (package barcode → destination hub/bin → vehicle/rider ID) + seal check + condition photo (`HANDOFF_VERIFICATION_FAILED` blocks wrong-vehicle handoffs); `GET /shipments/{id}/custody` answers "where at 15:00?" with `deviceId` + GPS + evidence |
| Capacity/compartments/compatibility | LIVE — `VEHICLE_CAPACITY_EXCEEDED` / `COMPARTMENT_INCOMPATIBLE` guard loads (cold package never rides an unrefrigerated bus even with free space) |
| Reconciliation engine + mutable plans | LIVE — `reconcile` (`RECONCILIATION_FAILED` → find missing → `TRIP_CANNOT_CLOSE`) and `replan` (`PLAN_NOT_MUTABLE` once departed) |
| Specialized courier surfaces (minimum information) | LIVE — seven roles (Local Last-Mile, Pickup, Transfer, Long-Distance Driver, Bus/Van Operator, Hub Courier, Emergency/Recovery) with ABAC-scoped views; full visibility matrix in SECURITY.md |
| Bus-operator UI | LIVE — Trip A → B, departure window, ETA, cargo summary, action buttons (wireframe, LONG-HAUL-RELAY.md) |
| Hub-worker UI | LIVE — Incoming/Outgoing/Exceptions tabs; Receive → Sort → Build Container → Load → Unload → Reconcile (wireframe, LONG-HAUL-RELAY.md) |
| Logistics anomaly detection | LIVE — `SCAN_GPS_MISMATCH` / `SCAN_VEHICLE_STATIC` / wrong-hub scans (`logistics_anomalies`, `logistics.anomaly` critical push; ops-owned resolution, admin workflow 24) |
| Control tower integration | LIVE — admin `GET /admin/logistics/control-tower` (network totals, trips per hub, critical exceptions queue) consumed in admin-web modules 26–27 |
| Carrier integrations + regional warehouses | PLANNED — SF-style third-party line-haul, pre-positioned inventory (backend ROADMAP) |

## Q. Deep logistics pass (service models, fleets, facilities, exceptions, weight/volume, warehouses/carriers) — full audit

| Requirement | Status |
| --- | --- |
| Strategy-pattern dispatch (`Order.dispatchStrategy` `nearest`/`zone`/`multi_leg`/`relay`/`warehouse` + `Order.fulfillmentSource` `merchant`/`warehouse`) | LIVE — server-set read-only fields; warehouse-fulfilled orders render the warehouse pickup point (API.md) |
| Rider service models (`RiderPrivate.serviceModel` `specialized`/`crowdsourced`/`errand`/`fleet`) | LIVE — profile chip + model-specific surfaces (specialized shift card, crowdsourced/errand grab feed, fleet badge); guaranteed dispatch priority for specialized is server-side matching (LONG-HAUL-RELAY.md 13) |
| Fleet master accounts + driver sub-accounts (`/fleet/accounts`, `RiderPrivate.fleetAccountId`) | LIVE — driver-side linkage chip only; master data admin-only; `FLEET_ACCOUNT_NOT_FOUND` / `FLEET_ACCOUNT_SUSPENDED` guards (LONG-HAUL-RELAY.md 14; SECURITY.md) |
| Facility whitelists (`/facilities` + `PUT /{id}/whitelist`, `accessPolicy` `whitelist_only`/`whitelist_or_otp`/`open`) | LIVE — geofenced entry scans, `NOT_WHITELISTED` (403) block + "Request access", grant/revoke notifications; status screen renders from notifications + scan outcomes (honest — no dedicated rider endpoint) (LONG-HAUL-RELAY.md 15) |
| Delivery exceptions catalog (18 kinds, `/delivery-exceptions` + `/{id}`) | LIVE — rider report/list/status; `open → resolving → resolved/escalated`; `EXCEPTION_ALREADY_RESOLVED` terminal guard; `exception.created`/`exception.resolved`/`exception.escalated` notifications (LONG-HAUL-RELAY.md 16) |
| Auto-replanning on disruption (`autoReplanned`, `plan.replanned` / `plan.optimized`) | LIVE — replan banner on the trip/consignment screen; custody chain unchanged; customer ETA via `intercity.eta_updated` (LOGISTICS-OS.md section 22) |
| Weight/volume capacity (`Vehicle.capacity.maxWeightKg`/`maxVolumeL` + per-compartment `usedWeightKg`/`usedVolumeL`; `Package.attributes.weightKg`/`volumeL`) | LIVE — cargo summary weight/volume bars, `CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED` inline load blocks (LONG-HAUL-RELAY.md 17) |
| Regional warehouse model (`/warehouses` + stock/fulfill) | LIVE in contract (admin/merchant-scoped) — rider app renders warehouse pickup context; `warehouse.fulfilled`/`warehouse.stock_low` never target the rider app |
| Third-party carrier registry (`/carriers`) | LIVE in contract (admin-scoped) — rider app renders carrier legs (`Consignment.carrierId`, `handledBy: carrierId`) + `carrier.handoff_required`; handoff scans standard multi-factor (LONG-HAUL-RELAY.md 12.4) |
| Active reassignment / escalation (`/admin/shipments/{id}/reassign` + `/escalate`) | LIVE in contract (admin-only) — rider receives outcomes (reassignment event, `exception.escalated`); `SHIPMENT_NOT_REASSIGNABLE` / `SHIPMENT_NOT_ESCALATABLE` status gates on the ops side |

## Production go/no-go checklist

1. Contract tests green against staging (MSW parity) — gate in CI.
2. Real-time: WS + long-poll verified under load; offline replay verified (200-event backlog).
3. Payments: provider sandbox certified; idempotency + reversal drills passed.
4. Safety: crash drill + fatigue drill + SOS acknowledge drill executed on staging.
5. Observability: request IDs, traces, alerts on dispatch queue depth + SOS volume.
6. Security review: masked numbers, PDPA/GDPR consent, camera telemetry consent, E2E encryption.
7. Scale: load test to target concurrency; runbooks for dispatch backlog and sync floods.

Verdict: enterprise-ready foundation — every Uber/Meituan category has a LIVE
implementation or a named planned milestone with a contract addition. No silent gaps.
