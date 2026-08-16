# HUDumika Provider — Testing

Test strategy for both surfaces. Core principle: MSW handlers are contract-tested against `backend/API-CONTRACT.yaml` so the app runs identically against mocks and the real API (MSW parity).

## Test stack

| Surface | Framework | Notes |
| --- | --- | --- |
| Mobile (Expo) | Jest + React Native Testing Library | Component + hook tests; native module mocks for `expo-secure-store`, push |
| Web (Vite) | Vitest + Testing Library | jsdom; react-router test utils |
| Shared mocks | MSW (`packages/shared/mocks`) | Same handler set both surfaces |
| E2E | Web: Playwright (dashboard); mobile: Expo + Maestro (happy path) | See E2E below |

## MSW contract tests

- Handlers implement every endpoint in API.md 1:1 with the contract: paths, query params (`limit`, `cursor`, `status`), request/response schemas, error codes (`409` conflicts, `401`, `429` with `retryAfterSeconds`, `422` field errors).
- Contract tests assert: handler shape matches the OpenAPI paths; response bodies validate against schemas (JSON schema derived from the YAML); enums (BookingStatus, PayoutStatus, VerificationState) are exhaustive.
- Same tests run against MSW in dev and against staging once the API is live — swapping the base URL (`EXPO_PUBLIC_API_URL` / `VITE_API_URL`) must not change results.
- MSW runs only in `development`; never bundled in production builds.

## E2E: booking happy path

Flow on both surfaces (accept → arrive → complete):

1. Log in via OTP mock (MSW) → landing on onboarding → application → `approved` (mock decision).
2. Set availability → receive `booking.requested` → accept within the countdown → `provider_accepted` → `scheduled`.
3. Advance `provider_arrived` → `in_progress`.
4. `POST /bookings/{bookingId}/complete` → `awaiting_customer_confirmation`.
5. Mock customer confirm → `completed` → booking appears in history; earnings screen shows the `booking_earning` entry; payout list shows `pending`.

Negative cases: accept after 300 s (`DISPATCH_ACCEPTANCE_TIMEOUT` → "request expired"), decline with reason → next-candidate copy, cancellation after acceptance (reliability notice + `cancelled` status), `disputed` booking (payout held).

## E2E: service business flow (dual ecosystem)

Full journey on both surfaces, mirroring SERVICE-CATALOG.md / TECHNICIANS.md:

1. Create a service listing (`POST /providers/me/services`), then delete attempt while bookings exist → `SERVICE_IN_USE` → deactivate instead.
2. `GET /bookings/estimate` → range + `tripFeeTZS` + disclaimer rendered.
3. Booking arrives with pre-visit job photos (mock `BookingCreate.photos`, max 6) → provider prepares; add a technician (`POST /providers/me/technicians`).
4. Accept → assign the technician (booking shows `technicianId`, technician `on_job`; second assignment → `TECHNICIAN_BUSY`).
5. Arrive → inspect → submit quote (`quote_issued`) → mock customer approves (`quote_approved`) → `in_progress`.
6. Record parts (`POST /bookings/{bookingId}/parts`) → issue invoice (`issued`, breakdown labor + trip + parts − discount + tax = total) → mock payment → `paid`.
7. Submit proof of service (photo + GPS stamp) → complete → warranty issued (`active`, `followUpAt` shown).
8. Earnings: statement shows the `booking_earning` entry; warranty claim (`claimed`) does not change the ledger.

Negative paths: `QUOTE_DECLINED` (work-start blocked, re-quote or cancel CTA), `PROOF_OF_SERVICE_ALREADY_SUBMITTED` (single proof per booking), `CERTIFICATION_EXPIRED` (listing blocked until renewal — `PATCH` re-enters `pending`).

## E2E: marketplace and job machine (provider OS)

1. Login as `owner` → capability catalog fetched (`GET /providers/me/capabilities`); invite a technician and a dispatcher (`POST /providers/me/staff`, both `invited` → OTP sign-in → `active`).
2. Dispatcher signs in: browse marketplace (`GET /dispatch/provider-jobs` with `lat`/`lon`) → nearby + recommended cards render `matchScore`, `reasons[]`, estimate range, urgency, `expiresAt` countdown.
3. Dispatcher assigns technician (`assign_technician`); technician session sees the job under `view_assigned_jobs` → accepts (`POST /dispatch/provider-jobs/{bookingId}/accept`) → `provider_accepted` → `scheduled`.
4. Full machine: `en_route` → `provider_arrived` → `diagnosing` → quote submitted → `quote_submitted` → customer approves → `quote_accepted` → `in_progress` → proof of service → `awaiting_customer_confirmation` → customer confirms → `completed` → `settled` (ledger shows the `booking_earning` entry; payout list shows `pending`).
5. Simple job (no quote gate): `provider_arrived` → `in_progress` directly — diagnosing/quote states absent from the timeline.

Negative paths:

- Offer expires: wait out the 5-min window → accept returns `409` `JOB_OFFER_EXPIRED` → "offer expired" state, job leaves the marketplace.
- Double-accept: two staff accept the same offer → second gets `JOB_OFFER_ACCEPTANCE_WINDOW` (already taken).
- Quote declined: customer declines at `quote_required` (`QUOTE_DECLINED`) → work blocked → re-quote or cancel CTA; re-quote returns to `quote_required`.
- Capability denial: technician session calls `assign_technician` → `403` `CAPABILITY_FORBIDDEN`; the technician UI never renders the assign action (catalog-gated).
- Last-owner guard: deleting the only `owner` → `PROVIDER_STAFF_LAST_OWNER`; ownership transfers by role change first.

## E2E: category, inventory, SLA, recurring (provider intelligence)

1. Category questionnaire: `GET /service-categories` renders per-trade config (plumbing vs electrical differ); `GET /service-categories/{categoryId}/questions` renders question types (single_choice, boolean, photo) — booking arrives with `BookingCreate.answers` keyed by question `key`, shown read-only on job detail.
2. Inventory deduct on parts use: add stock (`POST /providers/me/inventory`), record a parts line on a booking with matching `catalogueItemId` → `stockOnHand` drops by quantity; manual adjust below zero → `INVENTORY_NEGATIVE_STOCK`; adjust without reason → `INVENTORY_ADJUSTMENT_REASON_REQUIRED`.
3. Contract SLA deadline → escalation: contract booking carries `slaDeadlineAt`; advance past it → `sla.deadline_approaching` notification → `SLA_DEADLINE_MISSED` surfaces in the timeline.
4. Recurring plan auto-booking: plan list/CRUD (`GET/POST /providers/me/service-plans`); mock the sweeper emitting `recurring.booking_created` with a booking carrying `recurringPlanId` — occurrence settles per its own lifecycle (one `booking_earning` per occurrence).
5. Trust flag → owner notified: mock `GET /providers/me/trust` with a flag (e.g. `off_platform_payment`) → flag card renders with explanation; `trust.flag_raised` in-app notification deep-links to the trust screen.
6. Copilot `suggest_quote`: `POST /providers/me/copilot` → result renders with the disclaimer that it is a suggestion; quote totals are never pre-filled into the real quote mutation without provider review; `COPILOT_UNAVAILABLE` → non-blocking empty state.
7. Pause/resume: pause with reason → `job.paused`, paused pill; `PAUSE_NOT_ALLOWED` on wrong status; resume → `job.resumed`.
8. Check-in geofence: check-in at valid coords → `check_in` status; out of radius → `409` `CHECK_IN_NOT_ALLOWED` with position hint; manual fallback path works.

## Per-screen state checklist

Every screen must implement and test all four states:

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Login/OTP | sending | — | OTP invalid/expired/rate-limited; retry with `retryAfterSeconds` | session → redirect by role |
| Onboarding | `GET /providers/me` fetch | no application → start CTA | fetch fail → retry | per VerificationState |
| Availability | week skeleton | no windows → CTA | save fail → revert + toast | `204` → refetch |
| Jobs list (per status tab) | skeleton cards | "No incoming requests" etc. | retry button | status pills + TZS |
| Job detail | skeleton timeline | — | retry; mutation fail → toast + refetch | timeline + action buttons per status |
| Earnings | skeleton balance | "No payouts yet" | retry | balance, payouts, statement |
| Notifications | skeleton | "No notifications" | retry | unread/read, deep links |
| Preferences | skeleton switches | — | revert toggles | saved; locked system rows |
| Support tickets | skeleton | "No tickets" | retry | thread + reply composer |
| Settings/profile | skeleton | — | retry | profile, locale, logout |

## Quality gates

- `npm test` / `jest` green before merge; coverage watch on the shared api client and status-driven components.
- No snapshot-only tests for content strings (locale-sensitive); use text matchers via i18n keys.
- Run the contract test suite on every contract change; propose fixture updates in the same PR.
