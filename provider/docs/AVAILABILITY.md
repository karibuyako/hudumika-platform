# HUDumika Provider — Availability

Weekly schedule + active toggle, saved via `PUT /providers/me/availability` (`AvailabilityWindow` → `204`). Availability is the only signal the provider controls for matching; matching itself is server-side dispatch.

## AvailabilityWindow schema

| Field | Type | Notes |
| --- | --- | --- |
| `dayOfWeek` | integer 0–6 | 0 = Sunday … 6 = Saturday (platform convention per contract example); render with i18n day names |
| `startTime` | string `"09:00"` | 24 h local time, 5-min steps in the picker |
| `endTime` | string `"18:00"` | Must be after `startTime`; validate before save |
| `active` | boolean (default `true`) | Per-window enable/disable |

Rules in the UI:

- Multiple windows per day are allowed; validate no overlap client-side, but the server is the final authority (`VALIDATION_FAILED` with `errors[].field`).
- `active: false` windows remain stored but do not participate in matching.
- Save is a full replace (`PUT`, `204` no body): send the complete week, not a diff.

## Availability toggle semantics

Two levels:

1. Per-window `active` flag — disable one window without deleting it.
2. Global availability toggle — a convenience switch that flips every window's `active` flag (computed client-side, then sent as one full replace). Not an online/offline state like riders (`POST /riders/me/availability`); providers are matched purely by schedule + service area.

Visual: calendar week grid (web) / week strip (mobile), open slots in `success`, blocked slots muted, `disabled` state while saving; error state restores the previous schedule and shows the failure toast.

## How matching uses availability

From `backend/DISPATCH.md` — provider matching (bookings):

| Booking type | Matching basis | Provider flow |
| --- | --- | --- |
| Appointment | Service + trade + city/service area + availability window covering `scheduledFor` | Up to 3 candidates notified sequentially, 5-minute (300 s) acceptance window each |
| On-demand | Same, plus rank by distance to customer address and current idle state | `provider_arrived` → `in_progress` when work starts |

Key consequences for the app:

- A booking only reaches `provider_requested` if the provider is `approved` and a window covering `scheduledFor` is `active` — keep the calendar honest or miss requests.
- Acceptance within 300 s; timeout silently moves to the next candidate (`DISPATCH_ACCEPTANCE_TIMEOUT`). The incoming-request screen shows a countdown.
- All candidates declined → booking returns to `paid` with no provider; customer is offered reschedule or cancel (full refund). No action needed from the provider.

## Scheduling rules

- Earliest `scheduledFor`: server-enforced (`BOOKING_TIME_IN_PAST` on create); display only future slots.
- `durationMinutes` (15–480) is chosen by the customer; the provider sees it in the request.
- Reminder: `booking.reminder` push/SMS 1 h before `scheduledFor` to both parties.
- Arrival expectation: provider should arrive by `scheduledFor`; after 30 min past it, a reliability event fires and the customer is notified (late arrival affects the reliability score).
- Availability changes never affect bookings already `provider_accepted`/`scheduled`; they apply to future matching only.

## Screen states

| State | Behavior |
| --- | --- |
| Loading | Skeleton week grid while fetching `GET /providers/me` |
| Empty | No windows saved yet → "Set your weekly schedule" CTA |
| Error | Fetch failed → retry button; save failed → revert + toast |
| Success | Saved confirmation; `204` then refetch to confirm persisted week |

## Overtime and vacation (planned)

Overtime allowances and vacation blocks are planned extensions of the availability model (blocked time + workload inputs to slot calculation).
