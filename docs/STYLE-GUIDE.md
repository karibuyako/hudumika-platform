# HUDumika — Style Guide (from Meituan-Inspired Reference Build)

**Source analyzed:** `build-meituan-inspired-website (18).zip` (30+ page React 19 + Vite + Tailwind v4 + framer-motion v13 super-app prototype)
**Purpose:** Extract the visual/animation language so our public web (`new-public_web`) reaches the same state-of-the-art, enterprise-grade polish.

---

## 1. Theme & Color System

Same tokens as ours (the reference uses the identical "restrained enterprise palette"):

| Role | Value | Usage rule |
| --- | --- | --- |
| `paper` | `#fbf8f3` | Page background |
| `surface` | `#ffffff` | Cards, panels |
| `ink-900` | `#101412` | **Primary action color**, dark bands, text |
| `ink-700/500/300` | `#2b332f / #5c6560 / #8a9490` | Text hierarchy |
| `brand-500/600/700` | `#1a5c44 / #134332 / #0f2e22` | Brand accents, gradients |
| `brand-50` | `#eef4f0` | Hover fills, underlines |
| `accent` (gold) | `#c9a84e` | **Max 5% of UI** — logo dot, tiny badges only |
| `emerald-500/600` | success green | Positive stats, success states, "online" dots |
| `danger` | `#b42318` | Errors, cart badge |

### Signature patterns
- **Dark ink bands**: `bg-ink-900` used as full-width section dividers and hero panels (topbar, Rider hero, Earnings Calculator, Movies strip, App download, Footer). Light content on dark = premium contrast rhythm.
- **Soft card language**: `rounded-2xl/3xl` + `ring-1 ring-line` (or `ring-black/5`) instead of `border`; `shadow-sm` at rest → `shadow-xl shadow-black/5` on hover.
- **Colored glow shadows on CTAs**: `shadow-lg shadow-brand-500/20` / `shadow-brand-500/20` on primary buttons.
- **Glassmorphism on dark**: `bg-white/10 backdrop-blur ring-1 ring-white/10` chips/cards (rider stats, store buttons, movie cards `bg-white/5 ring-white/10`).
- **Ambient glow orbs**: absolutely-positioned `rounded-full bg-brand-50 blur-2xl` / `bg-brand-500/10 blur-3xl` circles behind hero content (Merchant page).
- **Gradient text**: `bg-gradient-to-r from-brand-600 to-emerald-600 bg-clip-text text-transparent` for hero keywords.
- **Image gradient overlays**: `bg-gradient-to-t from-ink-900/65 via-ink-900/10 to-transparent` + white text on photos (featured cards, market cards, hotel/travel cards).
- **Grid texture**: `backgroundImage: linear-gradient(#101412 1px,...) 32px` at 3.5% opacity over hero.

---

## 2. Typography

- Same fonts: Plus Jakarta Sans (body) + Space Grotesk (display).
- **Weight-forward**: `font-black`/`font-extrabold` headings, `tracking-tight`, `leading-[0.9–0.95]`.
- **Eyebrows**: `text-xs font-bold uppercase tracking-[0.16em]/[0.22em]` — muted (`text-ink-500`) on light, `text-white/60` on dark.
- **Bilingual microcopy**: "Pilau & Biryani • Chakula" / "Huduma zote • All services" — EN + Swahili pairings everywhere (enterprise-local trust).
- Numbers/spec labels in tiny mono-ish uppercase (`text-[10px] font-black tracking-widest`).

---

## 3. 3D & Motion Language (framer-motion)

### 3.1 `Tilt3DCard` — the flagship 3D effect (used on Rider & Merchant heroes)
- Mouse-follow 3D tilt: `useMotionValue` (0–1) → `useTransform` → `rotateX/rotateY ±15°`.
- `transformStyle: preserve-3d` on wrapper; inner layer at `translateZ(30px)` → real depth parallax between card face and its content.
- Spring hover: `whileHover={{ scale: 1.02, translateZ: 20 }}`, `transition: spring, stiffness 300, damping 20`.
- Reset to center on mouse leave. `perspective-[1000px]` + `cursor-pointer`.
- Content inside: photo card + floating "app-style" bottom panel (rider profile card, stats grid) → feels like a live product screenshot in 3D.

### 3.2 Floating UI badges (Hero)
- `motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}` — "Rider en route" and rating cards float over hero collage; second card delayed 0.8s at different amplitude for organic feel.

### 3.3 Entrance choreography
- Staggered `initial={{ opacity: 0, y: 16 }} animate/whileInView` with `delay: i * 0.07` per grid item.
- Scroll reveal: `whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}`.
- Buttons: `whileHover={{ y: -1 }}` / `whileTap={{ scale: 0.98 }}` (micro-interactions).

### 3.4 UI micro-animations
- **Cart count badge pop**: `AnimatePresence` + `initial={{ scale: 0 }} animate={{ scale: 1 }}` keyed by count.
- **Qty stepper**: minus button mounts/unmounts with scale pop; number animates `scale 1.25 → 1` on change.
- **Cart drawer**: spring slide-in `x: 100% → 0` (`spring, damping 30, stiffness 320`), backdrop blur.
- **Image zoom on hover**: `group-hover:scale-[1.02–1.03]` with `duration-500/700`.

---

## 4. Layout & Component Language

- Container: `max-w-[1280px] mx-auto px-4 sm:px-6` (wider than our 72rem).
- **Hero split layout**: left = copy (eyebrow pill → display headline → sub → search pill → stats row → trust line); right = **photo collage** (one large `aspect-[4/5]` card + two stacked smaller cards) + floating badges + progress bar inside card.
- **SectionHeading** pattern: eyebrow / title / sub on left + `action` button on right (View all / All movies).
- **Service/category grid**: 5-col tile grid, emoji or photo tiles `rounded-2xl` with hover `ring-ink-900/10`, selected = `bg-ink-900 text-white`.
- **Dark calculator panels** (`bg-ink-900 rounded-[2rem]`): range sliders (`accent-ink-900`), result card `bg-white` with breakdown + green "you keep" numbers + 0%-commission callout.
- **Feature cards with photo tops** (`aspect-[16/10]` image + padded body + number eyebrow `01/02/03`).
- **Testimonial/trust bands**: rounded avatar chips + M-Pesa/payment chips (`bg-white/10 ring-white/10` on dark; `bg-paper ring-line` on light).
- **Forms**: `rounded-2xl bg-neutral-50 px-4 py-3 ring-1 ring-black/5 focus:ring-brand-400`, radio-card selector via `has-[input:checked]:bg-ink-900 has-[input:checked]:text-white`, success state = big emerald `✓` circle + congratulations copy + "submit another" reset.
- **Footer**: dark `bg-ink-900`, bilingual columns, social circles `bg-white/10`, compliance chips (BRELA Licensed, TCRA Compliant), payment chips, helpline.

---

## 5. Enterprise-Ready Touches (state-of-the-art bar)

1. **TopBar** (thin dark strip): tagline + helpline number + "Become a Rider" / "Become a Merchant" links — audience routing at the very top.
2. **Trilingual i18n** (EN/SW/AR) via React Context with full nested dictionaries + language toggle pills in header (we ship EN-only per plan, architecture stays i18n-ready).
3. **Working functional depth**: cart drawer, checkout, live tracking simulation (polling countdown + status timeline), geolocation "Near Me" with haversine distance sort, search with query params.
4. **Trust signals everywhere**: ratings ★, review counts, Halal badges, verified provider, payment chips, compliance chips.
5. **Simulated API labels** ("GET /api/categories • paginated") — communicates real data integration intent.
6. Real photo assets via Pexels CDN (`images.pexels.com/photos/{id}...?auto=compress&cs=tinysrgb&fit=crop&w=800&h=600`) — richer than Unsplash-query URLs.

---

## 6. What We Adopt in new-public_web (mapped to our pages)

| Pattern | Where |
| --- | --- |
| Tilt3DCard (3D mouse tilt) | Home hero collage, `/rider` hero card, `/merchant` hero card |
| Floating UI badges | Home hero (rider card + rating card) |
| Dark ink bands + glass chips | Home MoviesStrip-equivalent → category spotlight band; `/rider` calculator; `/merchant` calculator; App download; Footer |
| Color glow orbs + gradient text | `/merchant` hero; Home hero keyword |
| Photo collage hero | Home hero (replaces text-only) |
| Range-slider calculators (live TZS math) | `/rider` earnings estimator, `/merchant` revenue calculator |
| Card radio selector (`has-[...]:checked`) | Rider signup vehicle picker |
| Staggered entrances + image hover zoom | All grids |
| SectionHeading w/ action button | All sections |
| Ring-based cards, colored CTA shadows | Global |
| Photo-top feature cards + 01/02/03 eyebrows | `/merchant` onboarding steps |
| Success states (emerald ✓ + copy) | All forms |
| Bilingual microcopy (EN • SW) | Pills, eyebrows, footnotes |
| Pexels CDN images + gradient overlays | Restaurant/market/category cards |
| TopBar with helpline + audience links | Global header |
| Trust chips (M-Pesa, Halal, ratings) | Home, `/rider`, `/merchant`, Footer |

---

## 7. Notes / Constraints

- Reduced-motion: all infinite/3D effects must respect `prefers-reduced-motion` (kill switch in our `index.css`).
- The reference is a *super-app demo*; our public web stays **marketing + lead capture** (per PLAN §1) — we borrow the *visual language*, not the transactional scope.
- Accent gold stays ≤5% of UI (enterprise restraint is part of the brand).
