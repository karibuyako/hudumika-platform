# HUDumika RIDER — Long-Haul, Line-Haul & Relay (Intercity)

Operating manual for the intercity / multi-leg logistics subsystem — the Logistics
Operating System. Source of truth: `backend/LOGISTICS-OS.md` (definitive spec) and
`backend/INTERCITY-LOGISTICS.md`; every endpoint exists verbatim in
`backend/API-CONTRACT.yaml`; every error code in `backend/ERROR-CODES.md`; every
table in `backend/DATA-MODEL.md`; every event in `backend/NOTIFICATIONS.md`.

This is the complete operating manual. It covers: the seven specialized courier
roles and what each may and may not see; the shipment → package → container
workflow; the trip operating surface with its six states and five advance actions;
multi-factor handoff verification; the custody ledger; capacity, compartments and
compatibility; the reconciliation duty; the replan duty; anomaly awareness; the
four rider service models (specialized / crowdsourced / errand / fleet) and what
each changes for the rider; fleet master accounts and driver sub-accounts; the
fixed-rider facility whitelist model (gated communities, business parks); the
18-kind delivery-exceptions catalog with its open → resolving → resolved/escalated
lifecycle and auto-replanning behavior; weight/volume capacity duties
(`CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED`); strategy-pattern
dispatch and how warehouse-fulfilled orders and third-party carrier legs surface
in the rider app; and the per-screen state contract for every screen in this
subsystem. The reader must be able to operate — and build — every screen from
this document alone.

---

## 1. The model in one diagram

```
CUSTOMER (City B)
   │  last_mile (motorcycle rider C)
   ▼
HUB B  ── sortation ──►  HUB B outbound bin
   ▲                            │  line-haul (bus 15, driver B)
   │  hub_transfer               ▼
   │                        HUB A inbound bin
MERCHANT (City A)              ▲
   │  first_mile (rider A)      │  hub_transfer
   └──►  HUB A  ──►  CONTAINER ─┘
```

- The **order** is the commercial transaction (customer-facing).
- The **shipment** is the physical object (SH-2026-000091829).
- The **package** is the GS1-style logistic unit with a barcode (PKG-7F92A8).
- The **container** groups packages (BAG-CN-000391, sealed).
- The **vehicle** carries containers with compartment capacity (bike → bus → truck).
- The **route** is the corridor (Dar es Salaam → Mwanza).
- The **trip** is one departure on that corridor (TRP-9912) with a manifest summary.
- The **leg** is one journey step inside the customer's order (first_mile, linehaul,
  hub_transfer, last_mile, return).

A bus never receives 300 orders — it receives a **Trip** with a manifest summary:
"327 shipments, 7 containers, 326 verified, 1 exception".

---

## 2. The specialized courier roles (capability-driven surfaces)

All couriers share the same rider platform and the same authentication. The
**surface** they get is capability-driven: the server grants capabilities per
role, and the app renders only what those capabilities allow. Requesting an action
without the capability returns `CAPABILITY_FORBIDDEN` (403). Access is RBAC + ABAC
+ resource-level + geographic/assignment/tenant restrictions — never
`role == rider → everything` (full policy: SECURITY.md).

`RiderPrivate.transportMode`: `local_motorcycle | local_car | van | linehaul_bus |
linehaul_truck | relay` (default `local_motorcycle`) — server-assigned
(ONBOARDING.md), validated against the leg `mode` (`TRANSPORT_MODE_INVALID` if a
rider is offered a leg their mode cannot handle).

### Role table

| # | Role | Transport mode | Vehicle | Primary views / screens | Key permissions | What they CANNOT see (minimum-information) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Local Last-Mile Rider | `local_motorcycle`, `local_car` | motorcycle / car / e-bike / bicycle | Available jobs, Active route, Handoff, History; Order detail for first_mile / last_mile legs | Pick up at merchant or hub bin; deliver to the customer on the last-mile leg; scan shipments; submit POD; advance their assigned legs (`start`/`complete`) | The final customer and destination address are never revealed until the last-mile leg starts (ABAC: leg `type` grant + `shipment.region == rider.zone`); never sees the line-haul manifest, never sees other legs' handlers' data, never sees declared values |
| 2 | Pickup Rider | `local_motorcycle`, `local_car` | motorcycle / car | Pickup list; single-order pickup flow; handoff screen | Pick up a shipment at the merchant, scan the package barcode at pickup (`scanType: pickup`), transport it to the origin hub, hand it over at the hub bin | The final customer, the destination address, the line-haul trip and its manifest; only the pickup point, merchant reference, and transfer hub are visible |
| 3 | Transfer Rider | `local_motorcycle`, `local_car`, `van` | motorcycle / car / van | Hub transfer queue; inbound/outbound manifest rows; handoff screen | Move shipments/containers between hubs and bins (hub_transfer leg), scan at hub_in/hub_out, verify seals | Customer phones, final addresses, declared values, trip manifests; only the manifest rows and hub bins for the transfer they are assigned |
| 4 | Long-Distance Driver | `linehaul_bus`, `linehaul_truck` | bus / truck / refrigerated truck | Trip screen, trip detail, cargo summary, route corridor, waybill events | Drive the assigned trip; advance the trip (start_loading → depart → arrive → start_unloading → complete); reconcile the consignment; report incidents | Individual order contents, customer phones, addresses, declared values — the driver sees the Trip + `manifestSummary` + containers only |
| 5 | Bus/Van Operator | `linehaul_bus`, `van` | bus / van | Trip screen (A → B), departure, ETA, cargo summary, action buttons; container list | Same as Long-Distance Driver for the assigned vehicle; load/unload by compartment; verify container seals at pickup; depart on schedule | Same as Long-Distance Driver: phones, addresses, declared values, individual orders |
| 6 | Hub Courier | `local_motorcycle` (hub staff surface) | none / hand-cart / motorcycle | Hub worker UI: Incoming / Outgoing / Exceptions; Receive → Sort → Build Container → Load → Unload → Reconcile | Inbound/outbound manifests and scans, scoped by `shipment.current_hub == worker.hub`; build and seal containers; load/unload vehicles; reconcile consignments | Anything outside their hub: other hubs' manifests, line-haul trip details, customer data, final destinations beyond the outbound bin |
| 7 | Emergency/Recovery Courier | any (assigned per incident) | assigned per incident | Recovery queue: exception shipment + custody ledger + ops instructions; replan confirmation | Pick up a package declared missing or delayed, follow ops instructions, rescan into the system, complete the exception | Unrelated shipments, other customers' data; only the exception shipment(s) assigned to them |

### Role-switching and capability rules

- Roles are server-assigned (ONBOARDING.md); the app never offers a client-side
  mode editor. `RiderUpdate` does not carry `transportMode`.
- `CAPABILITY_FORBIDDEN` (403) surfaces when a surface is not granted: a
  `local_motorcycle` rider tapping a line-haul action never succeeds.
- A rider can hold more than one capability (e.g. Pickup Rider in the morning,
  Local Last-Mile Rider in the afternoon) — the server returns whatever surfaces
  the authenticated session may use; the app renders the returned menus only.
- Independently of the transport role, every rider also carries a
  `RiderPrivate.serviceModel` (`specialized | crowdsourced | errand | fleet`),
  which changes hours guarantees, matching priority, and some surfaces
  (section 13).

---

## 3. Journey model and identity

### 3.1 Fulfillment types

`Order.fulfillmentType`: `local` (same city), `intercity` (hub-to-hub + line-haul,
multi-day), `relay` (sequential rider handoffs within a region). Server-determined;
checkout never asks for it.

Two further server-set order fields shape how the rider receives the work:

| Field | Enum | Meaning for the rider |
| --- | --- | --- |
| `Order.dispatchStrategy` | `nearest` / `zone` / `multi_leg` / `relay` / `warehouse` | Which dispatcher solved the order: `nearest` (instant on-demand), `zone` (same-day zone coverage), `multi_leg` (cross-city leg plan), `relay` (sequential rider handoffs), `warehouse` (nearest warehouse ships — the rider's first-mile pickup is at the warehouse) |
| `Order.fulfillmentSource` | `merchant` / `warehouse` (default `merchant`) | Where the goods come from: the merchant's own store, or a regional warehouse (pre-positioned inventory, `warehouse` dispatch). For `warehouse` orders the pickup point is the warehouse, not the merchant storefront |

`DISPATCH_STRATEGY_INVALID` (422) guards unknown strategy values server-side;
the rider app renders the fields read-only (API.md).

### 3.2 Identities and labels (GS1-style)

- Shipment number: `SH-2026-000091829` — globally unique, barcoded/QR-encoded.
- Package number: `PKG-7F92A8` — GS1-style logistic-unit ID, barcoded.
- Container number: `BAG-CN-000391` — barcoded, with a `sealCode` once sealed.
- Trip number: `TRP-9912`.
- Consignment number: platform-generated per line-haul batch.
- Waybill number: `Order.waybillNumber` — the customer tracking number.

**Physical label content** (printed at shipment creation): shipment ID,
destination, route, container, barcode. Scanning the barcode is the digital
identity of the physical object — never trust memory about "which bag belongs to
which order".

### 3.3 Route segments (legs)

`GET /orders/{orderId}/route` → `RouteSegment[]`:

| Field | Type | Values |
| --- | --- | --- |
| `legId` | uuid | — |
| `sequence` | integer | order of the legs |
| `type` | enum | `first_mile`, `linehaul`, `hub_transfer`, `last_mile`, `return` |
| `mode` | enum | `motorcycle`, `car`, `van`, `linehaul_bus`, `linehaul_truck` |
| `fromHubId` / `toHubId` | uuid, nullable | corridor endpoints |
| `handledBy` | string | `riderId` or `carrierId` (third-party line-haul) |
| `status` | enum | `pending`, `in_progress`, `completed`, `skipped` |
| `etaAt` | date-time, nullable | per-leg ETA — never client-computed |
| `startedAt` / `completedAt` | date-time, nullable | actuals |
| `custody` | object, nullable | `{from, to, sealIntact, at}` |

Advance a leg: `POST /orders/{orderId}/legs/{legId}/advance`
`{action: start | complete, location{lat, lon}?}` → 200 `RouteSegment[]`.
Errors: `LEG_NOT_FOUND` (404), `LEG_ALREADY_COMPLETED` (409 → refetch, show
completed).

---

## 4. Shipment, package and container workflow (step by step)

The physical-digital twin: the order is commercial, the shipment is the physical
object, packages are the scannable units. One order → one shipment → one or more
packages. `POST /shipments` links them; `SHIPMENT_ALREADY_EXISTS` (409) prevents
doubles. This separation lets the physical plan change (rider A → bus 15 → rider
C) without touching the customer's order.

### 4.1 Step 1 — Create a shipment from an order

`POST /shipments`

| Field | Type | Rule |
| --- | --- | --- |
| `orderId` | uuid (required) | the commercial order being materialized |
| `packageCount` | integer (required, min 1, default 1) | number of packages the physical shipment splits into |
| `containerId` | uuid, nullable | optional pre-assignment to an existing container |

Response 201 `Shipment`:

```json
{
  "id": "d7e1...",
  "shipmentNumber": "SH-2026-000091829",
  "orderId": "3f2b...",
  "packages": [
    { "id": "aa11...", "packageId": "PKG-7F92A8", "shipmentId": "d7e1...",
      "containerId": null,
      "attributes": { "temperature": "ambient", "fragile": false,
        "hazardous": false, "highValue": false, "maxTransitHours": null,
        "allowedModes": [], "compatible": true },
      "status": "prepared", "scannedIn": false, "scannedOut": false }
  ],
  "containerId": null,
  "status": "planned",
  "currentLegId": null,
  "declaredValueTZS": null,
  "createdAt": "2026-08-13T06:00:00Z"
}
```

- Who can create: merchant staff, hub workers, dispatch (per capability). The
  rider app surfaces "Create shipment" from the order context where granted.
- Error codes: `SHIPMENT_NOT_FOUND` (404, order missing or invisible),
  `SHIPMENT_ALREADY_EXISTS` (409 — the order already has a shipment; refetch and
  open the existing one).
- The label is printed here: shipment ID, destination, route, container, barcode.

### 4.2 Step 2 — Package barcode scan at pickup

`POST /shipments/{shipmentId}/scan`

| Field | Type | Rule |
| --- | --- | --- |
| `scanType` | enum (required) | `pickup` — the pickup rider scans the package at the merchant |
| `location` | string (required) | human-readable location |
| `vehicleId` | uuid, nullable | the rider's vehicle |
| `hubId` | uuid, nullable | only for hub-scoped scans |
| `lat` / `lon` | float, nullable | device GPS at scan time |

Response 201 `CustodyEntry` (`eventType: picked_up`). Effects:
- Shipment status `planned` → `picked_up`.
- Package status `prepared` → `picked_up`, `scannedIn: true`.
- Custody ledger gains the entry: actor = rider, deviceId = scanning device,
  GPS, timestamp.
- Events: `package.scanned` (next handler notified, in-app).

### 4.3 Step 3 — Hub in and sortation (hub courier)

- `scanType: hub_in` at the origin hub → shipment `at_hub`, package `at_hub`; a
  `hub_in` custody entry with `hubId`.
- Hub courier sorts by destination and assigns each package to a segregation
  section: `standard | fragile | cold_chain | documents | high_value`.
- `scanType: hub_out` moves the package to the outbound bin (custody entry
  `sorted` or `hub_out`-recorded; the ledger records the transition).

### 4.4 Step 4 — Container building (hub courier / transfer rider)

`POST /containers` with the `Container` shape:

| Field | Type | Values / rule |
| --- | --- | --- |
| `id` | uuid | server-generated |
| `containerId` | string | e.g. `BAG-CN-000391` |
| `kind` | enum | `bag`, `cage`, `pallet`, `lockbox`, `refrigerated_unit` |
| `section` | enum | `standard`, `fragile`, `cold_chain`, `documents`, `high_value` — the segregation section the container belongs to; sections never mix |
| `packageIds` | array | packages loaded into the container |
| `sealed` | boolean | `false` until sealed |
| `sealCode` | string, nullable | set at sealing |
| `sealedAt` | date-time, nullable | set at sealing |
| `currentTripId` | uuid, nullable | assigned when loaded on a trip |
| `createdAt` | date-time | — |

Build flow (hub worker UI):
1. Choose kind: `bag` (soft goods), `cage` (bulk/heavy), `pallet` (palletized),
   `lockbox` (high_value — locked section, stricter handoff with ID check),
   `refrigerated_unit` (cold_chain/frozen).
2. Choose section — only packages of that section may enter.
3. Scan each package barcode into `packageIds[]`.
4. Confirm load → `POST /containers` → 201 `Container` (unsealed).
5. **Seal**: confirm → the container flips to `sealed: true` with `sealCode` +
   `sealedAt`. The sealCode is the tamper-evident identity of the container.
6. Events: `container.sealed` (driver, in-app).

Errors: `CONTAINER_NOT_FOUND` (404), `CONTAINER_ALREADY_SEALED` (409 — a sealed
container cannot be modified; refetch and show the sealed state).

### 4.5 Step 5 — Vehicle loading by compartment

- `scanType: vehicle_load` + `vehicleId` at the vehicle bay → shipment
  `in_transit`, package `loaded`, custody entry `vehicle_loaded`.
- Capacity and compatibility are enforced at this point (section 8):
  - Over any compartment capacity → `VEHICLE_CAPACITY_EXCEEDED` (409).
  - Package attributes incompatible with the vehicle → `COMPARTMENT_INCOMPATIBLE`
    (409) — e.g. a `cold_chain` package on an unrefrigerated bus is rejected even
    with free space.
- Sealed containers load as units: scanning the container barcode verifies its
  seal (`sealIntact`) before the load is accepted.
- Loading per section: standard → standard compartment, fragile → fragile
  compartment, cold_chain → refrigerated compartment / refrigerated_unit
  container, documents → documents compartment, high_value → lockbox / armored.

### 4.6 Step 6 — Unloading, sortation, last mile, delivery

- `scanType: vehicle_unload` at the destination hub → package `sorted` or
  `unloaded` custody entry; shipment `at_hub`.
- Destination hub courier sorts per delivery zone; last-mile assignment flips the
  shipment to `out_for_delivery`.
- `scanType: delivery` at the customer → package `delivered`, shipment
  `delivered`, custody entry `delivered`. The delivery scan is the final
  multi-factor handoff (section 6) — barcode + destination + recipient/ID check.

### 4.7 Status enums (exact)

Shipment: `planned | picked_up | at_hub | in_transit | out_for_delivery |
delivered | exception`.

Package: `prepared | picked_up | at_hub | loaded | in_transit | sorted |
out_for_delivery | delivered | exception`.

Container: `sealed` boolean + `sealCode`; sealed is terminal for edits.

---

## 5. Trip operating surface (driver)

A driver never receives 300 orders — they receive a **Trip**. This is the core
anti-overload design: the bus operator's cargo view is the manifest summary, not
the orders.

### 5.1 The Trip object

`GET /trips?status=` / `GET /trips/{tripId}` → `Trip`:

```json
{
  "id": "trip-1...",
  "tripNumber": "TRP-9912",
  "routeId": "route-dar-mwanza",
  "vehicleId": "veh-bus-15",
  "consignmentIds": ["c-1...", "c-2..."],
  "status": "planned",
  "manifestSummary": { "expectedUnits": 327, "verifiedUnits": 0, "exceptions": 0 },
  "scheduledDeparture": "2026-08-13T18:30:00Z",
  "departedAt": null,
  "arrivedAt": null,
  "driverId": "rider-8...",
  "createdBy": "dispatch-1",
  "createdAt": "2026-08-13T08:00:00Z"
}
```

- `manifestSummary.expectedUnits` = units the manifest says should be on board.
- `manifestSummary.verifiedUnits` = units actually scanned into compartments.
- `manifestSummary.exceptions` = units currently flagged (missing, incompatible,
  seal-broken, unreconciled).
- The driver sees the trip, the route corridor, and the container list — never
  individual customer orders.

### 5.2 The six trip states

`planned → loading → in_transit → unloading → completed` (with `cancelled`
terminal):

| State | Meaning | What the UI shows |
| --- | --- | --- |
| `planned` | Trip created, not yet loading | Trip card, route A → B, `scheduledDeparture`, cargo summary (0 verified), START LOADING button enabled |
| `loading` | Loading in progress | Compartment-by-compartment load screen: for each section, scanned-in vs expected; capacity bars; exceptions list; DEPART enabled once loading is complete (and reconciliation state allows) |
| `in_transit` | Departed, on the road | Live trip header: route, ETA, cargo summary, ARRIVE button; `trip.departed` push; vehicle `on_trip` |
| `unloading` | Arrived at destination hub | Unload screen: scan each unit out (`vehicle_unload`); reconciliation runs at the end; COMPLETE enabled only after reconciliation matches |
| `completed` | Closed | Trip summary: final `manifestSummary`, timestamps, exceptions resolved or escalated; read-only |
| `cancelled` | Aborted before departure | Read-only; cargo returned to origin hub, consignments replanned (section 10) |

### 5.3 The five advance actions

`PATCH /trips/{tripId}` `{action: ...}` → 200 `Trip` (or 409):

| Action | Allowed from | Effect | Notes / UI |
| --- | --- | --- | --- |
| `start_loading` | `planned` | trip → `loading` | START LOADING; subsequent package scans (`vehicle_load`) land in compartments; `VEHICLE_CAPACITY_EXCEEDED` / `COMPARTMENT_INCOMPATIBLE` block loads inline |
| `depart` | `loading` | trip → `in_transit`, `departedAt` set, vehicle `on_trip`, `currentTripId` set | DEPART button; confirmation sheet; `trip.departed` push (driver + hubs); **the plan freezes here** — replan is no longer possible (`PLAN_NOT_MUTABLE`); departure scan with no movement later raises `SCAN_VEHICLE_STATIC` |
| `arrive` | `in_transit` | trip → `unloading`, `arrivedAt` set | ARRIVE at destination hub; `trip.arrived` push; unloading begins |
| `start_unloading` | `unloading` | confirms unloading start | UNLOAD action; package scans (`vehicle_unload`) decrement compartment `used` counts |
| `complete` | `unloading` | trip → `completed` | COMPLETE is **blocked** (`TRIP_CANNOT_CLOSE`, 409) until reconciliation matches (section 9); on success the trip closes and the summary renders |

Errors: `TRIP_NOT_FOUND` (404), `TRIP_ALREADY_ACTIVE` (409 — an advance was
already applied; refetch), `TRIP_CANNOT_CLOSE` (409 — reconciliation pending),
`VEHICLE_CAPACITY_EXCEEDED` (409, on loads), `COMPARTMENT_INCOMPATIBLE` (409, on
loads).

### 5.4 Bus-operator UI wireframe (Trip A → B)

```
┌─────────────────────────────────────────────┐
│ TRIP  TRP-9912                    STATUS: LOADING │
│ Route: Dar es Salaam → Mwanza    Est. 12 h   │
│ Vehicle: Bus 15 (T-reg plate)                 │
│ Departure window: Today 18:30 (scheduled)     │
├─────────────────────────────────────────────┤
│ CARGO SUMMARY                                │
│  Expected units ........ 327                 │
│  Verified units ........ 301                 │
│  Containers ............ 7 (5 sealed)        │
│  Exceptions ............ 1                   │
│   · PKG-… cold_chain: COMPARTMENT_INCOMPATIBLE │
├─────────────────────────────────────────────┤
│ COMPARTMENTS                                 │
│  standard    150/150 ████████████ full       │
│  fragile      24/25  ████████▌  1 free       │
│  cold_chain    0/20  ░░░░░░░░░░ blocked (no refrigeration) │
│  documents    40/40  ████████████ full       │
│  high_value   12/12  ████████████ full (lockbox sealed)    │
├─────────────────────────────────────────────┤
│ [ START LOADING ]  [ CONFIRM LOAD ]         │
│ [ DEPART ]         [ ARRIVE ]               │
│ [ UNLOAD ]         [ COMPLETE ]             │
│ [ REPORT INCIDENT ]                         │
└─────────────────────────────────────────────┘
```

- Action buttons are enabled only in the states that allow them (5.3); every
  other action is disabled with the current state shown.
- Loading / empty / error / retry / success contract per screen (section 18).

### 5.5 Hub-worker UI wireframe

```
┌─────────────────────────────────────────────┐
│ HUB WORKER — HUB A (Dar es Salaam)          │
│ TABS:  [Incoming] [Outgoing] [Exceptions]   │
├─────────────────────────────────────────────┤
│ INCOMING (today)                            │
│  TRP-9910 · Bus 14 · 6 containers · 1 exception │
│  TRP-9911 · Van 3  · 2 containers           │
├─────────────────────────────────────────────┤
│ OUTGOING (next departures)                  │
│  TRP-9912 · Bus 15 · 18:30 · expected 327   │
│  TRP-9913 · Truck 2 · 21:00 · expected 84   │
├─────────────────────────────────────────────┤
│ EXCEPTIONS                                  │
│  · 2 packages missing from TRP-9910 → RECONCILE │
│  · seal broken on BAG-CN-000388 → re-seal   │
├─────────────────────────────────────────────┤
│ WORKFLOW:                                   │
│  Receive → Sort → Build Container → Load → Unload → Reconcile │
│  [ RECEIVE ] [ SORT ] [ BUILD CONTAINER ]   │
│  [ LOAD ]    [ UNLOAD ]   [ RECONCILE ]     │
└─────────────────────────────────────────────┘
```

Workflow steps for the hub courier:
1. **Receive** — scan incoming trip/container barcodes; verify seals
   (`sealIntact`); condition photo if damaged.
2. **Sort** — per destination bin and segregation section.
3. **Build Container** — create + load + seal (section 4.4).
4. **Load** — scan units into the outbound vehicle's compartments
   (`vehicle_load`).
5. **Unload** — scan units off the inbound vehicle (`vehicle_unload`).
6. **Reconcile** — run the reconciliation; resolve exceptions (section 9).

---

## 6. Multi-factor handoff verification

Every transfer is a transaction (`POST /shipments/{shipmentId}/scan` with
`scanType: handoff`, or `POST /orders/{orderId}/handoff`). Nothing moves on
memory; everything moves on scan.

### 6.1 The three-step scan procedure

| Step | What is scanned | What the system verifies |
| --- | --- | --- |
| 1 | Package/shipment barcode | The package exists, is in a handoff-eligible state, and is **expected at this handoff point** (expected next handler / vehicle / leg) |
| 2 | Destination bin / hub + vehicle / rider ID | The scanned destination matches the plan (expected destination hub/bin; expected vehicle for the leg) |
| 3 | Seal check + condition photo + GPS | `sealIntact` must be `true`; a condition photo is captured when required (damage suspicion); GPS + deviceId + timestamp are recorded |

On success, the custody ledger gains the `handoff` entry and the next leg/handler
is notified (`package.scanned` / `handoff.completed`).

### 6.2 Failure behavior

| Condition | Code (409) | What happens |
| --- | --- | --- |
| Package scanned at the wrong handoff point (expected on Bus 22, scanned on Bus 19) | `HANDOFF_VERIFICATION_FAILED` | **Blocked handoff** — the custody entry is never written; the wrong-vehicle scan is rejected inline with `ErrorResponse.message` + `requestId`; ops is flagged; the correct scan still succeeds afterward |
| Wrong barcode / scan code for the expected transfer | `HANDOFF_SCAN_MISMATCH` | Rejected; re-scan prompt; draft kept |
| Tamper-evident seal not intact | `HANDOFF_SEAL_BROKEN` | Leg blocked; ops flagged; the receiving party opens the exception workflow (admin workflow 22) |
| Any invalid handoff state | `HANDOFF_INVALID` | Rejected; refetch the shipment and retry |

### 6.3 Wrong-vehicle handoff — concrete example

```
A package (PKG-7F92A8) is planned on TRP-9912 (Bus 22).
A hub worker scans it onto Bus 19 (TRP-9909) at the loading bay.

POST /shipments/{id}/scan
  { scanType: "handoff", location: "Hub A — Bay 4",
    vehicleId: "bus-19", lat: -6.79, lon: 39.28 }

→ 409 CONFLICT
  { code: "HANDOFF_VERIFICATION_FAILED",
    message: "Package is planned for a different vehicle",
    requestId: "4f9c..." }
```

- The scan is rejected; the custody ledger keeps its last state (no failed entry
  is invented); the correct vehicle scan succeeds.
- The operator's duty: re-scan the package against the planned vehicle (Bus 22)
  — the UI shows the expected vehicle on the scan screen so the error is
  self-correcting.

### 6.4 High-value handoff (lockbox)

`high_value` packages travel in a locked section with a stricter handoff: the
scan additionally requires the receiving party's ID check (rider ID verification
in the same three-step flow). Confirm the lockbox state at every scan.

---

## 7. Custody ledger

`GET /shipments/{shipmentId}/custody` → `CustodyEntry[]` — the append-only,
machine-verified chain of custody. **"Where was the package at 15:00?" is always
answerable.**

### 7.1 The CustodyEntry shape

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | entry id |
| `shipmentId` | uuid | the shipment |
| `packageId` | string, nullable | the package (when package-level) |
| `eventType` | enum | `picked_up`, `hub_in`, `sorted`, `container_loaded`, `vehicle_loaded`, `departed`, `arrived`, `unloaded`, `handoff`, `out_for_delivery`, `delivered` |
| `actorId` | uuid | who performed the scan |
| `actorType` | enum | `rider`, `driver`, `hub_worker`, `carrier`, `system` |
| `locationId` | string, nullable | named location |
| `vehicleId` | uuid, nullable | vehicle involved |
| `hubId` | uuid, nullable | hub involved |
| `lat` / `lon` | float, nullable | scan GPS |
| `deviceId` | string, nullable | physical device that performed the scan (scan-device binding) |
| `previousState` | string, nullable | state before |
| `newState` | string | state after |
| `evidence` | string, nullable | condition photo / seal code reference |
| `at` | date-time | timestamp |

### 7.2 Example ledger for "where was the package at 15:00?"

```
09:12 picked up by Rider A (GPS, device d-1)          → picked_up
10:01 arrived Hub A (H009, hub_in, worker w-2)        → at_hub
10:14 placed in Container C99 (container_loaded)      → sealed
10:28 loaded on Bus 22 (vehicle_loaded, driver B)     → in_transit
17:40 arrived Hub B (arrived, driver B)               → unloading
17:51 opened / sorted (sorted, worker w-7)            → at_hub
18:02 scanned for last mile (out_for_delivery, rider C) → out_for_delivery
19:04 delivered (delivered, rider C)                  → delivered
```

A 15:00 query returns: "in_transit on Bus 22, last entry 10:28 vehicle_loaded by
driver B (device d-2), GPS along route, seal intact."

### 7.3 Operator duties

- Read-only in the app — never edited client-side.
- Refresh on `package.scanned` events.
- The ledger is the reference for damage/loss attribution: the handoff where the
  seal was last verified intact is the responsibility reference point.
- Support answers "where is my package" by reading the last entry + its
  `evidence`/`deviceId`; escalation uses the admin custody-chain query (admin
  module 27).

---

## 8. Capacity, compartments and compatibility

### 8.1 The Vehicle object

| Field | Type | Values |
| --- | --- | --- |
| `id` | uuid | — |
| `vehicleType` | enum | `motorcycle`, `e_bike`, `bicycle`, `car`, `van`, `linehaul_bus`, `linehaul_truck`, `refrigerated_truck` |
| `registration` | string | plate/registration |
| `operatorId` | uuid, nullable | driver/rider or carrier |
| `capacity` | object | `{totalUnits, maxWeightKg?, maxVolumeL?, compartments[{name, capacity, used, usedWeightKg, usedVolumeL}]}` — unit count plus optional weight/volume ceilings and per-compartment used tracking (section 17) |
| `temperatureCapable` | boolean | false unless refrigerated |
| `securityCapability` | enum | `none`, `lockbox`, `cage`, `armored` |
| `permittedRoutes` | uuid[] | routes this vehicle may serve |
| `status` | enum | `active`, `on_trip`, `maintenance`, `retired` |
| `currentLocation` | object, nullable | `{lat, lon, updatedAt}` |
| `currentTripId` | uuid, nullable | set while on a trip |

### 8.2 Compartment types

| Compartment `name` | Purpose | Typical vehicle |
| --- | --- | --- |
| `standard` | general goods | any |
| `fragile` | shock-sensitive goods | van/bus/truck with padded section |
| `cold_chain` | temperature-controlled goods | `refrigerated_truck`, or `refrigerated_unit` container on any vehicle |
| `documents` | papers/envelopes, zero-mixing | any |
| `high_value` | valuables — locked section, ID-checked handoff | vehicles with `lockbox`/`armored` security capability |

Each compartment has `capacity` and `used`. The sum of `used` per compartment
feeds `capacity.totalUnits`.

### 8.3 Capacity used tracking

- `vehicle_load` increments the matching compartment's `used` (and its
  `usedWeightKg` / `usedVolumeL` when the package declares `weightKg` / `volumeL`).
- `vehicle_unload` decrements it.
- Loading past `capacity` → `VEHICLE_CAPACITY_EXCEEDED` (409) — inline block, no
  state change.
- Loading past `maxWeightKg` (vehicle-wide) → `CAPACITY_WEIGHT_EXCEEDED` (409).
- Loading past `maxVolumeL` (vehicle-wide) or a compartment's running
  `usedWeightKg` / `usedVolumeL` ceiling → `CAPACITY_VOLUME_EXCEEDED` (409).
  Full weight/volume rules and duties: section 17.
- `PATCH /vehicles/{vehicleId}` updates status, location, capacity, permitted
  routes (admin/fleet owner).

### 8.4 Package attributes vs compartments (compatibility)

`Package.attributes`:

| Attribute | Type | Values |
| --- | --- | --- |
| `temperature` | enum | `ambient`, `cold_chain`, `frozen` (default `ambient`) |
| `fragile` | boolean | default false |
| `hazardous` | boolean | default false |
| `highValue` | boolean | default false |
| `maxTransitHours` | integer, nullable | transit-time ceiling |
| `allowedModes` | array | `motorcycle`, `car`, `van`, `linehaul_bus`, `linehaul_truck`, `refrigerated_truck` |
| `compatible` | boolean | server-computed guard |

**Rule: routing rejects incompatible assignments** — `COMPARTMENT_INCOMPATIBLE`
(409). Concrete examples:

- A `cold_chain` package on an unrefrigerated bus → **rejected even with free
  space**. Only a `refrigerated_truck` compartment or a `refrigerated_unit`
  container on the vehicle may carry it.
- A `fragile` package into the `standard` compartment → rejected; must use the
  `fragile` compartment.
- A `highValue` package onto a vehicle with `securityCapability: none` →
  rejected; needs `lockbox`/`armored`.
- A package with `hazardous: true` onto a passenger `linehaul_bus` → rejected;
  only `linehaul_truck` with the hazard section.

**Never load an incompatible package. Sections never mix** — a container belongs
to exactly one `section`; packages of other sections cannot be added.

---

## 9. Reconciliation duty

The reconciliation engine is **machine-verified, not human-trusted**: it compares
the manifest against scanned-in loading and scanned-out unloading.

### 9.1 The contract

`POST /linehaul/consignments/{consignmentId}/reconcile` `{scannedOrderIds}` →
200 `ReconciliationResult`:

```json
{
  "consignmentId": "c-1...",
  "expected": 327,
  "scanned": 326,
  "missingOrderIds": ["ord-1..."],
  "status": "mismatch",
  "tripClosed": false
}
```

| Field | Meaning |
| --- | --- |
| `expected` | manifest units |
| `scanned` | units scanned (loading + unloading) |
| `missingOrderIds` | the difference — units never scanned at the expected points |
| `status` | `matched` (expected == scanned) or `mismatch` |
| `tripClosed` | `true` only when the trip could close (matched) |

### 9.2 Outcomes

| Outcome | Codes | Behavior |
| --- | --- | --- |
| Matched | 200 `{status: matched, tripClosed: true}` | Trip can close (`PATCH /trips/{id}` `complete` succeeds); summary renders |
| Mismatch | 409 `RECONCILIATION_FAILED` | Reconciliation rejected; `missingOrderIds[]` returned; the trip **cannot close** — `complete` returns `TRIP_CANNOT_CLOSE` (409) until resolved |
| Mismatch with missing packages | 409 `RECONCILIATION_MISSING_PACKAGES` | Same as above with the missing list surfaced prominently |
| Not found / wrong state | 404 `CONSIGNMENT_NOT_FOUND` / 409 `CONSIGNMENT_ALREADY_DEPARTED` etc. | refetch |

### 9.3 What the operator does to locate missing packages

1. Read `missingOrderIds[]` on the reconciliation screen.
2. Open `GET /shipments/{id}/custody` for each missing id — the **last custody
   entry is the last known holder and location** (actor, device, GPS, time).
3. Trace forward: was it scanned at loading (in the trip) or at unloading (left
   behind)? Was it sorted to the wrong bin? Was its container sealed on the
   vehicle?
4. Physically search the expected location; re-scan the found package
   (`vehicle_unload` or `hub_in`).
5. If found → reconcile again → `matched` + `tripClosed: true` → trip `completed`.
6. If not found → escalate to ops (admin workflow 23): locate via custody chain,
   re-route on the next corridor (`/replan`), or declare lost → damage-claim
   path.
7. `reconciliation.failed` (critical push) notifies ops + driver at failure;
   `plan.replanned` / `intercity.eta_updated` notify on resolution.

**The trip cannot close** (`TRIP_CANNOT_CLOSE`) until the exception resolves.
There is no operator override that bypasses the reconciliation engine.

---

## 10. Replan duty (mutable plan)

The logistics plan is **mutable until departure**: when a vehicle breaks down or
runs late, the consignment moves to an alternate trip/vehicle. The customer's
order never changes — only the physical plan.

### 10.1 The contract

`POST /linehaul/consignments/{consignmentId}/replan`

| Field | Type | Rule |
| --- | --- | --- |
| `reason` | string (required, max 500) | why the plan changes |
| `alternateTripId` | uuid, nullable | the alternate departure |
| `alternateVehicleId` | uuid, nullable | the alternate vehicle |

Response 200 `Consignment` (with new trip/vehicle assignment).

### 10.2 When to replan

- Original vehicle broke down (maintenance flag, `vehicle.status: maintenance`).
- Original trip is running late past the delivery-window promise.
- Hub congestion / road closure makes the corridor unavailable.
- Dispatch identifies a better corridor (capacity available).

### 10.3 What the operator does

1. Detect the trigger (trip delayed, vehicle breakdown — from the trip screen or
   `trip.departed`-time delays, or an ops instruction).
2. Check the alternate: `GET /trips` for the corridor, `GET /vehicles` for the
   vehicle, compatibility (section 8).
3. Submit the replan with a `reason`.
4. Confirm: `plan.replanned` (push) notifies driver + hubs; the customer's ETA
   updates via `intercity.eta_updated`; the consignment appears on the alternate
   trip's manifest.

### 10.4 When replan is impossible

`PLAN_NOT_MUTABLE` (409) — once the original trip has **departed**, the plan is
frozen. The plan freezes at DEPART: after `departedAt` is set, replan attempts
are rejected; exceptions are handled by the reconciliation/loss workflows
instead.

---

## 11. Anomaly awareness (fraud and trust)

Logistics anomalies are detected **server-side** and stored in
`logistics_anomalies`: `scan_gps_mismatch`, `scan_vehicle_static`, `wrong_hub_scan`,
`scan_before_pickup` — each with `severity` and `resolved`.

### 11.1 Anomaly triggers

| Anomaly | Trigger | Example |
| --- | --- | --- |
| `SCAN_GPS_MISMATCH` | Scan location vs actor GPS disagree beyond tolerance | Package scanned at Hub B while the actor's GPS is 70 km away in Hub A |
| `SCAN_VEHICLE_STATIC` | Vehicle scan recorded while the vehicle never moved | Package scanned onto Bus 22 while Bus 22 is still parked at the origin (no GPS movement since departure) |
| `wrong_hub_scan` | `scanType: hub_in` at a hub the shipment was not expected at | Package planned for Hub B scanned into Hub C |
| `scan_before_pickup` | Scan recorded before the pickup scan | A `vehicle_load` for a package still `prepared` |

### 11.2 Behavior

- The offending scan is **rejected** (409 with the anomaly code, e.g.
  `SCAN_GPS_MISMATCH`) and the custody entry is never written.
- `logistics.anomaly` (critical push) notifies ops + trust & safety.
- Scan-device binding: every `CustodyEntry.deviceId` is tied to the physical
  device; the anomaly review compares device/GPS/actor against the claimed
  location (admin workflow 24).
- **Anomalies are never resolved client-side** — the rider app renders the block
  with `ErrorResponse.message` + `requestId` and never retries the scan blindly.
  Resolution is ops-owned (verify → block/freeze → audit).

---

## 12. Consignment workflow, waybill and multi-day trips (line-haul rider)

### 12.1 Consignment lifecycle

Statuses: `manifesting → in_transit → at_hub → delivered` (| `cancelled`).

| Step | Endpoint | Notes |
| --- | --- | --- |
| Create | `POST /linehaul/consignments` `{fromHubId, toHubId, orderIds[], transportMode (van\|linehaul_bus\|linehaul_truck), scheduledDeparture?}` | 201; `CONSIGNMENT_FULL` (409); `INTERCITY_UNAVAILABLE` when no route configured (409); `HUB_NOT_FOUND` / `HUB_FULL` |
| Manifest | included in the consignment | per-order `waybillNumber` + segregation `section` (`standard\|fragile\|cold_chain\|documents\|high_value`) + `scannedIn`/`scannedOut` flags |
| Depart | `POST /linehaul/consignments/{id}/depart` | → `in_transit` + `departedAt`; `CONSIGNMENT_ALREADY_DEPARTED` (409) → refetch; `consignment.departed` |
| Arrive | `POST /linehaul/consignments/{id}/arrive` `{verifiedOrderIds, missingOrderIds?}` | `verifiedOrderIds` must equal the manifest: else `CONSIGNMENT_ORDER_MISMATCH` (409, difference shown) or `CONSIGNMENT_MISSING_ORDERS` (409 → exception workflow: locate → re-route → notify → audit); scanned-in orders leave the consignment (`scannedOut`) and pass to the last-mile rider via handoff; `consignment.arrived` |

### 12.2 Waybill

`GET /orders/{orderId}/waybill` → `{waybillNumber, events[]}` — append-only rows:
`scanned | handoff | loaded | departed | arrived | sorted | exception |
delivered` with `at`, `location`, `actor`, `note?`. Read-only; refreshes on
`waybill.updated`. `WAYBILL_INVALID` on malformed reads.

### 12.3 Multi-day promise

- Per-leg `etaAt` drives the "Day 1 / Day 2" phases from the leg plan.
- The delivery promise is a **window** ("Arrives Day 2, 09:00–14:00"), never a
  fabricated single ETA.
- ETA changes arrive as `intercity.eta_updated` (push) → refetch; the app never
  computes ETAs.
- Overnight legs are normal (`linehaul` with scheduled overnight departure);
  `leg.completed` / `handoff.completed` events keep the timeline alive overnight.

### 12.4 Third-party carrier handoffs (SF-style line-haul)

A line-haul leg may be handed to an **external carrier** instead of a platform
driver: `Consignment.carrierId` (nullable) and
`RouteSegment.handledBy: carrierId` identify the carrier leg. The platform runs
first mile + last mile; the carrier runs the middle leg.

- **What the rider sees**: the route/consignment shows the carrier leg with its
  carrier reference; the platform-side rider's job ends at the carrier handoff
  point (handoff scan at the origin hub) and resumes at the drop-off point
  (handoff scan at the destination hub).
- **Notifications**: `carrier.handoff_required` (push + in-app) tells the
  carrier and ops that the line-haul is ready to be handed over; the platform
  rider's handoff scan uses the standard multi-factor flow (section 6).
- **Carrier pickup/drop-off** are recorded via manual scans or webhook
  integrations (admin module 29, workflow 27) — the platform rider never
  resolves carrier exceptions; `CARRIER_UNAVAILABLE` (region/mode not served)
  and `CARRIER_NOT_FOUND` (404) surface only on admin/carrier-side calls.
- **Carrier leg in the customer timeline**: the customer's logical phases
  (`in_transit`, `arrived_city`) map to the carrier leg exactly as they do to a
  platform line-haul leg — nothing customer-visible changes.

---

## 13. Rider service models (specialized / crowdsourced / errand / fleet)

`RiderPrivate.serviceModel` (`specialized | crowdsourced | errand | fleet`,
default `specialized`) is the Meituan-style employment model of the rider
(专送 specialized, 众包 crowdsourced, 跑腿 errand). It is **server-assigned**:
it exists on `RiderPrivate` and is **not** part of `RiderUpdate` — the rider can
never change it from the app. Changes are made by admin (rider ops / fleet
account manager) during onboarding or employment transitions and are audited
(`rider.*`). An invalid value on any admin mutation → `SERVICE_MODEL_INVALID`
(422).

### 13.1 The four models — what each means for the rider

| Model | Rider type | Hours / guarantees | Dispatch matching | Primary surfaces |
| --- | --- | --- | --- | --- |
| `specialized` (专送) | Contracted dedicated courier | **Guaranteed hours** — scheduled shifts (`rider_shifts`), stable zone, shift swaps and breaks per the shift contract; earnings floor via guarantee + per-order fare | **Guaranteed dispatch priority**: eligible specialized riders are offered orders before the crowdsourced pool when both are eligible; assignments arrive as push offers with the 120 s window | Scheduled shift card, Home shift flow, Order Detail, Performance scorecard, missions |
| `crowdsourced` (众包) | Open-pool courier | No guaranteed hours — works when online; no shifts; peak-surge incentives | Grabs from the open pool: Available-orders feed (`GET /dispatch/available-orders`) where grab mode is enabled for the city; also receives push offers | Available orders feed, offer cards with countdown, Home without a shift card |
| `errand` (跑腿) | Ad-hoc errand courier | Pay-per-task; no guaranteed hours | On-demand matching of errand-type orders; same dispatch lane with per-task fares | Order Detail (errand orders), earnings per task |
| `fleet` (company driver) | Company driver under a fleet master account | Hours per the employer's schedule; **no platform-guaranteed hours** — the employer runs the schedule | Company-scheduled assignments linked to the master account (`RiderPrivate.fleetAccountId`); still eligible for platform dispatch | Fleet badge on Profile, company assignment flow, master-provisioned permissions (section 14) |

### 13.2 Onboarding differences per model

| Model | Onboarding additions | Verification gate |
| --- | --- | --- |
| `specialized` | Employment contract, background check, dedicated onboarding with a supervisor, vehicle eligibility per the contract | Full document stack + background check before `approved`; going online blocked until approved |
| `crowdsourced` | Lighter onboarding: identity + vehicle + training module (EDUCATION.md training center) | Standard verification; online toggle enabled on `approved` |
| `errand` | Identity + vehicle only; errand-specific training module optional | Standard verification |
| `fleet` | Provisioned by the fleet master (section 14): admin creates the master account, links vehicles/regions, invites the driver; the driver still verifies identity + licence individually | Per-driver verification still required; `RiderPrivate.fleetAccountId` is set on the rider record at provisioning |

### 13.3 UI differences per model

| Surface | `specialized` | `crowdsourced` | `errand` | `fleet` |
| --- | --- | --- | --- | --- |
| Home | Shift card (clock-in/out, break, swap) + guaranteed assignment list | Available-orders feed + surge badges; no shift card | Available-orders feed (errand orders) | Company assignment list; no platform shift card (employer schedules) |
| Offers | Push offers with 120 s window | Feed offers + push offers | Push + feed | Company-scheduled + push |
| Profile | Employment type, delivery zone, ratings | Delivery zone | Zone + task stats | **Fleet badge**: service model chip + fleet account linkage (section 14) |
| Earnings | Guarantee + fare breakdown (EARNINGS.md) | Per-order + surge | Per-task | Consolidated by master (admin module 31); driver still sees own ledger |

### 13.4 Service-model matching impact

- Dispatch scoring (DISPATCH-FLOW.md) applies the service-model rule: when a
  dispatchable order has no company-specific constraint, **eligible
  `specialized` riders are offered first** (guaranteed dispatch priority), then
  `fleet` company drivers on platform dispatch, then the `crowdsourced` /
  `errand` open pool. The scoring layer may additionally weight acceptance
  history, proximity, and workload (backend `DISPATCH.md`, AI-LAYER.md).
- `serviceModel` is a dispatch input only; it never changes fares, the
  acceptance window, or the delivery rules.
- Service-model changes that break dispatch guarantees are rejected server-side
  (`SERVICE_MODEL_INVALID`); the rider app renders the returned `RiderPrivate`
  unchanged and shows the block with `requestId`.

### 13.5 Per-screen state contract (service-model screens)

| Screen | Data | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Service model badge (Profile) | `RiderPrivate.serviceModel` + `fleetAccountId` | skeleton on profile fetch | no model → "not set" placeholder (never fabricated) | error card + `requestId` | refetch profile | model chip (specialized/crowdsourced/errand/fleet) + fleet linkage chip when `fleetAccountId` present |
| Guaranteed-hours card (specialized Home) | shift + assignment data | shift-card skeleton | no shift scheduled → "No scheduled shift" | error + retry | refetch | shift window, clock-in/out, swap/break actions (per EARNINGS.md) |
| Available-orders feed (crowdsourced/errand) | `GET /dispatch/available-orders` | offer skeletons | "No available orders — go online and wait for offers" | `OFFER_NOT_FOUND`-style removal + refetch | refetch feed | offer cards with countdown |

---

## 14. Fleet master accounts and driver sub-accounts

One **master account** per delivery company; drivers are **sub-accounts** linked
via `RiderPrivate.fleetAccountId`. The master owns vehicles, regions, and
consolidated billing; each driver keeps their own rider identity, verification,
ratings, and ledger. This mirrors the platform's "primary account +
sub-accounts" pattern applied to delivery companies.

### 14.1 The contract

`/fleet/accounts` (`GET` list, `POST` create) and `PATCH /fleet/accounts/{id}`
(update permissions/status) are **admin-only** (contract tag `[admin]`) — the
rider app never calls them. `FleetAccount`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | master account id — this is the value of `RiderPrivate.fleetAccountId` |
| `name` | string (max 120) | company name |
| `ownerUserId` | uuid | the master's owning user |
| `driverSubAccountIds` | uuid[] | one master, many driver sub-accounts |
| `vehicles` | uuid[] | vehicles owned by the company |
| `regions` | string[] | operating regions |
| `permissions` | object | per-capability boolean map for the master (RBAC) |
| `status` | enum | `active` / `suspended` |
| `createdAt` | date-time | — |

Errors: `FLEET_ACCOUNT_NOT_FOUND` (404), `FLEET_ACCOUNT_SUSPENDED` (409/403 —
operations on a suspended master are rejected server-side).

### 14.2 Provisioning flow (end to end)

1. **Admin** (fleet account manager, admin-web module 31) creates the master:
   `POST /fleet/accounts` `{name, ownerUserId, vehicles[], regions[],
   permissions}` → 201 `FleetAccount` (audit `fleet.*`).
2. **Admin** links each driver: the driver's rider record receives
   `serviceModel: fleet` + `fleetAccountId` (set by rider ops / fleet account
   manager, audited `rider.*` / `fleet.*`).
3. **Driver** logs in: `GET /riders/me` returns `serviceModel: fleet` +
   `fleetAccountId`; the Profile renders the fleet badge with the linkage id.
   The driver must still pass individual verification before going online.
4. **Admin** tunes permissions/status: `PATCH /fleet/accounts/{id}` (e.g.
   suspend the master) — audited.
5. **Master-side** (admin-web): consolidated view of drivers, vehicles, regions,
   billing across sub-accounts (module 31). The driver app never sees master
   billing; the master console never sees the driver's customer data.

### 14.3 What the master sees vs the driver

| Data | Master (admin-web module 31) | Driver (rider app) |
| --- | --- | --- |
| Company name / account record | yes (read/write) | fleet badge only — **no master name/record endpoint is rider-callable**; the linkage renders as the `fleetAccountId` chip |
| Driver sub-accounts | `driverSubAccountIds[]` with drill-in to each rider | own profile only (owner scope) |
| Vehicles | `vehicles[]` (company registry) | own vehicle/transport mode only |
| Regions | `regions[]` (read/write) | own `deliveryZone` |
| Permissions | `permissions` map (read/write, per sub-account) | enforced server-side; the app renders only granted surfaces (`CAPABILITY_FORBIDDEN` otherwise) |
| Billing | consolidated settlement/billing view | own ledger statement (`GET /payouts/me/statement`) — **never the master's totals** |
| Earnings | aggregate company performance | own `earningsTZS`/`cashCollectedTZS` only (owner scope, SECURITY.md) |

### 14.4 Permission boundary rules

- `RiderPrivate.fleetAccountId` is **read-only in the rider app** (not in
  `RiderUpdate`); only admin changes it.
- A driver's session is still a rider session: role checks, verification, and
  rating rules are unchanged. Being part of a fleet never bypasses rider
  verification, going-online gates, or penalties.
- Master suspension (`status: suspended`) disables the master's admin surfaces;
  driver sub-account operations that depend on the master are rejected
  (`FLEET_ACCOUNT_SUSPENDED`). Individual drivers remain rideable only within
  what the master's status permits — the rider app renders the block with
  `requestId` when a dependent call fails.
- Data isolation: master data (vehicles, regions, billing, other drivers'
  records) is never exposed through rider endpoints; per-service-model
  isolation in SECURITY.md.

### 14.5 Per-screen state contract (fleet screens)

| Screen | Data | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Fleet badge (Profile) | `RiderPrivate.serviceModel` + `fleetAccountId` | profile skeleton | no linkage → no badge (never fabricated) | error + retry | refetch profile | badge + account-id chip; tap → help article on fleet membership |
| Company assignments (fleet Home) | standard assignment surfaces scoped by the master | skeletons | "No company assignments" | error + retry | refetch | assignment cards (same OfferModal contract, DISPATCH-FLOW.md) |

---

## 15. Facility whitelists (fixed-rider credential access)

Gated communities and business parks get a **fixed-rider whitelist**: only
pre-approved riders may enter. The whitelist is a credential, not a check-in:
entry scans are geofenced and bind **rider → facility → delivery**.

### 15.1 The contract

`/facilities` (`GET` list, `POST` create) and `PUT /facilities/{id}/whitelist`
(`{riderIds: uuid[]}`) are **admin-only** (contract tag `[admin]`). `Facility`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | — |
| `name` | string (max 120) | facility name |
| `address` | string (max 300) | street address |
| `geofence` | array of `"lon,lat"` | polygon vertices — entry scans must fall inside |
| `whitelistRiderIds` | uuid[] | pre-approved riders (fixed-rider credential access) |
| `accessPolicy` | enum | `whitelist_only` (default) / `whitelist_or_otp` / `open` |
| `createdAt` | date-time | — |

`accessPolicy` semantics:

| Policy | Who may enter | Notes |
| --- | --- | --- |
| `whitelist_only` | whitelisted riders only | Default. A non-whitelisted rider's entry scan → `NOT_WHITELISTED` (403), entry blocked |
| `whitelist_or_otp` | whitelisted riders, or anyone with a valid one-time entry code | OTP fallback for one-off deliveries; the OTP is issued/validated by ops (admin module 30) |
| `open` | everyone | No gate; used for facilities that opted out |

Errors: `FACILITY_NOT_FOUND` (404), `NOT_WHITELISTED` (403), `FACILITY_WHITELIST_EXISTS` (409, duplicate whitelist entry).

### 15.2 Entry flow at a gated facility (step by step)

1. **Arrival**: the rider arrives at the facility gate with an assigned delivery
   whose pickup or drop-off is inside the facility (the delivery address or the
   first-mile pickup resolves to the facility).
2. **Geofenced entry scan**: the app performs the delivery/pickup scan through
   the standard shipment scan flow (`POST /shipments/{id}/scan` with
   `scanType: pickup` / `handoff` / `delivery` and GPS); the server checks:
   - the scan GPS is inside the facility `geofence` (geofence breach → the scan
     is rejected, `SCAN_GPS_MISMATCH`-style anomaly handling, section 11);
   - the rider is on `whitelistRiderIds` (or a valid OTP under
     `whitelist_or_otp`, or the policy is `open`).
3. **Entry granted**: the scan succeeds, the custody entry is written
   (`rider → facility → delivery` binding), and the delivery proceeds.
4. **Entry blocked**: `NOT_WHITELISTED` (403) — the entry scan is rejected with
   `ErrorResponse.message` + `requestId`; the rider is never blind-retried.
   Paths for the rider: contact ops/support (prefilled ticket) to request a
   whitelist grant, or ask the customer/guard for the one-time OTP when the
   policy is `whitelist_or_otp`.

### 15.3 Whitelist grant/revoke notifications

- `facility.whitelist_granted` (in-app): the rider's whitelist entry was added —
  renders a card with the facility name and policy.
- `facility.whitelist_revoked` (in-app): the entry was removed — renders the
  facility name and the consequences ("You can no longer enter {facility} for
  deliveries").
- The whitelist **status screen** renders from the notification trail + scan
  outcomes. There is **no dedicated rider GET endpoint for whitelist status in
  the contract** — the screen shows: facilities granted (from grant
  notifications, most recent first), revocations, and the last entry-scan
  result. A facility is "current" only while its most recent notification is a
  grant. This is honest rendering: no invented status field.

### 15.4 Rider duties at facilities

- Scan at the gate, never inside — the geofence is the entry credential.
- A revoked rider does not attempt entry (revocation renders in-app); if the
  scan still fires, `NOT_WHITELISTED` blocks it with `requestId`.
- Never share entry codes: the OTP path (where policy allows) is validated
  server-side per delivery; codes are not stored client-side beyond the active
  scan.
- Security model: SECURITY.md "Facility credential access model".

### 15.5 Per-screen state contract (facility screens)

| Screen | Data | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Facility whitelist status | notification trail + last scan outcomes | skeleton | "No facility access records yet" | error card + `requestId` | refetch notifications + scans | facility rows (granted/revoked pills, policy label, last scan result) |
| Entry scan at facility | `POST /shipments/{id}/scan` with GPS | scanner loading | — | `NOT_WHITELISTED` (403) block with facility name + `requestId` + "Request access" CTA (prefilled ticket); `SCAN_GPS_MISMATCH` when outside the geofence | re-scan only after ops resolves or policy allows | 201 `CustodyEntry` + "Entry granted" prompt; delivery proceeds |

---

## 16. Delivery exceptions catalog (18 kinds) and auto-replanning

`/delivery-exceptions` — the platform-wide exception catalog. Every disruption
is a typed record with a lifecycle, an outcome, and an `autoReplanned` flag.
A vehicle breakdown is **not** a manual fire-drill: the system detects →
finds an alternate trip → moves the manifest → notifies hubs → updates the ETA →
updates the customer.

### 16.1 The contract

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listDeliveryExceptions` | `GET /delivery-exceptions?kind=&status=` | Exceptions visible to the role (riders: own/assigned shipments) | `kind` (one of the 18), `status` (`open`/`resolving`/`resolved`/`escalated`) | `DeliveryException[]` |
| `createDeliveryException` | `POST /delivery-exceptions` | Report an exception (rider, ops, admin) | `DeliveryException` shape | 201 `DeliveryException` |
| `getDeliveryException` | `GET /delivery-exceptions/{exceptionId}` | Detail | — | `DeliveryException` / 404 |
| `updateDeliveryException` | `PATCH /delivery-exceptions/{exceptionId}` | Update status / resolve / escalate with outcome | `{status, outcome?}` (status required) | `DeliveryException` |

`DeliveryException`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | — |
| `kind` | enum (18 values, below) | the typed disruption |
| `shipmentId` | uuid, nullable | affected shipment |
| `orderId` | uuid, nullable | affected order |
| `tripId` | uuid, nullable | affected trip |
| `description` | string (max 1000) | what happened |
| `reportedBy` | string | actor reference (rider id, ops, system) |
| `status` | enum | `open` / `resolving` / `resolved` / `escalated` |
| `outcome` | string (max 1000), nullable | resolution/decision text |
| `autoReplanned` | boolean, default false | plan was recalculated automatically |
| `createdAt` | date-time | — |
| `resolvedAt` | date-time, nullable | when resolved |

Errors: `EXCEPTION_NOT_FOUND` (404), `EXCEPTION_ALREADY_RESOLVED` (409 — a
`resolved`/`escalated` exception cannot be re-opened; refetch and show the
terminal state).

### 16.2 The 18 kinds — full catalog

| # | `kind` | What it is | Typical reporter | Rider's reporting flow | Typical resolution path | `autoReplanned` typically |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `missing_package` | A package is not where it should be (at pickup, hub, or arrival) | Rider, hub courier, driver, ops | Report with shipment/order + description → ops locates via custody chain (admin workflow 25) | Locate via custody → re-scan → delivered; or declare lost → damage claim | yes (replan manifest) |
| 2 | `wrong_package` | The wrong package was picked up or handed over | Rider, hub courier | Report → hold the package → ops verifies barcode vs manifest | Swap/return → correct package dispatched | yes |
| 3 | `wrong_hub` | Package scanned at a hub it was not expected at | Hub courier, system (anomaly) | Report with expected vs scanned hub | Re-route to correct hub (or replan) | yes |
| 4 | `wrong_vehicle` | Package loaded on / handed to the wrong vehicle | Driver, hub courier, system (`HANDOFF_VERIFICATION_FAILED`) | Report with expected vs scanned vehicle | Unload → reload on the planned vehicle | yes |
| 5 | `scan_failure` | Barcode/QR fails to scan or verify | Rider, hub courier | Report with the package + condition | Manual verification → re-label → re-scan | sometimes |
| 6 | `damaged_package` | Package found damaged (seal broken, contents damaged) | Rider, hub courier, driver | Report with condition photo (evidence) | Inspect → re-seal or damage claim (last-intact-seal handoff is the reference) | sometimes |
| 7 | `late_vehicle` | Vehicle running late past the delivery-window promise | Driver, dispatch, ops | Report with trip + delay minutes | ETA update (`intercity.eta_updated`) or replan | yes (replan) |
| 8 | `vehicle_breakdown` | Vehicle broken down mid-route or before departure | Driver, system (telemetry/maintenance flag) | Report with trip + vehicle + location | **Auto-replan**: detect → find alternate trip → move manifest → notify hubs → update ETA → update customer (LOGISTICS-OS.md section 22); `plan.replanned` + `plan.optimized` when the optimizer re-runs | yes |
| 9 | `rider_unavailable` | Assigned rider/driver cannot fulfill (sick, no-show, dropped) | Dispatch, ops, system | Report with assignment | Active reassignment (`/admin/shipments/{id}/reassign`) or re-dispatch | yes |
| 10 | `bus_cancellation` | A line-haul departure is cancelled | Driver, hub courier, ops | Report with trip | Replan to next departure; `intercity.eta_updated` | yes |
| 11 | `hub_congestion` | Hub sorting capacity overwhelmed, delays inbound/outbound | Hub courier, ops | Report with hub + volumes | Prioritize critical shipments; defer non-critical; ETA updates | sometimes |
| 12 | `weather_disruption` | Weather blocks or slows a corridor | System (weather feed), driver | Report with corridor + conditions | Hold at hub or replan; `intercity.eta_updated` | sometimes |
| 13 | `road_closure` | Road/route closed (works, incidents, floods) | Driver, system | Report with corridor + diversion | Re-route or replan; ETA update | yes |
| 14 | `customer_unavailable` | Recipient not reachable at delivery attempt | Rider | Standard failed-delivery flow (`customer_unavailable` reason) + exception record | Reschedule or return to origin (RTO) | no |
| 15 | `package_refused` | Recipient refuses the package | Rider | Failed-delivery flow (`refused` reason) + exception record | Return to origin; refund rules | no |
| 16 | `route_deviation` | Rider/vehicle deviated from the planned route | System (telemetry/anomaly) | (system-detected) — rider reports context if needed | Verify → correct course or investigate (anomaly workflow) | no |
| 17 | `security_incident` | Theft, robbery, threat, or tampering | Rider (SOS + exception), ops | **Safety first**: SOS alert + exception with `security_incident`; never pursue | Escalate (`exception.escalated` critical to ops manager); law-enforcement path; freeze shipment | no (frozen) |
| 18 | `reconciliation_failure` | Consignment reconcile mismatch (expected ≠ scanned) | System, driver, hub courier | Report with `missingOrderIds` context | Reconciliation runbook (admin workflow 23): locate → re-scan → reroute or declare lost | yes |

### 16.3 The rider's reporting flow (step by step)

1. From the affected order/shipment/trip screen, tap **Report exception**.
2. Pick the `kind` (the 18 chips render from the catalog — never free text for
   the kind).
3. Fill `description` (max 1000) with what happened; attach the shipment/order/
   trip context (auto-linked from the screen you opened).
4. Submit `POST /delivery-exceptions` → 201 `DeliveryException`
   `{status: open, autoReplanned: false}`.
5. The app shows the exception card with the id + `requestId` for tickets.
6. Ops picks it up: `exception.created` notifies ops + affected parties
   (push, in-app).

### 16.4 Status lifecycle

`open → resolving → resolved` (or `escalated` terminal):

| Status | Meaning | Who sets it | UI |
| --- | --- | --- | --- |
| `open` | Reported, not yet handled | reporter (POST) | amber "Open" pill; card shows kind, context, description, `requestId` |
| `resolving` | Ops actively working it | ops (`PATCH` status) | blue "Resolving" pill; ETA note if delayed |
| `resolved` | Outcome recorded; exception closed | ops / driver (`PATCH` status + `outcome`) | green "Resolved" pill + outcome text + `resolvedAt`; `exception.resolved` notifies affected parties |
| `escalated` | Terminal escalation (incidents, security) | ops manager (`PATCH` status) | red "Escalated" pill; `exception.escalated` critical push to ops manager |

- `PATCH` on a `resolved`/`escalated` exception → `EXCEPTION_ALREADY_RESOLVED`
  (409) → the app refetches and shows the terminal state; there is no reopen.
- The rider may report an exception but **never resolves their own exception
  unilaterally** for kinds that affect other parties (missing/damage/security);
  the rider resolves only their own scoped actions (e.g. a scan failure they can
  fix by re-scanning) — the server enforces who may set which status.

### 16.5 Auto-replanning — what the rider sees

When a disruption triggers `autoReplanned: true` (breakdown, bus cancellation,
late vehicle, wrong hub/vehicle, missing package):

1. **Detect**: system or reporter creates the exception (`open`).
2. **Replan**: the engine finds an alternate trip/vehicle and moves the
   manifest; `autoReplanned: true` is set on the exception; `plan.replanned`
   (push + in-app) notifies drivers + hubs; if the global optimizer re-runs,
   `plan.optimized` (in-app) notifies dispatchers + drivers.
3. **What the driver sees**: a banner on the trip/consignment screen — "Your
   route was replanned — TRP-9913 replaces TRP-9912"; the consignment appears on
   the alternate trip's manifest; the custody chain stays intact (no invented
   events).
4. **What the customer sees**: `intercity.eta_updated` (push + in-app) with the
   new window; the tracking phase position is kept (customer ORDER-FLOW.md).
5. **Confirmation**: the exception moves to `resolved` with an `outcome`
   describing the replan (e.g. "Replanned to TRP-9913, Bus 16 — new ETA Day 2
   09:00–14:00").

If the plan is frozen (`PLAN_NOT_MUTABLE` — trip already departed), no replan is
possible; the exception is handled via locate/reconcile or loss workflows
(section 9, admin workflow 25).

### 16.6 Per-screen state contract (exception screens)

| Screen | Data | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Exception report | `POST /delivery-exceptions` | submit spinner | — | `VALIDATION_FAILED` (missing kind/description) inline; network error | re-submit (idempotent draft kept) | 201 → exception card with id + `requestId` |
| Exception list (my scope) | `GET /delivery-exceptions?status=` | card skeletons | "No exceptions" | error + retry | refetch | cards: kind pill, context (shipment/order/trip), status pill, `autoReplanned` badge, `createdAt` |
| Exception detail/status | `GET /delivery-exceptions/{exceptionId}` | skeleton | 404 → empty variant + retry | error + retry | refetch | kind, description, context links, status pill, `outcome`, `resolvedAt`, `autoReplanned` + replan banner; actions per role (e.g. rider resolves a scan failure) |
| Replan banner (trip/consignment) | `plan.replanned` / `plan.optimized` events | — | — | — | — | "Route replanned" banner + alternate trip/vehicle; refetch trip/consignment |

---

## 17. Weight/volume capacity duties

Beyond unit counts and compatibility, the network now tracks **weight and
volume** — a bus may have free slots but be at its axle-weight limit, or a van
may be full by volume while underweight.

### 17.1 The contract fields

`Package.attributes` adds:

| Field | Type | Meaning |
| --- | --- | --- |
| `weightKg` | number, nullable | declared package weight (kilograms) |
| `volumeL` | number, nullable | declared package volume (litres) |

`Vehicle.capacity` adds:

| Field | Type | Meaning |
| --- | --- | --- |
| `maxWeightKg` | number, nullable | vehicle-wide weight ceiling |
| `maxVolumeL` | number, nullable | vehicle-wide volume ceiling |

Each compartment gains running counters:

| Field | Type | Meaning |
| --- | --- | --- |
| `usedWeightKg` | number, default 0 | loaded weight in this compartment |
| `usedVolumeL` | number, default 0 | loaded volume in this compartment |

### 17.2 Loading rules (exact order of checks at `vehicle_load`)

1. **Compatibility** — `COMPARTMENT_INCOMPATIBLE` (409): package attributes vs
   vehicle/compartment (temperature, fragile, highValue, hazardous; section 8.4).
2. **Unit capacity** — `VEHICLE_CAPACITY_EXCEEDED` (409): compartment `used` +
   1 > `capacity`, or vehicle `totalUnits` ceiling.
3. **Weight** — `CAPACITY_WEIGHT_EXCEEDED` (409): compartment
   `usedWeightKg` + package `weightKg` > vehicle `maxWeightKg` (vehicle-wide)
   — and per-compartment ceilings when configured.
4. **Volume** — `CAPACITY_VOLUME_EXCEEDED` (409): compartment `usedVolumeL` +
   package `volumeL` > vehicle `maxVolumeL` (vehicle-wide) — and per-compartment
   ceilings when configured.

The checks are cumulative and inline: the load scan is rejected with the first
failing code, no state change, custody entry never written.

### 17.3 Per-compartment used tracking

- `vehicle_load` adds the package's `weightKg`/`volumeL` to the compartment's
  `usedWeightKg`/`usedVolumeL` (and 1 to `used`).
- `vehicle_unload` subtracts them (and decrements `used`).
- Packages without declared `weightKg`/`volumeL` still consume unit capacity;
  weight/volume checks apply only where the values exist (null values are
  skipped, never zero-fabricated).
- The trip screen renders weight/volume bars beside the unit bars:
  `usedWeightKg/maxWeightKg` and `usedVolumeL/maxVolumeL`, plus per-compartment
  values.

### 17.4 Concrete examples

| Scenario | Vehicle | Package | Result |
| --- | --- | --- | --- |
| Van at `maxWeightKg: 800`, compartments show `usedWeightKg: 780` | `linehaul_truck` with `maxWeightKg: 800` | `weightKg: 40` | 409 `CAPACITY_WEIGHT_EXCEEDED` — 780 + 40 > 800, rejected even though `used` slots remain |
| Bus `maxVolumeL: 6000`, compartment `usedVolumeL: 5900` | `linehaul_bus` | `volumeL: 200` | 409 `CAPACITY_VOLUME_EXCEEDED` — 5900 + 200 > 6000 |
| Same van, package `weightKg: 10` | same | `weightKg: 10` | accepted — 780 + 10 ≤ 800; counters update (`usedWeightKg: 790`) |
| Package with no `weightKg`/`volumeL` | any | `null`/`null` | unit check only; weight/volume checks skipped |

### 17.5 Rider duties

- **Declare honestly**: weight/volume are declared on `Package.attributes` at
  shipment/package creation — misdeclaration shifts risk and can block loading.
- **Never bypass a rejection**: `CAPACITY_WEIGHT_EXCEEDED` /
  `CAPACITY_VOLUME_EXCEEDED` are inline blocks with `requestId`; the remedy is
  to offload weight/volume or use a capable vehicle — never a blind retry.
- **Keep counters honest**: `usedWeightKg`/`usedVolumeL` move only by scan
  (`vehicle_load`/`vehicle_unload`) — the driver never edits counters.
- **Report overrides**: if a physical load differs from the declared values,
  correct the package attributes (where granted) or report an exception
  (section 16).

### 17.6 Per-screen state contract (weight/volume screens)

| Screen | Data | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Trip cargo summary | `GET /trips/{tripId}` | cargo skeletons | no cargo yet | error + retry | refetch | unit bars + weight bar (`usedWeightKg/maxWeightKg`) + volume bar (`usedVolumeL/maxVolumeL`) + per-compartment values |
| Package creation (attributes) | `POST /shipments` / package edit | submit spinner | — | `VALIDATION_FAILED` on bad values (negative, non-numeric) | re-submit | package with `weightKg`/`volumeL` shown on the label/detail |

---

## 18. Per-screen state contract

Every screen in this subsystem: loading skeleton → empty state → error + retry →
success. Mutations show an in-flight spinner with server rollback; 429 is honored
with `Retry-After`; every error surfaces `ErrorResponse.message` + `requestId`.

| Screen | Data | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Trip list | `GET /trips?status=` | trip-card skeletons | "No trips assigned" + filter hint | error card + `requestId` | retry refetches the list | trip cards with `tripNumber`, route, `scheduledDeparture`, `manifestSummary`, status pill |
| Trip detail | `GET /trips/{tripId}` | cargo-summary skeletons | not applicable (404 → not-visible variant) | error card; `TRIP_NOT_FOUND` → empty variant | refetch | cargo summary, compartments, action buttons per state (5.3) |
| Shipment list | `GET /shipments?status=` | card skeletons | "No shipments" + status-chip hint | error card | retry | cards: `shipmentNumber`, `packages[]`, `containerId`, status |
| Shipment detail | `GET /shipments/{shipmentId}` | skeleton | — | 404 → not visible variant | retry | shipment + packages + scan actions; links to custody + scan |
| Create shipment | `POST /shipments` | submit spinner | — | `SHIPMENT_ALREADY_EXISTS` inline (open existing) | re-submit | 201 → shipment detail |
| Scan/Verify (3-step) | `POST /shipments/{id}/scan` | scanner loading | — | inline blocks: `HANDOFF_VERIFICATION_FAILED`, `HANDOFF_SEAL_BROKEN`, `HANDOFF_SCAN_MISMATCH`, `SCAN_GPS_MISMATCH`, `SCAN_VEHICLE_STATIC`, `VEHICLE_CAPACITY_EXCEEDED`, `COMPARTMENT_INCOMPATIBLE` with `requestId` | re-scan (draft kept) | 201 `CustodyEntry` + next-step prompt |
| Container build | `POST /containers` | skeleton | no packages in section → empty state | `CONTAINER_ALREADY_SEALED` → refetch | retry | container + seal confirm → `sealCode` shown |
| Custody timeline | `GET /shipments/{id}/custody` | timeline skeletons | "No custody events yet" | error + retry | refetch | append-only `CustodyEntry[]` with actor/device/state/evidence, local time; refresh on `package.scanned` |
| Reconciliation | `POST /linehaul/consignments/{id}/reconcile` | result skeleton | no manifest rows | `RECONCILIATION_FAILED` / `RECONCILIATION_MISSING_PACKAGES` → missing list + locate via custody | re-reconcile after locating | `matched` + `tripClosed: true`; trip summary closes |
| Replan | `POST /linehaul/consignments/{id}/replan` | submit spinner | no alternate trips/vehicles → disabled | `PLAN_NOT_MUTABLE` inline (departed) | re-submit with fresh alternate | 200 `Consignment` + `plan.replanned` banner |
| Consignment list | `GET /linehaul/consignments?status=` | card skeletons | "No consignments" | error + retry | refetch | cards: `consignmentNumber`, corridor, `orderCount`, `scheduledDeparture`, status |
| Consignment detail | `GET /linehaul/consignments/{id}` | skeleton | — | 404 → empty variant | retry | manifest grouped by `section`, per-order `scannedIn`/`scannedOut`; create → depart → arrive per status |
| Route/legs view | `GET /orders/{id}/route` | leg skeletons | "No route yet" | error + retry | refetch | leg timeline with status pills + per-leg `etaAt` |
| Handoff screen | `POST /orders/{id}/handoff` | scanner loading | — | inline seal/scan blocks | re-scan | 201 `Handoff` + custody record |
| Waybill timeline | `GET /orders/{id}/waybill` | event skeletons | "No tracking events yet" | `WAYBILL_INVALID` → error + retry | refetch | append-only trail, read-only |
| Service model / fleet badge (Profile) | `RiderPrivate.serviceModel` + `fleetAccountId` | profile skeleton | no model → placeholder | error + retry | refetch profile | model chip + fleet linkage chip (`fleetAccountId`); fleet badge never renders master data (section 14) |
| Facility whitelist status | notification trail + scan outcomes | skeleton | "No facility access records yet" | error card + `requestId` | refetch | granted/revoked rows with policy labels (section 15.5) |
| Entry scan at facility | `POST /shipments/{id}/scan` + geofence | scanner loading | — | `NOT_WHITELISTED` (403) + "Request access" CTA; `SCAN_GPS_MISMATCH` outside geofence | re-scan after ops resolution | 201 `CustodyEntry` + "Entry granted" |
| Exception report | `POST /delivery-exceptions` | submit spinner | — | `VALIDATION_FAILED` inline (kind/description) | re-submit | 201 → exception card (section 16.6) |
| Exception list / status | `GET /delivery-exceptions` / `GET /delivery-exceptions/{id}` | skeletons | "No exceptions" | `EXCEPTION_NOT_FOUND` → empty variant | refetch | kind + status pills, `outcome`, `resolvedAt`, `autoReplanned` badge + replan banner (section 16.6) |
| Trip cargo summary (weight/volume) | `GET /trips/{tripId}` | cargo skeletons | no cargo yet | error + retry | refetch | unit + weight + volume bars, per-compartment counters (section 17.6) |
| Warehouse pickup context | order detail / first-mile leg (warehouse-fulfilled orders) | skeleton | — | 404 → empty variant | refetch | `fulfillmentSource: warehouse` chip + warehouse pickup point; stock availability shown only from server fields (API.md) |
| Carrier handoff context | consignment leg (`handledBy: carrierId`) + `carrier.handoff_required` | skeleton | no carrier leg | error + retry | refetch | carrier leg pill; handoff scans/notifications per the standard handoff flow (section 6) |

Consignment, route, handoff and waybill screens follow the same checklist
(NAVIGATION.md sections 10–11; data per API.md). New deep-logistics screens
(service models, fleet linkage, facility whitelists, exceptions,
weight/volume, warehouse/carrier context) follow the same checklist —
NAVIGATION.md section 12; data per API.md.

---

## 19. Security duties (operator level)

- **Seal integrity**: verify the tamper-evident seal at every handoff;
  `HANDOFF_SEAL_BROKEN` blocks the leg.
- **Section discipline**: sections never mix, even in an empty consignment.
- **High-value lockbox**: `high_value` orders travel in a locked section with a
  stricter handoff (ID check); confirm the lockbox state at scans.
- **Custody chain**: every scan/transfer is attributed to actor + device +
  timestamp; claims use the handoff where the seal was last verified intact.
- **Minimum information**: the local rider never sees the final customer until
  the last mile starts; the bus operator never sees phones or addresses
  (section 2). Full policy in SECURITY.md.
- **Facility credentials**: entry at a gated facility requires a valid whitelist
  membership (or an OTP under `whitelist_or_otp`); entry scans must fall inside
  the facility geofence; a revoked rider never attempts entry
  (section 15; SECURITY.md "Facility credential access model").
- **Fleet boundary**: a fleet driver's app is a rider surface, never a master
  console — master vehicles/regions/billing are admin-only; `fleetAccountId` is
  read-only in the app (section 14; SECURITY.md).
- **Exception honesty**: report the true `kind` and description; a
  `security_incident` is safety-first (SOS + exception) — never pursue;
  exceptions are never resolved client-side beyond the rider's own scoped
  actions (section 16).
- **Weight/volume integrity**: declare `weightKg`/`volumeL` honestly; never
  bypass a `CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED` block
  (section 17).

## 20. Geofence context switching

The app switches its surface by location context, driven server-side:

- **Hub geofence** → "handoff mode": scan/verify UI, inbound/outbound manifests,
  container build, reconcile actions appear.
- **Facility whitelist geofence** → entry scan UI (gated access); a non-whitelisted
  rider sees the blocked state (`NOT_WHITELISTED`).
- **Leaving the geofence** → reverts to the normal job surface (available jobs,
  active route, earnings).

Context comes from the geofence service, never from the client. The UI shows
the active context as a banner ("Handoff mode — Hub A", "Facility access —
North Gate").

## 21. Shipment freeze awareness

When an ops manager freezes a shipment (incident/security/legal hold), affected
riders/drivers see the shipment status `frozen` with the reason; all movement
actions (scan, handoff, load, advance) return `SHIPMENT_FROZEN` and custody is
locked. `shipment.unfrozen` restores the plan; the rider may be asked to
continue with the resume plan.
