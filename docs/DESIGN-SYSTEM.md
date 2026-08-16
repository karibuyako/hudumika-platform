# HUDumika Design System

One visual language across the public web, admin web, merchant/provider web, and all four mobile apps. Mobile apps mirror the web tokens; this document is the shared contract.

## Color tokens

| Token | Value | Usage |
| --- | --- | --- |
| `paper` | `#fbf8f3` | Page background (light surfaces) |
| `surface` | `#ffffff` | Cards, panels |
| `ink-900` | `#101412` | Primary action color, dark bands, footer, hero panels |
| `ink-700` | `#2b332f` | Headings |
| `ink-500` | `#5c6560` | Body text |
| `ink-300` | `#8a9490` | Muted text, disabled |
| `brand-500` | `#1a5c44` | Brand accents, primary buttons (light) — **primary** |
| `brand-600` | `#134332` | Hover states |
| `brand-700` | `#0f2e22` | Deep brand (hero bands, dark emphasis) |
| `brand-50` | `#eef4f0` | Hover fills, underlines, glow orbs |
| `accent` (gold) | `#c9a84e` | Logo dot + tiny badges only — max 5% of UI |
| `success` | `#059669` | Positive stats, success states, "online" dots |
| `danger` | `#b42318` | Errors, destructive actions |
| `line` | `rgba(16,20,18,0.08)` | Card rings instead of borders |

### Usage rules

- Cards use `ring` (1px `line`) not `border`; `rounded-2xl/3xl`; rest `shadow-sm` → hover `shadow-xl shadow-black/5`.
- Dark bands (`ink-900`) create the premium contrast rhythm; glass chips on dark are `bg-white/10 ring-white/10 backdrop-blur`.
- Gradient text: `brand-500 → emerald-600` for hero keywords only.
- Accent gold stays ≤ 5% of any screen.

## Typography

- Plus Jakarta Sans (body) / Space Grotesk (display) on web; nearest Expo-managed equivalents (e.g. `PlusJakartaSans` via `@expo-google-fonts`) on mobile.
- Headings: `font-extrabold/black`, `tracking-tight`, `leading-[0.9–0.95]`.
- Eyebrows: `text-xs font-bold uppercase tracking-[0.16em]`, muted on light, `white/60` on dark.
- Numbers/spec labels: tiny uppercase with wide tracking.
- Bilingual microcopy: English + Swahili pairings on pills and footnotes (trust signal).

## Components (shared kit)

| Component | Spec |
| --- | --- |
| Button | Primary = `ink-900` (light pages) or `brand-600`; glow shadow `brand-500/20`; press scale 0.98; disabled = `ink-300` |
| Card | `surface` bg, `ring-line`, `rounded-2xl`; hover lift with `shadow-xl` |
| Form field | `surface` bg, `ring-line`, focus ring `brand-600`; error text `danger`; helper text `ink-300` |
| Radio/checkbox card | Selected = `ink-900` bg + white text (`has-[input:checked]` pattern on web, state-driven on mobile) |
| Rating | Star icons (filled/half/outline), count text next to it; values always from API reviews |
| Status pill | `success` for positive, `danger` for errors, `ink-900` for neutral/active |
| Trust chips | M-Pesa/Tigo/Airtel/card payment chips; compliance chips (BRELA Licensed, TCRA Compliant) |
| Empty / loading / error / retry | Required for every list and detail screen (see TESTING.md per app) |
| Toast | Top-positioned, success/error/info variants, auto-dismiss |
| Voucher/coupon card | Dashed accent border, big value + validity line, redeem QR (e.g. `VoucherCard`) |
| Group buy card | Discount badge (`-30%`), original price struck through, "Buy" CTA |
| Dine-in table chip | Table label + live bill status dot (open/billing/paid) |
| Campaign status pill | draft / pending_review / live / paused / ended with dedicated colors |
| Analytics chart | Line/bar charts in brand palette; TZS formatted axes; download button |
| Chat thread | Bubble list (customer right/brand, merchant left/surface), system notices centered, unread badge on the tab |
| Message center row | Avatar + preview + time + unread dot; archived/blocked states labeled |

## Motion

- Respect `prefers-reduced-motion` everywhere; provide kill switch.
- Micro-interactions: buttons `whileTap scale 0.98`, subtle `y: -1` hover.
- List entrances: staggered fade-up (delay `i * 0.07`), once per view.
- Badges: gentle float `y: [0, -6, 0]` 5 s loop (hero screens only).
- 3D tilt card: mouse-follow rotateX/Y ±15°, `translateZ(30px)` depth — hero screens only (web).

## Layout

- Web container: `max-w-[1280px] mx-auto px-4 sm:px-6`.
- Mobile safe areas: use platform insets (SafeAreaView / `env(safe-area-inset-*)`); bottom nav max 5 items.
- Section heading pattern: eyebrow / title / subtitle left, optional action right.
- Numbers and money: `TZS 12,500` format, `Intl.NumberFormat('en-TZ')`-style grouping, always visible currency.

## Accessibility floor

- Contrast: body text ≥ 4.5:1; muted text only for non-essential info.
- Touch targets ≥ 44×44 px (mobile) / ≥ 40 px (web).
- All icons have accessible labels; forms have labels, not placeholders alone.
- Focus visible on web; screen-reader-friendly status announcements on live updates (order status, toasts).

## Source of truth

- **Tokens live in `@hudumika/tokens`** — the single source for names and values (web: `tokens.css` custom properties; native: JS tokens). See `packages/tokens/README.md`.
- Web reference implementation: `new-public_web` (tokens in `index.css`, components in `src/components`).
- Any token or component change is a shared change: document it here, update the reference implementation, and notify all teams.
