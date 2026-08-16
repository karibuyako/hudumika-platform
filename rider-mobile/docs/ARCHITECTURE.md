# HUDumika RIDER — Architecture

## Project layout (Expo managed)

```text
rider-app/
  app.json / app.config.ts      # EAS config, scheme, plugins
  src/
    api/                        # typed client generated from API-CONTRACT.yaml
      client.ts                 # fetch wrapper: base URL, bearer auth, retries
      endpoints.ts              # one function per operationId
      types.ts                  # generated request/response types
      errors.ts                 # ErrorResponse → typed screen errors
    state/
      auth/                     # session, refresh, role-scoped token
      rider/                    # RiderPrivate, online state
      notifications/            # push registration, unread badge
    navigation/
      RootNavigator.tsx         # auth gate + role switch
      HomeNavigator.tsx         # tabs
      DeliveryNavigator.tsx     # assignment/delivery stack
    screens/                    # one folder per screen
      auth/                     # OTP entry
      onboarding/               # application, documents, verification status
      home/                     # online toggle, active deliveries
      assignment/               # offer accept/reject
      delivery/                 # detail, pickup, navigation, proof
      earnings/                 # summary, statement, payouts
      notifications/
      support/                  # tickets
      settings/                 # profile, zone, vehicle, notifications prefs
    components/                 # design-system kit (DESIGN-SYSTEM.md tokens)
    i18n/                       # en, sw, ar catalogs + locale helpers
    hooks/
    theme/                      # colors, typography, spacing tokens
  msw/                          # handlers mirroring backend/API-CONTRACT.yaml
  __tests__/                    # jest unit + RNTL component tests
  e2e/                          # Detox scenarios
```

## Navigation map

```text
RootNavigator (auth gate)
├── SignedOut
│   └── OTP flow            POST /auth/request-otp → verify-otp → Session
├── Onboarding (unapproved rider)
│   └── Application → Documents → Verification status screen
└── Home tabs (approved rider)
    ├── Home      online toggle + active deliveries (max 3)
    ├── Earnings  summary, statement, payout history
    ├── Notifications
    ├── Support   ticket list/create/detail
    └── Settings  profile, deliveryZone, vehicle, preferences, logout
        └── (push) Delivery stack pushed over tabs:
            OfferModal (accept/reject, 120 s countdown)
            → DeliveryDetail → PickupConfirm → NavToMerchant → NavToCustomer
            → ProofOfDelivery → DeliveredSummary
```

- Deep links: `hudumika-rider://order/{orderId}`, `ticket/{ticketId}`, `payout` (from `Notification.deepLink`).
- Role switch (`GET /users/me/roles`): full session re-verify (`purpose: verify_role`), then a fresh role-scoped session; never reuse rider state in another role.

## State management

| State | Owner | Notes |
| --- | --- | --- |
| Session (access/refresh) | SecureStore (expo-secure-store) + in-memory context | Access token 15 min; refresh 30 days, rotation on every refresh |
| `RiderPrivate` | TanStack Query, `queryKey: ['rider', 'me']` | `verification`, `online`, `rating`, `deliveryZone` |
| Online state | TanStack Query mutation + cache | `PUT /riders/me/availability`; reflect server `online` truth |
| Active deliveries | TanStack Query `orders/me?status=rider_assigned,picked_up,delivering` + push invalidation | Reassigned/cancelled orders must disappear on push event |
| Assignments | Push event `order.rider_assigned` → offer modal state | 120 s window from push payload; local countdown |
| Unread count | Notifications query `unreadOnly=true` | Invalidate on mark-read and push |

Server-state with TanStack Query for everything fetched; local UI state only for ephemeral things (countdowns, form drafts, photo proof). Order status transitions never cached optimistically — apply the returned `Order` object from the 200 response.

## API client

- Base URL from `EXPO_PUBLIC_API_URL` (staging/prod). Never hardcoded.
- Auth header `Authorization: Bearer <accessToken>`; single interceptor refreshes on 401 via `POST /auth/refresh` (queued, one at a time), retries once with the new token.
- Error surface: `ErrorResponse` shape `{ code, message, requestId }`; `ValidationResponse` adds `errors[]`. Map `code` → local copy; always show `message`; `requestId` is available for support tickets.
- Mutations send an idempotency key header where the contract requires it; other mutations may reuse keys on retry (per ROADMAP standing rule 3).
- Timestamps are UTC ISO 8601; render local time.

## Environment config

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | API base (`/api/v1` paths are appended) |
| `EXPO_PUBLIC_ENV` | `development` / `staging` / `production` |
| `EXPO_PUBLIC_MSW_ENABLED` | enable mock API in dev |
| `EXPO_PUBLIC_MAPS_SCHEME` | deep-link scheme for navigation apps |

In dev, MSW is enabled by default when `EXPO_PUBLIC_MSW_ENABLED=true`; handlers mirror `backend/API-CONTRACT.yaml` exactly (see TESTING.md). No local caching of payouts/orders beyond TanStack defaults.

## Background location strategy (delivery flow)

- While delivering (`picked_up`/`delivering`): use `expo-location` with `LocationTask` (background, `accuracy: Balanced`, `timeInterval`/`distanceInterval` tuned to battery) uploading rider position via `POST /riders/me/location`; the server publishes it via `GET /orders/{orderId}/track` for the customer.
- Live location reporting loop: samples include `activity` (`stationary | walking | cycling | driving`) from device activity recognition; the loop pauses while `stationary` (battery), resumes on movement; `LOCATION_RATE_LIMITED` → drop sample and back off (interval doubles), `LOCATION_INVALID` → discard and re-arm the sensor. Latest row feeds `rider_locations` → dispatch ETA + customer tracking (DATA-MODEL.md).
- Foreground-only location is enough for the rest of the app; request background permission only after explaining why (pickup → drop-off tracking).
- When the last active delivery completes or the rider goes offline, stop the background task explicitly.
- System location updates stay client-side; the ETA the customer sees comes from `TrackingEvent.estimateMinutes` (dispatch estimates), never computed on-device.

## Offline viewing of assigned orders

- Follows the backend offline contract (ARCHITECTURE.md): a capped offline queue (200 items) enqueues POST/PATCH while offline and replays FIFO on reconnect; 409/404/403 drop, 5xx retry later, UI shows queue depth — upgraded by the Phase-3 sequence-numbered sync engine below.
- Assigned orders are viewable offline from the last-fetched `orders/me` cache (cards + details render from cached `OrderDetail`); all mutating actions (status advance, POD, SOS) are disabled with an "offline — reconnect to act" state until the queue replays.

## Offline-first sync engine (Phase 3)

- Queue: every mutation (`order_status`, `pod`, `location`, `safety_event`, `cod_cash`) enqueues locally with a monotonic `seq`; the queue is capped (200 events) and FIFO.
- Upload: `POST /riders/me/sync/batch` `{events[≤500], idempotencyKey}` → `{accepted, rejected[], highWaterMark}` — drop local events `≤ highWaterMark`, retry `rejected[]` per `seq`/`code`; `SYNC_BATCH_INVALID` (422) → re-encode the batch; `SYNC_SEQUENCE_GAP` → resend the missing span. `GET /riders/me/sync/status` reports `highWaterMark`, `pendingCount`, `lastSyncedAt`, `gaps[]`.
- Triggers: background sync on reconnect, app foreground, and 5–10 s throttled location pings while online (`LOCATION_RATE_LIMITED` → back off); data compression (gzip/batched payloads) applies to sync bodies (planned, backend Phase-2 lane, ROADMAP.md).
- UI: pending-count badge from `SyncStatus.pendingCount`; `sync.completed` (in-app) toast when the backlog flushes (NAVIGATION.md). Replays never mutate server-owned state locally — status transitions apply the returned `Order` after each accepted event.

## Deep-pass infrastructure (LIVE)

- **Data saver (maps)**: `RiderPreferences.wifiOnlyMaps` (default `false`) — when enabled, map tile fetches are deferred until a Wi-Fi connection is available (a "Data saver — maps on Wi-Fi" banner shows on tile-fetch attempts over cellular); route/offer data (JSON) is unaffected, only raster tiles are throttled. The preference persists via `PUT /riders/me/preferences` (DISPATCH-FLOW.md) and applies app-wide to map surfaces.
- **Push outbox (backend delivery queue)**: the backend delivers pushes through the `push_outbox` table (`pending | sent | failed`, `backend/DATA-MODEL.md`) with a worker that retries failed sends with backoff — the app's push handler is unchanged; `pending` rows are delivered when the worker retries. The rider app never retries pushes itself; persistent `failed` rows alert ops server-side.
- **Offline chat queue**: chat messages enqueue while offline as `chat_send` actions in the local queue (`src/lib/offline-queue.ts` blueprint pattern: `actionType: chat_send` with `clientActionId`) and replay through `POST /riders/me/sync/batch` on reconnect (the server-side `offline_actions` durable inbox, `actionType` incl. `chat_send`, deduplicates by `clientActionId`; `applied | duplicate` are dropped, others retried). The chat thread renders the queued message with a pending state and flips to sent on `applied`; a rejected `chat_send` surfaces an inline error with the draft kept.

## On-device AI (Phase 3)

- Edge models run on-device and work offline: fatigue detection (front-camera frames — consent-based, SECURITY.md) and POD image verification + guided capture (planned, `backend/ROADMAP.md` M10b). On-device results become `SafetyEvent`/POD submissions through the contract surfaces; raw frames never leave the device (SECURITY.md).
- Honesty rule per `backend/AI-LAYER.md`: contract fields are live, model quality is backend-tracked, telemetry-based features are planned.

## Planned (post-P10)

- In-app navigation (turn-by-turn) — planned; today navigation opens the installed maps app via `EXPO_PUBLIC_MAPS_SCHEME` (DELIVERY-FLOW.md).
- Hotspots / heatmap of delivery demand over time — planned; needs a contract addition (demand analytics for riders).

## Delivery flow state machine (UI)

`rider_assigned` → `rider_arrived_pickup` → `picked_up` → `delivering` → `rider_arrived_dropoff` → `delivered` — each step calls `POST /orders/{orderId}/status` with exactly that `status` value (plus optional `note`); `completed` follows `delivered` server-side. Exceptions branch at `delivering`: `failed_delivery` → `returning` (via `POST /orders/{orderId}/failed-delivery`) and `rescheduled` (via `POST /orders/{orderId}/reschedule`); POD is submitted via `POST /orders/{orderId}/proof-of-delivery` before `delivered`. The screen renders the server-returned `Order`; a `409 Conflict` (transition rejected, e.g. `FAILED_DELIVERY_NOT_ALLOWED`) surfaces a message and refetches the order. All other statuses (`preparing`, `merchant_accepted`, `cancelled`, `completed`, `disputed`) render as read-only context, never as transitions the rider can trigger.

## Theme system (light/dark toggle)

`src/theme/` holds the design tokens (colors, typography, spacing). The theme toggle (dark/light) is a design-system concern: tokens resolve from the active theme — system default, user override persisted locally — and every screen renders tokens only, never per-screen color literals. The theme is a local UI preference: it is not a server setting, never alters contract values, and stays separate from i18n (LOCALIZATION.md).

## Modular architecture (feature-first)

```text
src/features/<feature>/
  screens/      # feature screens (NAVIGATION.md)
  api.ts        # feature slice of the typed API client
  state.ts      # feature TanStack Query hooks + store
  msw.ts        # feature MSW handlers (contract parity)
  __tests__/    # feature unit + component tests
```

- Each feature owns its screens, API slice, state store, MSW handlers, and tests; cross-feature access goes through the shared `api/` client and `state/` contexts (code-ownership boundary per folder). MSW-per-feature parity keeps modules independently testable: a feature's tests and dev mocks run against its own handlers plus the shared ones — a contract change fails that feature's suite, not the whole app.
- The backend mirrors this: bounded contexts (riders, dispatch, orders, payments, notifications) deploy independently as microservices (`backend/ARCHITECTURE.md`); the app's client is per-context, so one bounded-context deploy never blocks another feature's build.

## Background services

- GPS loop: a background `LocationTask` samples every 5–10 s while delivering (battery-aware, pauses while `stationary`/offline, re-arms on movement — "Background location strategy" above). Sync engine wake triggers: connectivity change, app foreground, and a timed interval (throttled location pings while online); each wake flushes `POST /riders/me/sync/batch` and refreshes `pendingCount`.
- Push wake: offers arrive as push/in-app events (`order.rider_assigned`) and open the OfferModal via deep link, including from a backgrounded/killed app. Crash/error reporting: Sentry-style integration is planned (named in DEPLOYMENT.md and ROADMAP.md); until it ships, `requestId` + `ErrorResponse` logging is the diagnostic surface.
- OS constraints: Android runs the GPS loop inside a foreground service while online/delivering; iOS uses background location behind the system's authorization prompt. Both platforms may suspend background work — the app re-syncs on the next wake instead of failing.
