# HUDumika RIDER — Security

Backend policy reference: `backend/AUTH.md`. Invariants: role-scoped sessions never mix data; sensitive fields masked in API responses; clients never decide permissions.

## Token storage

- `expo-secure-store` for `accessToken` and `refreshToken` (Keychain / Android Keystore backed). Never AsyncStorage, never React state persistence.
- Access token JWT 15 min; refresh token 30 days with rotation on every `POST /auth/refresh` — store the rotated pair atomically.
- In-memory cache only in a session context; cold start loads from SecureStore.
- On 401 during a request: single-flight refresh, retry once; refresh failure → clear tokens → OTP screen.
- `POST /auth/logout` on logout; tokens wiped locally regardless of server response.
- Tokens never in logs; redact `Authorization` in debug output.

## Location permission policy

- Foreground location: requested only when the rider goes online or starts a delivery, with an in-app explainer first (per SHARED-FLOWS: explain why before requesting). Copy: "HUDumika uses your location to match deliveries and show live tracking to customers."
- Background location: requested for the delivery flow (pickup → drop-off) only; task starts on accepting an assignment and stops when the last active delivery ends or the rider goes offline. Copy: "Keep location on to complete deliveries and stay findable by dispatch."
- Location sharing is battery-efficient by contract: `POST /riders/me/location` is throttled (`LOCATION_RATE_LIMITED` → drop sample, back off — never retry-spam), samples carry `activity` and uploads pause when `stationary` (ARCHITECTURE.md).
- Permission denied mid-delivery: banner; delivery continues without position upload; ETA fallback handled server-side.
- Location data goes to the backend only via the contract surfaces (`track`, `/riders/me/location`); never logged client-side.

## SOS button

- SOS is a persistent top action on delivery screens and the Home header: tap → confirm sheet (`type` ∈ `safety | medical | mechanical | other`, optional `note`) → `POST /sos` → 201 `SosAlert` `{id, riderId, type, status: open, ...}`.
- The request attaches the last known location from the location task (`lat`, `lon` fields) so safety ops has a position even without a fresh fix; the app never fakes a fix — if none exists, the fields are omitted.
- Rate-limited: `SOS_RATE_LIMITED` (429) → show "Alert already sent — safety ops has your last known location" with the existing alert id, no repeated sends.
- Lifecycle: `open` (alert sent screen, countdown to ops acknowledgment) → `acknowledged` (`sos.acknowledged` in-app banner: "Acknowledged by safety ops — stay where you are") → `resolved` (read-only terminal state on the alert screen). Ack/resolve are ops actions with audit; the rider never mutates the alert.
- The alert screen shows the alert id for support tickets and keeps working while the order card is hidden (safety takes precedence over delivery UI).

## Emergency contact notification flag

- `SafetyEvent.emergencyContacted` (boolean, default `false`): set server-side when the platform notifies trusted contacts (`notifiedOnSos: true` contacts) on a crash/SOS escalation (crash drill, DELIVERY-FLOW.md). The app renders the flag as "Emergency contacts notified" on the safety-event detail / alert screen; the rider never triggers contact notification directly — contacts are dialed/messaged by the platform's own channel, and the flag is read-only state returned with the event (`POST /riders/me/safety-events` response and event history).

## Trip sharing privacy

- Share trip (`POST /riders/me/trips/{orderId}/share`) exposes a live trip view to trusted contacts only through the recipient's phone number — recipients are phone-only (`recipients`, max 5); names, profile data, and the rider's phone are never shared.
- `shareToken` is the only access credential; it expires server-side (`expiresAt` from `expiresInHours`, default 24) and a stale token returns `TRIP_SHARE_EXPIRED` — the app never retries an expired token, it generates a fresh share.
- Route visibility is opt-in per share via `includeRoute` (default true); without it recipients see position only, never the route or the address lines.
- Recipients never see order contents, earnings, ledger, or customer data; leaderboards are the only surface where other rider names appear (PERFORMANCE.md). The rider can stop a share by refreshing the status (server enforces expiry); there is no client-side persistence of share state.
- Trip-share duration control: the share window is `expiresInHours` (default 24) — the only share control; recipients may be prefilled from the trusted contacts list (below), but contact metadata (`relationship`, `notifiedOnSos`) never rides on the share token.

## Trusted contacts (`GET` / `POST /riders/me/contacts`, `DELETE /riders/me/contacts/{contactId}`)

- `TrustedContact`: `name` (max 120), `phone`, `relationship` (max 60, optional), `notifiedOnSos` (default true), `shareLocation` (default true); POST → 201, DELETE → 204.
- Purpose: emergency notification and optional location sharing only — contacts are used when the rider triggers SOS (`POST /sos`; `notifiedOnSos` contacts are marked notified server-side) or consents to location sharing per contact (`shareLocation`). Never used for marketing or analytics.
- `CONTACT_LIMIT_REACHED` → cap message at the cap: Add CTA disabled, existing contacts still listed; removal is a one-tap DELETE with a confirm sheet.
- Privacy: phones are stored server-side for SOS use; the app renders rows (name + relationship) and never surfaces contacts in shared surfaces; each contact's `shareLocation` is an explicit, revocable consent toggle.
- SOS drill flow (TESTING.md): triggering SOS on a drill marks `notifiedOnSos` contacts as notified (server-side) and the alert screen shows "Emergency contacts notified"; the rider never calls or messages contacts from the app.

## Security score and fraud alerts (`GET /riders/me/security`)

- Response: `{securityScore (0–100), alerts[]}` — `alerts[].type` (e.g. `unusual_location`), `severity` ∈ `low | medium | high`, `at` (date-time). The posture is server-computed from the fraud/risk stream (unusual location, unusual login patterns, `risk.event_detected` anomalies — `backend/AI-LAYER.md`); the app renders, never computes.
- Security screen: score gauge + alert list (severity pills, local-time `at`); `RiderPerformance.securityScore` mirrors it on the scorecard (PERFORMANCE.md).
- Alerts are informational: tapping an alert opens its explanation + a prefilled support ticket; the rider never resolves alerts client-side.
- Endpoint unavailable → empty-state variant + retry; `null`/absent score renders the planned state. Score and alerts are owner-only — never shared (trip-share recipients see position/route only, per the privacy section).

## Typed fraud signals

- The fraud/risk stream is typed (`backend/DATA-MODEL.md` `fraud_signals`, `backend/AI-LAYER.md` anomaly detection): `signal_type` ∈ `gps_spoof` (tampered location fixes), `rapid_decline` (burst decline patterns), `impossible_speed` (telemetry beyond physical limits), `multi_device` (concurrent sessions), `payment_abuse` (payment/COD anomalies) — each with `severity` (`low | medium | high | critical`) and a `resolved` flag.
- They feed the security score (`GET /riders/me/security` → `securityScore`) and admin risk review (`RiskEvent` types incl. the same `gps_spoof`, `rapid_decline`, `impossible_speed`, `multi_device`, `payment_abuse`); the app renders the resulting score/alerts only and never surfaces signal internals — the rider sees "unusual location / payment patterns" style copy, never raw signals, and never resolves signals client-side.

## Behavior telemetry privacy

- `behaviorScore` (telemetry-based) is planned: it will be computed server-side from consented sensor/riding data (PERFORMANCE.md). Before ship, `behaviorScore` is `null` and the UI shows the planned state — never a fabricated value.
- Consent model: telemetry collection requires explicit in-app consent with a description of what is collected and why; consent is revocable in Settings and the score degrades to available sources (POD, SOS, incidents) when revoked — the app never collects or stores telemetry locally, and never guesses the score client-side.

## Camera and sensor privacy (fatigue/crash detection)

- Fatigue detection uses the front camera with explicit consent (opt-in, revocable in Settings); inference runs on-device — raw frames/video are never uploaded or stored, only the resulting `SafetyEvent` metadata (`type`, `source`, `severity`, last location, `details`) is transmitted via `POST /riders/me/safety-events`.
- Crash detection uses accelerometer/gyroscope/GPS on-device; the safety event carries severity + location metadata only — no raw sensor streams leave the device.
- Safety events are rate-limited server-side (`SAFETY_EVENT_RATE_LIMITED`); the app never records or retransmits events beyond the offline sync queue (ARCHITECTURE.md).

## In-trip recording (planned)

- Uber-style encrypted in-trip recording for dispute resolution is planned (ENTERPRISE-READINESS.md; ROADMAP P12); nothing is recorded today and the app renders no recording UI.
- When it ships it must be opt-in per trip, encrypted end-to-end, consent-based (revocable per trip in Settings), and never uploaded raw — only recording metadata (session, duration, consent record, encrypted-pointer references) leaves the device via the contract surfaces.
- No recording data is collected, stored, or transmitted until the feature ships.

## Offline sync payload security

- Sync batches (`POST /riders/me/sync/batch`) travel over TLS with the bearer session; payloads carry the same event shapes as the live endpoints (no additional PII), and the offline queue persists only in the app sandbox (tokens stay in `expo-secure-store`).
- `SyncStatus` exposes counts and marks only (`highWaterMark`, `pendingCount`, `gaps[]`) — never event contents; a lost/stolen device loses the queue but nothing server-authoritative (ledger and order state are server-side).

## Rest reminder opt-out

- `rest.reminder` pushes (extended driving beyond `maxHoursPerDay`, DISPATCH-FLOW.md) are user-toggleable via notification preferences (`GET/PUT /notifications/me/preferences`, key `rest.reminder:push`), like any non-system event.
- The shift break action itself is not affected by the opt-out: `POST /riders/me/shifts/{shiftId}/break` stays available whenever the shift is `active`.

## Role switching

- `GET /users/me/roles` lists roles; switching to another role (customer/merchant/provider) requires a new `verify-otp` with `purpose: verify_role` and issues a fresh role-scoped session (per `AUTH.md`).
- Never share state between roles: separate query caches per role, separate navigation root, logout wipes the rider session on switch.
- Rider screens render only rider-scoped data; customer orders/payouts never appear in the rider app and vice versa.
- If the active session's role claim no longer matches rider expectations, the app returns to the role gate instead of rendering partial data.

## Masked customer data

- Customer phone is never displayed in full (DELIVERY-FLOW.md masked dialer).
- Delivery address shown for delivery only; not persisted beyond the active order screen.
- Payout destination masked (`PayoutSummary.method` only).
- No screenshots-with-PII guidance; in-app reminder on delivery screens is optional copy, not enforcement.

## Minimum-information visibility (Logistics OS)

The minimum-information model is the core privacy design of the Logistics OS:
every role sees exactly the fields needed to perform its step — and nothing else.
Enforced as RBAC + ABAC + resource-level + geographic/assignment/tenant
restrictions — never `role == rider → everything`; `CAPABILITY_FORBIDDEN` when a
courier surface is not granted (specialized roles table, LONG-HAUL-RELAY.md
section 2).

### Visibility matrix — which role sees which fields at which stage

| Field | Local last-mile rider | Pickup rider | Transfer rider | Long-distance driver | Bus/van operator | Hub courier | Recovery courier | Customer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Order id / waybill number | yes (assigned leg) | yes (pickup) | yes (manifest rows) | no | no | yes (manifest) | yes (assigned exception) | yes |
| Shipment number (SH-…) | yes | yes | yes (rows) | no (cargo summary only) | no (cargo summary only) | yes | yes | behind "Advanced" disclosure only |
| Package barcode (PKG-…) | yes (assigned) | yes | yes (rows) | no | no | yes | yes | never |
| Pickup address | yes | yes | no | no | no | no | yes (ops instructions) | yes |
| Transfer hub | yes | yes | yes | no | no | yes (own hub) | yes | no |
| Destination city / hub | yes (hub only) | yes (transfer hub only) | yes | yes (route corridor) | yes (route corridor) | yes (outbound bins) | yes | yes (city-level phases only) |
| Final customer address | only when last-mile leg starts | never | never | never | never | never | only for recovery delivery | yes |
| Customer phone | masked call only | never | never | never | never | never | never | own |
| Declared value (TZS) | never | never | never | never | never | never | never | own order |
| Line-haul manifest | never | never | rows for the transfer | never (summary only) | never (summary only) | inbound/outbound only | assigned exception only | never |
| Trip number / status | no | no | no | yes | yes | yes (own hub) | assigned trip | no (logical phases only) |
| Compartment used/capacity | no | no | no | yes (own vehicle) | yes (own vehicle) | yes (bay vehicles) | no | no |
| Custody ledger | assigned shipment | assigned shipment | assigned rows | own trip's units | own trip's units | own hub's units | assigned exception | never |
| Container list / seal state | assigned | assigned | assigned | yes (cargo) | yes (cargo) | yes | assigned | never |

Stage rules (ABAC):
- **Local last-mile rider**: pickup point + transfer hub only — the final
  customer and destination address are never revealed until the last-mile leg
  starts (ABAC: leg `type` grant + `shipment.region == rider.zone`).
- **Pickup rider**: sees the merchant pickup point and the transfer hub — never
  the final customer, never the destination address.
- **Transfer rider**: sees inbound/outbound manifest rows + hub bins for the
  assigned transfer — never customer phones or final addresses.
- **Bus/van operator / long-distance driver**: sees the Trip (TRP-…), route
  corridor, and `manifestSummary` (`expectedUnits`/`verifiedUnits`/`exceptions`)
  + container list — never customer phones, addresses, declared values, or
  individual orders.
- **Hub worker**: inbound/outbound manifests + scans only, scoped
  `shipment.current_hub == worker.hub` — anything outside the hub is absent.
- **Recovery courier**: exception shipment + custody ledger + ops instructions
  only — never unrelated shipments.
- **Dispatcher**: plans, reassignments, schedules — `shipment.region IN
  authorized`.
- **Ops manager**: overrides, exceptions, freeze/recovery.

### ABAC policies with concrete examples

| Policy | Evaluation at request time | Concrete example |
| --- | --- | --- |
| Leg-type grant | `GET /shipments` returns only shipments whose current assignment matches the caller's leg type | A last-mile rider receives no shipments while their only assignment is `first_mile` |
| Zone scope | `shipment.region == rider.zone` | A pickup rider in Kinondoni never sees a pickup in Temeke |
| Hub scope | `shipment.current_hub == worker.hub` for hub-courier surfaces | A Hub A worker scanning `hub_in` at Hub B → the scan target is absent/forbidden |
| Trip assignment | `trip.driverId == caller` for `PATCH /trips/{tripId}` and load scans | Driver A cannot advance Driver B's trip (`FORBIDDEN` / action hidden) |
| Capability grant | capability checks before rendering actions | `shipment.create` absent → no Create-shipment button; a forced call → `CAPABILITY_FORBIDDEN` |
| Mode grant | `RiderPrivate.transportMode` vs leg `mode` | `local_motorcycle` rider never receives a `linehaul_bus` leg; `TRANSPORT_MODE_INVALID` server-side |
| Destination reveal | final address revealed only when the last-mile leg `status` is actionable | The customer address is masked/null in every response until the shipment is `out_for_delivery` for the last-mile rider |
| Owner scope | ledger/earnings fields owner-only | `earningsTZS`, `cashCollectedTZS`, `tipTZS` render only for the authenticated rider |

The app renders only what the server returns for the authenticated session;
there is no client-side field filtering — a missing field is a server decision.

## Facility credential access model (fixed-rider whitelists)

Facility access is a **credential model, not a check-in**: the platform stores a
fixed-rider whitelist per facility and enforces it at scan time. Policy:
`accessPolicy` ∈ `whitelist_only` (default) / `whitelist_or_otp` / `open`
(LONG-HAUL-RELAY.md section 15).

- **Server-side enforcement only**: whitelist membership is checked on the
  server at every entry scan; the app never decides entry. A non-whitelisted
  rider's scan returns `NOT_WHITELISTED` (403) with `requestId` — the custody
  entry is never written.
- **Geofence binding**: entry scans must fall inside the facility `geofence`
  polygon. A scan outside the geofence is rejected (anomaly handling,
  `SCAN_GPS_MISMATCH`) — the geofence is part of the credential, so a rider
  cannot "check in" from outside the gate.
- **What the app stores**: nothing credential-like. Whitelist status renders
  from the notification trail (`facility.whitelist_granted` /
  `facility.whitelist_revoked`, in-app) and scan outcomes — there is no
  dedicated rider GET endpoint and no client-side whitelist cache that could be
  tampered with; the app never renders an invented "whitelisted" state.
- **OTP fallback**: under `whitelist_or_otp`, entry may use a one-time code
  validated server-side per delivery; codes are never persisted client-side
  beyond the active scan, never shared between deliveries, and never logged by
  the app.
- **Revocation**: `facility.whitelist_revoked` renders the consequence copy; a
  revoked rider does not attempt entry. If a scan still fires, the server blocks
  it (`NOT_WHITELISTED`) — there is no race window the app can exploit.
- **Access request path**: the "Request access" CTA opens a prefilled support
  ticket (facility + order context). Grants are admin decisions (admin-web
  module 30), audited (`facility.*`), and delivered as `facility.whitelist_granted`.
- **Boundary**: facility data (`Facility` records, geofences, full whitelist
  membership) is admin-only in the contract; rider endpoints return only scan
  outcomes and notifications.

## Fleet master/sub-account permission boundaries

Fleet membership (`RiderPrivate.fleetAccountId`) does **not** change the rider's
security posture — it adds one linkage field and one admin-side organizational
record (master account). Boundaries:

- **Direction of trust**: the master (admin-web module 31) owns vehicles,
  regions, permissions, and consolidated billing. The driver's app is a **rider
  surface only** — it never exposes master data: no master name, vehicles,
  regions, permissions map, billing totals, or other drivers' records exist on
  any rider endpoint (`GET /fleet/accounts` is admin-only; a rider-call
  assertion in E2E, TESTING.md D7).
- **Sub-account permissions**: each driver keeps their own rider identity,
  verification, ratings, and ledger. `fleetAccountId` is read-only in
  `RiderPrivate` (not in `RiderUpdate`); only admin (rider ops / fleet account
  manager) sets it, and every change is audited (`rider.*` / `fleet.*`).
- **Master status cascades server-side**: `FLEET_ACCOUNT_SUSPENDED` rejects
  master-dependent operations; the app renders the block with `requestId`. A
  suspended master never weakens individual driver verification, going-online
  gates, or penalties — those rules are rider-level and unchanged.
- **Earnings isolation**: the driver sees only their own `LedgerStatement`
  (owner scope, PAYOUTS-LEDGER.md). Master-side consolidated billing is
  computed from sub-account settlement data on the admin side; no rider payload
  ever carries master totals, and no master payload ever carries customer data.
- **No privilege escalation through membership**: fleet drivers hold the same
  rider role, the same capability gates (`CAPABILITY_FORBIDDEN`), and the same
  ABAC scopes as any other rider. `RiderPrivate.fleetType`
  (`captive | contracted | outsourced | hybrid`) is display/analytics context,
  not a permission.
- **Provisioning hygiene**: driver onboarding under a master still requires
  per-driver identity + licence verification; a master cannot provision a
  driver with a blank verification record.

## Service-model data isolation

`RiderPrivate.serviceModel` (`specialized | crowdsourced | errand | fleet`)
drives dispatch priority and some surfaces — it is **dispatch context, not a
permission** and it is **never a data-access scope**:

- **No cross-model data exposure**: riders of one model never see offers,
  orders, earnings, or performance data belonging to another model's riders.
  Dispatch matching happens server-side; the app renders only its own
  assignments and its own ledger (owner scope).
- **No client-side model selection**: `serviceModel` is not in `RiderUpdate`;
  a rider cannot switch models to gain priority or surfaces. Invalid admin
  values are rejected (`SERVICE_MODEL_INVALID`, 422) and audited.
- **Priority without access**: `specialized` riders get guaranteed dispatch
  priority (LONG-HAUL-RELAY.md 13.4) — this changes *when* offers arrive, never
  *what data* is visible. Crowdsourced riders on the grab feed see the same
  offer shape and the same privacy boundaries.
- **Shift vs no-shift surfaces**: guaranteed-hours surfaces (shifts, breaks,
  swaps) render only for models that have them (`specialized`; `fleet` runs
  employer schedules off-platform). The absence of a shift card for
  `crowdsourced`/`errand` is a UI-surface rule, never a data rule — no rider of
  any model can access another's shift, break, or earnings records.
- **Honest rendering**: model fields render only when the server returns them;
  a missing model or missing linkage renders a placeholder, never a fabricated
  value (TESTING.md per-screen checklist).

## Scan-device binding and anomaly detection (Logistics OS)

- Every `CustodyEntry` records `deviceId` + GPS + `actorId`: a scan is bound to
  the physical device that performed it (`logistics_anomalies`, DATA-MODEL.md).
- Anomaly types: `scan_gps_mismatch`, `scan_vehicle_static`, `wrong_hub_scan`,
  `scan_before_pickup` — each with `severity` and `resolved`.
- Anomalies are detected server-side: package scanned at Hub B while the actor
  GPS is 70 km away → `SCAN_GPS_MISMATCH`; scanned onto a bus still parked at
  origin → `SCAN_VEHICLE_STATIC`; wrong-hub scans.
- The scan is rejected (409) and the custody entry is never written;
  `logistics.anomaly` (critical) pushes to ops + trust & safety.
- The app renders the block with `ErrorResponse.message` + `requestId` and never
  retries the scan blindly; anomaly resolution is ops-owned (admin workflow 24)
  — verify device/actor → block/freeze → audit — never client-side.
- Scan devices: the deviceId comes from the authenticated device session; a
  device cannot claim another device's scans, and a scan without device binding
  is rejected as `HANDOFF_INVALID`-style invalid.

## Shift and earnings privacy

- Shift data is PII-light (start/end times, status), but `earningsTZS`, `cashCollectedTZS`, `cashReconciled`, and `deliveriesCompleted` are owner-only: rendered on the rider's own shift card only, never in any shared surface or another rider's app.
- Tip amounts (`Order.tipTZS`, `tip` ledger entries) are never exposed to other riders — statements and earnings cards render only the authenticated rider's own ledger (owner scoping per `PAYOUTS-LEDGER.md`).

## Logout

- Explicit logout button in Settings: confirm dialog → `POST /auth/logout` → clear SecureStore tokens → wipe query caches → RootNavigator to OTP.
- Session expiry handling: silent refresh; on hard failure, clear and route to OTP with a "Session expired" toast.

## Device loss / compromise

| Scenario | Procedure |
| --- | --- |
| Device lost | Refresh token rotation means the old session cannot be replayed indefinitely; user logs in again elsewhere |
| Compromised device | User re-logs in (invalidates previous sessions where supported); support ticket to revoke sessions |
| App data wipe | SecureStore cleared; re-login required; no offline money data to lose (ledger is server-side) |
| Stolen phone with pending payout | Payout destinations are masked and not editable in-app; contact support for payout hold |

## App hardening

- No secrets in client code: base URL and map scheme via `EXPO_PUBLIC_*` (environment-driven); MSW only in dev builds.
- HTTPS only (production API), certificate pinning deferred to release hardening phase (ROADMAP P7).
- Mutations idempotent-safe: idempotency keys on contract-required endpoints; retries never double-post statuses (advanceOrder returns the current `Order`).
- React Native SafeArea + standard Expo defaults; no webviews loading remote content.

## Geofence context security

Context (hub handoff mode, facility entry) is always derived server-side from
geofences — the client can never self-declare context. Entry scans bind
rider → facility → delivery; context switches are logged in the audit trail.
