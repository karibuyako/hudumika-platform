# HUDumika Public Web — Comprehensive Build Plan

**Project:** `@hudumika/public-web` v2 (rebuild)
**Location:** `/home/devagent/2/new-public_web`
**Status:** Approved (all decisions locked)
**Model:** Meituan hub-and-spoke routing + DoorDash conversion patterns

---

## 1. Vision & Goals

HUDumika is a Tanzanian on-demand delivery and services platform ("Your city, delivered") with four audiences: **Consumer**, **Merchant**, **Service Provider** (home services: plumbing, electrical, cleaning, repairs, beauty, moving…), and **Rider**. The public web is the **single front door** for all audiences:

- A visitor lands on the **home hub**, chooses their path, and is **redirected to the audience's own public web page** (`/services`, `/consumer`, `/merchant`, `/provider`, `/rider`).
- Each portal markets its product, captures **signup leads via forms**, and **funnels app downloads** (per-audience app).
- Marketing-only scope: no backend, no real transactions; forms persist to `localStorage` and show success states (API-ready stubs).

### Non-goals (v1)

- Real authentication, ordering, payment, dashboard data, backend/API
- i18n (English only), PWA, real app-store links/QR, analytics

---

## 2. Research Summary (what the giants do)

See `docs/RESEARCH.md` for full findings. Key takeaways:

### Meituan (waimai.meituan.com — verified via live fetch)

- Persistent top nav: Home · **Merchant Join** (入驻加盟) · Tech/API · CSR (社会责任) · **Download app**
- Sub-nav: Contact · **FAQ** (grouped: Payments, Promotions, Orders, Other) · Careers · Integrity
- Redirect "doors": merchant center (e.waimai.meituan.com, app-gated), merchant onboarding (kd.meituan.com, download-gated), **rider recruitment portal** (peisong.meituan.com: two tracks, benefits, FAQ, signup), per-app download pages with QR, CSR page (rider welfare stories), rules/legal center
- Pattern: web pages exist to route + capture leads + force app downloads

### DoorDash (www.doordash.com — verified via Jan 2026 Wayback snapshot)

- Top promo strip ("$0 DELIVERY FEE ON FIRST ORDER")
- **Audience dropdowns in nav** with value props: *Become a Dasher* ("Sign up in minutes") · *Become a Merchant* ("0% commissions for up to 30 days")
- Hero → category **CTA cards** (Groceries, Convenience, Beauty, Flowers, Alcohol 21+, Pets)
- **Membership block** (DashPass: $0 delivery fee, 5% back on pickup, 30-day free trial)
- "Unlocking opportunity" dual CTA (Dasher + Merchant)
- Merchant portal dashboard: Insights · Sales · Reports · Customers · Marketing · Menu Manager · Store Availability · Financials · Payouts · Integrations · POS · Help
- Dasher app-gated download page (store links only)
- **Help center split by audience** (Consumers / Dashers / Merchants, 24/7 chat + phone)
- SEO link farms (Popular Categories, Top Cities/Cuisines/Chains) · Footer: Get to Know Us / Let Us Help You / Doing Business + locale switcher
- B2B product (DoorDash for Business)

---

## 3. Tech Stack

| Concern     | Choice                                             |
| ----------- | -------------------------------------------------- |
| Build tool  | Vite 6 (`@vitejs/plugin-react`)                    |
| UI          | React 19, TypeScript 5 (strict)                    |
| Styling     | Tailwind CSS 4 (`@tailwindcss/vite`), custom tokens |
| Animation   | framer-motion 12                                   |
| Icons       | lucide-react                                       |
| Routing     | react-router-dom 7 (BrowserRouter, clean paths)    |
| Utils       | clsx + tailwind-merge (`cn()`)                     |
| Fonts       | Plus Jakarta Sans (body), Space Grotesk (display), JetBrains Mono (accents) |
| SEO         | Per-route `<title>` / `<meta description>` (`usePageMeta` hook) |

Config: `@` → `./src` alias; dev server `host: true, port: 5173`. Production needs SPA fallback (Vite preview handles it; document a rewrite rule for static hosts).

---

## 4. Design System (`src/index.css`)

Reused 1:1 from the current prototype (`/home/devagent/2/public-web`):

### Tokens

| Token                | Value      |
| -------------------- | ---------- |
| `--color-paper`      | `#fbf8f3`  |
| `--color-surface`    | `#ffffff`  |
| `--color-line`       | `#e8e6e0`  |
| `--color-line-strong`| `#d9d7d1`  |
| `--color-ink-900`    | `#101412`  |
| `--color-ink-700`    | `#2b332f`  |
| `--color-ink-500`    | `#5c6560`  |
| `--color-ink-300`    | `#8a9490`  |
| `--color-brand-700`  | `#0f2e22`  |
| `--color-brand-600`  | `#134332`  |
| `--color-brand-500`  | `#1a5c44`  |
| `--color-brand-50`   | `#eef4f0`  |
| `--color-accent`     | `#c9a84e`  |
| `--color-accent-soft`| `#f4ecd2`  |
| `--color-danger`     | `#b42318`  |
| `--color-danger-soft`| `#fef3f2`  |

### Fonts

- `--font-sans`: Plus Jakarta Sans
- `--font-display`: Space Grotesk
- `--font-mono`: JetBrains Mono

### Utilities & keyframes

- `container-x` (max-width 72rem, padding-inline 1.5rem)
- `bg-grid` texture
- Keyframes: `marquee-x` (Marquee), `caret` (Typewriter), `pulse-ring`, `floaty`

### Accessibility base

- `:focus-visible` brand outline, `.no-ring`
- Skip link, `sr-only-live`
- `prefers-reduced-motion` kill-switch for all animations
- Print styles (hide header/footer/nav)

### Advanced patterns (adopted from reference build — see `docs/STYLE-GUIDE.md`)

- **`Tilt3DCard`**: mouse-follow 3D tilt (`useMotionValue` → `rotateX/rotateY ±15°`, `preserve-3d`, inner `translateZ(30px)` depth layer, spring hover `scale 1.02`)
- **Floating UI badges**: infinite `y: [0, -6, 0]` float animations over hero collages
- **Dark ink bands** (`bg-ink-900`) as section dividers + glass chips (`bg-white/10 backdrop-blur ring-white/10`)
- **Color glow orbs** (`bg-brand-50 blur-2xl` circles), **gradient text** (`from-brand-600 to-emerald-600 bg-clip-text`)
- **Photo collage heroes** (large `aspect-[4/5]` card + stacked smaller cards + floating badges)
- **Range-slider calculators** (live TZS math, dark panels, white result cards)
- **Card radio selector** via `has-[input:checked]:bg-ink-900`
- Staggered entrances (`delay: i * 0.07`), image hover zoom (`group-hover:scale-[1.02] duration-700`)
- Ring-based cards (`ring-1 ring-line`), colored CTA glow shadows (`shadow-brand-500/20`)
- Bilingual microcopy pills (EN • SW), Pexels CDN photos, trust chips (M-Pesa, Halal, ratings)

---

## 5. Routing Map

```
/               Home hub (router)
/services       All-services marketplace (category filter via ?category=)
/consumer       Consumer ordering portal
/merchant       Merchant portal (restaurants & shops)
/provider       Service-provider portal (plumbers, electricians, cleaners…)
/rider          Rider portal
/faq            Help FAQ (grouped accordion)
/support        Support — 4 audience tracks + feedback form
/csr            Rider & community welfare
/about          Company page
/login          Shared login (static)
/privacy        Legal
/terms          Legal
/cookies        Legal
*               → 404 → redirect home
```

**Routing behavior:** `BrowserRouter` + `<ScrollToTop>` on route change. All "Back to home" links are `<Link to="/">`. Audience cards are `<Link>` elements (real client-side redirects to the portal). Unknown paths `Navigate` to `/`.

---

## 6. File Tree (target structure)

```
new-public_web/
├─ index.html                     # fonts, favicon, global meta
├─ package.json / tsconfig.json / vite.config.ts
├─ public/favicon.svg
├─ docs/
│  ├─ PLAN.md                     # this document
│  ├─ RESEARCH.md                 # Meituan/DoorDash findings
│  └─ STYLE-GUIDE.md              # advanced visual/animation language (reference build)
└─ src/
   ├─ main.tsx                    # Router + layout mount
   ├─ App.tsx                     # route table
   ├─ index.css                   # tokens, keyframes, a11y
   ├─ utils/cn.ts
   ├─ hooks/usePageMeta.ts        # per-route title/description
   ├─ data/constants.ts           # categories, restaurants, cities, faqs, audiences
   ├─ components/
   │  ├─ motion.tsx               # Reveal, Stagger, StaggerItem, Words, Typewriter, Counter, Marquee, ScrollProgress, useParallax, Tilt3DCard, FloatingBadge
   │  ├─ Header.tsx               # nav + audience dropdowns + city + login + app CTA + mobile menu
   │  ├─ Footer.tsx               # columns + hotline + SEO block + legal bar
   │  ├─ CitySelector.tsx         # modal, 8 TZ cities
   │  ├─ CookieConsent.tsx        # fixed bottom-left, accept/essential
   │  ├─ BackToTop.tsx
   │  ├─ PromoStrip.tsx           # "free first delivery" bar
   │  ├─ SectionHeading.tsx       # eyebrow + title + subtitle
   │  ├─ AppBadge.tsx             # iOS/Android store pill (shared)
   │  ├─ QrBox.tsx                # QR-style placeholder tile
   │  ├─ forms/
   │  │  ├─ Field.tsx             # label + input/select + error + icon
   │  │  ├─ MerchantSignupForm.tsx
   │  │  ├─ RiderSignupForm.tsx
   │  │  └─ FeedbackForm.tsx
   │  └─ pages/
   │     ├─ HomePage.tsx
   │     ├─ ConsumerPage.tsx
   │     ├─ MerchantPage.tsx
   │     ├─ RiderPage.tsx
   │     ├─ FaqPage.tsx
   │     ├─ SupportPage.tsx
   │     ├─ CsrPage.tsx
   │     ├─ AboutPage.tsx
   │     ├─ LoginPage.tsx
   │     └─ LegalPages.tsx        # Privacy/Terms/Cookies (data-driven)
```

---

## 7. Page-by-Page Spec

### 7.1 Home `/` — the router hub

Sections top→bottom:

1. **PromoStrip** — thin bar: "Free first delivery — other fees apply" + Sign in / Sign up links (DoorDash model)
2. **Header** (fixed, transparent → surface on scroll, ScrollProgress bar)
3. **Hero** — city badge ("Now serving Dar es Salaam" → opens CitySelector), headline "Your city, delivered." (Words animation, gradient-text keyword), Typewriter subline, **address search bar** (decorative), trust ticks (2000+ restaurants · Free first delivery · Avg 25 min); right side: **photo collage** (large food card + stacked small cards) with **floating rider/r rating badges** and a progress-bar card
4. **Category CTA cards** — upgraded grid: 10 categories, each an icon card with per-category CTA label ("Shop groceries", "Send flowers", "Shop alcohol" + 21+ note) linking to `/consumer`
5. **Audience router** — 3 large cards (Consumer/Merchant/Rider), each: icon, title, description, offer hint (Merchant: "0% commission for 30 days"; Rider: "Sign up in minutes"), **primary CTA redirecting to `/consumer` `/merchant` `/rider`**, secondary "Get the [X] app" anchor to that portal's download section
6. **HUDumika+ membership teaser** — DashPass-style: "$0 delivery fee · 5% back on pickup · 30 days free" + CTA → `/consumer`
7. **Popular restaurants** — horizontal scroll strip (promo badge, rating, ETA, fee) → `/consumer` — photo-top cards with gradient overlays, Pexels CDN images
8. **How it works** — 3 steps (Browse → Order → Track) with 01/02/03 eyebrows and photo-top cards
9. **Stats** — animated counters (2000+ restaurants · 15K+ orders daily · 98% on-time · 4.8 rating)
10. **Category spotlight band** — dark `bg-ink-900` band with glass chips (fresh market, groceries, pharmacy) — vertical rhythm break
11. **Testimonials** — 3 cards (consumer/merchant/rider voices)
11. **Footer**
12. Floating: CitySelector modal, CookieConsent, BackToTop

### 7.2 Consumer `/consumer`

1. Back-to-home link; hero: "Order food online in Dar es Salaam" + search + app CTA
2. Category chips → filters restaurant grid (client-side)
3. **Restaurant grid** — reuse `RESTAURANTS` (Unsplash images, promo/ETA/fee badges)
4. Featured deals strip
5. How ordering works (3 steps)
6. Consumer app download section (`AppBadge` x2 + `QrBox`)
7. CTA band: "Already a member? Sign in" → `/login`

### 7.3 Merchant `/merchant`

1. Hero: "Grow your business with HUDumika" + **gradient-text keyword** + ambient glow orbs + primary CTA (scrolls to form) + secondary (merchant app download); right side: **Tilt3DCard** with merchant stats panel (+68% orders · 4.8★ · 24/7)
2. Stats band (avg order lift 40%+, 10K+ daily customers, fast payouts)
3. Benefit cards: Visibility · Order dashboard · Marketing tools · Fast payouts
4. Onboarding steps: Apply → Verify → Launch → Grow (photo-top cards, 01/02/03 eyebrows)
5. **Transparent commission** section (3 simple pricing tiers, static)
6. **Revenue calculator** — dark panel with range sliders (avg order value + orders/day → live monthly projection TZS, 14% commission breakdown, "you keep" green total, 0%-commission-30-days callout)
7. **Dashboard preview mock** (DoorDash model): module chips — Insights · Orders · Menu Manager · Customers · Marketing · Financials · Payouts, in a stylized browser-frame card
8. **MerchantSignupForm**
9. Merchant testimonials + merchant FAQ accordion
10. Merchant app download + "Merchant login" → `/login`

### 7.4 Rider `/rider`

1. Hero: "Earn on your schedule" + CTA (form) + app download — dark `bg-ink-900` hero with photo background + gradient overlay + glass stat cards (TZS 45k max/day · Daily M-Pesa payout · 4.8★); right side: **Tilt3DCard** with rider profile card (Juma • Boda • online badge + daily stats grid)
2. **Two-track comparison** (Meituan model): *Dedicated Rider* (stable income, training, insurance, equipment) vs *Flex Rider* (own schedule, instant payouts, gig) — side-by-side table
3. **Earnings estimator** — dark panel calculator: city pills (Dar/Arusha/Mwanza/Dodoma/Zanzibar) + orders-per-day range slider → live daily/weekly/monthly TZS with per-order rate + bonus logic + "Start Earning Now" CTA
4. Benefits grid (insurance, fast payouts, support, bonuses)
5. Rider stories (3 cards)
6. **RiderSignupForm** — with card radio vehicle picker (Boda/Bicycle/Gari via `has-[input:checked]`)
7. Rider FAQ accordion
8. Rider app download + "Rider login" → `/login`

### 7.5 FAQ `/faq` (Meituan model)

- Grouped accordion: **Payments & Money** (refunds, payout times) · **Promotions** (first-order discount, new-user rules) · **Orders** (cancellation, late delivery, compensation) · **Delivery** (times, tracking) · **Support & Safety**
- Data-driven from `constants.ts` (`FAQ_GROUPS`)
- Keyboard-accessible accordion (buttons + `aria-expanded`)

### 7.6 Support `/support` (DoorDash model — 3 tracks)

- **Consumer track**: hotline + hours (e.g., 9:00–23:00 daily), email, links to `/faq`
- **Merchant track**: dedicated hotline + hours, support email, "Merchant dashboard help"
- **Rider track**: dedicated hotline + hours, gear/equipment note
- **Feedback form** (`FeedbackForm`: name, email, topic select, message; localStorage + success state)

### 7.7 CSR `/csr`

- Hero: "We invest in our riders and communities"
- Rider welfare pillars: Safety first · Fair earnings · Training & growth
- Community stories (3–4 cards: donation drives, safety campaigns, rider spotlights)
- CTA → `/rider`

### 7.8 About `/about`

- Mission ("Your city, delivered"), story timeline (2025 founding → scale), values, contact links → `/support`

### 7.9 Login `/login`

- Static form (email/phone, password + eye toggle, remember me, forgot password, sign-up link), brand card, back-to-home. Submit shows "coming soon" notice (no auth).

### 7.10 Legal `/privacy` `/terms` `/cookies`

- Data-driven legal template (`LEGAL_DOCS` in constants): structured sections with effective date; cookies page lists cookie types (essential/optional) matching CookieConsent copy.

---

## 8. Shared Components Spec

| Component      | Behavior |
| -------------- | -------- |
| `Header`       | Fixed; scrolled state (surface/backdrop-blur/border); desktop nav: Order Food · Partner (dropdown: offer + "Become a Partner" → /merchant) · Deliver (dropdown → /rider) · Help (→ /faq) · city pill (opens CitySelector) · Log in · "Get the App"; mobile: hamburger → animated panel with all links incl. city; aria-labels |
| `Footer`       | Brand + blurb; columns: Company (About, CSR, Press) · Order (Food, Groceries, Pharmacy, Flowers → /consumer) · Partner (Become a Merchant → /merchant, Merchant Login → /login, Rider Sign Up → /rider) · Support (FAQ, Contact → /support, Privacy, Terms, Cookies); **SEO block**: Top cities (Dar es Salaam, Arusha, Dodoma, Mwanza, Zanzibar, Mbeya, Tanga, Morogoro) + popular cuisines chips (static links to /consumer); bottom bar: location · © year · legal links · hotline |
| `CitySelector` | Modal: 8 TZ cities, selected checkmark, backdrop blur, ESC/backdrop close |
| `CookieConsent`| Shows after 1.8s, Accept all / Essential only, no persistence (v1) |
| `BackToTop`    | Appears > 600px scroll, smooth scroll |
| `PromoStrip`   | Top thin bar, dismissible (state only), DoorDash-style offer copy |
| `AppBadge`     | iOS (Apple SVG) / Android (Play SVG) store pills — reusable, placeholder hrefs |
| `QrBox`        | Rounded tile with "Scan to download" + brand glyph (visual placeholder) |
| `SectionHeading` | eyebrow (uppercase brand, tracked) + title + optional subtitle |
| `forms/Field`  | Label + icon-adorned input/select + inline error + aria-invalid |
| `usePageMeta`  | Sets `document.title` + meta description per route |

**Motion primitives (ported from `public-web`):** `Reveal` (fade-up-blur on view), `Stagger` / `StaggerItem`, `Words`, `Typewriter`, `Counter`, `Marquee`, `ScrollProgress`, `useParallax` — all respecting `prefers-reduced-motion`.

---

## 9. Forms Spec

All forms: client-side validation, error messages under fields, `aria-invalid`, submit → save to `localStorage` (`hudumika.leads`) → success card (personalized), link to app download + "We'll contact you within 24h".

### MerchantSignupForm

| Field             | Type   | Validation              |
| ----------------- | ------ | ----------------------- |
| Restaurant name*  | text   | required                |
| Owner name*       | text   | required                |
| Phone*            | tel    | TZ format (+255 / 07…)  |
| Email*            | email  | required, email regex   |
| City*             | select | required (8 cities)     |
| Business type*    | select | Restaurant / Grocery / Pharmacy / Other |
| Number of outlets*| number | ≥ 1                     |
| Comment           | textarea | optional              |

### RiderSignupForm

| Field         | Type   | Validation             |
| ------------- | ------ | ---------------------- |
| Full name*    | text   | required               |
| Phone*        | tel    | TZ format (+255 / 07…) |
| City*         | select | required (8 cities)    |
| Vehicle*      | select | Bicycle / Motorcycle / Car / On foot |
| Availability* | select | Full-time / Part-time / Weekends |
| Referral code | text   | optional               |

### FeedbackForm

| Field    | Type   | Validation           |
| -------- | ------ | -------------------- |
| Name*    | text   | required             |
| Email*   | email  | required, regex      |
| Topic*   | select | Order / Merchant / Rider / Other |
| Message* | textarea | required, min 10 chars |

---

## 10. Data Layer (`src/data/constants.ts`)

- `CATEGORIES` (10: icon, label, color, ctaLabel)
- `RESTAURANTS` (6: name, cuisine, rating, time, fee, image, promo?)
- `CITIES` (8 TZ cities: id, name, region)
- `AUDIENCES` (3: id, icon, title, desc, offer, href, cta)
- `FAQ_GROUPS` (5 groups × 4–6 Q&A)
- `SUPPORT_TRACKS` (3: consumer/merchant/rider — hotline, hours, email)
- `MERCHANT_MODULES` (dashboard preview chips)
- `LEGAL_DOCS` (privacy/terms/cookies content)
- `SEO_META` (per-route titles/descriptions)

---

## 11. Accessibility & Quality Bar

- Skip link · semantic landmarks (`header/main/nav/footer`) · focus-visible rings · labeled icons (`aria-label`) · `alt` on images · accordion keyboard support · contrast ≥ 4.5:1 · `prefers-reduced-motion` fully honored · print styles · 100% keyboard navigable · no horizontal overflow on mobile

---

## 12. Performance & SEO

- Lazy-load below-fold images (`loading="lazy"`)
- Route-level code splitting: `React.lazy` for Consumer/Merchant/Rider/Faq/Support pages
- Per-page meta (`usePageMeta`): e.g. `/merchant` → "Grow your restaurant with HUDumika | Restaurant signup"
- Descriptive single `index.html` meta as fallback
- All CTAs are real links/`<Link>` (no dead `#`)

---

## 13. Build Order (implementation milestones)

1. **Scaffold**: Vite react-ts project in `new-public_web`; install deps; copy `index.css`, `cn.ts`, `motion.tsx`, favicon, fonts; configure vite/tsconfig with alias; `npm run dev` sanity check
2. **Docs**: `docs/PLAN.md` + `docs/RESEARCH.md` (this step — done)
3. **Foundation**: `constants.ts`, `usePageMeta`, layout (Header/Footer/PromoStrip/BackToTop/CookieConsent/CitySelector), route table in `App.tsx`
4. **Home hub** (all §7.1 sections)
5. **Consumer portal**
6. **Merchant portal** (+ dashboard mock, signup form)
7. **Rider portal** (+ tracks, estimator, signup form)
8. **Support pages**: FAQ, Support, CSR, About, Login, Legal
9. **Polish**: code-splitting, SEO meta pass, reduced-motion audit, responsive pass
10. **Verify** (§14) and fix

---

## 14. Verification / QA Checklist

- [ ] `npm run typecheck` — zero errors
- [ ] `npm run build` — clean production build
- [ ] `npm run dev` smoke test:
  - [ ] Home → each audience card redirects to correct portal
  - [ ] Header dropdowns open/close; mobile menu works; city selector selects + reflects in hero
  - [ ] All 12 routes render; unknown path → home
  - [ ] Merchant form: empty submit shows errors; valid submit → success + localStorage entry
  - [ ] Rider form: same; earnings estimator math updates live
  - [ ] Merchant revenue calculator: slider changes update projection + commission math
  - [ ] Tilt3DCard: tilt follows mouse on rider/merchant heroes; resets on leave; disabled under reduced-motion
  - [ ] Feedback form validation
  - [ ] FAQ accordions open/close (keyboard + click)
  - [ ] No console errors/warnings
- [ ] Lighthouse-style pass: no CLS from images; lazy loading on strip images
- [ ] `prefers-reduced-motion` — animations disabled
- [ ] 360px / 768px / 1280px responsive breakpoints

---

## 15. Out of Scope (v1) / Future

- Real auth, ordering, payments, dashboard data, backend/API
- i18n (EN/SW), PWA, app store real links/QR, analytics
- Future: consumer web ordering flow (waimai-style), merchant onboarding with document upload, rider application status tracking
