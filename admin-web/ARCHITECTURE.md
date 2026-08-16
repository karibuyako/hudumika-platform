# HUDumika Admin Web — Architecture

React + Vite + TypeScript, matching the public web stack so the design system and component conventions carry over.

## Repository layout

```text
admin-web/
├── src/
│   ├── main.tsx / App.tsx
│   ├── auth/                # login, MFA, session provider, guards
│   ├── api/                 # typed client generated from the contract
│   ├── modules/             # one folder per module (MODULES.md)
│   │   ├── overview/
│   │   ├── customers/
│   │   ├── merchants/
│   │   ├── providers/
│   │   ├── riders/
│   │   ├── cities/
│   │   ├── catalogue/
│   │   ├── orders/
│   │   ├── bookings/
│   │   ├── dispatch/
│   │   ├── payments/
│   │   ├── reviews/
│   │   ├── support/
│   │   ├── promotions/
│   │   ├── content/
│   │   └── audit/
│   ├── components/          # table, filter bar, detail drawer, stepper modal, masked field
│   ├── lib/                 # formatting (TZS, dates), permissions hook
│   ├── i18n/
│   └── styles/
├── public/
└── vite.config.ts
```

## Key conventions

| Concern | Approach |
| --- | --- |
| Data fetching | React Query (server cache, retries, refetch intervals for overview/dispatch) |
| Global state | Zustand for UI state (filters, drawer state) only |
| Routing | react-router with staff-role guards; route meta carries required role |
| Tables | Shared data table: server-side cursor pagination, column config, row actions, export button |
| Detail views | Drawer panels with the entity timeline (events) and action buttons |
| Mutations | Optimistic off; show loading → success/error toast; reason input on money/status/moderation actions |
| Masking | `MaskedField` component — unmask button only when permission grants it |
| API client | Generated from `backend/API-CONTRACT.yaml` (same source as every client) |
| MSW | Dev-mode mocks matching the contract; MSW parity tests |

## Environments

- `VITE_ADMIN_API_URL` per environment; never hardcoded.
- Separate staging vs production hostnames; staging uses staging admin API with seeded data.
- Feature flags: route-level flags for modules not yet backed by the API.

## Non-goals

- No marketing pages, no public routes, no payment processing.
- No direct DB access — everything through `/admin/*` API.
