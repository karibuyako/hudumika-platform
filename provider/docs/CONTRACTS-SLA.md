# HUDumika Provider — B2B Contracts, SLA, and Recurring Plans

Enterprise business for the provider: service contracts with organizations (SLAs on response and resolution), plus recurring service plans for subscription-style customers. Both link to bookings (`Booking.contractId`, `Booking.recurringPlanId`) so a job carries its commercial context.

## Service contracts (`ServiceContract`)

`GET /providers/me/contracts` lists the business's contracts; `POST /providers/me/contracts` creates one. Data in `service_contracts` (DATA-MODEL.md).

| Field | Meaning |
| --- | --- |
| `organizationName` (required, max 160) | The contracting organization |
| `locations` | Array of site labels the contract covers |
| `coveredServices` (required) | Service types included (e.g. plumbing, electrical) |
| `slaResponseMinutes` (required) | Max minutes to respond to a service request |
| `slaResolutionMinutes` (nullable) | Max minutes to resolve on site |
| `pricing` | Free-form pricing terms (e.g. per-visit, per-contract) |
| `coverageArea` | Service areas covered |
| `workingHours` (max 120) | Hours SLA windows apply (e.g. "Mon–Fri 08:00–17:00") |
| `escalationRules` (max 500) | Who to escalate to and when |
| `status` | `draft` → `active` → `expired` \| `cancelled` |
| `createdAt` | UTC |

Rules:

- Only `active` contracts create SLA-bearing bookings; `draft` contracts are editable works-in-progress, `expired`/`cancelled` no longer produce bookings.
- A booking created under a contract carries `contractId` and `slaDeadlineAt` (the server computes the deadline from `slaResponseMinutes`/`slaResolutionMinutes` + `workingHours`).
- `CONTRACT_NOT_FOUND` on unknown IDs (also when the ID belongs to another provider — no existence leaks).

## SLA enforcement on bookings

Bookings linked to a contract show `slaDeadlineAt` (UTC) in the booking payload and detail timeline:

| Signal | Behavior |
| --- | --- |
| `sla.deadline_approaching` | Push + in-app to dispatcher and provider owner before the deadline; the UI shows a countdown pill on the booking and highlights it in the dispatcher console |
| `SLA_DEADLINE_MISSED` | Server-side error/flag when the deadline passes without response or resolution; surfaces in the booking timeline, notifies ops, and feeds quality signals (TRUST-SAFETY.md) |
| Escalation | `escalationRules` (text) describes the fallback; the app renders it read-only on the booking detail for contract jobs |

The SLA countdown renders local time from the UTC `slaDeadlineAt`; on any `409` state conflict the client refetches the booking — the server state is the truth.

## Recurring service plans (`ServicePlan`)

`GET/POST /providers/me/service-plans` manage subscription-style plans. Data in `provider_service_plans`.

| Field | Meaning |
| --- | --- |
| `name` (max 120), `serviceId` | Plan identity; the service delivered each occurrence |
| `frequency` | `weekly` \| `biweekly` \| `monthly` \| `quarterly` \| `annually` |
| `priceTZS` | Price per occurrence (integer TZS) |
| `active` (default true) | Accepts new subscribers |
| `customerCount` (default 0) | Subscribers — server-maintained, read-only |
| `createdAt` | UTC |

Rules:

- Required on create: `name`, `serviceId`, `frequency`, `priceTZS`.
- A booking from a plan links `recurringPlanId`; each occurrence is an ordinary booking (own `id`, own events, own invoice and settlement).
- Recurring bookings settle per occurrence — one `booking_earning` entry per occurrence at its own settlement, never a plan-level payout (EARNINGS.md).
- `PLAN_NOT_FOUND` on unknown IDs; `PLAN_IN_USE` blocks destructive changes while bookings reference the plan — deactivate (`active: false`) instead.

## Automatic recurring booking sweeper (planned)

The recurring booking sweeper (auto-create the next occurrence from each active plan) is a planned server-side job — flagged in DATA-MODEL.md (`provider_service_plans` + `recurring_booking_created` event) but not yet scheduled in `backend/ROADMAP.md`. Until it lands, the client renders plans and `recurringPlanId` on bookings read-only and never fabricates future occurrences client-side. The `recurring.booking_created` notification (NOTIFICATIONS.md) fires when the sweeper produces a booking.

## Organizations and billing (planned)

Organization records beyond the contract payload — per-location contacts, billing accounts, and approval rules for spend — are planned, not built. The current contract exposes only what `ServiceContract` carries. Render those fields read-only until a contract addition lands; flag needs with the backend team rather than inventing endpoints.

## Screen states

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Contracts list | Skeleton rows | "No contracts yet — add your first organization" CTA | Retry button | Cards: organization, status pill (`draft`/`active`/`expired`/`cancelled`), covered services, SLA minutes |
| Contract form | Skeleton form | — | `VALIDATION_FAILED` field errors; save failure → revert + toast | `201` → contract listed; `draft` pill |
| Plan list | Skeleton rows | "No service plans yet — create your first plan" CTA | Retry button | Cards: name, service, frequency, `TZS priceTZS` per occurrence, `customerCount`, active pill |
| Plan form | Submitting state | — | `VALIDATION_FAILED`; `PLAN_IN_USE` → explain deactivate | `201` → plan listed |
| SLA countdown (booking) | Skeleton pill | — (no `slaDeadlineAt` on non-contract jobs) | Refetch on conflict | Countdown pill; deadline-missed state with escalation notice |

## Cross-cutting

- Money is integer TZS with thousands separators (`TZS 12,500`); `priceTZS` renders with currency always visible.
- Every screen implements loading, empty, error, retry, and success states.
- MSW handlers mirror these endpoints 1:1 with `backend/API-CONTRACT.yaml` (MSW parity); error codes from `backend/ERROR-CODES.md`.

## Organization depth (planned)

Organizations will eventually carry departments, employees, a billing account, and approval rules — contracts already reference organization + locations; the rest is a contract addition.
