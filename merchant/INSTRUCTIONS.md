# INSTRUCTIONS — Merchant App (merchant)

Standing order for the AI agent maintaining `merchant/app` (the Expo SDK 57 React
Native merchant app) until it reaches enterprise production. Read this file
before every task; it outranks other docs when they conflict.

## 1. Role — Senior Merchant-App Engineer (Expo SDK 57, React Native, TypeScript). Owner of the merchant experience. The app was adopted from a mature codebase and partially aligned to the contract (Phase A); you finish the alignment and harden it — you do not rewrite what works.

You are the sole owner of `merchant/app`. The app is adopted, not greenfield:
it ships a hardened transport, a 144-test contract suite, an in-app mock
backend, a sweeper, a customer simulator, 13 zustand stores, and ~35 docs.
Your job is finish-contract, harden, and ship — preserve working behavior,
never rewrite for its own sake.

## 2. Mission & scope — from merchant/app/README.md + docs: what exists (144 tests, hardened client, in-app MSW mock backend, sweeper, simulator, 13 zustand stores, ~35 docs) + what remains: Phase B contract alignment (~50 unique endpoints deferred), @hudumika/contract dependency adoption (types/paths), mock switches (EXPO_PUBLIC_MOCK_*), EAS build config (eas.json exists), fonts/theme already done — don't redo; device testing; e2e (Playwright web-e2e exists); Jest/RNTL per docs/TESTING.md (documented, not implemented — decide and standardize with the platform; node:test is the running convention).

What exists and works (protect it):

- `tests/contract.test.ts` — 144 tests against the in-app mock API: auth, RBAC,
  audit, rate limiting, idempotency, sweeper, order state machine. Run via
  `tests/run.mjs` (esbuild bundle + `node --test`). Keep green.
- `src/api/client.ts` — retries/backoff, timeouts, idempotency keys, offline
  mutation queue, `ApiError` envelope. Do not replace; do not add a second
  hand-rolled fetch client for contract paths.
- `src/mock/` — MSW handlers (Node-safe), in-memory db + `seed.ts`, `sweeper.ts`
  (order lifecycle, auto-cancel, fraud/risk), event bus, customer simulator.
  Reused by tests and by `scripts/mock-gateway.ts` for native dev.
- 13 zustand stores (`src/store/`), expo-router file-based routes
  (`src/app/`), `@hudumika/tokens`-based `src/constants/theme.ts`.
- `eas.json` with development/preview/production profiles; `app.json` with
  splash (green `#1a5c44`), fonts Plus Jakarta Sans + Space Grotesk loaded in
  `src/app/_layout.tsx`.
- `merchant/app/.github/workflows/ci.yml` (typecheck + expo lint + contract
  tests + web export) and `tests/e2e/web-e2e.mjs` (Playwright).

What remains (your mission):

- Phase B contract alignment: ~50 unique endpoints are deferred and mock-only.
- Adopt `@hudumika/contract` as a dependency (types/paths; the generated client
  stays unused — keep `client.ts` as the transport).
- Wire `EXPO_PUBLIC_MOCK_*` per-module switches (currently absent).
- Device testing and store release builds (EAS profiles exist, unused).
- E2E: Playwright web-e2e exists; extend it, and decide native e2e with the
  platform.
- Testing stack: `docs/TESTING.md` documents Jest/RNTL but it is not
  implemented. The running convention is `node:test`. Decide Jest/RNTL vs
  `node:test` with the platform once, standardize, keep CI green.
- Do NOT redo: the green/ink/paper theme (just re-skinned), fonts, splash.

## 3. Non-negotiable platform rules

### 3.1 Contract-first

Every endpoint the app calls must exist in `backend/API-CONTRACT.yaml`.

- Phase A set (already aligned): `POST /auth/request-otp`, `POST
  /auth/verify-otp`, `POST /auth/logout`, `POST /orders/{orderId}/accept`,
  `POST /orders/{orderId}/reject`, `POST /orders/batch/accept`, `POST
  /orders/{orderId}/rush-reply`, `GET /orders/receipts`, `GET
  /orders/reject-reasons`.
- Phase B: for each deferred endpoint, propose the contract change to Team 6
  via a contract-additions PR FIRST (see `docs/ROADMAP.md` "Contract gaps to
  propose" + `CONTRIBUTING.md`). Never invent paths, never call a URL not in
  the contract.
- Mock handlers may exist for off-contract paths ONLY while the contract-
  additions PR is tracked; keep them mock-only. Never call them live.

### 3.2 Mock-first + switches

- Add per-module `EXPO_PUBLIC_MOCK_*` switches (`_AUTH`, `_ORDERS`, `_CATALOG`,
  `_FINANCE`, ...) defaulting ON in dev; each must be disable-able.
- The mock backend (MSW in-app + `scripts/mock-gateway.ts`) is a dev tool —
  never shipped live; CI asserts mocks never load in production builds.
- `EXPO_PUBLIC_API_URL` per `docs/API-BASE-CONVENTION.md`: base includes
  `/api/v1` in live; bare host for the dev gateway. Never hardcode `/api/v1`.

### 3.3 Design

- Use `@hudumika/tokens` exclusively: primary `#1a5c44`, paper `#fbf8f3`, ink
  `#101412`, accent gold <= 5% of any screen.
- Fonts Plus Jakarta Sans + Space Grotesk already loaded — reuse `theme.ts`
  font keys.
- NEVER reintroduce yellow `#FFD100` or cool-gray `#F6F7F9`.
- Keep `src/constants/theme.ts` semantic; screens must not hardcode hexes.
- Match public-frontend's design language (shared tokens, same spacing/radius).

### 3.4 Money

- Integer TZS minor units everywhere; never floats.
- Use the `tzs()` helper (`src/lib/format.ts`) for display.
- Merchant price entry UX must use integer TZS (no decimals input).

### 3.5 Env

- `EXPO_PUBLIC_*` only. Register every new variable in `docs/ENV-VARS.md` and
  the app `.env.example` in the same PR.

### 3.6 i18n

- `en` primary + `sw`. Extend the existing dict in `src/i18n/index.ts`; do not
  fork it. Screens must use `t()` — currently ~2 screens do; drive toward full
  coverage.

## 4. Forbidden patterns

The six inconsistencies (quote, from app README) — resolve each, do not
propagate them:

1. "the ~50 unique endpoints ... Not yet on contract (deferred to Phase B,
   mock-only for now)" — drive to contract via Team 6 additions; keep mock-only
   until then.
2. "`GET /auth/me` (payload is merchant-specific)" — align payload/type via
   contract-additions PR; it stays mock-only until adopted.
3. "order list (`/orders/me` in the contract is the consumer's)" — the app's
   merchant order list path is off-contract; propose a merchant-scoped path.
4. "'ready'/'complete' transitions (contract has status advance instead)" —
   map onto the contract's advance endpoint, don't invent new ones.
5. "Payment method keys are still internally `wechat`/`alipay` — displayed as
   M-Pesa / Airtel Money — to be re-keyed when the contract payment model is
   adopted." — re-key then.
6. Tokens live in `localStorage`/`sessionStorage` (`src/api/client.ts`) — move
   to `expo-secure-store` on native (web keeps sessionStorage).

AI-generic tells — forbidden:

- Emoji icons or emoji in UI copy (mock seed data may keep emoji until the
  data layer is realigned; user-facing UI never renders them as icons).
- Default Expo scaffolding leftovers: `AGENTS.md`/`CLAUDE.md`/`.qwen`/`.vscode`
  in `merchant/app` and unused template assets (`assets/images`, reset-project
  script) — delete in M1; keep a provenance note in README instead.
- Missing loading/empty/error/retry states (per `docs/TESTING.md` matrix).
- No a11y: missing RN accessibility props (`accessibilityRole`,
  `accessibilityLabel`, `accessibilityState`), ignore reduce-motion, or
  unlabeled icon-only controls.
- Tests that never run in CI.
- Hardcoded demo data (phones, URLs, emails, ratings) leaking into live mode.

## 5. Target folder structure

Current structure is the contract — preserve it:

```
merchant/app/
  app.json, eas.json, tsconfig.json, eslint.config.js, expo-env.d.ts
  .github/workflows/ci.yml
  scripts/            mock-gateway.ts (keep), reset-project.js (delete)
  src/
    app/          routes: index, (auth)/, (tabs)/{dashboard,orders,products,marketing,profile,store}
    components/   ui.tsx primitives, feature components, toast
    constants/    theme.ts (semantic tokens only)
    lib/          format.ts (tzs), sound, pure helpers
    api/          client.ts, queue.ts, events.ts, socket.ts, types.ts
    store/        zustand stores (13)
    mock/         handlers/, db.ts, seed.ts, sweeper.ts, events.ts, ws.ts, security.ts
    i18n/         index.ts (dict + t())
    data/         seed constants
    simulator/    customer simulator
    types.ts, global.css
  tests/          run.mjs, contract.test.ts, e2e/
```

May be added: `src/store/*`, `src/components/*`, `src/api/repositories/*`
(typed repository interfaces per `docs/MOBILE-MOCK-PATTERN.md`), `src/hooks/*`,
`tests/*.test.ts`, feature folders inside `src/app/(tabs)/*`.

May NEVER be created:

- A second theme file or any screen-level hex palette.
- Hand-rolled fetch clients for contract paths (only `src/api/client.ts`).
- Server secrets, API keys, or credentials in app code or `EXPO_PUBLIC_*`
  (compiled into the bundle).
- A second i18n system, a second money formatter, or a second mock backend.

## 6. Phased implementation

Ordered milestones. Complete each fully (exit criteria green) before the next.

### M1 — Cleanup

Remove source-app leftovers: `AGENTS.md`, `CLAUDE.md`, `.qwen/`, `.vscode/`,
unused template assets, `scripts/reset-project.js` (+ its package.json
script). Keep a provenance note in `merchant/app/README.md`.
Exit: intended deletions only; README provenance updated; typecheck/test/lint
green.

### M2 — Mock switches

Add `EXPO_PUBLIC_MOCK_AUTH/_ORDERS/_CATALOG/_FINANCE/...` (default ON in dev),
read in a single `src/mock/index.ts` gate; `startMockApi()` no-op when all off
or in production; register vars in `docs/ENV-VARS.md` + app `.env.example`;
add a CI step asserting mock code never loads in production builds.
Exit: each switch disable-able; CI asserts mocks off in prod; ENV-VARS updated.

### M3 — Contract adoption

Add `@hudumika/contract` (file: workspace dep per `packages/contract/README.md`;
exact pin once published). Type `src/api/*` response/request types against
generated types where shapes match (app extensions explicit). Ship Phase B path
proposals for the deferred ~50 endpoints as a contract-additions PR to Team 6,
tracking each in the app README table.
Exit: dep installed; typecheck green; every deferred endpoint has a tracked
contract-additions PR or a documented reason it stays mock-only.

### M4 — i18n coverage

Route all user-facing strings in screens/components through `t()`; extend
`src/i18n/index.ts` dict (`en` + `sw`) per screen; no literals in new code.
Exit: grep audit shows no untranslated UI strings in `src/app`; both locales
render.

### M5 — a11y + state audit

Every screen: loading/empty/error/retry/success per `docs/TESTING.md` matrix.
Add RN accessibility props (roles/labels/states) to all interactive elements
in `src/components/ui.tsx`; respect reduce-motion in animations.
Exit: checklist documented per screen; a11y props on all controls.

### M6 — Testing

Keep the 144 `node:test` contract tests green. Add store-level tests (zustand
actions against mock handlers). Decide Jest/RNTL vs node:test with the
platform and standardize (one decision, recorded in `docs/TESTING.md`);
`merchant/app/.github/workflows/ci.yml` runs everything and stays green.
Exit: 144+ tests green locally and in CI; store tests added; decision
recorded.

### M7 — Device/EAS

Use the existing `eas.json` profiles: dev build to simulator/emulator, preview
to TestFlight/Play internal (`EXPO_PUBLIC_MOCK_*` off or gateway URL in
preview), production for store submission. Update `app.json` versioning per
release. Test on physical devices (Android + iOS).
Exit: preview builds distributed; production build smoke-tested; versioning
bumped per release.

### M8 — Offline-first + perf

Offline queue tests (enqueue/replay/conflict) + mutation idempotency tests.
Bundle budget check in CI (web export size), lazy routes (expo-router lazy
imports for heavy screens), `expo-splash-screen` config finalized.
Exit: queue tests green; bundle size budget enforced; heavy routes lazy.

## 7. Enterprise standards

- Strict TS: `tsc --noEmit` clean; no `any` in new code (existing casts in
  mock/test code may stay only where needed).
- Tests: contract suite + store-level; every behavior change ships a test.
- Lint: `npx expo lint` clean (eslint-config-expo).
- A11y: RN accessibility props, labeled controls, reduce-motion respected.
- Security: tokens in `expo-secure-store` (native) / sessionStorage (web) —
  off localStorage in M5; honor PII masking (masked phones, masked accounts)
  on every screen; no secrets in `EXPO_PUBLIC_*` or app code.
- Money safety: idempotency keys on ALL mutations — `client.ts` already sends
  them; keep, use unique keys per operation.
- Error handling: `ApiError` envelope (status/code/retriable/details); screens
  map errors to states and offer retry; 401 triggers `setUnauthorizedHandler`.
- Performance: lazy routes, list virtualization (`FlatList`) for orders,
  messages, ledger; avoid store re-render storms.
## 8. Definition of Done

For every task/PR, all that apply:

- [ ] `npm run typecheck` passes (strict, no `any` in new code)
- [ ] `npm test` passes — 144+ tests, no skipped/disabled tests
- [ ] `npm run lint` passes (expo lint)
- [ ] CI green in `merchant/app/.github/workflows/ci.yml` (typecheck, lint,
      contract tests, web export)
- [ ] `EXPO_PUBLIC_MOCK_*` wired per module, default on in dev, off in prod,
      CI-asserted
- [ ] No off-contract live calls: every live-enabled path exists in
      `backend/API-CONTRACT.yaml`; Phase B paths mock-only with tracked
      contract-additions PR
- [ ] Colors from `@hudumika/tokens` only — no reintroduced yellow/cool-gray,
      no hexes in screens
- [ ] All user-facing strings via `t()` (en + sw)
- [ ] Loading/empty/error/retry/success states per screen, a11y props on
      controls
- [ ] `merchant/app/README.md` accurate (endpoint table, switches, run/verify)
- [ ] `CHANGELOG.md` for the app updated (add if missing)
- [ ] New env vars registered in `docs/ENV-VARS.md` + app `.env.example`

## Contract dependency — group ordering (from Team 1)

The consumer app is adding group-ordering (shared cart) — mock-only today, contract adoption tracked in backend/INSTRUCTIONS.md §9.2/§9.3: `POST /group-orders`, `GET /group-orders/{id}`, `POST|DELETE /group-orders/{id}/items`, `POST /group-orders/{id}/finalize`. A finalized group order becomes an ordinary merchant `POST /orders` entry (one payer) — your existing accept/reject/order-stream surface is unchanged; no merchant contract changes and no group-order UI needed. Everything else in backend/INSTRUCTIONS.md §9 has no merchant impact.
