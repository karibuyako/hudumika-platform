# HUDumika Provider — Service Catalog

The provider's storefront on the platform: a skilled-service business (Dianping-Manager-style) selling services, not food items. The service catalog is a separate surface from the merchant catalogue — `provider_services` listings with duration and pricing models, never merchant `catalogue_items` (DATA-MODEL.md). This doc covers listings, category configuration, the intake questionnaire, upfront estimates, the quote flow, final invoicing, parts recording, and service warranties.

## Dynamic category configuration (`ServiceCategoryConfig`)

`GET /service-categories` returns the platform's configurable category engine (`service_categories_config`, DATA-MODEL.md) — every new vertical is configuration, not code:

| Field | Meaning |
| --- | --- |
| `name` | e.g. Plumbing, Electrical |
| `requiredSkills` / `requiredCertifications` | Skills and certificates a provider needs to serve the category |
| `pricingModel` | `fixed` \| `hourly` \| `quote` \| `dynamic` |
| `defaultDurationMinutes` | Typical job length |
| `questionnaireTemplate` | The intake questions (`ServiceQuestion[]`, below) |
| `requiredPhotos` | Minimum photos for a request (default 0) |
| `requiredEquipment` | Equipment the provider must bring |
| `cancellationRules` (max 500) | Category-specific cancellation policy text |
| `warrantyDays` (default 0) | Standard warranty length per category |
| `commissionBps` (default 0) | Commission basis points for the category |

Provider-side uses: the category config drives what the provider sees per trade — required certifications gate eligibility (with `CERTIFICATION_EXPIRED` blocking listings), `warrantyDays` pre-fills warranty issuance, and `commissionBps` informs the earnings preview (commission itself still reads from the ledger only). The catalog renders category cards with loading/empty/error/success states; unknown categories are never rendered from local fallbacks.

## Dynamic intake questionnaire (`ServiceQuestion`, `BookingCreate.answers`)

`GET /service-categories/{categoryId}/questions` returns the category's intake questions; the customer's answers arrive on the booking as `BookingCreate.answers` (free-form object keyed by question `key`).

| Field | Meaning |
| --- | --- |
| `key` | Stable answer key, e.g. `leak_or_blockage` |
| `label` | Display text |
| `type` | `text` \| `single_choice` \| `multi_choice` \| `number` \| `boolean` \| `photo` \| `video` |
| `required` | Mandatory answers (default false) |
| `options` | Choices for choice types (nullable) |

Examples: plumbing asks "leak or blockage? where? water shut off?" with photos; electrical asks "what's wrong? which room? power off?". The provider sees the answers on the incoming request and job detail (read-only evidence) so the technician can prepare tools and parts before travel — same pattern as pre-visit job photos. `QUESTIONNAIRE_INVALID` guards malformed questionnaire configuration server-side; the client renders whatever question types the config returns, with per-type input states (choice pills, number stepper, photo/video upload placeholders where the category requires them).

## Service listings (`ProviderService`)

| Endpoint | Purpose |
| --- | --- |
| `GET /providers/me/services` | Catalog list (loading/empty/error/success) |
| `POST /providers/me/services` | Create a listing |
| `PATCH /providers/me/services/{serviceId}` | Update listing |
| `DELETE /providers/me/services/{serviceId}` | Remove listing (`204`; `SERVICE_IN_USE` when bookings exist) |

`ProviderService` fields: `name` (max 160), `description` (max 2000), `trade`, `durationMinutes` (min 15), `pricing { baseTZS, perHourTZS, tripFeeTZS (default 0), partsIncluded (default false) }`, `active` (default true), `createdAt`. Required on create: `name`, `durationMinutes`, `pricing.baseTZS`.

Rules:

- `tripFeeTZS` covers travel to the customer address; `partsIncluded: true` means listed parts are inside the base price (quote only adds labor/trip when true); `perHourTZS` is for time-based trades (electrical, painting, tutoring).
- Deleting a listing with existing bookings returns `SERVICE_NOT_FOUND` (if unknown) or `SERVICE_IN_USE` (bookings reference it). Deactivate (`active: false`) instead of delete to stop new requests while keeping history.
- `CERTIFICATION_EXPIRED`: a listing whose trade requires a certification is blocked while the certification status is `expired` (see ONBOARDING.md) — the listing shows a "renew to relist" state.
- Contract note: listings only become visible to customers through the booking/estimate flow; there is no public `ProviderService` listing endpoint yet.

## Upfront estimates (`BookingEstimate`)

`GET /bookings/estimate?serviceId&area` returns the transparent-pricing commitment shown before any booking:

| Field | Meaning |
| --- | --- |
| `lowTZS` / `highTZS` | Price range for the service in the area |
| `tripFeeTZS` | Travel fee |
| `estimatedDurationMinutes` | Expected job length |
| `disclaimer` | "Final quote may vary after on-site inspection" (max 300) |

`ESTIMATE_UNAVAILABLE` when the service is inactive or not servable in the area. The disclaimer renders verbatim on the customer side and on the provider's job preview — estimates are ranges, never promises.

## Quote flow (`BookingQuote`, `Booking.quoteStatus`)

Provisional estimate → on-site inspection → final quote → customer decision → proceed. `quoteStatus` moves `provisional` → `quote_issued` (provider submits) → `quote_approved` | `quote_declined` (customer decides).

| Step | Endpoint | Errors |
| --- | --- | --- |
| Submit final quote at/after inspection | `POST /bookings/{bookingId}/quote` — body `BookingQuote { laborTZS, tripFeeTZS, parts[], expiresAt, note }` | `QUOTE_NOT_ALLOWED` (status gate), `QUOTE_ALREADY_ISSUED` |
| Customer decision | `POST /bookings/{bookingId}/quote/decision` — `{ decision: approved \| declined, note }` | — |

Rules:

- Work may only start (`in_progress`) on `quote_approved`; the app hides the work-start action until then.
- `quote_declined` blocks work: the provider must re-quote (`quoteStatus` returns to `quote_issued` after a new submission) or the booking is cancelled per cancellation policy (SHARED-FLOWS.md). `QUOTE_DECLINED` surfaces as a booking-level error code.
- `expiresAt` (nullable) is a courtesy deadline; the customer may still decide after it — never auto-approve client-side.

## Final invoicing (`ServiceInvoice`)

`POST /bookings/{bookingId}/invoice` — body `{ laborTZS, discountTZS (default 0), note }` → `ServiceInvoice`. Issued only after completion (`INVOICE_NOT_ISSUABLE` otherwise).

| Field | Source |
| --- | --- |
| `laborTZS` | Provided at issue (required) |
| `tripFeeTZS` | From the approved quote / listing |
| `partsTZS` | Sum of recorded `booking_parts` |
| `discountTZS` | Provided at issue (default 0) |
| `taxTZS` | Server-computed |
| `totalTZS` | labor + trip + parts − discount + tax, server-computed |

`status` enum: `draft` → `issued` → `paid`. The client never computes totals; it renders `totalTZS` formatted (`TZS 12,500`). Invoice detail shows the breakdown lines; `issuedAt` is the UTC timestamp. Payment turns it `paid` (see PAYMENTS.md on-site payments).

## Parts recording (`PartsLine`)

`POST /bookings/{bookingId}/parts` — body `{ parts: PartsLine[] }` → parts are added to the job and to the final invoice. `PARTS_INVALID` on bad lines.

`PartsLine`: `name` (max 120), `quantity` (min 1), `unitCostTZS`, `catalogueItemId` (nullable — links the line to the provider's parts inventory). The provider records parts during/after work; the app shows the running parts subtotal before invoice issue.

## Service warranties (`ServiceWarranty`)

`POST /bookings/{bookingId}/warranty` — body `{ validDays (min 1), coverage (max 1000), followUpAt }` → `ServiceWarranty` with `status: active`. `WARRANTY_NOT_ALLOWED` outside completion.

- Statuses: `active` → `expired` (validity window ends) or `claimed` (customer opened a claim).
- Claim flow: the customer opens a support ticket referencing the booking; ops reviews and updates the warranty to `claimed`. There is no provider-side claim mutation — the provider sees the status change and the ticket.
- `followUpAt` (nullable) schedules a follow-up visit; when set, the app shows the follow-up on the job timeline and (planned) triggers `booking.followup` — contract addition, not built.

## Screen states

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Catalog list | Skeleton cards | "No services yet — create your first listing" CTA | Retry button | Listing cards: name, trade, `TZS base`, duration, `active` pill |
| Listing form | Skeleton form | — | `VALIDATION_FAILED` field errors; save failure → revert + toast | Created/updated confirmation; list refetch |
| Delete listing | Disabled button + spinner | — | `SERVICE_IN_USE` → explain deactivate instead; `SERVICE_NOT_FOUND` → refetch | `204` → removed from list |
| Estimate preview (job) | Skeleton range card | — | `ESTIMATE_UNAVAILABLE` → "estimate not available for this area" | Range + `tripFeeTZS` + disclaimer |
| Quote submit | Submitting state | — | `QUOTE_NOT_ALLOWED` / `QUOTE_ALREADY_ISSUED` → refetch booking, toast | `quote_issued` pill on booking |
| Quote decision (customer side) | — | — | — | `quote_approved` unlocks work-start; `quote_declined` shows re-quote/cancel CTA |
| Invoice | Skeleton breakdown | — | `INVOICE_NOT_ISSUABLE` → refetch booking | Issued breakdown; `paid` pill after payment |
| Parts | Saving lines state | "No parts recorded" | `PARTS_INVALID` → line errors | Running parts subtotal |
| Warranties | Skeleton | "No warranty for this job" | `WARRANTY_NOT_ALLOWED` → refetch | Active warranty card with `followUpAt` |

## Cross-cutting

- Retry safety: double-submits are rejected by server state checks (`QUOTE_ALREADY_ISSUED`, `PROOF_OF_SERVICE_ALREADY_SUBMITTED`) and the booking status gates; send `Idempotency-Key` only where the contract declares it (booking creation, payment intents).
- Money is integer TZS, rendered with thousands separators; totals are always server-computed.
- MSW handlers implement these endpoints 1:1 with the contract (MSW parity); error codes above are from `backend/ERROR-CODES.md`.

## Group buying (planned)

Group purchases of service plans (shared cleaning, office blocks) are a planned pricing model.
