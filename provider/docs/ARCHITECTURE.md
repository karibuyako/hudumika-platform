# HUDumika Provider — Architecture

## Repository layout

The provider app lives in `apps/provider/` (or the repo root per team decision) with two entry points sharing code:

```text
provider/
  apps/
    mobile/                 # Expo app (mobile surface)
      app/                  # expo-router routes
      package.json
    web/                    # React + Vite + TypeScript (web dashboard)
      src/
        pages/              # route-level screens
        components/
        main.tsx
        vite.config.ts
  packages/
    shared/                 # shared modules (both surfaces)
      api/                  # typed client generated from the contract
      auth/                 # session context, token refresh, role switching
      i18n/                 # en / sw / ar dictionaries + formatting
      ui/                   # design-system components (DESIGN-SYSTEM.md)
      mocks/                # MSW handlers mirroring API-CONTRACT.yaml
  backend/                  # (already exists) API-CONTRACT.yaml + backend docs
```

The public web (repo root) is a separate marketing surface and must never contain provider dashboard routes.

## Supply-side surface (provider operating system)

The provider app is a distinct supply-side surface — a shared platform, specialized app, not a variant of the merchant app (NAVIGATION.md blueprint):

- Merchant app = catalog + order flow; provider app = service-job machine: matching → offer → schedule → diagnose → quote → work → confirm → settle → warranty. Every node maps to real contract endpoints.
- Data and sessions are role-scoped: provider sessions never touch merchant data (SECURITY.md role isolation) even though both ride the same platform backend.
- Job flows are matching-driven: `GET /dispatch/provider-jobs` surfaces nearby/recommended/offer/quote-request jobs with `matchScore` + `reasons[]` transparency; acceptance is time-boxed (5 min, `expiresAt`, `JOB_OFFER_EXPIRED`).
- The job state machine (`BookingStatus`: matching → offered → provider_accepted → scheduled → en_route → provider_arrived → check_in → diagnosing → quote_required → quote_submitted → quote_accepted → in_progress → completion_review → awaiting_customer_confirmation → completed → settled → warranty; exceptional states escalated/reassignment/provider_late/no_show/customer_cancelled/provider_cancelled; terminals declined/cancelled/refunded/disputed) is enforced server-side. The client renders `BookingDetail.events` and maps actions per state; it never re-derives transition legality — `409` `BOOKING_STATUS_CONFLICT` / `403` `CAPABILITY_FORBIDDEN` surface as refetch + toast.
- UI per session capability: modules render from `GET /providers/me/capabilities`; role switch re-fetches the catalog.
- **Capability-driven surface**: the provider shell is one codebase; capabilities select modules. A dispatcher sees the dispatch console, an owner sees staff/payouts, a technician sees assigned jobs. The same principle extends to verticals: category configuration (`GET /service-categories`, SERVICE-CATALOG.md) drives what a plumber vs an electrician sees — an electrician gets the electrical intake questions and required-equipment checklist, a cleaner gets the cleaning checklist. Same platform, different surface; nothing vertical-specific is hardcoded.
- **Event-driven job flow**: domain events drive the machine end-to-end — `ServiceRequested → ProviderMatched → … → WarrantyOpened` (matching, offer, accept, schedule, reminder, check-in, work, completion, settle, warranty). Events surface to clients via `BookingDetail.events`, notifications (`backend/NOTIFICATIONS.md`), and the realtime stream; clients render events, never re-derive transition legality — `409` `BOOKING_STATUS_CONFLICT` / `403` `CAPABILITY_FORBIDDEN` surface as refetch + toast.
- Shared `packages/` (api, auth, i18n, ui, mocks) serve both apps where true sharing exists (auth primitives, design tokens); provider feature trees live under `apps/provider/` and never import merchant app routes or state.

## Provider AI copilot

`POST /providers/me/copilot` (`CopilotRequest` → `{ action, result, suggestions? }`) assists the provider on job content:

| Action | Purpose |
| --- | --- |
| `explain_job` | Plain-language summary of a booking (answers, photos count, urgency) |
| `diagnose_photos` | Suggests probable causes from job photos |
| `suggest_quote` | Draft labor/trip line items from job context |
| `recommend_materials` | Parts/materials candidates for the job |
| `generate_message` | Drafts customer-facing copy (in `language`) |
| `summarize_history` | Booking history over `historyMonths` (default 3) |

- v1 is rule-based (template + structured job data); ML assistance is planned (`COPILOT_UNAVAILABLE` when the service is down).
- Guardrail: the copilot recommends — business rules decide. Quote totals, invoices, parts, warranties, and status transitions are never auto-accepted from copilot output; every suggestion is provider-reviewed before submission, and money/status mutations remain contract-gated (`Idempotency-Key`, server validation). Copilot output is never shown to customers verbatim.

## Shared modules

| Module | Contents | Notes |
| --- | --- | --- |
| `api` | Typed client from `API-CONTRACT.yaml` (paths, schemas, error codes) | Single source of truth for types; regenerate on contract changes |
| `auth` | `SessionProvider`, `useSession`, refresh interceptor, role switch (re-verify OTP) | Role-scoped: a `provider` session never reads customer/merchant data |
| `i18n` | Locale dictionaries (`en`, `sw`, `ar`), money and date formatters | `en` first, `sw` ready, `ar` capable (RTL-safe layout) |
| `ui` | Shared kit from `DESIGN-SYSTEM.md`: Button, Card, FormField, StatusPill, Rating, Toast, empty/error/retry blocks | Tokens in both Tailwind (web) and theme.json (Expo) |
| `mocks` | MSW handlers for web + MSW/Expo-compatible handlers for mobile dev | Must match the contract 1:1 (MSW parity) |

## Navigation map

Same logical map on both surfaces (bottom nav on mobile, sidebar on web):

```text
auth (OTP login / role verify)
  -> onboarding / verification        (state = VerificationState)
       -> availability + services      (weekly schedule, baseRateTZS, service areas)
            -> bookings / jobs         (incoming, upcoming, active, history)
                 -> job detail         (status timeline, actions per status)
                 -> earnings           (balance, payouts, statement)
                      -> settings      (profile, notifications, support, security, logout)
```

- Auth stack: request-otp → verify-otp → redirect by `activeRole`; `purpose: verify_role` for role switching.
- Post-approval gate: `VerificationState = approved` is required before the availability/jobs tabs unlock. `pending`, `documents_review`, `changes_requested`, `rejected`, `suspended` each render a dedicated onboarding state (see ONBOARDING.md).
- Deep links: booking detail, ticket, payout statement (`Notification.deepLink`).

## State management recommendation

- Server state: TanStack Query (both surfaces) — key by role + resource (`['provider', 'bookings', {status}]`, `['provider', 'payouts']`). Invalidation after mutations: accept/decline/status-advance invalidate the bookings list and detail.
- Auth/session: React context + secure storage adapter (`expo-secure-store` mobile, `sessionStorage` web). One context per role; sessions never mix.
- Local UI state: hooks/components; no global store unless a real cross-screen need appears (e.g. live booking countdown).
- Mutations: optimistic updates only for read-safe flags (notification read); accept/decline/status always await server response.

## Environment configuration

| Variable | Surface | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | mobile | API base URL (no `/api/v1` suffix; client appends it) |
| `VITE_API_URL` | web | API base URL |
| `EXPO_PUBLIC_ENV` / `VITE_ENV` | both | `development` (MSW on), `staging`, `production` |
| Push | mobile | Expo project config; push tokens registered with the backend per NOTIFICATIONS.md |

- Never hardcode URLs, support phones, or emails; all environment-driven.
- MSW runs only in `development`: mock handlers in `packages/shared/mocks`; the swap to the real API is config-only, no UI changes.
- API contract details: base path `/api/v1`, bearer auth, cursor pagination (`limit`, `cursor`), `Idempotency-Key` on booking/payment mutations.

## Conventions

- All timestamps from the API are UTC ISO 8601; render via i18n local formatters.
- Money: integer TZS, formatted `TZS 12,500` (`Intl.NumberFormat('en-TZ')`-style grouping).
- Errors: switch on `ErrorResponse.code`, never on `message` text.

## Technical architecture (platform standards)

- **Backend**: REST microservices (auth, jobs, payments, notifications, matching) behind the gateway; real-time via WebSocket + long-poll, with MQTT considered for high-frequency location streams.
- **Queues/caching**: Kafka/RabbitMQ for async tasks and domain events; Redis for caching, geospatial rider/provider positions, and surge config.
- **Database**: PostgreSQL (users, jobs, payments) + PostGIS geospatial queries; TimescaleDB for analytics time-series; Elasticsearch for service discovery/search.
- **Infrastructure**: Docker containers, Kubernetes orchestration, auto-scaling; Prometheus/Grafana monitoring; ELK stack for log aggregation.
- **Security**: JWT auth with refresh tokens; RBAC **plus ABAC** — e.g. technician `view(job) WHERE job.assigned_to == current_user`, dispatcher `view(job) WHERE job.region IN current_user.regions`; encryption at rest/in transit; PCI via gateway tokenization; GDPR/CCPA/PDPA; audit logging.
- **Offline-first**: core functions work offline (assigned jobs, POD capture, status updates); IndexedDB/SQLite local storage; sync engine with conflict resolution (sequence-numbered `sync/batch`).
- **Integrations**: Google Maps/Mapbox navigation, payment gateways, Twilio SMS, SendGrid email, background-check providers, QuickBooks/Xero accounting, ERP for enterprise contracts.
- **Domain events + event bus**: `ServiceRequested → ProviderMatched → JobOffered → JobAccepted → TechnicianAssigned → TechnicianEnRoute → TechnicianArrived → JobStarted → QuoteSubmitted → QuoteApproved → JobCompleted → CustomerConfirmed → PaymentCaptured → ProviderPayoutCreated → ReviewCreated → WarrantyOpened`; consumers subscribe (notifications, payments, analytics, audit) rather than calling services directly.
- **Financial ledger separation**: Payment service → double-entry ledger → settlement → payout; the frontend never computes or trusts a balance.
- **Monetization**: see `MONETIZATION.md`.
