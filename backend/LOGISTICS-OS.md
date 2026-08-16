# HUDumika Logistics Network Operating System (Logistics OS)

The definitive spec for multi-modal, multi-leg, multi-day delivery. This is not
"a delivery app" — it is a **logistics network operating system**: orders are
commercial objects, shipments are physical objects, legs are transportation
operations, manifests group physical objects, handoffs transfer custody, events
form the audit trail, and dispatch dynamically controls the network.

```
                     CUSTOMER
                        │
                     ORDER          ← commercial
                        │
                    SHIPMENT        ← physical
                        │
                     PACKAGE         ← logistic unit (GS1-style identity)
                        │
                 LOGISTICS PLAN     ← mutable
                        │
              ┌─────────┼─────────┐
            LEG 1     LEG 2     LEG 3
          MOTORCYCLE   BUS    MOTORCYCLE
           RIDER A   DRIVER B   RIDER C
            HUB A ─── HUB B ─── CUSTOMER
              │        │         │
           HANDOFF  HANDOFF   DELIVERY
                        │
                 EVENT / AUDIT STREAM
                        │
          TRACKING · SECURITY · CONTROL TOWER
                        │
                   AI / OPTIMIZER
```

## 1. Entity model (physical-digital twin)

Every physical object has a machine-readable digital identity:

| Physical | Digital | Contract |
| --- | --- | --- |
| Parcel | `Shipment` (SH-2026-000091829) | `/shipments` |
| Individual box | `Package` (PKG-7F92A8) with attributes | `Shipment.packages[]` |
| Bag/cage/pallet/lockbox | `Container` (BAG-CN-000391, sealed) | `/containers` |
| Vehicle (bike→bus→truck) | `Vehicle` with compartment capacity | `/vehicles` |
| Corridor | `Route` (Dar → Mwanza, departures) | `/routes` |
| One departure | `Trip` (TRP-9912, manifest summary) | `/trips` |
| Journey step | `RouteSegment` (leg) | `Order.routeSegments[]` |

A bus never receives 300 orders — it receives a **Trip** with a manifest summary:
"327 shipments, 7 containers, 326 verified, 1 exception".

## 2. Order → Shipment separation

The order is the commercial transaction; the shipment is the physical object.
One order → one shipment → one or more packages. Creating a shipment
(`POST /shipments`) links them; `SHIPMENT_ALREADY_EXISTS` prevents doubles.
This separation lets the plan change (rider A → bus 15 → rider C) without
touching the customer's order.

## 3. Identity and labels

- GS1-style logistic-unit IDs: shipment, package, and container numbers are
  globally unique and barcoded/QR-encoded.
- Physical label: shipment ID, destination, route, container, barcode.
- Scanning the barcode is the digital identity of the physical object — never
  trust memory about "which bag belongs to which order".

## 4. Scanning & multi-factor verification at every handoff

Every transfer is a transaction (`POST /orders/{id}/handoff` / `/shipments/{id}/scan`):

1. Scan package/shipment barcode → system verifies expected next handler
   (`HANDOFF_SCAN_MISMATCH` if handed to the wrong vehicle/leg).
2. Scan destination bin/hub + vehicle/rider ID (three-step verification).
3. Seal check: `sealIntact` must be true (`HANDOFF_SEAL_BROKEN` blocks).
4. Condition photo + GPS + timestamp recorded in the custody ledger.

A package expected on Bus 22 but handed to Bus 19 → **blocked handoff**.

## 5. Custody ledger

`GET /shipments/{id}/custody` returns the full chain:

```
09:12 picked up by Rider A (GPS) → 10:01 Hub A (H009) → 10:14 Container C99 →
10:28 loaded Bus 22 → 17:40 arrived Hub B → 17:51 opened → 18:02 scanned →
18:10 assigned Rider B → 19:04 delivered
```

"Where was the package at 15:00?" is always answerable.

## 6. Capacity, compartments, and compatibility

- `Vehicle.capacity.compartments[]`: standard / fragile / cold_chain /
  documents / high_value — each with capacity and used count
  (`VEHICLE_CAPACITY_EXCEEDED`).
- `Package.attributes`: temperature, fragile, hazardous, highValue,
  maxTransitHours, allowedModes.
- Routing rejects incompatible assignments (`COMPARTMENT_INCOMPATIBLE`) — a
  cold package never rides an unrefrigerated bus even with free space.

## 7. Reconciliation engine

`POST /linehaul/consignments/{id}/reconcile` compares manifest vs scanned
loading vs scanned unloading. `expected ≠ scanned` →
`RECONCILIATION_FAILED` + missing packages; the trip cannot close until the
exception is resolved (`TRIP_CANNOT_CLOSE`). Machine-verified, not human-trusted.

## 8. Mutable logistics plan

`POST /linehaul/consignments/{id}/replan` moves a consignment to an alternate
trip/vehicle when the original breaks down or is late (`PLAN_NOT_MUTABLE` once
departed). The customer's order never changes — only the physical plan.

## 9. Logical tracking vs physical state

Customers see `GET /orders/{id}/tracking-phases`: confirmed → picked up →
traveling → arrived in your city → out for delivery → delivered. The physical
leg states behind it are hidden — privacy + simplicity.

## 10. Minimum-information visibility (ABAC)

- Local rider: pickup point + transfer hub only (never the final customer until
  the last mile starts).
- Bus operator: trip, route, manifest summary, containers — never customer
  phones or final addresses.
- Hub worker: inbound/outbound manifests + scans (`shipment.current_hub == worker.hub`).
- Dispatcher: plans, reassignments, schedules (`shipment.region IN authorized`).
- Ops manager: overrides, exceptions, freeze/recovery.

Enforced as RBAC + ABAC + resource-level + geographic/assignment/tenant
restrictions — never `role == rider → everything`.

## 11. Specialized rider surfaces (capability-driven)

Shared rider platform, different surfaces: Local Last-Mile Rider · Pickup Rider ·
Transfer Rider · Long-Distance Driver · Bus/Van Operator · Hub Courier ·
Emergency/Recovery Courier — same auth, different permissions/workflows/views.

- Motorcycle rider UI: Available Jobs / Active Route / Handoff / History; job =
  pickup (Merchant X) → drop (Hub A).
- Bus operator UI: Trip (Hub A → Hub B), departure, ETA, cargo summary
  (327 shipments, 7 containers), START LOADING / CONFIRM LOAD / DEPART / ARRIVE /
  UNLOAD / REPORT INCIDENT.
- Hub worker UI: Incoming / Outgoing / Exceptions; Receive → Sort → Build
  Container → Load → Unload → Reconcile.
- Dispatcher UI: UNASSIGNED / ACTIVE / AT RISK + Reassign / Change Route /
  Escalate.

## 12. Exception management & auto-replanning

18 exception kinds (missing/wrong package, wrong hub/vehicle, scan failure,
damage, late vehicle, breakdown, rider unavailable, hub congestion, weather,
road closure, refused, deviation, security). A vehicle breakdown triggers:
detect → find alternate trip → move manifest → notify hubs → update ETA →
update customer.

## 13. Control tower

`GET /admin/logistics/control-tower`: active shipments / delayed / exceptions /
at-risk totals, live network map (trips per hub), critical exceptions queue
(wrong hub scan, vehicle delayed, package missing, rider no-show, seal broken,
reconciliation failed).

## 14. Events and anomaly detection

- Event stream: ShipmentCreated → PickupAssigned → PackagePickedUp →
  ArrivedAtHub → Sorted → ContainerCreated → Loaded → VehicleDeparted →
  ArrivedAtHub → Unloaded → Sorted → LastMileAssigned → OutForDelivery →
  Delivered (each with actor, location, vehicle, device, state, evidence).
- Fraud/trust: `logistics_anomalies` — package scanned at Hub B while actor GPS
  is 70 km away (`SCAN_GPS_MISMATCH`), scanned onto a bus still parked at the
  origin (`SCAN_VEHICLE_STATIC`), wrong-hub scans.

## 15. Roadmap

Backend M11 (logistics lane): shipments/packages/containers → vehicles/routes/
trips → reconciliation/replan → control tower → carrier integrations (SF-style
third-party for line-haul) and regional-warehouse model (pre-positioned
inventory for next-day) — planned. See backend/ROADMAP.md.

## 16. Strategy-pattern dispatching (per delivery type)

`Order.dispatchStrategy` selects the algorithm: `nearest` (instant/on-demand —
nearest motorcycle rider), `zone` (same-day zone coverage), `multi_leg`
(cross-city: build the leg plan), `relay` (sequential rider handoffs), or
`warehouse` (nearest warehouse ships). The strategy is a pluggable dispatcher —
the same core service, different solver per strategy
(`DISPATCH_STRATEGY_INVALID` for unknown strategies).

## 17. Rider service models (Meituan-style)

`RiderPrivate.serviceModel`: `specialized` (专送 — contracted dedicated fleet),
`crowdsourced` (众包 — open pool), `errand` (跑腿 — ad-hoc errands), `fleet`
(company driver). Matching, guarantees, and UI surfaces differ per model
(`SERVICE_MODEL_INVALID` on invalid changes).

## 18. Fleet master accounts with sub-accounts

`/fleet/accounts` — one master account per delivery company; drivers are
sub-accounts linked via `RiderPrivate.fleetAccountId`, each with its own
permissions (RBAC), while the master owns vehicles, regions, and consolidated
billing. Mirror of the "primary account + sub-accounts" pattern.

## 19. Regional warehouse model (next-day, day-after)

- Merchants pre-position inventory in target-city warehouses
  (`/warehouses` + `warehouse_stock`); bulk inbound via
  `PUT /warehouses/{id}/stock`.
- When a customer orders, the server selects the nearest warehouse
  (`fulfillmentSource=warehouse`, `POST /warehouses/{id}/fulfill`); stock is
  deducted; `warehouse.fulfilled` notifies the customer.
- This is how next-day/day-after service works without an express courier per
  order (Kuaishou "Extreme Speed" model).

## 20. Third-party carriers (SF-style line-haul)

`/carriers` registry: line-haul legs can be handed to an external carrier
(`Consignment.carrierId`). The platform handles first mile + last mile;
the carrier runs the middle leg. Carrier handoffs use `carrier.handoff_required`
and manual scans or webhook integrations.

## 21. Facility whitelists (fixed-rider credential access)

`/facilities` + `/facilities/{id}/whitelist`: gated communities and business
parks get a fixed-rider whitelist (`accessPolicy: whitelist_only |
whitelist_or_otp | open`). Non-whitelisted riders are blocked at entry
(`NOT_WHITELISTED`); geofenced entry scans bind rider → facility → delivery.

## 22. Delivery exceptions catalog (18 kinds)

`/delivery-exceptions`: missing/wrong package, wrong hub/vehicle, scan failure,
damage, late vehicle, breakdown, rider unavailable, bus cancellation, hub
congestion, weather, road closure, customer unavailable, refused, route
deviation, security incident, reconciliation failure — each with status
`open → resolving → resolved/escalated`, outcome, and `autoReplanned` flag.
A breakdown triggers: detect → find alternate trip → move manifest → notify
hubs → update ETA → update customer.

## 23. Active reassignment and escalation

`POST /admin/shipments/{id}/reassign` — dispatcher moves a shipment to another
rider or trip mid-flight (`SHIPMENT_NOT_REASSIGNABLE` when the status forbids it).
`POST /admin/shipments/{id}/escalate` — incident/safety escalation with reason.

## 24. Weight/volume capacity

`Vehicle.capacity` adds `maxWeightKg`/`maxVolumeL` and per-compartment
`usedWeightKg`/`usedVolumeL`; `Package.attributes` adds `weightKg`/`volumeL`.
Loading rejects over-capacity (`CAPACITY_WEIGHT_EXCEEDED`,
`CAPACITY_VOLUME_EXCEEDED`) alongside the unit and compatibility checks.

## 25. Global optimizer (AI/ML, planned)

The batching optimizer solves: which packages → which rider → which hub → which
vehicle → which trip → which sequence → which handoff → which time — across the
fleet (the 200^100-class assignment problem). Long-term targets per AI-LAYER.md:
sub-millisecond route planning and fleet-wide re-optimization
(`plan.optimized`); Meituan-scale figures remain capacity targets, not v1
requirements.

## 26. Container identity (SSCC-compatible)

Container IDs follow the GS1 SSCC pattern (Serial Shipping Container Code) so
barcodes on bags/cages/pallets can be scanned by external carriers and systems.
Each container carries its own barcode; scanning it links all contained
packages to the manifest and custody chain.

## 27. Shipment freeze (ops control)

`POST /admin/shipments/{id}/freeze` — ops manager halts all movement on a
shipment (incident, security, legal hold); status becomes `frozen`, every
movement endpoint returns `SHIPMENT_FROZEN`, and custody is locked in place.
`POST /admin/shipments/{id}/unfreeze` authorizes recovery and resumes the plan
with a `resumePlan`. Both are audited (`shipment.freeze`/`shipment.unfreeze`).

## 28. Geofence context switching

The app switches surfaces by location context: entering a hub geofence enables
"handoff mode" (scan/verify UI); entering a facility whitelist geofence enables
the entry scan; leaving the geofence reverts to the normal job surface. Context
is derived server-side from geofences, never trusted from the client.
