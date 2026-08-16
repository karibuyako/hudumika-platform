# Customer App — Booking Flow (Services)

Lifecycle per `SHARED-FLOWS.md` and `BookingStatus` from the contract. Every screen has loading /
empty / error / retry / success states.

## Scheduling options

Customers choose how urgent the job is: **ASAP** (dispatch now), Today (next available slot), Tomorrow, a specific date, or a specific time window. ASAP and urgent bookings raise `urgency` to `urgent`/`emergency` on the booking and get priority matching + faster dispatch.

## Screen sequence

```
Home → Explore (services) → Service detail → Provider list → Provider detail
     → Booking form (schedule + address + description) → Payment → Booking detail
     → Status timeline → Completion confirmation → Review
```

## Step-by-step

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Service search | `GET /services` | `?cityId&category`; `unit` hints pricing (per_hour/per_visit). |
| 2 | Provider list | `GET /providers` | `?cityId&trade`; sort by rating/reliability/price; `verified` badge; `baseRateTZS`. |
| 3 | Provider detail | `GET /providers` (detail via list item) | Qualifications, `rating`, `reviewCount`, `serviceAreas`, availability. |
| 4 | Booking form | — | `scheduledFor` (local → UTC ISO 8601), `durationMinutes` (15–480), `address` (`AddressSnapshot`), `description` ≤2000, optional photos (client-side only). |
| 5 | Payment | `POST /bookings` + `POST /payments/intent` | See `PAYMENTS.md`. |
| 6 | Booking detail | `GET /bookings/{id}` | Timeline from `events[]`. |
| 7 | Completion | `POST /bookings/{id}/complete` | Customer confirmation step (below). |
| 8 | Review | `POST /reviews` | After `completed` (`REVIEWS.md`). |

## Status timeline

From `BookingStatus`, rendered as timeline rows:

```
draft → pending_payment → paid → provider_requested → provider_accepted → scheduled
     → provider_arrived → in_progress → awaiting_customer_confirmation → completed
```

Terminal: `declined`, `cancelled`, `refunded`, `disputed`, `no_show`.

- `provider_requested`: "Waiting for provider" — request to next available provider if declined
  (dispatch queue; acceptance window is server-side).
- `declined`: push `booking.declined`; UI offers "Request another provider" or cancel with refund.
- `scheduled`: reminder copy + countdown to `scheduledFor`; `booking.reminder` push 1 h before.

## Customer confirmation step (completeBooking)

- Trigger: booking reaches `awaiting_customer_confirmation` (provider finished job, `booking.completed`
  is NOT emitted until the customer confirms).
- Screen: "Job complete?" with price summary, "Confirm completion" primary button.
- Action: `POST /bookings/{bookingId}/complete`; success → status `completed`; payout eligible,
  review prompt.
- Not ready: "Problem" secondary action → dispute/support ticket (`TicketCreate` with `bookingId`).
- `409` `BOOKING_STATUS_CONFLICT` → refetch detail (provider/customer state race).

## Reschedule

- Before provider acceptance: cancel (`POST /bookings/{id}/cancel`) + create a new booking
  (full refund applies, see rules below).
- After acceptance: reschedule is a support-path action; UI shows cancellation rules instead of
  direct reschedule (no dedicated contract endpoint — do not invent one).

## Cancellation rules

| Window | Rule | UI |
| --- | --- | --- |
| Before provider acceptance | Full refund (provider-timing caveat) | Confirm dialog "Full refund" |
| After acceptance | Cancellation fee shown before confirmation | Fee listed in dialog; `POST /bookings/{id}/cancel` with `reason` |
| Provider cancels late | Reliability event + notify operations | Banner; offer next-available provider or refund |
| No-show (provider) | `no_show` status; reliability score impact | Amber banner `booking.no_show`; refund/dispute CTA |
| Customer dispute | Payout held until review | `disputed` banner + ticket CTA; `dispute.resolved` returns `refunded` or `completed` |

- `409` `BOOKING_NOT_CANCELLABLE` → toast + refetch.
- Fees and refunds displayed in `TZS 12,500` format; amounts from server only.

## No-show handling

- `booking.no_show` push/in-app event; booking status → `no_show`.
- UI: explanation card, automatic refund state if policy applies (`refunded`), otherwise dispute CTA.
- Customer can open a support ticket referencing `bookingId` for follow-up.

## Dispute state

- `disputed` → amber banner; payout held server-side until review.
- Actions: attach message to ticket; wait for `dispute.resolved` notification; terminal statuses
  `refunded` or `completed`.

## Per-screen state contract

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Service list | Skeletons | "No service in this city" | Error card | Retry | Category cards |
| Provider list | Skeletons | "No providers for this time/area" | Error card | Retry | Provider cards |
| Provider detail | Skeleton | — | Error + retry | Retry | Profile + availability |
| Booking form | Prefill skeleton | — | `BOOKING_TIME_IN_PAST` inline | Retry submit | Booking created |
| Booking detail | Skeleton timeline | — | Error + retry | Retry | Timeline + actions |
| Completion confirm | Spinner on button | — | 409 → refetch | Retry | `completed` + review prompt |
| Bookings list | Skeletons | "No bookings yet" | Error + retry | Retry | Paginated cards + status chips |

Success feedback: toasts, status pill updates, haptic on booking confirmed, countdown refresh.

## Re-book (one-click same provider)

After a completed booking, the customer can re-book the same provider with one tap — the booking form is pre-filled from the previous booking (service, provider, address) via a normal `POST /bookings`.
