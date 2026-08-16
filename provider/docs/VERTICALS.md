# HUDumika Provider — Verticals

Provider-side view of the industry verticals served by the provider surface. The platform verticals are defined in `../GLOSSARY.md` (Vertical); the merchant-side mapping lives in `../merchant/VERTICALS.md`. Every vertical runs on the same provider booking surface — there are no vertical-specific endpoints.

## Covered verticals

`ProviderApplication.trade` spans 15 trades plus `other`, covering 10+ service verticals:

| Vertical | Trade(s) | Typical services |
| --- | --- | --- |
| Home services | plumbing, electrical, cleaning, repairs, carpentry, painting | Pipe and fixture work, wiring and appliance/AC repair, home and office cleaning, general repairs, furniture and joinery, painting and finishing |
| Beauty | beauty | Haircuts, styling, braiding, barbering, nails, makeup at the customer's location |
| Wellness | wellness | Massage, spa treatments, relaxation sessions |
| Fitness | fitness | Personal training, group studio sessions, home workout programs |
| Education | education | Tutoring (school subjects, exam prep, language, skills) |
| Automotive | automotive | Mechanical repair, diagnostics, detailing, tyre and battery services |
| Pet care | pet_care | Grooming, bathing, vet-assistant visits for routine care |
| Health care | health_care | Non-clinical home care (elderly care, post-operative assistance, personal care); clinical services are out of scope for v1 |
| Events | events | Event planning, setup and teardown, venue service for private and corporate events |
| Property | property | Property maintenance, small building work, unit upkeep for landlords and tenants |
| Other | other | Any trade not yet classified; operations assigns requirements manually |

## Service packages

All verticals compose bookings from the existing booking and service primitives. Provider service listings live in the provider catalog (`GET/POST /providers/me/services`, SERVICE-CATALOG.md) — distinct from the merchant `/catalogues/*` surface, which does not apply to providers:

- Service from the public catalogue (`GET /services`): `Service` carries `category`, `name`, and a pricing-hint `unit` (`per_order`, `per_hour`, `per_visit`, `per_item`) that drives pricing copy.
- Booking composition (`BookingCreate`): `providerId`, `serviceId`, `scheduledFor`, `durationMinutes` (15–480), `paymentMethod`, `address`, `description`.
- Pricing: `ProviderPublic.baseRateTZS` (starting price on the profile) plus the customer-side price breakdown; money is integer TZS throughout.
- Job lifecycle: `BookingStatus` state machine (`provider_requested` → `provider_accepted` → `scheduled` → `provider_arrived` → `in_progress` → `awaiting_customer_confirmation` → `completed`; terminal states `declined`, `cancelled`, `refunded`, `disputed`, `no_show`), enforced server-side.

Typical package shape per vertical (how the primitives combine):

| Vertical | Unit bias | Typical booking shape |
| --- | --- | --- |
| Home services | per_visit / per_hour | Repair visit with description and duration; per-hour for electrical and painting |
| Beauty | per_visit / per_item | Appointment at customer location; per-item for nail and makeup services |
| Wellness | per_hour | Fixed-duration massage/spa session |
| Fitness | per_visit / per_order | Session or program block with duration |
| Education | per_hour | Hourly tutoring slot |
| Automotive | per_visit | On-site or pickup repair job |
| Pet care | per_visit | Grooming appointment at customer location |
| Health care | per_hour | Shifted home-care visit; duration reflects hours of care |
| Events | per_order | Event-day engagement with schedule and setup time |
| Property | per_visit / per_hour | Maintenance call-out or hourly property work |

## Client history, recurring appointments, waitlists

Planned, not built. Each requires a contract addition — no endpoints exist today:

- Client history and notes: a provider record of past clients, preferences, and job notes per client. Today the provider reconstructs history from `GET /bookings/me` (own bookings) and received reviews; there is no per-client notes field on the contract.
- Recurring appointments: standing weekly/fortnightly bookings (e.g. cleaning schedules, training blocks, maintenance rounds). Today every occurrence is an independent booking (`scheduledFor` + `durationMinutes`); no recurrence rule exists on `BookingCreate` or `Booking`.
- Waitlists: customer interest for a provider when availability is full. Dispatch has no waitlist state (`DISPATCH.md`); unscheduled demand is served by the normal acceptance flow.

These items ship with the P8c vertical expansion phase (ROADMAP.md, backend M9c). Until the contract additions land, the UI must not render these features; keep the states honest: loading/empty/error/retry around `GET /bookings/me` and `GET /payouts/me/statement` only.

## Commission and earnings per vertical

Commission is set per provider at approval (per GLOSSARY: "set per merchant/provider on approval"), consistent across verticals:

- Providers earn via the ledger: a `booking_earning` entry on `completed` and a negative `commission` entry at settlement (`GET /payouts/me/statement`). Clients never compute commission; they read it from ledger entries.
- Staff commission rules (`per_order`, `per_service`, `per_revenue` in basis points) are merchant-side only — they reward a merchant's staff (GLOSSARY Commission rule). Providers are not merchant staff: they are independent earners settled through the ledger and payouts, never through staff commission rules.
- `commissionRateBps` is not exposed on `ProviderPrivate` (contract gap, ROADMAP.md); the provider app shows earnings and payouts only.

## Qualification and documents per vertical

Per-vertical qualification and document requirements are configuration-driven and vary by trade (e.g. licences for electrical work, certificates for home care, permits for events). The client renders requirements from config — never hardcoded — and the backend keeps regulated categories from reaching `approved` without their documents (ONBOARDING.md). Contract note: per-trade requirement lists are not yet exposed on the API.
