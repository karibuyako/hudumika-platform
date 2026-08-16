# HUDumika Intercity & Multi-Leg Logistics

How the platform handles out-of-city deliveries that take more than one day and
require multiple transportation legs — motorcycle → bus → motorcycle — modeled on
how large platforms operate (Meituan relay delivery 接力配送, FedEx/UPS
hub-and-spoke networks, line-haul trunk transport).

## 1. The model: legs, hubs, consignments, handoffs

```
Merchant (City A)            Hub A                Hub B                Customer (City B)
   │  first_mile                │                   │                      │
   └─▶ local rider (motorcycle) └─▶ line-haul bus ──▶ sortation ──▶ last_mile ──▶
              │  linehaul        (many orders       │   hub_transfer  local rider
              │  consignment)    in one vehicle)    │   (motorcycle)
```

| Concept | What it is | Contract |
| --- | --- | --- |
| **Fulfillment type** | `local` (same city), `intercity` (hub-to-hub + line-haul), `relay` (sequential rider handoffs within a region) | `Order.fulfillmentType` |
| **Route segment (leg)** | One transportation step: first_mile, linehaul, hub_transfer, last_mile, return — with mode, hubs, handler, status, ETA, custody | `Order.routeSegments[]` / `GET /orders/{id}/route` |
| **Hub** | City consolidation/sorting center where orders are scanned in/out and re-routed | `/hubs` |
| **Line-haul consignment** | One bus/truck carries many orders at once; per-order barcode manifest with segregation sections | `/linehaul/consignments` + manifest |
| **Handoff** | Custody transfer between legs — barcode scan + tamper-seal check + condition photo | `POST /orders/{id}/handoff` |
| **Waybill** | The tracking number and full scan/event trail across every leg | `Order.waybillNumber` / `GET /orders/{id}/waybill` |

## 2. How big platforms ensure efficiency, security and zero mixing errors

### Efficiency
- **Hub-and-spoke consolidation**: many small orders are consolidated into one
  line-haul vehicle (bus/truck) per corridor — economies of scale; hubs sort by
  destination (like FedEx Worldport / UPS Louisville).
- **Batch manifests**: one consignment carries dozens of orders; capacity and
  section limits prevent overloading (`CONSIGNMENT_FULL`).
- **Per-leg ETA**: each leg has `etaAt`; the customer sees the whole journey with
  per-leg ETAs and live updates (`intercity.eta_updated`).
- **Scheduling**: `scheduledDeparture` windows per corridor; multi-day promise
  communicated as delivery-date windows (e.g. "Arrives Day 2, 9:00–14:00").

### Zero mixing errors (the core risk)
1. Every order gets a unique `waybillNumber` and barcode.
2. The consignment **manifest** maps each order to a **segregation section**
   (`standard | fragile | cold_chain | documents | high_value`) — goods of
   different types never physically mix; handlers load per section.
3. **Scan at every transition**: origin hub scan-in → vehicle departure →
   destination hub arrival with `verifiedOrderIds` (must equal the manifest —
   `CONSIGNMENT_ORDER_MISMATCH`) → per-order sortation → last-mile rider scan.
4. Missing orders at arrival (`CONSIGNMENT_MISSING_ORDERS`) raise an exception
   workflow: locate, re-route, notify customer, and audit.
5. The **waybill event trail** is append-only, so any discrepancy is traceable
   to the exact scan point, actor, and timestamp.

### Security & assurance
- **Custody chain**: every handoff records `from → to`, scan code, seal state,
  condition photo, GPS, and time; `HANDOFF_SEAL_BROKEN` or
  `HANDOFF_SCAN_MISMATCH` blocks the leg advance and flags ops.
- **Tamper-evident seals**: packages are sealed at origin; the receiving party
  verifies seal integrity at each handoff.
- **Segregation + high-value section**: high-value orders travel in a locked
  section with a stricter handoff (ID check).
- **Insurance bands**: declared value determines the coverage band; damage/loss
  claims follow the custody chain to attribute responsibility.
- **Role-based views by transport mode**: local riders see single orders;
  line-haul riders/carriers see consignments + manifests only; hub staff see
  sortation queues — the exact "different view / access control by role and
  means of transport" requirement.

## 3. Rider roles by means of transport

`RiderPrivate.transportMode`: `local_motorcycle | local_car | van | linehaul_bus |
linehaul_truck | relay`. Capabilities differ:

| Mode | Sees | Handles |
| --- | --- | --- |
| local_motorcycle/car | single-order offers | first_mile, last_mile |
| van | single orders + small batches | first/last mile, short line-haul |
| linehaul_bus/truck | consignments + manifests (not individual customer orders) | line-haul leg, hub-to-hub |
| relay | relay chain assignments | sequential handoffs within a region |

Matching validates `transportMode` against the leg mode (`TRANSPORT_MODE_INVALID`
if the rider isn't licensed/configured for it — e.g. a motorcycle rider cannot
take a linehaul bus leg).

## 4. Multi-day promise

- `intercity` orders carry delivery-window metadata on the leg ETAs; the customer
  app renders "Day 1 / Day 2" phases from the leg plan.
- Overnight legs are normal (`linehaul` with scheduled overnight departure);
  `leg.completed`/`handoff.completed` events keep the timeline alive overnight.
- Courier relays (`relay`) allow same-day region coverage without a single rider
  traveling the whole distance — riders hand off at meeting points (custody
  transfer with scan).

## 5. Exception and dispute handling

- Scan mismatch / missing order / seal broken → `consignment.exception` +
  `waybill.updated` (exception event) → ops runbook (locate → re-route →
  notify → audit) → customer informed with new ETA.
- Damage claims use the custody chain: the handoff where the seal was last
  verified intact is the reference point for responsibility.
- Dispatch treats intercity orders as a separate lane: local dispatch, line-haul
  scheduling, and hub sortation are independent queues (see DISPATCH.md).

## 6. Roadmap position

Backend M11 (logistics lane) — hubs + route legs first, then consignments +
handoffs + waybill trail, then relay mode and carrier integrations (third-party
bus/truck lines). See backend/ROADMAP.md and the cross-team roadmap P9 lane.
