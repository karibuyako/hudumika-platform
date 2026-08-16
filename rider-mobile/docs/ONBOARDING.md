# HUDumika RIDER — Onboarding

Goal: a user becomes an approved rider and can go online. Server gates everything: no jobs are dispatched before approval (`verification: approved`).

## Flow

```text
OTP login (verify-otp, purpose: login|signup)
  → Application (POST /riders)
  → Documents upload
  → Verification status polling (GET /riders/me)
  → approved → Home (online toggle) / rejected or changes_requested → revision
```

## 1. Application (`POST /riders`)

`RiderApplication` required: `name`, `phone`, `city`; optional `email`, `vehicle`, `hasSmartphone`, `documentsNote`.

| Field | UI |
| --- | --- |
| `name` | Full name, min 1 char, max 120 |
| `phone` | Pre-filled from session `User.phone` (read-only) |
| `email` | Optional, validated |
| `city` | Picker from `GET /cities?country=TZ` |
| `vehicle` | `motorcycle`, `bicycle`, `car` — one choice, affects eligibility |
| `hasSmartphone` | Required true for app-based delivery |
| `documentsNote` | Free text (max 500), e.g. pending license renewal |

Response is `LeadCreated` `{id, status: submitted|under_review, createdAt}`. Duplicate submissions: re-submit is a new application; the UI explains re-review. Success state: confirmation + step 2 prompt.

## 2. Document upload

Documents are attached to the application (uploaded via signed URL from the app's own upload flow; document review state per document is `missing | pending | approved | rejected`). Standard set:

| Document | Purpose |
| --- | --- |
| National ID | Identity verification |
| Driver's licence | Required for `motorcycle` and `car` |
| Vehicle registration / photo | Vehicle verification |
| Health certificate | Fitness to deliver (food handling) |
| Insurance | Proof of cover during trips |
| Bicycle registration (where required) | City-dependent registration |

- Upload state per document: not uploaded → uploading → uploaded → `pending` review → `approved`/`rejected` (from `RiderAdmin.documents`, surfaced to rider via verification screen + `lead.reviewed` SMS/in-app notification).
- Rejected documents show the reason and allow re-upload (new upload replaces the rejected one).
- `changes_requested` verification state: show the requested changes list, block going online.

## 3. Verification state (`VerificationState`)

Rendered from `GET /riders/me` → `verification`:

| State | Screen | Actions |
| --- | --- | --- |
| `pending` | "Application received" | none (wait) |
| `documents_review` | Document status list | re-upload rejected docs |
| `changes_requested` | Requested changes | edit + resubmit |
| `approved` | Home, online toggle enabled | deliver |
| `rejected` | Rejection + reason | contact support (ticket) |
| `suspended` | Suspended banner + reason | appeal via support ticket; online toggle disabled |

Loading: skeleton of status card. Empty: no application yet → show application form. Error/retry: refetch button. Success: state-specific card as above. The screen polls `riders/me` (or refreshes on `lead.reviewed` notification) while in `pending`/`documents_review`/`changes_requested`.

## 4. Background check and face verification

- The background check runs alongside document review during verification; its status is shown on the verification screen while the flow is in `pending` / `documents_review`: `pending` → `in_progress` → `clear` (eligible) or `flagged` (manual review — the rider sees a "check under manual review" state, never a fabricated result). The check never auto-approves: going online still requires `verification: approved` (server gate).
- Approval and pending/rejected states: `approved` → online toggle enabled; `pending` / `in_progress` → "Application under review" with no actions; `rejected` → rejection + reason with a "fix issues" re-submission path (re-upload or re-submit from the verification screen, mirroring the `changes_requested` edit + resubmit flow).
- Face verification (AI selfie liveness check) is a planned phase alongside the Academy safety course gate (EDUCATION.md, ROADMAP P10): it requires contract additions (face-verification endpoints), and until it ships the app shows no selfie UI — going online requires only `verification: approved`.

## 5. Vehicle selection

- Chosen once at application (`vehicle`); changeable later via `PATCH /riders/me` (affects dispatch eligibility only server-side).
- Displayed on profile and Home ("Riding: Motorcycle").
- Vehicle never affects any fee shown in-app (server-side).

## 6. Transport mode (means of transport role)

`RiderPrivate.transportMode` — `local_motorcycle | local_car | van | linehaul_bus | linehaul_truck | relay` (default `local_motorcycle`) — assigns the rider's role by means of transport (LONG-HAUL-RELAY.md). The mode decides what the rider sees and handles: local modes get single-order offers; `van` adds small batches and short line-haul; `linehaul_bus`/`linehaul_truck` see consignments + trips + manifests only (never individual customer orders); `relay` gets relay-chain assignments with sequential handoffs.

### 6.1 Mode selection (when and how)

- Selection happens at onboarding/verification (server-side assignment); the app renders `transportMode` from `GET /riders/me` on Profile and Home, and never offers a client-side mode editor — `RiderUpdate` does not yet carry `transportMode`, so changes go through ops (support ticket), like employment type.
- The onboarding application form collects the intended mode as a choice card (local / van / line-haul bus / line-haul truck / relay); the submitted value is informational until ops verifies the documents for that mode.
- Multi-mode: a rider may be granted more than one capability (e.g. `van` + `relay`); the server returns the surfaces for the granted capabilities; the app renders the returned menus only.

### 6.2 Licensing and verification per mode

| Mode | Documents required | Verification gates |
| --- | --- | --- |
| `local_motorcycle` | National ID, driver's licence (motorcycle class), vehicle registration/photo, health certificate, insurance | `verification: approved`; licence class checked against the vehicle type |
| `local_car` | National ID, driver's licence (car class), vehicle registration/photo, insurance | `verification: approved`; car-class licence required |
| `van` | National ID, driver's licence with van class (or car class + vehicle-class endorsement where applicable), van registration/insurance | `verification: approved`; the licence must cover the registered vehicle class |
| `linehaul_bus` | National ID, driver's licence with bus class, bus registration/insurance, passenger/commercial endorsement where applicable, route/PSV permit where required by law | `verification: approved` + bus-class licence + endorsement; `Route.permittedVehicles` must contain `linehaul_bus` for the assigned corridor |
| `linehaul_truck` | National ID, driver's licence with truck class, truck registration/insurance, commercial endorsement where applicable | `verification: approved` + truck-class licence + endorsement; `Route.permittedVehicles` must contain `linehaul_truck` |
| `relay` | reuses the motorcycle/car licence already collected + relay training (EDUCATION.md, planned) | `verification: approved`; relay training certificate marked planned until the training module ships |

Document lifecycle: each document uploads → `pending` review → `approved` /
`rejected` (reason shown, re-upload replaces). A rejected mode document blocks
that mode's assignment; the rider sees which document failed and re-uploads.

### 6.3 Vehicle registration linkage

- The rider's `vehicle` (application choice) links to the registered vehicle
  record: registration plate/photo, type, class. For line-haul modes the linked
  `Vehicle` entity is the platform fleet vehicle (registration, capacity
  compartments, `temperatureCapable`, `securityCapability`, `permittedRoutes`,
  status) — assigned to the driver by ops/fleet, never created by the rider app.
- Mode ↔ vehicle consistency: a `linehaul_bus` rider cannot operate a
  motorcycle-registered vehicle; the vehicle class must match the licence class
  (licensing rule above).
- Fleet ownership: `fleetType` (`captive | contracted | outsourced | hybrid`,
  default `captive`) and `hubId` (distribution hub, nullable) display on the
  profile and are updatable via `RiderUpdate` — the mode itself stays ops-set.

### 6.4 Matching validation

- Matching validates the mode against the leg `mode`: a `local_motorcycle` rider
  cannot take a `linehaul_bus` leg — `TRANSPORT_MODE_INVALID` rejects the
  assignment server-side (DISPATCH-FLOW.md); the app renders the returned error,
  never a local filter.
- Vehicle-level gates: the assigned `Vehicle` must be `active`, on a
  `permittedRoutes` corridor, and compatible with the cargo
  (`COMPARTMENT_INCOMPATIBLE` guard at load).

## 7. Delivery zone setup

- `deliveryZone` (string, e.g. city/zone label) set via `PATCH /riders/me`.
- Pick from service areas of the chosen city (`GET /cities` → `City.serviceAreas[]`).
- Dispatch only assigns orders whose merchant falls inside the rider's delivery zone (per `DISPATCH.md`).

## 8. Reliability score

`reliabilityScore` (0–100, integer) is computed and stored server-side (visible to staff in `RiderAdmin`); the rider app explains it, it is not exposed as a raw admin field unless shown in Settings.

| Factor (per `DISPATCH.md` anti-gaming) | Effect |
| --- | --- |
| Late arrival at merchant pickup | Decrease |
| Cancellation after accepting an assignment | Decrease |
| Repeated declines within one hour | Decrease (declines are otherwise free) |
| Completed deliveries, on-time pickups | Maintain/increase over time |

UI: Settings → "Reliability" card explains the factors (en + sw); no numeric spoofing — value rendered only from server data, if surfaced at all.

## 9. Business / role mapping

- `RiderPrivate.merchantIds` (array of business UUIDs) is the rider's role mapping: at login the rider is mapped to the associated business(es) — orders from those businesses are prioritized/visible in the rider's active list per dispatch, never picked client-side.
- Profile shows "Associated businesses": for each `merchantId`, fetch the public `GET /merchants/{merchantId}` (approved merchants only) for name/logo. Loading: business card skeletons. Empty (no mapping): "No associated businesses" — dispatch still works via the open pool. Error: retry per card; unknown id renders masked, never a crash.
- The mapping is set server-side (ops/onboarding); the rider never edits `merchantIds`.

### Role-based access

- `RiderPrivate.merchantIds` also gates rider-level permissions server-side: riders mapped to a business may see that business's delivery context (pickup codes, store-specific notes, branded surfaces where shipped) while unmapped riders see the generic flow. Clients never decide permissions — surfaces render only what the server returns for the authenticated rider (SECURITY.md role separation).
- Different rider types can therefore hold different permissions per business (e.g. mapped vs open-pool riders); the app renders the same endpoints and honors whatever the server allows — no client-side feature flags.

## 10. Employment type (`RiderPrivate.employmentType`)

- `employmentType` ∈ `full_time | part_time` (default `full_time`), rendered on profile and used by ops for shift planning.
- Onboarding collects the preference at application time (full-time / part-time choice card); the value shown always comes from `GET /riders/me` — the save path for changes is a planned contract addition (`RiderUpdate` does not yet carry it); until then changes go through ops via a support ticket. The choice is informational for dispatch scheduling, never a hard gate on offers.

## 11. Availability preferences (`RiderPrivate.availability`)

- `availability`: `{preferredDays: number[] (0–6), preferredStart ("09:00"), preferredEnd ("18:00"), maxHoursPerDay (default 12)}` — server-owned, read-only in the app.
- Onboarding shows the preferences form (weekday toggles, start/end time pickers, max-hours stepper) with default values; submitted values follow the same planned save path as employment type (ops-set until `RiderUpdate` extends).
- `maxHoursPerDay` feeds the rest-reminder sweep (`rest.reminder` push when continuous driving exceeds it, DISPATCH-FLOW.md) and the shift/break prompts; `preferredDays`/`preferredStart`/`preferredEnd` inform ops shift offers — the app never schedules shifts itself.

## 12. Business-specific workflows and branded experience (planned)

- Business-specific onboarding steps (per-merchant training, branded uniforms/documents, business-only payout rules) and per-business branded rider surfaces are planned — contract additions (per-merchant rider settings) plus ops workflows; marked planned in ROADMAP P10c. Today, one onboarding fits all riders; `merchantIds` mapping is the hook the planned branded flow will key off.

## 13. Safety onboarding (planned)

- Facial recognition and the safety training video + test are a planned phase (reference EDUCATION.md Academy: road safety course, certification milestones): they require contract additions (face-verification and course/progress endpoints) and are marked planned in ROADMAP P10. Today, going online requires only `verification: approved`.

## State checklist

| State | Behavior |
| --- | --- |
| Loading | Skeletons for application form submit, status polling |
| Empty | No application → form; no docs → upload prompt |
| Error | `422 VALIDATION_FAILED` → inline field errors; network → retry banner |
| Retry | Refetch `riders/me`; re-submit form keeps draft |
| Success | Approved → Home with online toggle; else state-specific guidance |
