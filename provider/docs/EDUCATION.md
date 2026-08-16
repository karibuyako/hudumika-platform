# HUDumika Provider — Academy (Planned)

The Provider Academy is the in-app training program for service professionals (the HUDumika equivalent of a partner academy): per-trade onboarding courses, certification milestones, operations tips, and a direct line to the business manager.

Status: planned phase (post-launch, see ROADMAP.md). Not shipped in P0–P7; every server-tracked capability below is marked `contract addition needed` and must follow `backend/API-CONTRACT.yaml` once added.

## Scope

| Item | Phase | Backend dependency |
| --- | --- | --- |
| Static course catalogue (per trade) | Planned | none — content is app-driven |
| Course progress tracking | Planned | contract addition needed: course/progress endpoints |
| Certificates and badges | Planned | contract addition needed: certification field on `ProviderPrivate` / `ProviderPublic` |
| Onboarding course gate | Planned | today a client-side marker only (ONBOARDING.md step 7) |
| Business manager contact | Planned | contract addition needed: manager field on `ProviderPrivate`; until then env-driven config |

## Course catalogue by trade

Courses are selected by the provider's trade (`GET /services?category`); a provider only sees courses for approved trades.

| Course | Audience | Content summary | Certification |
| --- | --- | --- | --- |
| Worksite safety | All trades | PPE, hazards (electrical, water, heights), emergency steps | Safety Certificate |
| Trade tool handling | Plumbers, electricians, repairers, carpentry | Correct tool use, maintenance, replacement rules | Tool Handling Certificate |
| Customer service | All trades | Arrival etiquette, quoting vs `PriceBreakdown`, photo evidence, review handling | Service Excellence Certificate |
| Hygiene and materials | Cleaning, beauty, laundry, pest control | Product handling, disposal, customer-site rules | Hygiene Certificate |

## Onboarding courses

- The safety course is recommended before the first booking; regulated trades must pass it before `approved` (gate copy on the onboarding screen).
- Completion today is a client-side marker (ONBOARDING.md step 7); server-tracked completion is `contract addition needed` before it can block approval.

## Certification milestones

| Milestone | Earns | Benefit (planned) |
| --- | --- | --- |
| Pass first course | Safety Certificate | Progress shown in Academy |
| Pass all trade courses | Trade Certified badge | Badge on the public profile (contract addition needed) |
| 12 months with no reliability penalty | Senior Provider tier | Priority in dispatch candidate ranking (server-side) |

Certification state renders read-only from the server; never hardcoded or derived locally.

## Operations tips

- Confirm the job the day before from the booking detail; render `scheduledFor` in local time.
- Mark `provider_arrived` on arrival; late arrival (> 30 min past `scheduledFor`) records a reliability event (DISPATCH.md).
- Upload completion evidence before `complete` — a missing upload blocks completion (BOOKING-FLOW.md).
- Keep documents current; `changes_requested` blocks new bookings (ONBOARDING.md).

## Business manager contact

- Every provider is assigned a business manager (phone + email) shown in Academy and Settings.
- No hardcoded numbers: the contact renders from environment config today; `ProviderPrivate.businessManager` is `contract addition needed` for account-specific contact.

## Feedback and help

| Need | Path |
| --- | --- |
| Course feedback | Support ticket (`POST /support/tickets`, subject prefilled with the course name) |
| Certificate dispute | Support ticket referencing the course/certificate |
| Help with the app | `ticket.reply` thread; deep link to ticket detail |

## Screen state checklist (Academy screens)

| State | Behavior |
| --- | --- |
| Loading | Course card skeletons |
| Empty | No courses for the current trade (before trade selection) |
| Error | `ErrorResponse.message` + retry |
| Retry | Refetch course list and progress |
| Success | Course list, progress bars, certificate cards |

## Contract additions needed

- Course catalogue + progress endpoints (list, start, complete).
- Certification state on `ProviderPrivate`; badge on `ProviderPublic`.
- `course.certified` notification event (backend NOTIFICATIONS.md catalog).
- `ProviderPrivate.businessManager` contact object.
