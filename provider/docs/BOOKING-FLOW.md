# HUDumika Provider — Booking Flow

Job lifecycle for the provider, from incoming request to payout eligibility. Statuses are the `BookingStatus` enum; the state machine is enforced server-side (409 `BOOKING_STATUS_CONFLICT` on illegal transitions).

## Lifecycle (home-service job machine)

```text
paid -> validating -> matching -> offered -> provider_accepted -> scheduled
  -> reminder_sent -> en_route -> provider_arrived -> check_in
  -> diagnosing -> quote_required -> quote_submitted -> quote_accepted -> in_progress
  -> completion_review -> awaiting_customer_confirmation -> completed -> settled
  -> warranty     (post-settle status)
```
Simple jobs skip the `diagnosing`/`quote_required`/`quote_submitted` gate (`check_in`/`provider_arrived` → `in_progress` directly). `provider_requested` remains in `BookingStatus` for direct push requests; marketplace jobs appear first at `matching`/`offered`.

| State | Meaning | Transitioned by |
| --- | --- | --- |
| `validating` | Post-payment intake checks (questionnaire answers, address, category rules) | server |
| `matching` | Dispatch scoring candidates (distance, skill, rating, price, response rate, service area, job type) | server |
| `offered` | In the marketplace (`GET /dispatch/provider-jobs`) with a 5-min acceptance window (`expiresAt`; `JOB_OFFER_EXPIRED` on timeout) | server → provider |
| `provider_accepted` | Offer accepted (`POST /dispatch/provider-jobs/{bookingId}/accept`; direct requests: `POST /bookings/{bookingId}/accept`) | provider |
| `scheduled` | Slot confirmed, technician assigned (`Booking.technicianId`) | server on acceptance |
| `reminder_sent` | Scheduled reminder delivered (`job.reminder`, `booking.reminder`); job still ahead of slot | server |
| `en_route` | Technician traveling to the address | provider (`POST /bookings/{bookingId}/status`) |
| `provider_arrived` | On site; navigation + customer contact live | provider |
| `check_in` | Provider checked in at the site (geofence or manual, `POST /bookings/{bookingId}/check-in`; `CHECK_IN_NOT_ALLOWED` outside radius/status) | provider |
| `diagnosing` | On-site inspection | provider |
| `quote_required` | Diagnosis needs a quote; `job.quote_required` notice | server |
| `quote_submitted` | Final quote submitted (`POST /bookings/{bookingId}/quote`), awaiting customer decision | provider |
| `quote_accepted` | Customer approved; work may start (decline → re-quote or cancel) | customer (`quote/decision`) |
| `in_progress` | Work started | provider |
| `completion_review` | Provider-done review (photos, parts, invoice) before completion request | provider |
| `awaiting_customer_confirmation` | Completion requested; proof of service required first | provider (`complete`) |
| `completed` | Customer confirmed, or 24 h auto-confirm | customer / server |
| `settled` | Payout eligible — ledger release (`booking_earning` entry) | server |
| `warranty` | Post-settle warranty status (`active`/`expired`/`claimed` per `ServiceWarranty`) | server / ops |

Exceptional states: `customer_cancelled`, `provider_cancelled` (who cancelled), `provider_late` (arrival > 30 min past `scheduledFor`; reliability impact), `escalated` (ops intervention, e.g. SLA miss or dispute routing), `reassignment` (job moved to another technician/provider), plus terminals `declined`, `cancelled`, `refunded`, `disputed`, `no_show`. (`draft`, `pending_payment`, `paid` are customer-side; the provider first sees the booking at `matching`/`offered` or `provider_requested`.)

## Incoming requests and offers

| Item | Behavior |
| --- | --- |
| Marketplace offer | `job.offered` push + `GET /dispatch/provider-jobs`; card shows `summary`, `photoCount`, `distanceKm`, `estimateLowTZS`/`estimateHighTZS`, `urgency`, `scheduledFor`, `matchScore` + `reasons[]`, `expiresAt` |
| Acceptance window | 5 min countdown visible on the offer; on timeout (`JOB_OFFER_EXPIRED`) the job moves to the next candidate and leaves the list |
| Accept (offer) | `POST /dispatch/provider-jobs/{bookingId}/accept` → `provider_accepted`; `409` `JOB_OFFER_ACCEPTANCE_WINDOW` if already taken |
| Direct request | `booking.requested` push → `provider_requested`; accept via `POST /bookings/{bookingId}/accept` within 300 s (`DISPATCH_ACCEPTANCE_TIMEOUT`) |
| Decline | `POST /bookings/{bookingId}/decline` with `reason` (max 500) → next candidate; no payout impact, repeated declines hurt the reliability score |
| Error handling | Network failure: keep countdown running, retry the mutation with idempotency key; expired → "offer expired" state |

## During the job

| Step | Action | Endpoint |
| --- | --- | --- |
| En route | Mark `en_route` | `POST /bookings/{bookingId}/status` |
| Arrived | Mark `provider_arrived` | `POST /bookings/{bookingId}/status` |
| Check-in | Check in at the site (geofence or manual) | `POST /bookings/{bookingId}/check-in` |
| Diagnosing (quote-gated jobs) | Mark `diagnosing`; submit quote → `quote_submitted` | `POST /bookings/{bookingId}/quote` |
| Work started | Mark `in_progress` (after `quote_accepted` on quote-gated jobs) | same |
| Pause (waiting for parts/access) | Pause with `reason` (max 300) | `POST /bookings/{bookingId}/pause` |
| Resume | Resume work | `POST /bookings/{bookingId}/resume` |
| Completion | Request completion → `awaiting_customer_confirmation` | `POST /bookings/{bookingId}/complete` |
| Customer confirms | (customer side) → `completed` | — provider sees status update |
| Auto-confirm | 24 h without confirmation → auto `completed`, both parties notified | server-side |

`BookingDetail.events` renders the timeline (each event: `status`, `at`, `by`, `note`). Refresh on push + pull-to-refresh; success states after every mutation (toast + timeline update).

## Check-in (geofence or manual)

`POST /bookings/{bookingId}/check-in` — body `{ lat, lon }` (float):

- The server validates the location against the booking address geofence. `409` `CHECK_IN_NOT_ALLOWED` fires when the status does not allow check-in or the coordinates fall outside the radius; manual check-in is the fallback for no-GPS or edge cases and the server still records the coordinates.
- Success moves the booking to `check_in`; `job.check_in` notifies the customer ("technician on site").
- The check-in button renders only at/after `provider_arrived`; on `CHECK_IN_NOT_ALLOWED` the app refetches the booking (server state is the truth) and shows the position hint.

## Pause and resume

`POST /bookings/{bookingId}/pause` — body `{ reason }` (max 300, required). Pausing records the reason and time; `job.paused` notifies the customer. Common reasons: waiting for parts, waiting for access, safety hold.

- `PAUSE_NOT_ALLOWED` when the status gate rejects (e.g. before `in_progress` or after completion request); `RESUME_NOT_ALLOWED` when not paused. Resume via `POST /bookings/{bookingId}/resume`; `job.resumed` notifies the customer.
- The paused state renders as a distinct pill on the job; pause duration is visible on the timeline via events. Frequent pauses are a quality signal (TRUST-SAFETY.md).

## Pre-visit job photos

The customer attaches job photos when booking (`BookingCreate.photos`, max 6) so the provider can prepare tools and parts before arrival. The provider sees the photos on the incoming request and job detail; they cannot be modified by the provider (read-only evidence). LIVE in `API-CONTRACT.yaml` — the gallery renders from the booking payload with loading/empty/error states; upload is customer-side only.

## Quote flow integration

For priced-after-inspection jobs the lifecycle passes through the quote gate (SERVICE-CATALOG.md):

```text
provisional estimate -> on-site inspection -> quote_issued -> quote_approved -> in_progress
                                                     \-> quote_declined -> re-quote or cancel
```

- `Booking.quoteStatus` starts `provisional`. The provider submits the final quote (`POST /bookings/{bookingId}/quote`) at or after arrival inspection; the booking then shows `quote_issued` to the customer.
- Customer decision (`POST /bookings/{bookingId}/quote/decision`): `quote_approved` unlocks the work-start action; `quote_declined` blocks work — re-quote or cancel per policy. `QUOTE_NOT_ALLOWED` / `QUOTE_ALREADY_ISSUED` / `QUOTE_DECLINED` surface as booking-level errors; on `QUOTE_ALREADY_ISSUED` refetch the booking (the server state is the truth).
- The estimate preview on the job shows the range + `tripFeeTZS` + the "final quote may vary" disclaimer verbatim.

## Proof of service

Completion is gated on proof of service (`POST /bookings/{bookingId}/proof-of-service`, body `ProofOfService { type: photo|signature|notes, value, gpsStamp }`):

- `gpsStamp { lat, lon, at }` is captured at the customer address; missing GPS on photo proof is accepted (nullable) but the app warns that location-stamped proof is stronger for disputes. `PROOF_OF_SERVICE_INVALID` (bad type/empty value) → field errors; `PROOF_OF_SERVICE_ALREADY_SUBMITTED` → one proof per booking, refetch and show the existing proof.
- Submit proof before `POST /bookings/{bookingId}/complete`; the complete button is disabled until present (success state on submit, retry on network failure).

## On-site payment

After the invoice is issued, the customer pays on site by scanning the provider's QR or the booking payment intent (reuse `/payments/qr` + `/payments/intent`; see PAYMENTS.md). The provider sees `ServiceInvoice.status` flip `issued` → `paid`; booking completes and the ledger entry is released. The provider never takes payment off-platform (PRODUCT.md: no off-platform payment prompts).

## Follow-up

Warranty follow-ups (`ServiceWarranty.followUpAt`, SERVICE-CATALOG.md) show on the job timeline. Planned (not built): `followUpAt` triggers a `booking.followup` event that re-opens the job as a follow-up task — contract addition; until it lands, render the follow-up date read-only.

## Completion evidence

Provider cannot mark completion without required evidence for regulated categories (PRODUCT.md). Evidence is uploaded before `POST /bookings/{bookingId}/complete`; the button is disabled until present. Upload failure keeps the job at `in_progress` with a retry state.

## No-show, late arrival, escalation, reassignment

- Provider did not arrive: booking moves to `no_show` (server-side, with reliability event + customer notification). The app surfaces `booking.no_show` in-app notification and the status pill.
- Late arrival (> 30 min past `scheduledFor`): booking flags `provider_late` — reliability event + customer notification (`job.provider_late`); score impact on the provider.
- `escalated`: ops intervention (SLA miss, safety, dispute routing); `job.escalated` notifies ops + customer; the provider sees the state pill and an ops note on the timeline.
- `reassignment`: the job moved to another technician/provider; the timeline records the old and new assignee; `technicianId` updates.

## Rescheduling

No dedicated reschedule endpoint exists in `API-CONTRACT.yaml`. Practical paths:

1. Customer initiates reschedule from the customer app (contract gap flagged to the backend team); otherwise `POST /bookings/{bookingId}/cancel` with `reason` → customer rebooks a new time.
2. Disputed points go through `TicketCreate` with `bookingId` for operations help.

## Cancellation rules (from SHARED-FLOWS.md)

| Scenario | Rule |
| --- | --- |
| Before acceptance | Full refund (payment-provider timing applies); provider not involved |
| After acceptance, customer cancels | Cancellation fee shown before confirmation; payout rules per policy; status `customer_cancelled` |
| Provider cancels after acceptance | Status `provider_cancelled`; recorded as provider late cancellation → reliability event + operations notified |
| Booking `disputed` | Payout held (not batchable) until review; release proceeds or a `refund` ledger entry is added |

The cancel action requires a `reason` (max 500); show the policy summary (fee, reliability impact) in a confirm dialog before sending.

## Cancellation policy and appeals

- Provider late cancellation after acceptance records a reliability penalty (score deduction, server-side) and notifies operations — already in SHARED-FLOWS cancellation rules.
- The provider sees the penalty as a reliability event on the booking, a score change on the earnings/profile screens, and (planned) a `penalty.issued` notification.
- Appeals follow the same pattern as `../rider/PENALTIES-APPEALS.md`: open a support ticket (`POST /support/tickets`) referencing the booking (`TicketCreate.bookingId`) and the penalty; rider operations (admin) reviews the booking events and issues a decision; the decision arrives via ticket reply + (planned) `appeal.resolved` notification. Until penalty history is in the contract, reference the booking and describe the penalty in the ticket body; include the `requestId` from the relevant notification for traceability.

## Screen state checklist (jobs list + detail)

| State | Jobs list | Job detail |
| --- | --- | --- |
| Loading | Skeleton cards | Skeleton timeline |
| Empty | Per-status tabs show empty state + CTA (e.g. "No incoming requests") | — |
| Error | Retry button; keep last data if refresh failed | Retry + toast |
| Retry | Same query, backoff | Same |
| Success | Cards with status pills (`success`/`danger`/`ink-900`), TZS total | Timeline, action buttons per current status, address + customer contact (masked) |

Push events (`booking.requested`, `booking.arrived`, `booking.completed`, `booking.no_show`) deep-link into the booking detail via `Notification.deepLink`.
