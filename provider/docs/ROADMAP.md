# HUDumika Provider — Roadmap

Phased plan for the provider app aligned with `../ROADMAP.md` (P0–P9). Clients never wait on backend deploys: MSW parity with `backend/API-CONTRACT.yaml` keeps every phase buildable.

| Phase | Backend milestone | Provider deliverables | Exit criteria |
| --- | --- | --- | --- |
| **P0 — Foundations** | M1 auth + users | Scaffold Expo app + Vite web dashboard; shared `api` client from contract; OTP login (`request-otp`/`verify-otp`, `purpose: login`); refresh/logout; role-scoped session context; MSW auth handlers | Login → dashboard redirect; token refresh and logout work on both surfaces |
| **P1 — Application** | M2 cities/services/leads/approvals | Application form (`POST /providers`); `GET /cities` + `GET /services` pickers; verification screen rendering every `VerificationState`; profile + availability (`GET/PATCH /providers/me`, `PUT /providers/me/availability`); reliability score display | Application → `approved` (mocked decision) unlocks the app; `changes_requested` → resubmit loop works |
| **P2 — Transactions** | M3 orders + payments | No provider work (customer-side); keep earnings foundations in mind | — |
| **P3 — Bookings** | M4 bookings | Jobs tabs (upcoming/active/history via `GET /bookings/me`); incoming request screen with 300 s countdown; accept/decline (`accept`, `decline`); status advance (`provider_arrived`, `in_progress`); complete request (`complete`); cancel with reason; detail timeline from `BookingDetail.events` | Appointment flow: request → accept → schedule → arrive → progress → complete (customer confirms) → history |
| **P4 — Dispatch** | M5 dispatch | On-demand matching UX (distance-ranked requests); arrival/no-show edge states (`no_show`, late-arrival notice); acceptance-timeout handling (`DISPATCH_ACCEPTANCE_TIMEOUT`) | On-demand flow green in E2E; anti-gaming copy (reliability impacts) surfaced |
| **P5 — Money** | M6 payouts + ledger | Earnings dashboard (`GET /payouts/me`); statement with date range (`GET /payouts/me/statement`); payout status pills incl. `exception`; dispute hold awareness (`disputed` bookings); TZS formatting everywhere | Statement balances match ledger fixtures; dispute hold visible in UI |
| **P6 — Engagement** | M7 reviews/support/notifications | Notification center + preferences (`GET /notifications/me`, preferences GET/PUT, mark read); push registration (Expo); per-event UI mapping (`booking.requested`, `booking.reminder`, `payout.*`, `review.received`, `ticket.reply`); support tickets (create/list/get/reply); reviews received (via profile rating; `GET /reviews/me` pending contract) + report abuse | Push lands on device for a booking request; ticket thread round-trip works |
| **P7 — Launch** | M8 admin + hardening | Release readiness: contract suite green vs staging, security pass (SECURITY.md), EAS store builds + web deploy, perf/accessibility audit, localization `sw` verified, `ar` layout checks | Both surfaces in production; rollback runbooks tested |

## Phase invariants (from cross-team ROADMAP standing rules)

1. Follow `backend/API-CONTRACT.yaml`; never invent endpoints — propose contract changes first (open items: `GET /reviews/me` for received reviews, reschedule endpoint).
2. Every screen: loading, empty, error, retry, success states.
3. Idempotency keys on booking mutations (accept/decline/status/cancel) — safe retries.
4. Money is TZS with thousands separators; never floats.
5. `en` first release; `sw`-ready keys; `ar`-capable.
6. No hardcoded URLs, phones, emails, or ratings — environment-driven config only.

## Dependencies and sequencing

| This phase waits on | Backend milestone | Unblocks |
| --- | --- | --- |
| P0 scaffold + auth | M1 | everything (client never blocks on deploys — MSW parity) |
| P1 application | M2 | availability + matching |
| P3 bookings | M4 | P4 on-demand, P5 earnings references |
| P5 payouts | M6 | dispute holds, statements |
| P6 engagement | M7 | reviews list (contract gap), notifications, tickets |

## Milestone cut line per sprint

1. Ship the phase's screens with MSW fixtures before backend deploys.
2. Run the contract suite (TESTING.md) green against mocks; re-run against staging when the milestone lands.
3. Update this roadmap only via the cross-team `../ROADMAP.md` process — phases are shared commitments.

## Contract gaps to raise with backend

- Received-reviews listing (`GET /reviews/me` or similar) — currently only `rating`/`reviewCount` exist.
- Rescheduling endpoint — today cancel + rebook is the only path.
- Provider commercial terms (`commissionRateBps`) are not exposed on `ProviderPrivate`; earnings UI reads commission from ledger entries only.
- Per-trade document/qualification requirement lists are config-driven; `GET /service-categories` exposes skills/certifications, but per-provider trade requirements (e.g. `tradeRequirements`) are not yet exposed on the contract.
- Automatic recurring booking sweeper — planned server-side job (CONTRACTS-SLA.md); `recurring.booking_created` event exists in the notification catalog.
- Organizations and billing (contract locations, billing accounts, approval rules) — planned, beyond current `ServiceContract` fields.
- `booking.followup` (re-open a job as a follow-up task) — planned; `booking.followup_due` exists in the notification catalog.

## Planned — provider intelligence & enterprise (post-launch)

| Phase | Backend gate | Provider deliverables | Exit criteria |
| --- | --- | --- | --- |
| **P9c — Provider intelligence & enterprise** | Contract slice landed in `backend/API-CONTRACT.yaml`: `GET /service-categories` (+ questions), `/providers/me/inventory` (+ adjust), `/providers/me/service-plans`, `/providers/me/contracts`, `/providers/me/documents` (+ PATCH), `/providers/me/dispatch`, `/bookings/{id}/assign-technician`, `/bookings/{id}/check-in`, `/bookings/{id}/pause`, `/providers/me/trust`, `/providers/me/copilot`; backend milestone note: no dedicated backend milestone is scheduled yet in `backend/ROADMAP.md` — implementation lands after the M9/M10 windows; confirm lane with backend before sprint commitment | Categories engine UI (SERVICE-CATALOG.md): per-trade config + dynamic intake questionnaire rendered on requests; inventory (INVENTORY-MATERIALS.md): parts/consumables/equipment/tools, stock + adjust + low-stock, parts-deduct on booking, technician tool assignment; contracts/SLA (CONTRACTS-SLA.md): contract CRUD, SLA countdown + deadline escalation; recurring plans (CRUD + `recurringPlanId` occurrences); trust & safety (TRUST-SAFETY.md): trust profile, flags, documents, dimensions; dispatcher console (TECHNICIANS.md); copilot (ARCHITECTURE.md): rule-based v1 actions | E2E green (TESTING.md provider-intelligence flow): questionnaire → answers on job; inventory deducts on parts use; SLA deadline → escalation; recurring occurrence settles per occurrence; trust flag notifies owner; copilot `suggest_quote` never auto-submits; pause/resume and check-in geofence paths covered |

## Planned (not committed)

- Provider tier benefits: concrete perks per `tier` (`bronze` → `platinum`) — matching priority, commission, support levels — defined platform-side before UI claims them.
- Organizations and billing: per-location contacts, billing accounts, approval rules (CONTRACTS-SLA.md).
- Reference checks and background checks with probation window (TRUST-SAFETY.md verification engine).
- Selfie/liveness identity capture (planned identity stage).
- AI copilot ML models (v1 is rule-based).
- Capacity management: `maxConcurrentJobs` per technician (TECHNICIANS.md).
- Blacklist: platform-level provider exclusion list (ops-controlled).

## Planned phase — education (post-launch)

Not part of the P0–P7 commitment; depends on the contract additions flagged in `EDUCATION.md`.

| Phase | Backend gate | Provider deliverables | Exit criteria |
| --- | --- | --- | --- |
| **P8 — Academy** | contract additions: course catalogue/progress, certification fields, `course.certified`, business manager contact | Per-trade course list (safety, tool handling, customer service), progress UI, certification milestones + badge, operations tips, feedback via support tickets, business manager contact | First safety course completable; certification milestone shown; course feedback opens a ticket |
| **P8c — Vertical expansion** | M9c (reporting/CRM/export + vertical readiness; trades extended per backend ROADMAP) | Full trade enum on the application form (15 trades + `other`, see ONBOARDING.md Vertical trades); per-vertical qualification/document requirements rendered from config (contract note below); vertical onboarding copy (service examples, pricing hints per trade); VERTICALS.md coverage verified on both surfaces | All 10+ verticals selectable end-to-end; per-vertical requirement config renders; `other` fallback works; client history/notes, recurring appointments, and waitlists flagged as contract additions (not shipped) |
| **P9 — Dual-ecosystem provider tools** | Provider service tools contract slice already landed in `backend/API-CONTRACT.yaml` (`/providers/me/services`, `/providers/me/technicians`, `/providers/me/certifications`, `/bookings/estimate`, `/bookings/{id}/quote` (+decision), `/bookings/{id}/proof-of-service`, `/bookings/{id}/parts`, `/bookings/{id}/invoice`, `/bookings/{id}/warranty`); backend milestone note: implementation scheduled after the M9d merchant-ops window — confirm lane with backend before sprint commitment | Service catalog (SERVICE-CATALOG.md): listings CRUD with pricing model (base + per-hour + trip fee + parts-included), estimate preview, quote flow (issue → decision → approve/decline), invoice breakdown (labor + trip + parts − discount + tax), parts recording, warranties with follow-up; TECHNICIANS.md team CRUD + assignment (Booking.technicianId), certification management (ONBOARDING.md) with `CERTIFICATION_EXPIRED` listing gate; notification events as contract additions (NOTIFICATIONS.md) | E2E green (TESTING.md service business flow): listing → estimate → booking with photos → technician assigned → quote → approve → work → proof of service → parts → invoice issued → paid → warranty issued; `QUOTE_DECLINED` and `CERTIFICATION_EXPIRED` paths covered; contract addition (`booking.followup`) raised with backend |
| **P9b — Provider operating system** | Provider OS contract slice landed in `backend/API-CONTRACT.yaml`: `BookingStatus` extended (matching, offered, en_route, diagnosing, quote_required, quote_accepted, settled), `GET /dispatch/provider-jobs` (+ `POST .../accept`), `/providers/me/staff` CRUD, `GET /providers/me/capabilities`; backend milestone note: implementation scheduled after the M9d merchant-ops window — confirm lane with backend before sprint commitment | Job machine UI: marketplace browse (nearby/recommended/offers/quote_requests) with `matchScore` + `reasons[]` transparency, estimate range, urgency, acceptance-window countdown (`JOB_OFFER_EXPIRED`); full status machine through `settled` (simple jobs skip the quote gate); staff management (owner/dispatcher/technician/supervisor, capability-based, `PROVIDER_STAFF_LAST_OWNER` guard); capability-gated navigation from `/providers/me/capabilities`; `CAPABILITY_FORBIDDEN` and `JOB_OFFER_ACCEPTANCE_WINDOW` handling | E2E green (TESTING.md marketplace flow): marketplace → offer accept → full job machine through `settled`; quote-declined → re-quote path; technician capability denies dispatcher actions (`403`); offer-expiry surface; staff invite → active lifecycle |

Contract note: per-trade document/qualification requirement lists are config-driven but not yet exposed on the contract (planned with the M9c vertical readiness work) — the app renders the generic document table until a `tradeRequirements`-style field lands.
