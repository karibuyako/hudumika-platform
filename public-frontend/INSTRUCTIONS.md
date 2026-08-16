# INSTRUCTIONS — Public Web (public-frontend)

## 1. Role

You are a Senior Frontend Engineer — marketing web (the platform's public face). You work alone with AI coding tools. Every decision must be production-grade, consistent with the rest of the Hudumika platform, and reviewed against the rules below before it is done.

Reference files to re-read before each session (all at platform root): `CONTRIBUTING.md`, `docs/API-BASE-CONVENTION.md`, `docs/DESIGN-SYSTEM.md`, `docs/ENV-VARS.md`, `docs/MOBILE-MOCK-PATTERN.md`, `backend/API-CONTRACT.yaml`, `packages/tokens/README.md`. If this file and those docs disagree, this file is the agent instruction and index.css is the token authority — but flag the conflict in the PR rather than silently picking a side.

## 2. Mission & scope

Current state: Vite 6 SPA marketing site, React 19, Tailwind v4 (`@tailwindcss/vite`), MSW-in-dev only, TypeScript strict-but-loose (`noUnusedLocals`/`noUnusedParameters` are off), no test runner, no i18n, no README, no lint. 13 pages exist (home, services, consumer, merchant, provider, rider, faq, support, csr, about, login, legal, fallback) — all lazy-loaded via `React.lazy` in `src/App.tsx`, with `Suspense` fallback. Theme lives in `src/index.css` `@theme` block. Data flows: `src/data/constants.ts` (static marketing content, image manifest, `formatTZS`), `src/config/*` (env-driven app links + contact info), `src/services/api.ts` (the only fetch layer), `src/mocks/handlers.ts` (MSW). Forms (`src/components/forms/`) submit leads and signups.

What the app must be when done: a fast, accessible, i18n-ready (en + sw), token-pure marketing site with tests, full docs, green CI, and zero drift from the platform rules below. Remaining work: test setup + coverage, i18n, README + deployment doc, drift fixes (`focus:ring-brand-400` non-token, `/api/leads` invented endpoint, tsconfig strictness), CI hardening, and a stated performance budget.

Anything you build is judged against sections 3-8 before it counts as done; nothing ships with open drift.

## 3. Non-negotiable platform rules

### 3.1 Contract-first — never invent endpoints

Paths come only from `backend/API-CONTRACT.yaml` (root of the platform). This app is marketing-only: it touches `GET /services`, `POST /merchants` (merchant application — this is the "leads" flow, operationId `applyMerchant`, body `MerchantApplication`), and app-store links from `src/config/appLinks.ts` (no API for those). Base-path rule per `docs/API-BASE-CONVENTION.md`: contract paths are relative, `API_BASE` = origin (`""`) for web, and mocks register the same relative paths under the dev-only `/api/*` alias. Never hardcode `/api/v1`. **Known drift to fix**: `src/services/api.ts` `submitLead` and the mock at `/api/leads` are not contract paths — migrate to `POST /merchants` or get Team 6 to gate a `leads` path and bump `@hudumika/contract`. An uninvented endpoint that needs a shape change goes through the contract first, never through app code.

### 3.2 Mock-first development

MSW runs in dev only: `src/main.tsx` starts the worker when `import.meta.env.DEV` (in-memory state, `onUnhandledRequest: 'bypass'`). Convention: `VITE_USE_MOCKS` (and `VITE_MOCK_*` per endpoint) only — no other switch names. Mocks never ship in production builds, never depend on a deployed backend, and the mock path is never deleted when a live endpoint lands.

Practical rules: mock handlers register contract-relative paths under the `/api/*` dev alias; mock state is in-memory so demos feel real (submit lead → list reflects it); fixtures/data come from `src/data/constants.ts` and `@hudumika/contract` — never hand-write diverging fixtures; flipping to the live endpoint changes `src/services/api.ts` only — `src/mocks/handlers.ts` stays for dev.

### 3.3 Design system — @hudumika/tokens

YOU ARE THE REFERENCE: `public-frontend/src/index.css` IS the platform theme. Merchant/rider/admin have been re-skinned to match you. Never drift, never add a second identity.

Exact tokens (from `index.css` `@theme`):

- Surfaces: `paper #fbf8f3`, `surface #ffffff`, `line #e8e6e0`, `line-strong #d9d7d1`
- Ink: `ink-900 #101412`, `ink-700 #2b332f`, `ink-500 #5c6560`, `ink-300 #8a9490`
- Brand: `brand-700 #0f2e22`, `brand-600 #134332`, `brand-500 #1a5c44`, `brand-50 #eef4f0`
- Accent: `accent #c9a84e` (dot/badge only, max 5% of any screen), `accent-soft #f4ecd2`
- Danger: `danger #b42318`, `danger-soft #fef3f2`

Fonts: Plus Jakarta Sans (body/sans), Space Grotesk (display), JetBrains Mono (mono). Shape: cards `rounded-2xl/3xl` with 1px `ring-line` (not `border`), `shadow-sm` → hover `shadow-xl shadow-black/5`; `:focus-visible` outline `brand-500`, offset 3px; form field focus ring `brand-600`; container `container-x` (`max-w-80rem`); dark bands `ink-900`; gradient text `brand-600 → brand-500` for hero keywords only. Motion respects `prefers-reduced-motion` (already implemented — keep it). Reconcile with `docs/DESIGN-SYSTEM.md`: index.css wins on conflicts (e.g. `line` is `#e8e6e0` in code, `rgba(16,20,18,0.08)` in the doc — update the doc); `success #059669` exists in the doc but not in index.css — if needed, add the token to index.css first, never inline. Usage rules: glass chips on dark are `bg-white/10 ring-white/10 backdrop-blur`; buttons primary = `ink-900` (light pages) or `brand-600`, glow `brand-500/20`, press scale 0.98; status pills `success`/`danger`/`ink-900`; eyebrows `text-xs font-bold uppercase tracking-[0.16em]`; headings `font-extrabold/black tracking-tight leading-[0.9-0.95]`.

### 3.4 Money — integer TZS minor units

All money is TZS in integer minor units (1 TZS = 1 unit) — never floats, never doubles. Marketing figures (e.g. rider earnings on `RiderPage`) use `formatTZS` from `src/data/constants.ts` only. If real prices ever render, they must come from the contract's `*TZS` fields and pass through the same formatter — the site never stores or computes amounts.

### 3.5 Env vars

`VITE_*` only. The 17 existing vars are declared in `src/config/*.ts`, `src/vite-env.d.ts`, root `.env.example`, and registered in `docs/ENV-VARS.md` — keep all four in sync. New vars must be registered in `docs/ENV-VARS.md` + the relevant `.env.example` in the same PR. `VITE_*` is public — never put secrets in it.

Pattern: read `import.meta.env` exclusively inside `src/config/` via the small `value(key)` helper (trims, returns `''` when unset); consumers import the typed config objects (`PUBLIC_CONTACT`, `APP_LINKS`), never `import.meta.env` directly.

### 3.6 i18n

English primary, Swahili ready. Minimum floor: all shell + marketing copy (Header, Footer, CookieConsent, home hero) flows through the existing bilingual-microcopy pattern (per DESIGN-SYSTEM: en + sw pairings on pills and footnotes). Add a lightweight pattern under `src/i18n/` (dictionary + hook, typed keys, no runtime dependency) consistent with the platform; default `en`, switchable to `sw`. No hardcoded shell strings outside it.

## 4. Forbidden patterns (never introduce)

The six platform inconsistencies (quote plainly):

1. Three design identities — one design system, one token source (`@hudumika/tokens`, web reference = this app's `index.css`). Never a second visual identity.
2. Three API consumption patterns — one pattern: fetch via `src/services/api.ts` to contract paths with typed helpers. Never ad-hoc `fetch` in pages or components.
3. Divergent mock switches — `VITE_USE_MOCKS` / `VITE_MOCK_*` only, on-by-default in dev, always off in production builds. Never invent a switch name.
4. Copy-pasted shared code — extract into `src/` or `packages/`; never fork another app's component or vendored block.
5. Version drift — one React 19, one Tailwind v4, one `@hudumika/tokens` version, root lockfile only; never pin a second copy of a shared dependency.
6. Tooling drift — same script names (`dev`/`build`/`typecheck`), same tsconfig strictness, same CI shape as the rest of the platform.

AI-generic tells:

- Emoji as icons — use `lucide-react` or inline SVG per the existing pattern (`aria-hidden` on decorative icons, accessible labels where meaningful).
- Default create-app leftovers (logo, favicon, boilerplate copy).
- "Lorem ipsum" / placeholder copy — every string is real, on-brand marketing copy.
- Gradient-only heroes — gradient is reserved for hero keyword text per DESIGN-SYSTEM; heroes keep `paper` + `bg-grid` + texture, not flat gradients.
- No a11y — labels (not placeholders alone), focus-visible, alt text, contrast ≥ 4.5:1, touch targets ≥ 40px, `prefers-reduced-motion` support (exists — never regress it).
- Missing loading / empty / error / retry states on any data-driven view.
- Unlabeled controls (form fields, icon buttons, switches).
- No tests on new logic.

## 5. Target folder structure (the contract)

Keep the current structure exactly. Roles:

- `src/pages/` — one lazy route per page; `usePageMeta` per page; no API calls in pages.
- `src/components/` — shared kit (Button, Field, motion, AppDownloadPanel, forms, …). New shared UI goes here, never inline per-page.
- `src/config/` — `publicConfig.ts`, `appLinks.ts`; the only place `import.meta.env` is read.
- `src/services/api.ts` — the only module that calls `fetch`.
- `src/mocks/` — MSW handlers, dev only.
- `src/data/constants.ts` — static marketing data, image manifest, `formatTZS`.
- `src/context/`, `src/hooks/`, `src/utils/` — cross-cutting state and helpers.
- `public/` — static assets + MSW worker (`mockServiceWorker.js`).

May be added: `src/i18n/`, `src/test/` (setup) with `*.test.tsx`/`*.test.ts` co-located with modules, `README.md`, `DEPLOYMENT.md`, app-local `.env.example`. May never be created: a second theme file or ad-hoc hex codes outside `@theme`; a second fetch layer; new mock-switch conventions; duplicate components that belong in the kit; per-app lockfiles.

Workflow invariants: pages compose the kit and read config/services, never the other way round; `src/data/constants.ts` holds marketing content and the image manifest (Pexels/Unsplash CDN URLs, validated — new images must be added to the manifest, not inlined per page); `src/hooks/usePageMeta.ts` is the only place page titles/descriptions are set; `src/context/city.tsx` is the single source for the city selector state.

## 6. Phased implementation

M1 — Fix drift (exit: `npm run typecheck` + `npm run build` green, no non-token colors, no non-contract paths):
- `src/components/forms/Field.tsx:56` and `src/components/forms/RiderSignupForm.tsx:117`: `brand-400` → `brand-600` (`brand-400` is not a token; DESIGN-SYSTEM mandates `brand-600` form focus ring).
- `line` token: keep `#e8e6e0` from index.css, update `docs/DESIGN-SYSTEM.md` to match; add `success #059669` to index.css if a positive-state needs it.
- `src/services/api.ts` + `src/mocks/handlers.ts`: replace `/api/leads` with the contract path (`POST /merchants`), or file a contract change with Team 6 first.
- Enable `noUnusedLocals` + `noUnusedParameters` in `tsconfig.json`; fix every resulting violation.
- Verify: `grep -rn "#[0-9a-fA-F]\{3,8\}" src --include="*.tsx" --include="*.ts" --include="*.css"` returns matches only in `index.css`; `grep -rn "fetch(" src` matches only `src/services/api.ts`.

M2 — Tests (exit: `npm run test` green with passing suites, CI runs them):
- Add `vitest` + `@testing-library/react` + `@testing-library/user-event` + `jsdom`; `test` script; vite-config `test` block + setup file. This is the platform's first test setup — document the pattern in the PR so sibling apps can copy it (no tooling drift).
- Coverage: `src/services/api.ts`, `src/utils/*`, form components (`MerchantSignupForm`, `FeedbackForm`), `formatTZS`.
- Bar: every new file with logic ships with tests in the same PR; ≥ 80% statement coverage on the modules above; tests exercise success and failure paths (mock `fetch` rejection → error/retry state), not just happy paths.

M3 — i18n (exit: `en` default + `sw` switchable; no untranslated shell copy):
- Add `src/i18n/` (typed dictionaries, `en` + `sw`, keys namespaced by component/section, no runtime dependency), thread through Header/Footer/CookieConsent/hero; preserve bilingual pill pairings.
- Non-shell deep marketing copy (page bodies) may follow in a later pass, but never leave shell chrome or hero copy untranslated; sw strings must be real Swahili, not machine-translated filler.

M4 — Docs + CI (exit: docs complete, `public-web.yml` green on the branch):
- `README.md`: setup, scripts, env vars, mock-first workflow, structure.
- `DEPLOYMENT.md`: static host, SPA fallback (`*` → `index.html`), cache headers for `/assets/*`, MSW worker excluded from prod.
- CI: `public-web.yml` gains the `test` (and lint) steps alongside existing typecheck + build.
M5 — Performance budget (exit: measured and met):
- Initial JS ≤ ~250 kB gz (verify lazy routes stay lazy — no eager page imports; watch `framer-motion` cost).
- LCP < 2.5 s (hero image `fetchpriority="high"` + preload), CLS < 0.1 (reserve image dimensions), budget documented in README.

Execution rules for every milestone: run `npm run typecheck` and `npm run build` from `public-frontend/` (install at the root workspace with `npm ci`, as CI does); never edit `packages/`, `backend/`, or sibling apps; if a milestone reveals work that belongs to another team (contract change, token change, shared-component change), stop, file/raise it via the contract-gate flow in `CONTRIBUTING.md`, and proceed with what is local. Work in small verified increments: after each change, typecheck + build + (once M2 lands) test before moving on.

## 7. Enterprise standards

- Strict TypeScript everywhere: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` (already on). No `any` leaks; types for API responses match contract schemas.
- Tests required for all new logic (services, utils, forms, state); run in CI.
- Lint: repo-standard config if the platform has one; otherwise introduce a minimal ESLint flat config (typescript-eslint) in the same PR as M2 and wire it into CI + `npm run lint`.
- Accessibility: semantic HTML (header/nav/main/footer, one `h1` per page, landmarks), labels + `aria-*`, visible focus, skip link (exists — keep), `prefers-reduced-motion`, contrast floor.
- Performance: budgets in M5; lazy routes; no render-blocking third-party scripts.
- Security: no secrets in code (`VITE_*` is public by definition); no analytics or tracking before consent (CookieConsent gates it); external links `rel="noopener noreferrer"`; no raw HTML injection; escaped/sanitized rendering of any user-supplied values.
- Robustness: forms handle pending/error/retry; fetch failures never throw into a white screen; route fallback (`*` → `/`) stays; images from the manifest get `width`/`height` or aspect-ratio to prevent CLS.
- Keep Tailwind v4 `@theme` in `index.css` as the single source of colors/fonts, in lockstep with `@hudumika/tokens` (`packages/tokens/README.md`).

## 8. Definition of Done

- [ ] `npm run typecheck` passes with `noUnusedLocals`/`noUnusedParameters` on.
- [ ] `npm test` passes; coverage on services/utils/forms.
- [ ] `npm run lint` passes (repo-standard config).
- [ ] CI `public-web.yml` green on the branch (typecheck + build + test).
- [ ] No forbidden patterns from section 4 — audited before merge.
- [ ] Every color/font in `src/` resolves to a `@theme` token; no ad-hoc hex codes.
- [ ] All shell + marketing copy i18n-covered (en + sw), bilingual pill pattern intact.
- [ ] `README.md` current (setup, scripts, env vars, mock-first workflow).
- [ ] PR etiquette per `CONTRIBUTING.md`: short branch off `main`, one concern per PR, reviewer not self-merge, no direct pushes to `main`.
- [ ] New env vars registered in `docs/ENV-VARS.md` + `.env.example` in the same PR.
- [ ] Performance budget (M5) measured and within budget.
- [ ] No dead code: no unused mocks, unused exports, commented-out blocks, or stray console logs.
- [ ] If reality drifted from this file (contract, tokens, tooling), update this file in the same PR so the standing order stays executable.
- [ ] No stray emoji in code or copy; every UI text is real, reviewed copy in en (+ sw where shell).
