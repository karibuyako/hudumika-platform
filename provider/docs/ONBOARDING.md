# HUDumika Provider — Onboarding and Verification

Flow: account (OTP) → provider application → document review → approval → publish profile → receive bookings.

Provider onboarding is a separate path from merchant onboarding (dual-ecosystem model): providers are skilled-service businesses with their own application, verification state, trade requirements, and (below) professional certifications. The provider never reuses the merchant application flow, and provider records never touch merchant tables.

## Application steps

| Step | Data | Endpoint / source |
| --- | --- | --- |
| 1. Identity | Name, phone, email, city | `POST /providers` (`ProviderApplication`) |
| 2. Trade | Trade category (15 trades + `other`; see Vertical trades) | `GET /services?category` + local selection |
| 3. Documents | Identity + qualifications uploads | Part of application review; status per document |
| 4. Service areas | City + `serviceAreas` from `GET /cities` | `PATCH /providers/me` |
| 5. Profile | `bio`, `baseRateTZS`, `avatarUrl` | `PATCH /providers/me` |
| 6. Availability | Weekly schedule + active toggle | `PUT /providers/me/availability` |
| 7. Training | Safety/service-standard completion marker (client-side step) | Local state; gating copy |
| 8. Review | Operations approves or requests changes | `VerificationState` via `GET /providers/me` |

Document requirements:

| Document | Purpose | Status values |
| --- | --- | --- |
| Identity (government-issued ID / NIDA) | Verify the person behind the account | `missing`, `pending`, `approved`, `rejected` |
| Qualifications / licences (where required) | Trade competence for regulated categories | same |
| References / portfolio images | Quality signal where required | same |

Document status is displayed per document; upload failure keeps the document `missing` and blocks submission. Regulated categories cannot reach `approved` without qualifications.

## VerificationState — what the app renders

From `VerificationState` (`GET /providers/me.verification`):

| State | Provider sees | App behavior |
| --- | --- | --- |
| `pending` | "Application received" | Submit screen (success state), wait state |
| `documents_review` | "Documents under review" | Progress screen, no jobs tab |
| `changes_requested` | Reason + which documents to fix | Editable re-submission (retry state per document) |
| `approved` | Full app unlocked | Availability + bookings + earnings tabs |
| `rejected` | Reason | Appeal via support ticket (`TicketCreate`), app locked |
| `suspended` | Notice + reason | App locked, contact support |

Screen states: loading (spinner while fetching `/providers/me`), empty (no application yet → start button), error (API unavailable → retry), success (per step), and the locked states above. `changes_requested` and `rejected` decisions arrive with the `lead.reviewed` notification and are also reflected on next fetch.

## Trade and service area setup

- Trade list comes from the platform service catalogue (`GET /services`); unit drives pricing hints (`per_hour`, `per_visit`, `per_order`, `per_item`).
- Service areas: pick from the city's `serviceAreas` (polygons); saved via `PATCH /providers/me` (`serviceAreas[]`). The provider only matches bookings whose customer address falls inside a selected area (see AVAILABILITY.md matching rules).
- `baseRateTZS` is the starting price shown on the public profile (`ProviderPublic.baseRateTZS`); customer sees a full price range before booking.

## Vertical trades

`ProviderApplication.trade` spans 15 trades plus the `other` fallback:

`plumbing, electrical, cleaning, repairs, carpentry, painting, beauty, wellness, fitness, education, automotive, pet_care, health_care, events, property, other`

The provider surface therefore serves 10+ service verticals. Vertical-to-trade mapping:

| Vertical | Trades | Typical providers |
| --- | --- | --- |
| Home services | plumbing, electrical, cleaning, repairs, carpentry, painting | Plumbers, electricians, cleaners, repairers, carpenters, painters |
| Beauty | beauty | Salons, barbers |
| Wellness | wellness | Massage and spa services |
| Fitness | fitness | Personal trainers, studios |
| Education | education | Tutors |
| Automotive | automotive | Mechanics, vehicle care |
| Pet care | pet_care | Grooming, vet assistants |
| Health care | health_care | Home care (non-clinical) — clinical services are out of scope for v1 |
| Events | events | Event planners, venues |
| Property | property | Property maintenance |
| Other | other | Unclassified trades |

Per-vertical qualification and document requirements (which documents are mandatory, which trades need licences or certificates) are configuration-driven: operations configures requirements per trade, and the client renders them from that config — never hardcoded. Contract note: per-trade requirement lists are not yet exposed on the contract; until a requirements field (e.g. `tradeRequirements`) lands, the app renders the generic document table above, and the backend gate keeps regulated categories from reaching `approved` without qualifications (see VERTICALS.md and ROADMAP.md P8c).

## Professional certifications (skill and certification verification)

`provider_certifications` records the business's professional licences and trade certificates — the "skill and certification verification" requirement. Certifications display on the public provider profile for trust (`ProviderPublic`).

| Endpoint | Purpose |
| --- | --- |
| `GET /providers/me/certifications` | Certification list with verification status |
| `POST /providers/me/certifications` | Add a certification |
| `PATCH /providers/me/certifications/{certificationId}` | Renew or re-upload a document |

`Certification` fields: `type` (e.g. `electrician_license`), `number`, `issuer` (max 120), `issuedAt` (date), `expiryDate` (date), `documentUrl`, `verified` (boolean, default `false`), `status` (`pending` | `verified` | `rejected` | `expired`). Required: `type`, `number`.

Rules:

- `CERTIFICATION_INVALID` on malformed records; `CERTIFICATION_EXPIRED` when `expiryDate` passes (server flips status) or when submitting an already-expired document.
- `CERTIFICATION_EXPIRED` blocks listing affected services: the service catalog (SERVICE-CATALOG.md) hides or disables listings whose trade requires the expired certification until renewal (`PATCH` with a fresh `expiryDate`/`documentUrl` re-enters `pending`).
- Status is server-verified; `verified: false` until ops verifies the document. The provider sees a verification progress state per certification; rejected entries show the reason and a re-upload path.
- `lead.reviewed`-style notifications for certification decisions are a contract addition (see NOTIFICATIONS.md) — until then, status changes appear on next fetch.

## Provider team setup (staff roles and capabilities)

`/providers/me/staff` manages the business's team — separate from customer/merchant user accounts. `ProviderStaffRole`: `owner`, `dispatcher`, `technician`, `supervisor`.

| Role | Typical use | Default capabilities (server-enforced) |
| --- | --- | --- |
| `owner` | Business principal; full control incl. staff management, payouts, settings | Full catalog |
| `dispatcher` | Assigns jobs to technicians, monitors live jobs, contacts customers | `view_all_jobs`, `assign_technician`, `reassign_job`, `view_schedule`, `contact_customer`, `monitor_live_jobs` |
| `technician` | Field work on assigned jobs | `view_assigned_jobs`, `accept_job`, `reject_job`, `view_customer_location`, `contact_customer`, `start_job`, `upload_before_photos`, `upload_after_photos`, `submit_quote`, `complete_job` |
| `supervisor` | Oversight of team and job quality | Business-configured oversight subset (no fixed default in the contract) |

Capabilities are explicit per member and never inherited: a technician never gains dispatcher capabilities (and vice versa), regardless of position in the team. Capabilities are configurable per member on `POST`/`PATCH /providers/me/staff`.

- Member lifecycle: created `invited` → signs in via OTP → `active`; `suspended` blocks the member's sessions. Removing the last `owner` is blocked (`PROVIDER_STAFF_LAST_OWNER`); ownership transfers by changing another member's role to `owner` first.
- `GET /providers/me/capabilities` returns the session's capability catalog; the app renders modules and actions only for capabilities in it — never optimistic UI for actions the server would deny (`403` `CAPABILITY_FORBIDDEN`).
- `provider_staff` (login team) is distinct from `provider_technicians` (fleet records, TECHNICIANS.md); a technician staff member still needs a fleet record to be assignable to jobs.
- Screen states: loading skeleton, empty ("No team members — invite the first one"), error + retry, success; mutations show in-flight states and revert on failure.

## Reliability score

Score is 0–100, computed and stored server-side (`ProviderAdmin.reliabilityScore`); the provider app shows it read-only with an explanation. Affected by (per DISPATCH.md anti-gaming and the GLOSSARY):

| Event | Effect |
| --- | --- |
| No-show (`booking.no_show`) | Strong negative |
| Late arrival (30 min past `scheduledFor`) | Negative; also triggers a reliability event + customer notification |
| Cancellation after acceptance | Negative; recorded as provider late cancellation, operations notified |
| Repeated declines | Negative, especially within a short window (dispatch anti-gaming) |

Score is not hardcoded anywhere in the client; render from the API only. Repeated quality complaints additionally trigger manual review (PRODUCT.md).

## Verification depth (planned)

- **KYC**: government ID + selfie/liveness verification (planned).
- **Interview/reference check/probation** stages before full activation (planned).
- **Languages** and **experience level** join the capability registry for better matching (planned).

## Provider types

The platform models four provider shapes — **Individual** (solo technician), **Provider Business** (company, branches, teams, technicians), **Franchise/Network** (regional operators + local providers), and **Enterprise** (multi-branch, dispatcher/supervisor/finance team). The same provider shell renders per type and per capability.
