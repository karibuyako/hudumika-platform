# HUDumika Provider — Notifications

Push setup (mobile), notification center (both surfaces), per-event UI mapping from `backend/NOTIFICATIONS.md`, and preferences.

## Push setup (Expo)

- Use Expo Push Service (FCM/APNs behind it). Device tokens are registered with the backend per user and refreshed on login (backend NOTIFICATIONS.md delivery model).
- Request push permission only after explaining why (OS copy + our explanation screen); keep a settings path always.
- Handle foreground, background, and quit states; `Notification.data.deepLink` navigates to booking detail, ticket, or payout statement.
- Token registration failure: degrade gracefully — in-app polling still works; show a non-blocking banner with retry.

## Notification center

- `GET /notifications/me?unreadOnly&limit&cursor` (cursor pagination, infinite scroll or "load more").
- Unread badge driven by the `unreadOnly` query and `Notification.read`; `POST /notifications/{notificationId}/read` per item (optimistic update, safe to retry).
- Pull-to-refresh + realtime via WebSocket while an active session exists (in-app channel).
- Item states: loading (skeleton), empty ("No notifications"), error (retry), success (list + relative local times). Timestamps are UTC from the API; render local.

## Per-event UI mapping (provider)

| Event | Channel | App behavior |
| --- | --- | --- |
| `booking.requested` | push | Incoming-request screen + 300 s countdown; deep link to booking detail |
| `job.offered` | push, in-app | Marketplace offer card with `expiresAt` countdown |
| `quote.requested` | push, in-app | Customer wants an estimate; submit quote CTA |
| `job.quote_required` | in-app | Diagnosis needs a quote; quote composer |
| `booking.accepted` | in-app | Confirmation toast; booking appears in upcoming |
| `job.assigned_technician` | push, in-app | Technician notified: job assigned; deep link to booking detail |
| `job.reminder` (before scheduled slot) | push, SMS | "Job reminder" banner; deep link |
| `booking.reminder` (1 h before) | push, SMS | Banner in jobs list; deep link |
| `booking.arrived` | in-app | You marked arrival — timeline updates |
| `job.check_in` | in-app | Check-in recorded; customer notified "technician on site" |
| `job.paused` / `job.resumed` | in-app | Pause/resume confirmation with reason shown |
| `booking.completed` | in-app, push | Earnings hint ("ledger updated"); deep link to statement |
| `booking.no_show` | in-app | Danger status; reliability impact notice |
| `job.escalated` / `job.provider_late` | push, in-app | Ops involved / late-arrival notice; reliability impact |
| `job.warranty_claimed` | in-app | Customer claimed the job warranty; open ticket context |
| `recurring.booking_created` | in-app | Next plan occurrence auto-created; deep link |
| `sla.deadline_approaching` | push, in-app | Dispatcher/owner: SLA countdown warning on contract jobs |
| `document.expiring` / `document.expired` | in-app | Renewal prompt; deep link to documents (TRUST-SAFETY.md) |
| `trust.flag_raised` | in-app | Risk flag raised; explanation + appeal path |
| `payout.paid` / `payout.failed` / `payout.exception` | in-app, push (failed) | Earnings update; `failed`/`exception` open support CTA |
| `dispute.opened` / `dispute.resolved` | in-app | Payout-held notice; booking `disputed` pill |
| `review.received` | in-app | Profile rating update (from published reviews) |
| `review.moderated` | in-app | Your review was hidden/deleted |
| `ticket.reply` | push, in-app | Deep link to ticket thread |
| `lead.reviewed` | SMS, in-app | Onboarding `VerificationState` change |

Notifications that require urgent action (`booking.requested`, `job.offered`, `sla.deadline_approaching`) also drive the badge; all others are informational.

## Service-business events

These events are now in `backend/NOTIFICATIONS.md`: `quote.issued`, `quote.decision`, `proof_of_service.submitted`, `invoice.issued` (service), `warranty.issued`, `warranty.claim_opened`, `booking.followup_due`:

| Event | Roles notified | App behavior |
| --- | --- | --- |
| `quote.issued` | customer | Final quote awaits decision (deep link to booking) |
| `quote.decision` | provider | Customer approved or declined the quote (`quote_accepted` / re-quote or cancel CTA) |
| `proof_of_service.submitted` | customer | Completion evidence captured; confirm completion |
| `invoice.issued` (service) | customer | Final invoice ready for on-site payment |
| `warranty.issued` | customer | Warranty card active with `followUpAt` |
| `warranty.claim_opened` | provider, ops | Claim opened on a warranty (support ticket reference) |
| `booking.followup_due` | provider | `ServiceWarranty.followUpAt` follow-up due |

`booking.followup` (re-opens the job as a follow-up task) remains planned — contract addition, not built; until it lands, render the follow-up date read-only (BOOKING-FLOW.md).

## Preferences

- `GET/PUT /notifications/me/preferences` → `NotificationPreferences`: per-event toggles per channel (`push`, `sms`, `email`, `inApp`), e.g. `booking.reminder:push`.
- UI: event groups (Bookings, Payouts, Reviews, Support) with channel switches per group (mobile) or per event (web).
- High-priority system events (OTP, security, payout failures) cannot be disabled — show them as locked toggles (backend rule).
- Save: `PUT` whole object; optimistic toggle with rollback on error (`PREFERENCE_INVALID_EVENT` → field error).

## Screen state checklist (center + preferences)

| State | Center | Preferences |
| --- | --- | --- |
| Loading | Skeleton list | Skeleton switches |
| Empty | "No notifications" + unread tab hint | — |
| Error | Retry button | Revert toggles + toast |
| Success | List, read/unread pills, deep links | Toggles, locked system rows |
