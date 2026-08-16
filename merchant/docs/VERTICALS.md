# HUDumika Merchant — Industry Verticals

Industry strategy: how each vertical is served by existing platform surfaces, what already applies, and what is honestly still a gap. Vertical readiness ships with backend M9c (provider trade extension + vertical config); anything marked "planned" or "M9c or later" does not exist yet.

## Platform surfaces

| Surface | Primitive | Serves |
| --- | --- | --- |
| Merchant catalogue | Orders, delivery, dine-in, group buy, promotions, loyalty, inventory (M9a) | Retail, hotels (rooms as items), pet retail, education (materials) |
| Dine-in | Tables, QR ordering, reservations | Restaurants, cafes, events catering |
| Provider trade | Bookings, availability, service catalogue | All service verticals |
| Booking | Appointment lifecycle: `draft → pending_payment → paid → provider_accepted → scheduled → in_progress → completed` (+ decline/cancel/no_show) | Appointment-driven verticals |

Provider trade enum (contract): `plumbing`, `electrical`, `cleaning`, `repairs`, `carpentry`, `painting`, `beauty`, `wellness`, `fitness`, `education`, `automotive`, `pet_care`, `health_care`, `events`, `property`, `other`.

## Vertical map

| Vertical | Surface | Capabilities that already apply | Gaps (phase marker) |
| --- | --- | --- | --- |
| Retail | Merchant catalogue + dine-in (in-store) | Catalogue + options as variants (size/color), bulk item create/update and spreadsheet import/export (live, M9c), master inventory + PO + COGS (M9a), promotions/coupons, loyalty, group buy | Barcode scanning (contract addition, M9c or later); stock per option choice (contract addition); unified customer profile (planned) |
| Beauty / Hair / Wellness | Provider trade `beauty`, `wellness` | Appointments via booking, service packages as `Service` entries (`unit` per_visit/per_hour), staff commission rules (per_service), retail inventory for products | Client history (later — booking events + reviews today); treatment notes (later); waitlist + no-show handling (no-show event today, waitlist later); recurring appointments (later); salon tool connectors (later) |
| Hotels & Accommodation | Merchant catalogue (rooms) + reservations | Room nights as catalogue items, per-store inventory + low-stock alerts for room blocks, table/reservation primitives for check-in queues | OTA channel managers OUT OF SCOPE v1; room-type calendar availability (later) |
| Medical / Dental / Health | Provider trade `health_care` | Appointment booking, provider availability, client history from booking events, medical inventory via master inventory | Patient records OUT OF SCOPE v1 (HIPAA-grade); insurance claims OUT OF SCOPE v1; e-prescriptions OUT OF SCOPE v1; telemedicine OUT OF SCOPE v1; treatment notes (later); compliance tools (later) |
| Pet services | Provider trade `pet_care` | Booking + service packages (grooming, boarding) | Pet profiles per client (later); recurring grooming plans (later) |
| Fitness & Wellness | Provider trade `fitness`, `wellness` | Booking + service packages (sessions, classes as `per_session` services) | Class capacity sync (later); membership plans via loyalty tiers today, dedicated gym plans later |
| Automotive | Provider trade `automotive` | Booking (service, repair) + merchant catalogue for parts with inventory | Parts VIN/vehicle records (later) |
| Education & Training | Provider trade `education` | Booking (lessons, tutoring), service packages | Course series / enrollment tracking (later) |
| Events & Weddings | Provider trade `events` | Booking (vendors, photography, catering), group buy for bundles, reservations for venues | Multi-vendor packages (later); event planning checklist (later) |
| Real Estate & Property | Provider trade `property` | Booking for viewings/tours, service packages | Property listings (later); viewing scheduling (booking covers single viewings today); tenant management (later); maintenance requests (later); rent collection (later) |

## Cross-cutting mapping rules

- Appointments, service packages, and client history map to existing booking + provider primitives: `Service` (catalogue of offerings), `Booking` + `booking_events` (history), `ProviderPrivate.availability` (weekly schedule), reviews (reputation). No vertical gets a parallel appointment system.
- Retail variants are already expressible: `CatalogueItem.options` covers size/color/choice groups (MENU-CATALOGUE.md). A dedicated `variants` resource is not needed in v1.
- Retail bulk import/export is live in the contract: `POST /catalogue-items/bulk` (max 500), `POST /catalogues/import` (max 5000 rows), `GET /catalogues/export` (MENU-CATALOGUE.md).
- Retail barcode scanning is not in the contract — a `barcode` field on `CatalogueItem` and a scan-at-POS flow are a contract addition (M9c or later). Until it lands, the UI exposes no barcode surface.
- Integration-based channels (POS/ERP sync, inventory `masterSource: pos|erp`, delivery partners, mini-program) are staged with the M9a/M9b connector model (INTEGRATIONS-WEBHOOKS.md); until the connector ships, the registry renders statuses honestly.

## Out of scope v1 (documented, not promised)

| Area | Status |
| --- | --- |
| Hotel OTA channel manager sync | OUT OF SCOPE v1 (contract addition, later) |
| Insurance claims processing | OUT OF SCOPE v1 |
| Telemedicine / remote consultations | OUT OF SCOPE v1 |
| HIPAA-grade medical records / patient data | OUT OF SCOPE v1 (no medical-record storage or clinical workflows) |
| Vertical-specific compliance certifications | OUT OF SCOPE v1 (platform-level data protection only, SECURITY.md) |

## Rules

- Vertical configuration lives in docs and contract data (provider `trade` enum), not in client code; no client hardcodes vertical-specific logic.
- Any gap moved into a milestone must land in `backend/API-CONTRACT.yaml` first (phase gate in ROADMAP.md).
