# Hudumika Merchant — merchant operations app (Expo)

Merchant-facing mobile/web app of the Hudumika platform: order acceptance, store
management, menu, promotions, finance, analytics, team & roles, and risk review.

## Origin & status

- Adopted from an existing Expo merchant app (Expo SDK 57 / RN 0.86 / expo-router
  / zustand / MSW 2.15). Source of truth snapshot lives at
  `/home/devagent/Desktop/step` (kept untouched as backup).
- **Source-app leftovers removed (M1):** `AGENTS.md`, `CLAUDE.md`, `.qwen/`,
  `.vscode/`, `.claude/`, the `reset-project` script and unused Expo template
  assets (`react-logo*`, `expo-badge*`, `expo-logo`, `logo-glow`,
  `tutorial-web`, `tabIcons/`) were deleted; only assets referenced by
  `app.json` remain. See the "Origin" line above for provenance.

- **Phase A (Hudumika integration) applied:** identity/locale sweep (TZ, TZS, en+sw),
  auth flow aligned to the Hudumika contract (`/auth/request-otp` +
  `/auth/verify-otp`, requestId + code, mock dev code shown in UI), the
  accept-batch order path renamed to the contract's `/orders/batch/accept`, a
  native mock gateway added, and the test runner made space-safe.
- Contract alignment is **path + payload-shape level** (see table below). The app
  keeps its hardened local transport (`src/api/client.ts`: retries/backoff,
  timeouts, idempotency keys, offline mutation queue) instead of the generated
  contract client — the generated orval client does plain relative `fetch` and
  cannot target the mock gateway base URL from native.
- **Phase B deferred endpoints resolved:** the ~50 mock-only endpoints tracked
  in [`../docs/CONTRACT-ADDITIONS.md`](../docs/CONTRACT-ADDITIONS.md) were
  adopted onto contract paths through the drift-elimination waves; legacy mock
  paths stay registered as dev aliases (per-group resolution tables live in
  that doc). The known inconsistencies (merchant session via
  `GET /merchants/me`, merchant order list, status-advance transitions) were
  resolved on contract paths.

## Phase B — deferred endpoints (resolved)

All Phase B deferred groups were resolved through contract adoption and the
drift-elimination waves — every merchant-scope operation in
`backend/API-CONTRACT.yaml` is now covered (handlers + tests + screens).

**Operations coverage: 217/217 merchant-scope operations; 497 tests across 26
suites.** The per-group resolution tables (contract path, legacy alias,
status) live in `../docs/CONTRACT-ADDITIONS.md`; legacy mock paths stay
registered as dev aliases behind the `EXPO_PUBLIC_MOCK_*` switches.

Implemented phases: **P0–P8c** — P6b–P6e and P8/P8b/P8c shipped in full, P7
(Arabic locale + RTL) shipped. The unserved remainder of the 580 operations in
`backend/API-CONTRACT.yaml` belongs to other app surfaces (admin/riders/
providers/customer) and is out of merchant scope.

## Contract-aligned endpoints

| App path (via `client.ts`, `/api` prefix) | Contract |
| --- | --- |
| `POST /auth/request-otp` `{channel,destination,purpose}` → `{requestId, expiresInSeconds, debugCode, demo}` | `POST /auth/request-otp` (debugCode/demo are mock-only extensions) |
| `POST /auth/verify-otp` `{requestId, code, purpose}` → `{accessToken, refreshToken, me}` | `POST /auth/verify-otp` (`me` is the merchant-app extension; `purpose` is an extension) |
| `POST /auth/logout` | `POST /auth/logout` |
| `POST /orders/{id}/accept` | `POST /orders/{orderId}/accept` |
| `POST /orders/{id}/reject` | `POST /orders/{orderId}/reject` |
| `POST /orders/batch/accept` | `POST /orders/batch/accept` |
| `POST /orders/{id}/rush-reply` | `POST /orders/{orderId}/rush-reply` |
| `GET /orders/receipts` | `GET /orders/receipts` |
| `GET /orders/reject-reasons` | `GET /orders/reject-reasons` |

## Run

```bash
npm install
npx expo start          # web: press w (MSW serves the API in-browser)
npm run mock:gateway    # native dev: mock API server on :3001 (same MSW handlers)
EXPO_PUBLIC_API_URL=http://<lan-ip>:3001 npx expo start   # point a device at the gateway
```

Demo account: `+255700000000` — an SMS code is issued by the mock and shown on
the login screen.

## Verify

```bash
npm run typecheck       # tsc --noEmit (app code; tests/ and scripts/ excluded)
npm test                # bundles tests with esbuild, runs node --test (497 tests)
npm run lint
```

- Test runner: `tests/run.mjs` (esbuild + `node --test`); suites: contract
  (`tests/contract.test.ts`, 144 tests — full mock API incl. auth, RBAC, audit,
  rate limiting, idempotency, sweeper), store (`tests/store.test.ts`, zustand
  actions against the mock), queue (`tests/queue.test.ts`, offline queue +
  idempotency), per-phase suites (dine-in, group-buy, loyalty, promotions,
  p6d-gaps, p6e-analytics, w0a, orders-gaps, catalogue-ext, supply-chain,
  webhooks-tasks, staff-ops, engagement, reports-crm, finance-ext,
  store-settings, catalogues-merchants, contract-aliases), drift suites
  (drift-catalogues/orders/store/marketing), i18n (`tests/i18n.test.ts`, locale
  parity), bundle budget (`tests/bundle-budget.mjs`, run after web export).
- Note: `tests/.build` and `scripts/.build` are generated bundles, gitignored.

## Mock switches

Per-module `EXPO_PUBLIC_MOCK_*` switches (all default ON in dev; set `false` to
route that module to the live API), gated in `src/mock/switches.ts`:

`EXPO_PUBLIC_MOCK_AUTH` · `_ORDERS` · `_CATALOG` · `_CATALOGUES` · `_MERCHANTS` ·
`_FINANCE` · `_BI` · `_MARKETING` · `_PROMOTIONS` · `_GROUP_BUY` · `_MESSAGING` ·
`_NOTIFICATIONS` · `_OPS` · `_STORE` · `_LOYALTY` · `_DEVICES` · `_CATALOGUE_EXT` ·
`_CHAIN` · `_SUPPLY_CHAIN` · `_WEBHOOKS` · `_TASKS` · `_STAFF_OPS` · `_REPORTS` ·
`_ANALYTICS_EXT` · `_PRINT_JOBS` · `_ALL` (master). Mocks never load when `EXPO_PUBLIC_ENVIRONMENT=production` or when every switch is off —
CI asserts the production export contains no mock runtime marker. See
`docs/ENV-VARS.md` and `.env.example`.

## Dev conventions

- `src/mock/` is the in-app mock backend: MSW handlers, in-memory db + seed,
  sweeper (order lifecycle + fraud/risk), event bus, customer simulator.
  Node-safe (no browser globals) so tests and the gateway reuse it.
- Web dev: MSW service worker intercepts same-origin `/api/*`.
  Native dev: `scripts/mock-gateway.ts` runs the same handlers behind a plain
  Node HTTP server; `client.ts` prefixes `EXPO_PUBLIC_API_URL` (empty on web).
