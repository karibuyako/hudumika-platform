# HUDumika Provider — Technicians

Contractor and fleet management for the provider business. A provider is a skilled-service business that dispatches its own technicians; the platform picks the provider business for a booking (DISPATCH.md provider matching), and the business assigns the technician. Technicians are team records (`provider_technicians`), not platform accounts — they have no login.

## Technician team CRUD (`Technician`)

| Endpoint | Purpose |
| --- | --- |
| `GET /providers/me/technicians` | Team list |
| `POST /providers/me/technicians` | Add a technician |
| `PATCH /providers/me/technicians/{technicianId}` | Update skills, status, certifications |
| `DELETE /providers/me/technicians/{technicianId}` | Remove a technician (`204`) |

`Technician` fields: `name` (max 120), `phone`, `trade`, `skills[]`, `status` (`idle` | `on_job` | `offline`, default `idle`), `currentBookingId` (nullable), `certifications[]`, `rating` (nullable), `createdAt`. Required on create: `name`, `phone`, `trade`.

Rules:

- `offline` technicians are not shown as assignable for new jobs but keep history.
- `TECHNICIAN_BUSY`: assigning a technician who already has `currentBookingId` (already `on_job`) is rejected — pick another or wait for the current job to close. The same busy guard applies server-side to any operation touching an `on_job` technician (e.g. remove).
- `TECHNICIAN_NOT_FOUND` on unknown IDs (also when the ID belongs to another provider — no existence leaks).

## Assigning a technician to a booking

`Booking.technicianId` (nullable) records the assigned technician. The dispatcher (or owner, with the `assign_technician` capability) assigns via `POST /bookings/{bookingId}/assign-technician` — body `{ technicianId, note (max 300) }`. The server writes `technicianId`, sets the technician's status to `on_job` with `currentBookingId`, and notifies the technician (`job.assigned_technician`).

- `TECHNICIAN_ALREADY_ASSIGNED`: the booking already has a technician — reassignment goes through the `reassignment` exceptional state (BOOKING-FLOW.md), not a silent overwrite.
- `TECHNICIAN_BUSY`: the chosen technician already has `currentBookingId` (already `on_job`) — pick another or wait for the current job to close.
- `ASSIGN_TECHNICIAN_NOT_ALLOWED`: booking status gate (e.g. already in progress or cancelled).
- `TECHNICIAN_NOT_FOUND`: unknown IDs (also when the ID belongs to another provider — no existence leaks).
- On booking completion/cancellation the technician returns to `idle` and `currentBookingId` clears (server-side).

## Dispatcher console (`GET /providers/me/dispatch`)

The dispatcher view (capability `view_all_jobs` + `assign_technician` / `view_schedule`) renders two panels from one endpoint:

| Panel | Content |
| --- | --- |
| `unassignedJobs` | `ProviderJobOffer[]` waiting for a technician (summary, photos count, distance, estimate range, urgency, `scheduledFor`, `matchScore` + `reasons[]`) |
| `technicianSchedule` | Per technician: `name`, `status` (`idle` \| `on_job` \| `offline`), `currentBookingId` (nullable), `nextBookingAt` (nullable) |

Workflow: pick an unassigned job → pick an idle technician from the schedule → `POST /bookings/{bookingId}/assign-technician`. The console updates on pull-to-refresh + realtime; assignment failures (`TECHNICIAN_BUSY`, `TECHNICIAN_ALREADY_ASSIGNED`, `ASSIGN_TECHNICIAN_NOT_ALLOWED`) surface as toasts with the offending technician highlighted and the next idle candidate offered.

## Capacity management (planned)

`maxConcurrentJobs` per technician (how many jobs a technician may carry) is planned, not in the contract. Until it lands, busy-guard semantics (`TECHNICIAN_BUSY`, one `currentBookingId`) are the only capacity rule; never render multi-job assumptions client-side.

## Tool and equipment assignment

Inventory items of category `tool`/`equipment` carry `assignedTechnicianId` (INVENTORY-MATERIALS.md). The dispatcher console and the technician's job detail show carried tools so the technician prepares before travel; assignment state is read-only in the dispatch UI (managed from the inventory screens).

## Job dispatch model

| Layer | Who decides |
| --- | --- |
| Booking → provider | Platform provider matching (service + trade + service area + availability; DISPATCH.md) |
| Provider → technician | The provider business, internally (team list + `technicianId` on the job) |

The provider app therefore has two views: incoming bookings (platform-matched) and team assignment (business-internal). Availability (AVAILABILITY.md) gates platform matching; technician `status` gates assignment. Neither replaces the other.

## Technician location visibility (planned)

Live technician locations are not in the contract yet. The planned design reuses the rider-location pattern (`rider_locations` — latest + history, backend-throttled) as `technician_locations`, feeding dispatch ETAs and (optionally) customer "technician on the way" tracking. Not built; no endpoints exist — do not render location UI beyond the booking address until the contract addition lands.

## Team rating aggregation

- `Technician.rating` (nullable) is per-technician, computed from published reviews — never hardcoded.
- The team view aggregates server-side (count + average); clients render only what the API returns.
- Provider-level `rating` on `/providers/me` is the business rating, distinct from per-technician ratings.

## Screen states

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Team list | Skeleton rows | "No technicians yet — add your first technician" CTA | Retry button | Cards: name, trade, skills, status pill, rating |
| Technician form | Skeleton form | — | `VALIDATION_FAILED` field errors; save failure → revert + toast | Created/updated confirmation |
| Remove technician | Spinner on row | — | `TECHNICIAN_BUSY` → explain (on a job); `TECHNICIAN_NOT_FOUND` → refetch | `204` → row removed |
| Assign (job detail) | Assigning state | "No idle technicians" → mark offline/trade mismatch hint | `TECHNICIAN_ALREADY_ASSIGNED` → show current technician; `TECHNICIAN_BUSY` → toast, offer next idle candidate; `ASSIGN_TECHNICIAN_NOT_ALLOWED` → refetch booking | Technician pill + `on_job` status on team list |
| Dispatcher console | Skeleton panels | "No unassigned jobs" / "All technicians idle" | Retry per panel | Unassigned jobs list + schedule with status pills and `nextBookingAt` |
| Rating view | Skeleton | "No ratings yet" | Retry | Aggregated team average + per-technician rating |

## Cross-cutting

- `phone` is used for internal dispatch contact only; never displayed to customers (masked contact relay per PRODUCT.md).
- MSW handlers mirror these endpoints 1:1 (MSW parity); error codes from `backend/ERROR-CODES.md` (`TECHNICIAN_NOT_FOUND`, `TECHNICIAN_BUSY`).

## Emergency dispatch (planned)

Emergency/urgent bookings bypass the normal offer queue: admin or the provider owner can override assignment to a specific technician (`POST /bookings/{id}/assign-technician` with an emergency note).

## Check-out and time tracking

Check-in starts tracked time; the job completion flow records check-out implicitly (completed → settled). A dedicated check-out endpoint is a planned contract addition.
