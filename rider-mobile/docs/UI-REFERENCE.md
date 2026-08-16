# HUDumika Rider — UI Design Reference

## 0. Purpose & provenance

This document extracts the UX decisions worth keeping from the experimental
prototype in `uber-driver-app-blueprint (10).zip` (a Next.js driver-app
blueprint) and records how they map onto the Hudumika rider app.

- Extracted from "uber-driver-app-blueprint" — **design reference only, NOT
  source code**; the project was rejected as a foundation: Next.js web stack vs
  our mandated Expo/React Native, zero tests, demo-grade auth.
- We mine its **UX decisions only** (flows, states, layouts, money and safety
  patterns). No code, palette license, or component is adopted.
- **The binding surface is our contract** — `backend/API-CONTRACT.yaml`.
  This document never overrides it. Where the blueprint and the contract
  disagree (offer countdown 15s vs 120s, wait-pay rate, status names), the
  contract wins; this doc flags each divergence.
- Date: 2026-08-13.

## 1. Design language

Dark-mode-first, high-contrast, glanceable for eyes-on-road. Every screen
answers one question: "What does the driver need to do right now?"

### 1.1 Palette

| Token | Hex | Use |
|---|---|---|
| Primary background | `#000000` | Screen base |
| Card / bottom sheet | `#141414` / `#1A1A1A` | Sheets, cards |
| Surface / elevation | `#2D2D2D` | Elevated surfaces, chips, outlines |
| Text primary | `#FFFFFF` | Headings, values |
| Text secondary | `#A3A3A3` | Labels, captions |
| Text muted | `#555` / `#666` | Hints, inactive tab |
| Success / online / money | `#00D63C` | Online dot, GO ONLINE, totals |
| Warning / surge / wait-pay | `#FFB800` | Surge pills, wait-pay, amber alerts |
| Danger / decline | `#FF3B30` | Decline, cancel, red alerts |
| Action / link | `#0057D9` (link variant `#4d94ff`) | Call/chat affordances |
| Map surface | `#151a2e → #0c1322` | Simulated map base (not adopted as-is) |

### 1.2 Typography

| Role | Style |
|---|---|
| Headings | Inter Bold, 24–32px |
| Body | Inter Regular, 16px |
| Captions / labels | Inter Medium, 12–14px |
| Money / hero numbers | Inter Black, 40–56px, `tabular-nums` |
| Overline labels | 11px uppercase, wide tracking |

Hudumika note: we are not bound to Inter; this is a weight/size system, not a
font mandate (see `LOCALIZATION.md` for script support).

### 1.3 Spacing, touch, motion

| Rule | Value |
|---|---|
| Base unit | 4px |
| Touch targets | min 48px (primary buttons 56px+) |
| Card padding | 16–20px; screen margins 16px; section gaps 24px |
| State transitions | 200ms ease-out |
| Modal appearance | 300ms slide-up (spring) |
| Press feedback | 100ms `scale(0.97)` |
| Status change attention | 400ms pulse |
| Countdown rings | 1000ms linear deplete, stepped per second |

Bottom sheets: 28px top radius, translucent scrim `black/70`, drag + tap-out
dismiss. Primary actions are full-width, stacked, green-first.

## 2. Driver state machine

Verbatim `DriverState` enum from `src/lib/types.ts`:

```text
splash · login · otp · onboarding · pending · offline · online · accepting
· picking_up · at_restaurant · delivering · at_customer · completed · reverification
```

Order lifecycle (`OrderStatus`): `requested → accepted → picking_up →
at_restaurant → delivering → at_customer → completed`, plus
`cancelled · declined · timed_out`.

```text
                      ┌─────────────── accept ───────────────┐
                      ▼                                      │
splash → login ⇄ otp → onboarding → pending → offline → online → accepting
                      │                      ▲  │            │      │
                      └── (approved) ────────┘  │     decline/timeout, or complete
                                              go online      │
        online → accepting → picking_up → at_restaurant → delivering
                           (auto-accept pref bypasses accepting)
        delivering → at_customer → [hand_to_customer | leave_at_door + photo]
                → completed → online (loop, next dispatch scheduled)
        exceptions branch anywhere:
          cancelled / declined / timed_out → online
          customer_unreachable → 8-min timer modal → completed (earnings protected)
          account_suspension / fraud → offline · document_expired → offline+profile
          identity_reverification → reverification → offline
```

Exactly one screen per state; `offline`/`online` additionally branch on the
active bottom tab (home / earnings / trips / profile).

### 2.1 Transition triggers (observed in the blueprint)

| Transition | Trigger in blueprint | Hudumika equivalent |
|---|---|---|
| online → accepting | SSE push or fallback dispatch timer (~12–16s while idle) | Server-pushed offer per DISPATCH.md; contract matching flow |
| accepting → picking_up | ACCEPT button or auto-accept preference | `POST /orders/{orderId}/status` `accepted` |
| accepting → online | DECLINE, timeout (15s ring) or decline reason | `declined` / `timed_out` status |
| picking_up → at_restaurant | "I've Arrived" | `rider_arrived_pickup` |
| at_restaurant → delivering | CONFIRM PICKUP (items all checked optional, wait logged) | `picked_up` w/ pickup code or manual note (DELIVERY-FLOW.md) |
| delivering → at_customer | "I've Arrived" | `rider_arrived_dropoff` |
| at_customer → completed | Hand to customer, or Photo Proof confirm | `delivered` → `completed`; POD via `proof-of-delivery` |
| completed → online | "BACK TO MAP", next dispatch scheduled | Loop continues; optionally offline → session saved |

Guard rails observed: dispatch is dispatched only while `online` and idle;
go-online runs a compliance pre-check (reverification, expired docs,
suspension) before flipping state; go-offline cancels pending timers and SSE,
and reports session minutes.

### Why this maps to NAVIGATION.md

Our `NAVIGATION.md` opens with the same principle: "The app is a state machine
with a flow graph, not a page list: Offline → Online → Accept → Pickup →
Delivery → Complete → repeat." The blueprint confirms the pattern works — a
driver app is a loop over a machine, where overlays (modals) sit on top of the
current state rather than being separate destinations. We adopt the concept
unchanged; the difference is discipline: our transitions call
`POST /orders/{orderId}/status` and render the **server-returned** `Order`
(never optimistic), where the blueprint mutated local state first.

## 3. Screen-by-screen UX notes

| Screen | Blueprint behavior | Hudumika decision / contract link |
|---|---|---|
| Splash | Brand moment ~2s, routes by existing session | Adopt; route to `/dashboard` per NAVIGATION.md |
| Login | Phone input w/ country code, Continue | Adopt; `POST /auth/request-otp` |
| OTP | 6 boxes, auto-advance, 30s resend | Adopt; `POST /auth/verify-otp`; debug code in staging only |
| Onboarding | 6 steps: personal → vehicle → documents (license, registration, insurance) → face scan → background check → review | Adopt structure; map to our doc set (NATIONAL ID, licence, registration, health, insurance per NAVIGATION.md / ONBOARDING.md); **drop** self-approve + "Skip setup" |
| Pending | Checklist-style verification screen, animated progress | Adopt as passive state; approval is server-driven (`VerificationState`), never client auto-approve |
| Offline home | Greeting, today's earnings, promo/surge card, single GO ONLINE button | Adopt; compliance pre-check before going online (docs expired / suspension / reverification gate) |
| Online home | Green pulsing dot, rating pill, bell w/ unread badge, "Waiting for orders…", destination filter chip, bottom sheet: today's earnings + time online + GO OFFLINE | Adopt; filter + batch badge are follow-ons, not required |
| Matching / offer | Fullscreen takeover, countdown **ring**, pickup→dropoff route, customer notes, earnings box (base/tip/bonus/surge), ACCEPT / DECLINE | Adopt layout + ring; **countdown: blueprint 15s → our contract 120s** (API-CONTRACT.yaml). Decline → reason picker (drop: canned reasons list is fine to reuse locally), timeout → auto-decline `timed_out` |
| Pickup | Nav screen (turn-by-turn banner, ETA ring) → "I've Arrived" → At Restaurant: order-number, item checklist (check off each item), wait ticker, wait-pay banner, CONFIRM PICKUP | Adopt; statuses map to `rider_arrived_pickup → picked_up` (DELIVERY-FLOW.md). **Item checklist** maps to item verification; see contract order items. Wait-pay: see §4 |
| Delivery | Nav screen, customer notes card, call / chat buttons | Adopt; **masked** call/chat — `POST /orders/{orderId}/masked-call`, chat thread per order |
| At customer | Hand to Customer | Leave at Door with photo proof → CONFIRM & COMPLETE; Call / Message; "Can't reach customer" | Adopt both dropoff methods; `POST /orders/{orderId}/proof-of-delivery` (POD error codes in DELIVERY-FLOW.md) |
| Unreachable | 8-minute protocol modal (ring timer, call button, complete-under-protocol enabled only at 0:00, "earnings protected") | Adopt wholesale — see §4.4 |
| Completion | Green check pop, "Delivered!", earnings breakdown card, 5-star customer rating, BACK TO MAP | Adopt; rollup card is our completion summary (EARNINGS.md fare-sum rule) |
| Earnings / Trips / Profile | See §4 / §5 | Structure adopted; content per EARNINGS.md, PAYMENTS.md |
| System events | Centered alert modal w/ tone ring (red/amber), single action + dismiss | Adopt; QA/dev triggers in staging (Profile → System Events) |
| App offline | Amber banner "orders paused", pending-sync pill, queue-flush on reconnect | Adopt as concept; see backend SYNC/offline-queue notes |

Decline reasons (blueprint): Restaurant closed, Order not ready / too long,
Unsafe area, Vehicle issue, Personal emergency, Other — with a warning that
frequent cancels reduce promotion eligibility. Keep, wording localized.

### 3.1 Offer modal anatomy (adopted layout, contract timing)

1. Fullscreen takeover, 300ms slide-up; no tab bar, no back affordance.
2. Countdown ring: 36px-radius SVG ring in success green over surface ring,
   1000ms linear deplete; number center, `font-black` 24px. Blueprint total
   15s; **Hudumika shows 120s** (contract offer window) — same ring, different
   denominator.
3. Restaurant card: emoji tile, name, address, "Open" pill.
4. Route card: green dot → red pin rail, Pickup / Drop-off labels, three
   stat columns (distance, pickup ETA, trip time).
5. Customer notes card (italic quote).
6. Earnings box: soft green gradient panel, "Estimated earnings" label,
   hero `font-black` figure, sub-rows base / tip / bonus / surge multiplier.
7. Actions: full-width green ACCEPT, outline red DECLINE; timeout auto-declines
   with a toast explanation and reschedules the next dispatch.

### 3.2 Pickup / delivery step sequences (adopted)

Pickup: Nav (turn-by-turn banner, ETA ring `MM:SS`) → "I'VE ARRIVED" →
At Restaurant: call button, wait ticker with free-window/wait-pay switch,
order-items checklist (check per line, pill `n/total`, all-checked unlocks
confirm), pickup instructions w/ order number → CONFIRM PICKUP (wait-logged) →
"Report an issue" / "Cancel delivery" escape hatches.

Delivery: Nav (red ETA ring, customer-notes card) → "I'VE ARRIVED" → At
Destination: Hand to Customer (primary), Leave at Door (secondary) → Photo
Proof (tap to capture, green verify badge, CONFIRM & COMPLETE disabled until
captured) → Completion: green check pop, "Delivered!", earnings breakdown,
5-star customer rating (amber stars), BACK TO MAP.

## 4. Money UX

### 4.1 Earnings dashboard

- Hero: "Today's earnings" in Inter Black 48–64px, `tabular-nums`.
- Mini-stats row: Trips, Online time, Avg per trip.
- Weekly bar chart (7 bars, today highlighted green + glow; value labels above
  bars, day labels below).
- Promotions: amber-gradient cards, progress bar, progress pill, "Claim {reward}"
  button when claimable, toggles to "Claimed".
- "Available to cash out" row + "Cash Out" button → modal: method + fee
  (blueprint: Instant, `$0.50`), confirm → spinner → success ("on its way").
  Blueprint has "payout active" pill in header.

### 4.2 Money display rules (ours)

- **Never floats.** Contract money is TZS integer minor units; render grouped
  integers: `TZS 12,500` via `Intl.NumberFormat('en-TZ')`-style grouping.
- Blueprint rendered `$12.50` floats — that presentation style is dropped;
  the layout (hero number, breakdown rows, green totals) is kept.
- Big numbers: bold black (`font-black`) numerals, green for earnings.
- Surge shown as `×1.4` multiplier pill (amber); wait-pay and bonus rows in
  amber with `+` prefix; totals green `font-black`.
- Stateful money labels: "Claimed" (promotion), "Free window" vs "Wait pay ·
  5m" — never render a `0` value where a state label communicates more.

### 4.3 Payouts (blueprint vs ours)

Blueprint sells a single "Instant — $0.50 fee" cash-out modal (confirm →
spinner → "on its way to your bank"). Hudumika productizes both tiers per
PAYMENTS.md / PAYOUTS-LEDGER.md:

| | Blueprint (drop) | Hudumika |
|---|---|---|
| Speed | Instant only, fixed fee | Instant + standard (schedule per PAYMENTS.md) |
| Method of record | "Chase ••4821" hardcoded | Wallet/payout method from contract |
| Verification | None | PIN/session verification before payout (AUTH/PAYMENTS.md) |
| Ledger | Notional | Real ledger; every payout line reconciles (PAYOUTS-LEDGER.md) |

Keep the modal shape (method card, amount hero, confirm → progress → success),
swap the semantics for contract-backed payout calls.

### 4.4 Wait-pay math (blueprint: adopt the shape, contract rate)

```text
billable = max(0, waitSeconds - 5*60)     // 5-minute free grace window
waitPay  = (billable / 60) * rate         // blueprint: $0.20/min
```

Banner shows "Wait pay · 5m" with `+` value once billable; "Free window" while
inside grace. Breakdown row: "Wait pay (7m) · +TZS …". **Rate and grace are
contract-controlled** (API-CONTRACT.yaml fare breakdown, `waitPayTZS`) — render
server values verbatim, never recompute client-side as authoritative.

### 4.5 Unreachable 8-minute protocol (adopt verbatim)

1. Driver taps "Can't reach customer"; modal opens with 8:00 ring counter.
2. CTA: "Call customer" (masked call) + body text: call first, then wait the
   full 8 minutes before closing.
3. "Complete under protocol" is disabled until 0:00; expiry flips ring to
   green + check.
4. Completion message: "Unreachable protocol complete — earnings protected."
5. Outcome: order closes as delivered/returned per contract
   (`POST /orders/{orderId}/failed-delivery` / return paths in DELIVERY-FLOW.md).

## 5. Safety & engagement patterns

| Pattern | Blueprint notes | Hudumika |
|---|---|---|
| SOS | In-profile safety affordance | `POST /sos` (contract); keep entry points on profile + in-trip menus |
| Trusted contacts | Contact list + share status | Keep concept; contract `contacts`/riders/me/sync |
| Trip share | Public share page (`/share/[code]`), short code, expiry | Adopt shape; contract `POST /riders/me/trips/{orderId}/share` — **our expiry is 4h**, modeled server-side |
| Notification inbox | Typed: order / earnings / promotion / system / warning; color-coded pills: warning=red, promotion=amber, earnings=green, else blue; unread red badge on bell; Mark all read | Adopt; types per NOTIFICATIONS.md |
| Support tickets | Issue reporter w/ category + canned agent replies | Adopt ticket flow; **drop canned auto-replies** — real agents/support per SUPPORT.md |
| QA / dev triggers | Profile → System Events fires all edge states: order cancelled, customer unreachable, payment issue, GPS error, app offline, fraud detection, account suspension, document expired, low rating, low acceptance, identity reverification, surge, incentive unlocked | Keep in **staging only** (debug-code box pattern already exists); never in prod builds |
| Offline resilience | Offline banner, queued actions, flush on reconnect | Concept adopted; sync mechanics are backend's (API-CONTRACT.yaml) |
| Chat | Thread per order, smart-reply chips (customer simulation) | Adopt thread UI; drop simulated customer replies |

Tone conventions: red = blocking/account-level, amber = attention, green =
success/money, blue = informational/link.

## 6. Take / Drop summary

| Take for Hudumika | Drop for Hudumika |
|---|---|
| One-big-state-machine app model (splash → … → completed → loop) | Simulated CSS map (deep-link to real maps app; `EXPO_PUBLIC_MAPS_SCHEME` per NAVIGATION.md) |
| Glanceable dark cards: hero earnings number, mini-stats, status pills | Hardcoded demo persona, USD, San Francisco coordinates |
| Offer modal: fullscreen takeover, countdown ring, route card, earnings box, ACCEPT/DECLINE | 15s countdown → **our 120s** (contract) |
| Unreachable 8-minute protocol (call → full wait → complete, earnings protected) | Self-approve onboarding / "skip setup" / demo auto-approve |
| Wait-pay math shape: 5-min grace then per-minute pay | Canned agent + smart-reply customer simulation |
| Earnings rollup card (base / surge / tip / bonus / wait-pay / total) | Plaintext demo sessions (contract auth: OTP, server sessions) |
| Item checklist, photo-proof dropoff, decline-reason picker | Web-only Next.js stack (we are Expo/React Native, zero tests in source) |
| Typed notification inbox, tone system (green/amber/red/blue) | Client-authoritative status transitions (we render server-returned `Order`) |
| Trip share w/ expiry, SOS, trusted contacts, staging QA event triggers | Money rendered as floats — we render `TZS 12,500` integers only |

## 7. Related Hudumika docs (authority)

| Doc | Covers |
|---|---|
| `rider-mobile/docs/NAVIGATION.md` | State-machine principle, screen map, on-boarding/auth flow |
| `rider-mobile/docs/DELIVERY-FLOW.md` | 7-stage status progression, POD error codes, failed-delivery/return/reschedule branches |
| `rider-mobile/docs/EARNINGS.md` | Fare-sum rule, ledger, dashboard analytics, TZS integer rendering |
| `rider-mobile/docs/ONBOARDING.md`, `PAYMENTS.md`, `NOTIFICATIONS.md`, `SUPPORT.md` | Onboarding wizard, payout cycles, inbox types, support |
| `backend/API-CONTRACT.yaml` | The binding surface: `POST /orders/{orderId}/status`, `POST /orders/{orderId}/proof-of-delivery`, `POST /sos`, `POST /orders/{orderId}/masked-call`, earn-ings/payout and notification endpoints |

> Contract paths are authoritative. If this document and the contract ever
> disagree, the contract wins and this document should be corrected.