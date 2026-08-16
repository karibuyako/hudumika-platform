# HUDumika Dispatch

Dispatch covers two distinct flows: **rider assignment for orders** and **provider matching for bookings**.

## Rider assignment (orders)

1. Order reaches `paid` → dispatch queue (`dispatch:orders` in Redis).
2. Candidate pool: online riders in the same city with delivery zone covering the merchant.
3. Score candidates: distance to merchant, load (active deliveries), reliability, rating. Pick top candidate.
4. Push assignment with a **120-second acceptance window**.
5. Rider accepts → order `rider_assigned`. Rider rejects or times out → next candidate.
6. No acceptance after pool exhausted → order stays `paid`/`preparing`; escalation to ops via notification; admin monitor shows it.
7. Riders are not charged for declining; repeated declines inside one hour trigger a reliability score penalty.

Rules:

- One rider can carry up to 3 active deliveries at once; dispatch respects that.
- Re-assignment always appends an `order_events` row.
- ETA shown to the customer comes from dispatch estimates, updated on pickup.

## Provider matching (bookings)

### Appointment-based bookings

1. Booking `paid` → `matching`.
2. Match by service + trade + city/service area + availability window that covers `scheduledFor`, plus matching factors: distance, ETA, skill match, certifications, rating, reliability, price competitiveness, response rate, historical acceptance, **job complexity**, customer preferences, emergency priority, and workload (`ProviderJobOffer.matchScore` + `reasons` for transparency).
3. Candidates appear in the provider job marketplace (`GET /dispatch/provider-jobs`) as nearby/recommended offers and are pushed sequentially (5-minute acceptance window each) → `offered`.
4. Acceptance → `provider_accepted` → `scheduled` (technician assigned by the provider business via `Booking.technicianId`).
5. Decline/expiry → next candidate; `JOB_OFFER_EXPIRED` when the window closes.
6. All declined → booking returns to `paid`/`matching` with no provider; customer gets a notification to reschedule or cancel (full refund).

### Home-service job flow (provider operating system)

`matching → offered → provider_accepted → scheduled → en_route → provider_arrived → diagnosing → quote_required → quote_accepted → in_progress → awaiting_customer_confirmation → completed → settled`

- `en_route`: provider dispatched and traveling (per technician assignment).
- `diagnosing`: on-site inspection; the provider may submit a final quote (`POST /bookings/{id}/quote`) → `quote_required` → customer decision → `quote_accepted` (or declined → re-quote/cancel).
- `completed`: customer confirms work + proof of service.
- `settled`: payout eligible (ledger release), then `warranty`/`dispute` follow states.
- Not every job takes the full path — simple jobs skip diagnosing/quote states.

### On-demand bookings

1. Same matching, but candidates are ranked by distance to the customer address and current idle state.
2. Provider `provider_arrived` → `in_progress` when the job starts.
3. Provider requests completion → `awaiting_customer_confirmation` → customer confirms → `completed` (payout eligible).

## Timeouts and fallbacks

| Stage | Timeout | Action |
| --- | --- | --- |
| Rider accept | 120 s | next candidate |
| Provider accept | 300 s | next candidate |
| Rider pickup | 15 min after `merchant_accepted` | notify rider, escalate to ops |
| Provider arrival | 30 min past `scheduled_for` | reliability event + notify customer |
| Customer confirm completion | 24 h | auto-confirm, notify both parties |

## ML-driven dispatch (Phase 3)

- Matching: order–rider acceptance-probability model augments rule scoring; rider preferences (zones, max concurrent) and fleet type are features.
- Prep-time timing: riders are assigned when the merchant's predicted prep time (model) is nearly elapsed — cuts waiting time; `predictedPrepMinutes` shown on the offer.
- Batching: orders group by pickup/drop-off proximity, delivery windows, and prep times; `Trip` exposes the sequence.
- Geofence auto-status: arrival at pickup/drop-off can auto-advance status when the geofence + speed checks confirm the rider is at the location.
- Proactive re-routing: live traffic/weather/road-closure context recalculates `Trip` sequences and ETAs (dynamic re-routing); manual reorder always allowed.
- Address disambiguation: ambiguous addresses are normalized with an `addressConfidence` score on the offer.

## Crash / fatigue escalation (Phase 3)

1. Device detects impact (accelerometer/gyroscope/GPS) → `POST /riders/me/safety-events` (crash_detected).
2. App shows a 10-second "Are you OK?" countdown.
3. No response → auto: SOS to dispatch with live location; emergency contacts notified (trip share); emergency services called if configured; all active orders cancelled and re-assigned.
4. Fatigue: front-camera model detects drooping eyelids/yawning → alerts (audio/vibration/LED) → "Take a Break" → escalation to dispatch → mandatory break (`RiderShift.forcedRestUntil`, `REST_ENFORCED` blocks new offers). Rest resets the counter.
5. Mandatory rest reminders also fire after `maxHoursPerDay` continuous driving.

## Dynamic pricing and incentives

- Surge multipliers are configured per time-of-day, day-of-week, and zone; applied to the base fare (`FareBreakdown.surgeMultiplier`).
- Zone boosts: completing deliveries inside a high-demand zone earns a zone bonus entry.
- Heat zones (`GET /dispatch/heatmap`) show demand level + active surge multiplier for rider positioning.
- Fare escalation: when an offer is declined `n` times, the fare is automatically increased by a configured step, up to a cap (`dynamic price increase`).
- Rest reminders: sweeper flags riders past `maxHoursPerDay` continuous driving and prompts a break (riders can start a shift break).

## Anti-gaming

- Distance and score math is server-side only; riders cannot pick orders.
- Reliability score (0–100) updated on: no-show, late arrival, cancellations after acceptance, repeated declines.
- Ops monitor (`/admin/overview`) surfaces stuck orders and dispatch exceptions.

## Failure handling

- Dispatch queue is Redis-backed with retries (3) and a dead-letter set reviewed by ops.
- If dispatch fails entirely, the order remains `paid`; the customer sees `merchant_accepted`/`preparing` and a support ticket can escalate.
