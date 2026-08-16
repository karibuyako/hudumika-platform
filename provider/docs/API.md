# HUDumika Provider — API Reference

All endpoints from `backend/API-CONTRACT.yaml` that the provider surfaces call. Base path `/api/v1`, bearer auth, cursor pagination (`?limit=20&cursor=<opaque>`), all timestamps UTC. Money fields are integer TZS. Clients switch on `ErrorResponse.code`, never on `message`.

## Auth and users

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `POST /auth/request-otp` | OTP send (`channel: phone\|email`, `purpose: login\|signup\|verify_role`) | `OtpDelivery` (`requestId`, `expiresInSeconds`, `resendInSeconds`); `429` `RATE_LIMITED` |
| `POST /auth/verify-otp` | Login and role switch; returns role-scoped session | `Session`; `401` `OTP_INVALID` / `OTP_EXPIRED` / `OTP_MAX_ATTEMPTS` |
| `POST /auth/refresh` | Token rotation (15 min access, 30 day refresh) | `Session`; `401` `REFRESH_TOKEN_REVOKED` / `SESSION_EXPIRED` |
| `POST /auth/logout` | Revoke session server-side | `204` |
| `GET /users/me` | Header identity, `locale`, `roles`, `activeRole` | `User` |
| `PATCH /users/me` | Edit name, email, avatar, `locale` (`en\|sw\|ar`) | `UserUpdate` → `User` |
| `GET /users/me/roles` | Role-switch picker (never mixes data between roles) | `RoleSummary[]` |

## Onboarding and profile

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET /cities?country=TZ` | City + service-area pickers | `City[]` (`serviceAreas[].id/name/polygon`) |
| `GET /services?cityId&category` | Trade sub-service list, `unit` (`per_order\|per_hour\|per_visit\|per_item`) | `Service[]` |
| `POST /providers` | Submit provider application | `ProviderApplication` → `LeadCreated` (`submitted\|under_review`) |
| `GET /providers/me` | Profile, `verification`, `payoutCycleDays`, `baseRateTZS`, `availability`, `rating`, `reviewCount`, `verified` | `ProviderPrivate` |
| `PATCH /providers/me` | Update `bio`, `baseRateTZS`, `avatarUrl`, `serviceAreas` | `ProviderUpdate` → `ProviderPrivate` |
| `PUT /providers/me/availability` | Save weekly schedule + availability toggle (see AVAILABILITY.md) | `AvailabilityWindow` → `204` |

## Bookings

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET /bookings/me?status&limit&cursor` | Jobs list with `status` filter | `Booking[]` |
| `GET /bookings/{bookingId}` | Job detail with `events` timeline and `address` | `BookingDetail`; `403`/`404` |
| `POST /bookings/{bookingId}/accept` | Accept within the 300 s acceptance window | `Booking`; `409` `BOOKING_ALREADY_ACCEPTED` / `BOOKING_STATUS_CONFLICT` / `DISPATCH_ACCEPTANCE_TIMEOUT` |
| `POST /bookings/{bookingId}/decline` | Decline with `reason` (max 500) | `Booking` |
| `POST /bookings/{bookingId}/status` | Advance: `provider_arrived` → `in_progress`; `note` optional | `{status, note}` → `Booking`; `409` `BOOKING_STATUS_CONFLICT` |
| `POST /bookings/{bookingId}/complete` | Request completion → `awaiting_customer_confirmation` | `Booking` |
| `POST /bookings/{bookingId}/cancel` | Provider-initiated cancel with `reason` (max 500) | `Booking`; `409` `BOOKING_NOT_CANCELLABLE` |

Booking statuses that appear in the UI: `validating`, `matching`, `offered`, `provider_requested`, `provider_accepted`, `scheduled`, `reminder_sent`, `en_route`, `provider_arrived`, `check_in`, `diagnosing`, `quote_required`, `quote_submitted`, `quote_accepted`, `in_progress`, `completion_review`, `awaiting_customer_confirmation`, `completed`, `settled`, `warranty`, exceptional `escalated`/`reassignment`/`provider_late`/`no_show`/`customer_cancelled`/`provider_cancelled`, plus terminal `declined`, `cancelled`, `refunded`, `disputed`. (`draft`, `pending_payment`, `paid` are customer-side states; the provider only sees `paid`+.) `settled` = payout eligible (ledger release). `Booking.quoteStatus` (`provisional` → `quote_issued` → `quote_approved` | `quote_declined`) and `Booking.technicianId`/`contractId`/`recurringPlanId`/`slaDeadlineAt` are provider-facing additions on `Booking`/`BookingDetail`.

## Dispatch marketplace and provider staff

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET /dispatch/provider-jobs` | Job marketplace: nearby/recommended jobs, offers, quote requests (`lat`, `lon` required; `radiusKm` default 10, `trade`, `kind` `nearby\|recommended\|offers\|quote_requests`, `limit` default 20) | `ProviderJobOffer[]` |
| `POST /dispatch/provider-jobs/{bookingId}/accept` | Accept a marketplace offer → `provider_accepted` (5-min window) | `Booking`; `409` `JOB_OFFER_EXPIRED` / `JOB_OFFER_ACCEPTANCE_WINDOW` (already taken) / `CAPABILITY_FORBIDDEN` |
| `GET /providers/me/staff` | Team list with per-member capabilities | `ProviderStaff[]` |
| `POST /providers/me/staff` | Invite a member (`name`, `phone`, `role`) | `201` `ProviderStaff` (`invited`) |
| `PATCH /providers/me/staff/{staffId}` | Change role, capabilities, or status | `ProviderStaff`; `PROVIDER_STAFF_NOT_FOUND` |
| `DELETE /providers/me/staff/{staffId}` | Remove a member; last-owner removal blocked | `204`; `PROVIDER_STAFF_LAST_OWNER` |
| `GET /providers/me/capabilities` | Capability catalog for the session; drives visible modules per role | `{ capabilities: string[] }` |

`ProviderJobOffer`: `bookingId`, `kind` (`nearby\|recommended\|offer\|quote_request`), `trade`, `summary` (description + photos count), `photoCount` (default 0), `distanceKm`, `customerArea`, `estimatedDurationMinutes`, `estimateLowTZS`/`estimateHighTZS` (nullable), `urgency` (`standard\|urgent\|emergency`), `scheduledFor` (nullable), `matchScore` (0–1, nullable), `expiresAt` (nullable), `reasons[]` (why this job was recommended — transparency).

`ProviderStaff`: `id`, `name` (max 120), `phone`, `role` (`owner\|dispatcher\|technician\|supervisor`), `capabilities[]` (explicit per member, never inherited), `status` (`invited\|active\|suspended`), `createdAt`. Required on create: `name`, `phone`, `role`.

Capabilities are server-enforced: a technician session calling a dispatcher action gets `403` `CAPABILITY_FORBIDDEN`; the UI renders only the session's capabilities (SECURITY.md). `provider_staff` (login/team roles) is distinct from `provider_technicians` (fleet records, TECHNICIANS.md).

## Service catalog, quotes, proof of service, parts, invoice, warranty

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET/POST /providers/me/services` | Catalog list / create a listing (required: `name`, `durationMinutes`, `pricing.baseTZS`) | `ProviderService[]` / `201` (`name`, `description`, `trade`, `durationMinutes`, `pricing{baseTZS, perHourTZS, tripFeeTZS, partsIncluded}`, `active`) |
| `PATCH/DELETE /providers/me/services/{serviceId}` | Update or remove a listing | `ProviderService` / `204`; `SERVICE_NOT_FOUND`, `SERVICE_IN_USE` (delete blocked with bookings) |
| `GET /bookings/estimate?serviceId&area` | Upfront price range + trip fee + duration + disclaimer (transparent pricing) | `BookingEstimate` (`lowTZS`, `highTZS`, `tripFeeTZS`, `estimatedDurationMinutes`, `disclaimer`); `ESTIMATE_UNAVAILABLE` |
| `POST /bookings/{bookingId}/quote` | Submit final quote after inspection | `BookingQuote` (`laborTZS`, `tripFeeTZS`, `parts[]`, `expiresAt`, `note`) → `Booking`; `409` `QUOTE_NOT_ALLOWED` / `QUOTE_ALREADY_ISSUED` |
| `POST /bookings/{bookingId}/quote/decision` | Customer approves/declines (`decision: approved\|declined`, `note` max 500) | `Booking`; `quoteStatus` → `quote_approved` / `quote_declined` (`QUOTE_DECLINED` blocks work until re-quote or cancel) |
| `POST /bookings/{bookingId}/proof-of-service` | Completion proof: `type: photo\|signature\|notes`, `value`, `gpsStamp{lat,lon,at}` | `Booking`; `PROOF_OF_SERVICE_INVALID`, `PROOF_OF_SERVICE_ALREADY_SUBMITTED` |
| `POST /bookings/{bookingId}/parts` | Record parts used (`parts: PartsLine[]`; `name`, `quantity`, `unitCostTZS`, `catalogueItemId` nullable) | `Booking`; `PARTS_INVALID` |
| `POST /bookings/{bookingId}/invoice` | Issue final invoice (`laborTZS` required, `discountTZS` default 0, `note`) — after completion only | `ServiceInvoice` (`laborTZS` + `tripFeeTZS` + `partsTZS` − `discountTZS` + `taxTZS` = `totalTZS`; `status` `draft\|issued\|paid`); `INVOICE_NOT_ISSUABLE` |
| `POST /bookings/{bookingId}/warranty` | Issue warranty on completion (`validDays` min 1, `coverage`, `followUpAt`) | `ServiceWarranty` (`status` `active\|expired\|claimed`); `WARRANTY_NOT_ALLOWED` |
| `GET/POST /providers/me/technicians` | Technician team list / add (required: `name`, `phone`, `trade`; `status` `idle\|on_job\|offline`, `currentBookingId`, `certifications[]`, `rating`) | `Technician[]` / `201` `Technician` |
| `PATCH/DELETE /providers/me/technicians/{technicianId}` | Update (skills, status, certifications) or remove a technician | `Technician` / `204`; `TECHNICIAN_NOT_FOUND`, `TECHNICIAN_BUSY` (on a job) |
| `GET/POST /providers/me/certifications` + `PATCH /providers/me/certifications/{certificationId}` | Certification list/add/renew (`type` e.g. `electrician_license`, `number`, `issuer`, `issuedAt`, `expiryDate`, `documentUrl`, `verified`, `status` `pending\|verified\|rejected\|expired`) | `Certification[]` / `201` / `200`; `CERTIFICATION_INVALID`, `CERTIFICATION_EXPIRED` (blocks affected service listings) |

Contract notes: `BookingCreate.photos` (pre-visit job photos, max 6), `BookingCreate.answers` (dynamic questionnaire answers, SERVICE-CATALOG.md), `Booking.contractId`/`Booking.recurringPlanId`/`Booking.slaDeadlineAt` are all live in `API-CONTRACT.yaml`.

## Provider intelligence and enterprise

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET /service-categories` | Dynamic category config: skills/certifications, pricing model, duration, questionnaire template, required photos/equipment, cancellation rules, warranty days, commission | `ServiceCategoryConfig[]` |
| `GET /service-categories/{categoryId}/questions` | Dynamic intake questionnaire (SERVICE-CATALOG.md) | `ServiceQuestion[]` (`key`, `label`, `type` `text\|single_choice\|multi_choice\|number\|boolean\|photo\|video`, `required`, `options`) |
| `GET/POST /providers/me/inventory` | Parts/materials/equipment inventory (INVENTORY-MATERIALS.md) | `ProviderInventoryItem[]` / `201` (`name`, `category` `part\|consumable\|equipment\|tool`, `stockOnHand`, `lowStockThreshold`, `unitCostTZS`, `assignedTechnicianId`) |
| `POST /providers/me/inventory/items/{itemId}/adjust` | Stock adjustment with `delta` + `reason` (parts use deducts automatically) | `ProviderInventoryItem`; `INVENTORY_ITEM_NOT_FOUND`, `INVENTORY_NEGATIVE_STOCK`, `INVENTORY_ADJUSTMENT_REASON_REQUIRED` |
| `GET/POST /providers/me/service-plans` | Recurring service plans (CONTRACTS-SLA.md) | `ServicePlan[]` / `201` (`frequency` `weekly\|biweekly\|monthly\|quarterly\|annually`, `priceTZS`, `customerCount`); `PLAN_NOT_FOUND`, `PLAN_IN_USE` |
| `GET/POST /providers/me/contracts` | B2B contracts with SLAs (CONTRACTS-SLA.md) | `ServiceContract[]` / `201` (`organizationName`, `locations`, `coveredServices`, `slaResponseMinutes`, `slaResolutionMinutes`, `pricing`, `coverageArea`, `workingHours`, `escalationRules`, `status` `draft\|active\|expired\|cancelled`); `CONTRACT_NOT_FOUND` |
| `GET/POST /providers/me/documents` + `PATCH /providers/me/documents/{documentId}` | Document service (TRUST-SAFETY.md): upload/renew (`type` `identity\|license\|certificate\|insurance\|tax\|registration\|vehicle\|background_check\|training`) | `ProviderDocument[]` / `201` / `200` (`status` `uploaded\|processing\|verified\|rejected\|expiring\|expired`, `expiryDate`, `verifiedAt`); `DOCUMENT_NOT_FOUND`, `DOCUMENT_EXPIRED` |
| `GET /providers/me/dispatch` | Dispatcher console: `unassignedJobs` + `technicianSchedule` (idle/on_job/offline, `currentBookingId`, `nextBookingAt`) | `{ unassignedJobs: ProviderJobOffer[], technicianSchedule: [...] }` |
| `POST /bookings/{bookingId}/assign-technician` | Dispatcher assigns a technician (`technicianId`, `note` max 300) | `Booking`; `409` `TECHNICIAN_ALREADY_ASSIGNED` / `TECHNICIAN_BUSY` / `ASSIGN_TECHNICIAN_NOT_ALLOWED`; `TECHNICIAN_NOT_FOUND` |
| `POST /bookings/{bookingId}/check-in` | Check in at the site (geofence or manual) with `lat`/`lon` | `Booking`; `409` `CHECK_IN_NOT_ALLOWED` (wrong status or out of radius) |
| `POST /bookings/{bookingId}/pause` | Pause work with `reason` (max 300) | `Booking`; `PAUSE_NOT_ALLOWED` (resume via `/bookings/{bookingId}/resume`; `RESUME_NOT_ALLOWED`) |
| `GET /providers/me/trust` | Trust/risk profile (TRUST-SAFETY.md) | `TrustProfile` (`trustScore`/`riskScore` 0–100, `flags[]`, `verifiedBadge`, `tier` `bronze\|silver\|gold\|platinum`); `TRUST_PROFILE_UNAVAILABLE` |
| `POST /providers/me/copilot` | AI copilot (ARCHITECTURE.md): `explain_job\|diagnose_photos\|suggest_quote\|recommend_materials\|generate_message\|summarize_history` | `CopilotRequest` → `{ action, result, suggestions? }`; `COPILOT_UNAVAILABLE` |

## Reviews

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `POST /reviews` | Provider reviews a customer after `completed` (policy permits) | `ReviewCreate` (`targetType: customer`) → `Review`; `409` `REVIEW_ALREADY_EXISTS` / `REVIEW_NOT_ELIGIBLE` |
| `POST /reviews/{reviewId}/report` | Report an abusive review, `reason` (max 300) | `ReviewReport` (`open\|resolved\|dismissed`); `REVIEW_NOT_REPORTABLE` |

Contract note: there is no list-received-reviews endpoint in `API-CONTRACT.yaml` yet. Received reviews surface as `rating` + `reviewCount` on `/providers/me` (from published reviews only). Propose `GET /reviews/me` to the contract team before building a reviews-list screen.

## Payouts

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET /payouts/me?limit&cursor` | Payout history + current balance | `PayoutSummary[]` (`pending\|processing\|paid\|failed\|exception`) |
| `GET /payouts/me/statement?from&to` | Ledger statement (immutable entries) | `LedgerStatement` (`openingBalanceTZS`, `closingBalanceTZS`, `entries[]`) |

## Notifications and support

| Endpoint | Used for | Response refs |
| --- | --- | --- |
| `GET /notifications/me?unreadOnly&limit&cursor` | Notification center | `Notification[]` (`type`, `deepLink`, `read`) |
| `GET /notifications/me/preferences` | Read preferences | `NotificationPreferences` |
| `PUT /notifications/me/preferences` | Update per-event toggles per channel (`push`, `sms`, `email`, `inApp`) | `NotificationPreferences`; `PREFERENCE_INVALID_EVENT` |
| `POST /notifications/{notificationId}/read` | Mark one read | `204`; `NOTIFICATION_NOT_FOUND` |
| `POST /support/tickets` | Open ticket (`subject`, `body`, optional `bookingId`) | `TicketCreate` → `Ticket` |
| `GET /support/tickets/me` | My tickets | `Ticket[]` (`open\|assigned\|in_progress\|resolved\|closed`) |
| `GET /support/tickets/{ticketId}` | Ticket detail with messages | `TicketDetail` |
| `POST /support/tickets/{ticketId}/messages` | Reply (`body`, max 4000) | `TicketDetail`; `TICKET_CLOSED` |

## Cross-cutting error handling

- `401 UNAUTHORIZED` / `SESSION_EXPIRED` → refresh once, then force logout to auth screen.
- `403 FORBIDDEN` → wrong role session; show role-switch prompt.
- `429 RATE_LIMITED` → respect `retryAfterSeconds`.
- `422 VALIDATION_FAILED` → map `errors[].field` to form fields.
- `409 CONFLICT` (status transition not allowed) → refetch the booking; the server state is the truth; show toast.
- All mutations carry `Idempotency-Key` (booking status/cancel and payment-related flows) so retries never double-apply.
- MSW handlers in `packages/shared/mocks` implement every endpoint above 1:1 with the contract (MSW parity) for dev and tests.

## Provider portfolio, job notes, and exports

- `GET/PUT /providers/me/portfolio` — photos/videos of past work (`PortfolioItem`: kind photo/video, caption, serviceId; max 50; `PORTFOLIO_INVALID`); displayed on the public provider profile.
- `POST /bookings/{bookingId}/notes` — internal team notes (provider owner/dispatcher/technician/supervisor only; never visible to the customer; `BOOKING_NOTE_INVALID`).
- `POST /providers/me/exports` — tax/earnings/jobs reports as csv/pdf/json (async job; `PROVIDER_EXPORT_IN_PROGRESS`).
