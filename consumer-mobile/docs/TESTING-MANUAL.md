# Consumer App — Complete Manual Test Plan (Real-World)

Covers **all 140 operations** (OPERATIONS-COVERAGE.md A–Q) across every screen. App: Expo SDK 57 (web at :8082, native via EAS). Mock mode is default (demo phone `+255700000000`, mock OTP debug code shown on-screen). Contract-live vs mock-only paths degrade gracefully (error/retry) against a live backend until Team 6 adopts them (docs/CONTRACT-ADDITIONS.md).

Legend: ✅ testable now (mock) · 🔶 contract-live (needs backend) · ⚠️ native-only (needs device)

---

## 0. Pre-flight checklist

- [ ] Open the app → `Choose your city` appears (no crash)
- [ ] Demo login: `+255700000000` → Send code → enter the shown debug code → continue
- [ ] Verify each seeded record exists (from mockState): merchants (Kilimanjaro Eats, Coastline Grill, Mama Nne Foods…), providers (Plumber svc_001…), orders (ord_active_001, ord_intercity_002, ord_warehouse_003, ord_rush_008…), bookings (bk_active_001, bk_quote_002, bk_declined_003, bk_noshow_004, bk_confirm_005…), coupons (WELCOME20, FREEDEL…), group-buys (gb_001/002), vouchers (VD-…), wallet (TZS 29,981), membership (240 pts, bronze), notifications (3), conversations (conv_001 open, conv_002 blocked), hotel (hotel_seafront_001), travel options (Dar→Mwanza bus/ferry, Dar→Arusha bus/flight, Dar→Dodoma bus/train), events (evt_concert_001…), live-deals (lds_live_001), split (spl_seed_001), group-order (gor_seed_001), red packets (2), invoices (INV-2026-0142…), withdrawals (2), disputes (disp_001/002/003), shipments (shp_1042/2048/1107), tracking-share token (ts_ord_warehouse_003_demo8f).

---

## A. User Account & Identity (ops #01–#10)

### A1 Login — OTP (#02, #04) ✅
1. `/login` → enter `+255700000000` → **Send code**.
2. Expected: navigates to `/verify-otp`, debug code visible, 60s resend countdown.
3. Enter a wrong code → inline `Wrong code` error (OTP_INVALID); 5 wrong → `Too many attempts` (OTP_MAX_ATTEMPTS); request a new code and verify the old request dies.
4. Enter the correct code → haptic + session → `/onboarding` (first time) or `/home`.
5. **Resend**: wait for countdown → tap **Resend** → new requestId issued, new debug code; resend again within 60s → rate-limit copy with `retryAfterSeconds`.

### A2 Signup (#01) ✅
1. `/login` → **Sign up** segment → send code → verify. Expected: same OTP flow, `signup` purpose, session created.

### A3 Forgot password (#05) ✅
1. `/login` → **Forgot password** → verify OTP. Expected: `password_reset` purpose request, works like login.

### A4 Social login (#10) ✅
1. `/login` → **Google** (or **Apple**) → explainer sheet → **Continue**. Expected: session created (demo), routes to `/onboarding`; **Cancel** closes.

### A5 Logout (#03) ✅
1. Profile tab → **Logout** → confirm. Expected: returns to `/login`, SecureStore cleared, session anon.

### A6 Update profile (#06) ✅
1. Onboarding step 2 (name + language chips en/sw/ar) → **Save**. Expected: PATCH /users/me, name appears on Home greeting; language switches immediately.
2. `/settings` → Language segmented → switch → persists + PATCH /users/me.

### A7 Delete account (#07) ✅
1. `/settings` → **Delete account** → confirm. Expected: POST /privacy/delete → logout → `/login`.

### A8 Sessions (#08) ✅
1. `/security` → session rows with current badge → **Revoke** a non-current session (2-step confirm) → row removed; revoking current is blocked.
2. Expire/refresh path: force a 401 (clear token) → single-flight refresh → replay works.

### A9 2FA (#09) ✅ (mock)
1. `/security` → **Two-factor authentication** → **Enable** → demo code sheet (`123456`).
2. **Disable** → wrong code → `Invalid code`; correct code → disabled.
3. Verify `verifyTwoFactor` round-trip via tests.

### A10 Password change — `/change-password` ✅
1. Current + new (< 8 chars → inline validation) + confirm mismatch → error.
2. Valid → toast + back. Wrong current → `UNAUTHORIZED` copy.

---

## B. Location & Address (ops #11–#18)

### B1 GPS detection (#11, #17, #18) ✅ (web) / ⚠️ (native)
1. Onboarding city picker → **Use my location** → permission sheet copy → Allow.
2. Expected: browser GPS fix → nearest seeded city auto-selected + detected service-area pill. Deny → friendly error + manual pick still works.
3. Home header **locate** icon → same detection updates the city.

### B2 Address CRUD (#12–#15) ✅ (local store; server surface pending)
1. `/addresses` → **Add** → form (label/lines/landmark/instructions/phone) + **Use current location** (fills lat/lon + map preview) → Save.
2. Edit (tap row/pencil) → prefilled → Save. Delete (trash). Radio → set default.
3. Select an out-of-service-area address → refused (`Address outside service area`).

### B3 Service-area validation (#16) ✅
1. Add an address whose area isn't in the selected city → danger flag + disabled selection.

---

## C. Discovery & Search (ops #19–#26)

### C1 Search (#19) ✅
1. Home search bar → type (300ms debounce) → suggestions dropdown → submit → results page (mixed entity types).

### C2 Filters + sort (#20, #21) ✅ (client + mock server)
1. Results → **Filters** → rating chips (4.5/4/3), max price, type chips; badge shows active count; **Clear all**.
2. **Sort** → relevance/rating/price asc/desc/distance → order changes.
3. **Grid/List toggle** persists.

### C3 History + clear (#22, #23) ✅
1. `/search` → recents appear after searches → **Clear** empties (DELETE /search/history).

### C4 Autocomplete (#24) ✅ — suggestions appear while typing; tap to submit.

### C5 Voice search (#25) ✅ (web Speech API) / ⚠️ (native)
1. Mic button → allow mic → speak → transcript fills input + auto-submits (`?voice=1`).
2. Unsupported browser → toast + input focus.

### C6 Image search (#26) ✅
1. Image button → picker → select image → thumbnail → results (`?image=`).

### C7 Saved searches ✅
1. **Star** next to recents → saved; `/favorites` Saved segment lists them; delete via X; tap runs the search.

---

## D. Restaurants & Food (ops #27–#37)

### D1 Merchant list (#27) ✅ — Home nearby cards + campaign pills; open/closed pill; rating; ETA.

### D2 Merchant detail + menu (#28–#30) ✅
1. Card → `/merchant/{id}`: catalogue grouped by category; item rows; out-of-stock disabled; closed merchant → banner + add-to-cart disabled + **Chat** + **Reserve a table**.

### D3 Dish configuration + cart (#31–#35) ✅
1. Item → **DishSheet**: required option choices, addon toggles, qty 1–99 → **Add to cart** (haptic + cart bar appears).
2. `/cart`: per-merchant groups; −/+ steppers (1–99, clamp); trash removes; X clears group; **note** per line.
3. **Product page** (`/product/{merchantId}/{itemId}`) → same configurator + honest coming-soon markers.

### D4 Favorites (#36, #37) ✅
1. Merchant detail heart toggles (optimistic, rollback). Home card heart overlay toggles. `/favorites` lists them; heart/remove.

### D5 Closed-merchant gating ✅
1. Open a closed seed merchant → all add-to-cart disabled; banner; Chat + Reserve still work.

---

## E. Services, Providers & Bookings (ops #38–#45, #69–#72)

### E1 Providers (#38, #39) ✅ — Services tab → providers list → detail (verified badge, trade, base rate, preferred toggle).

### E2 Service categories + questionnaire (#40, #42) ✅
1. Services tab → category → `/service/{id}` (pricing model, duration, cancellation rules, questionnaire preview, providers) → **Book** → `/book?serviceId=`.
2. `/book`: schedule mode chips (ASAP/Today/Tomorrow/Pick date) + time + date chips; duration; description; payment method chips (smart default); questionnaire (text/number/yes-no/single/multi/**photos** via picker ≤4); estimate card with retry.

### E3 Book + pay (#42) ✅
1. Submit → create booking → intent → STK-push wait → paid → `/booking/{id}`. COD → placed directly.
2. Errors: `BOOKING_TIME_IN_PAST`, `BOOKING_DURATION_INVALID`, `BOOKING_PROVIDER_UNAVAILABLE`, payment set.

### E4 Quote flow ✅
1. Open `bk_quote_002` → quote card (labor/parts/trip rows, note, expiry) → **Approve** / **Reject** (reason) / **Ask provider** (note; mock flag). Revised-quote banner when data exists.

### E5 Booking lifecycle (#69–#71) ✅
1. `bk_active_001` (provider_accepted): scheduled countdown, cancel → reason sheet.
2. `bk_confirm_005` (awaiting_customer_confirmation): **Complete** → completed; **Problem** → prefilled support ticket.
3. `bk_declined_003`: **Request another provider** → `/book`; **Cancel with refund** → refunded.
4. `bk_noshow_004`: no-show banner + refund/dispute CTA.
5. Completed booking: **Rate your provider** → `/review?targetType=provider`; **Book again** → prefilled; invoice/warranty/proof cards (or "not issued" fallback).
6. Pending payment: **Pay now** + **Pay via checkout** (`?transactionType=booking`).

### E6 Provider availability (#43) ✅ — availability shown from seeded data on service/detail screens.

### E7 Favorite providers (#44, #45) ✅ — preferred toggle on provider detail; "Your preferred providers" section on Services tab. (Contract favorites remain merchant-only; provider favorites are the mock-first preferred surface.)

---

## F. Grocery & Retail (ops #46–#52)

### F1 Retail browse (#46) ✅ — retail merchants flow through the same catalogue; home categories include retail.
### F2 Product detail (#47) ✅ — `/product/...` (price, compare-at where present, options, qty, add-to-cart).
### F3 Cart ops (#48–#50) ✅ — same as D3; retail items per-merchant groups.
### F4 Retail favorites (#51, #52) ✅ — merchant-level hearts (contract-scoped).

---

## G. Hotels, Travel, Events (ops #53–#60)

### G1 Hotels (#53–#56) ✅
1. `/hotels` → filters (check-in/nights/guests) → card → `/hotels/{id}` → rooms → **Select** → sheet (dates, guests ≤ capacity, phone) → **Book & pay** → `/hotel-bookings/{id}`.
2. My bookings section; pending_payment → **Pay via checkout** (`?transactionType=hotel`); no-cancel note.

### G2 Travel (#57, #58) ✅
1. `/travel` → origin/destination pickers → date chips → mode chips (All/Bus/Ferry/Flight/**Train**) → **Search** → option cards (provider, departure/arrival local, duration, seats) → **Book** → passengers + phone → `/travel-bookings`.
2. Train: TAZARA Dar→Dodoma (mock extension).

### G3 Events + tickets ✅
1. `/events` → category chips → event → tiers → **Select** → qty (1–10) → **Buy** → tickets with codes → `/events/tickets`. Sold-out tier → disabled; 409 → refetch.

---

## H. Orders, Tracking & Activity (ops #61–#68, #72–#77)

### H1 Place order (#61) ✅ — checkout flow (see J). Confirmation screen (#62): order no, ETA, items, address, payment, **Track order** + **Back home**.

### H2 Activity center (#63, #64, #137) ✅
1. Orders tab → segments: Orders/Bookings/Dine-in/Reservations/Vouchers; active first; per-segment empty states with CTAs; live refresh on events.

### H3 Order detail (#65) ✅ — timeline from events, refund card (intent), disputed/reject/warehouse banners, points-earned pill.

### H4 Cancel (#66) ✅ — reason sheet → cancelled; `ORDER_NOT_CANCELLABLE` → refetch.

### H5 Modify request (#67) ✅ — **Request change** (active orders) → type chips + note → pending approval; 409 → refetch.

### H6 Reorder (#68) ✅ — order detail **Reorder** + Home quick action → cart prefilled → checkout.

### H7 Tracking (#72–#75) ✅
1. `/order/{id}/tracking`: rider map + ETA (server), six-phase strip, route legs (Day 1/2), waybill trail, delivery-window card, delay banner (intercity), Advanced disclosure, stale warning, offline banner.
2. **Simulate delay** (dev, ord_intercity_002) → window shifts + exception row + banner.
3. 15s poll + realtime events refetch. 404 → "Tracking unavailable".

### H8 Push (#76) ⚠️ (native) — registration on login, unregister on logout, tap → deep link. (Web: in-app notifications only.)

### H9 Trip-share (#77) ✅
1. Tracking → **Share trip** → token link (`hudumika://track-share/{token}`).
2. Open `/track-share/ts_ord_warehouse_003_demo8f` → read-only view (no actions, watch banner, live poll). Invalid/expired token → "Tracking unavailable".

### H10 Rush ✅ — `/order/{orderId}` on `ord_rush_008` → **Hurry up** → rush requested; `ORDER_RUSH_NOT_ALLOWED` elsewhere.

### H11 Tip ✅ — delivered/completed → **Tip** sheet (amount chips/custom, method chips, note) → sent pill; non-delivered → hidden.

### H12 Masked call ✅ — tracking **call** → masked number toast (real number never shown).

---

## I. Payments & Wallet (ops #78–#91)

### I1 Payment methods (#78–#80) ✅
1. `/payments` → list with Default pill → **Set as default** → **Remove** (confirm) → **Add** (contract-enum chips, skips existing). `available:false` (card) disabled.

### I2 Payment flow (#81) ✅
1. Checkout → method select → **Pay** → STK-push wait → confirm → paid → confirmation. 
2. Error matrix: `PAYMENT_PROVIDER_ERROR` (retryAfter countdown), `PAYMENT_ALREADY_PAID` (→ confirmation), `PAYMENT_INTENT_NOT_FOUND` (recreate+refetch), `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_METHOD_UNSUPPORTED` (chip disabled), `PAYMENT_REFUND_PENDING` (banner), `PAYMENT_SIGNATURE_INVALID` (support copy).

### I3 Refunds (#82) ✅ — cancelled/refunded order shows green refund card (amount + providerReference + paidAt); partially_refunded handled.

### I4 Wallet (#83–#86) ✅
1. `/wallet`: balance; **Top up** (presets + method chips + idempotency) → credit + transaction; **Withdraw** (amount presets/percent + destination phone/account validation) → record; transaction rows → **Report issue** (type chips + description); history + refund summary.

### I5 Coupons (#87–#89) ✅
1. `/coupons` claim (available → claimed, used/expired/void pills); checkout selector + **suggested-coupon chip** (best applicable); `COUPON_MINIMUM_SPEND_NOT_MET`/`EXPIRED`/`ALREADY_USED` clear with copy; **Remove coupon**.

### I6 Invoices (#90, #91) ✅
1. `/invoices` → rows (number/kind/amount/status) → detail → **Download** (issued/paid) opens the receipt URL. Empty → "No invoices yet".

---

## J. Communication (ops #92–#100)

### J1 Chat (#92–#95) ✅
1. Messages tab: filter chips (All/Open/Archived/Blocked); unread badge (tab icon); infinite scroll.
2. Thread: send (optimistic, rollback + draft restore on failure), attachments (≤4, remove chips), **Load older**, auto mark-read, `MESSAGE_RATE_LIMITED` countdown (send twice fast).
3. `conv_002` (blocked) → read-only banner, no composer.
4. From order detail **Chat** → prefilled conversation.

### J2 Masked calls (#96, #97) ✅ — tracking call sheet → masked number; inbound call is a native concern (⚠️).

### J3 Notifications (#98–#100) ✅
1. `/notifications`: category chips, mark-all-read, per-item tap → markRead + deep-link nav (allow-listed only), pagination, live prepend.
2. Preferences: 7 sections, 28 per-event toggles, system/security locked with helper text; save optimistic + rollback; `PREFERENCE_INVALID_EVENT` highlights the row.

---

## K. Reviews & Ratings (ops #101–#107)

### K1 Review creation (#101, #102) ✅
1. Order detail → **Review** (delivered/completed) → stars + body (+ provider: 6 dimension rows + would-recommend) → submit → pending pill + points pill.
2. Review again → `REVIEW_ALREADY_EXISTS` → shows existing.

### K2 My reviews (#105) ✅ — `/reviews` (profile → My reviews): state chips (pending/published/hidden/deleted), verified-purchase badge + merchant reply display, thumbs up/down (#107), **Report** sheet (#106), **Edit** (#103) → prefilled form, **Delete** (#104) → confirm.

---

## L. Loyalty & Rewards (ops #108–#116)

### L1 Points + membership (#108–#113) ✅
1. `/membership`: balance, tier, benefits; ledger (earn/redeem/check_in/bonus/expire/adjust); **Check-in** (once/day, streak + day-7 bonus, 409 handled); **Redeem** rows (500pts→TZS 5,000 etc.) with insufficient-balance disabled + shortfall; points-earned pills on orders/reviews.

### L2 Check-in (#114) ✅ — see L1; second same-day → "already checked in".

### L3 Referral (#115, #116) ✅
1. Profile → referral card: copy/share code (`hudumika://referral/HUDU-DEMO-25`); `/referrals` → **Have a code? Claim** → claim (self-code/unknown/already-claimed errors); deep link prefills.

### L4 Birthday reward ✅ — profile card (when not in benefits) → **Claim** → credited; double-claim → handled.

---

## M. Favorites & Saved (ops #117–#120)

### M1 Favorites (#117–#119) ✅ — hearts (merchant/home/product), `/favorites` segments (merchants real; providers/dishes honest coming-soon).
### M2 Lists (#120) ✅ — `/favorites` Lists segment: create (name), open, add merchants, remove, delete; curated lists (`/list/{id}`) via the Lists repo.

---

## N. Settings & Privacy (ops #121–#127)

### N1 Notification prefs (#121) ✅ — J3.
### N2 Language (#122) ✅ — A6.
### N3 Privacy/consent (#123) ✅ — `/privacy`: 9 purpose toggles (location routes through the permission sheet); recommendations gated on personalization consent; **Export my data** → job id toast (#127).
### N4 App version/update (#124, #125) ⚠️ — About section (env links); store update = native.
### N5 Clear cache (#126) ⚠️/CLIENT — storage cleared on logout (documented).
### N6 Change password ✅ — A10.

---

## O. Support & Help (ops #128–#135)

### O1 Help center (#128, #129) ✅ — `/help`: 300ms search, articles, detail, contact CTA.
### O2 Tickets (#130–#133) ✅
1. `/support`: create (subject + category chips incl. feedback + body) with `?orderId=`/`?bookingId=` prefill; list → detail → **Reply**; `TICKET_CLOSED` handled; closed banner.
### O3 Live support chat (#134) ✅ — support conversations render through the conversation surface (staff role).
### O4 Feedback (#135) ✅ — feedback category chip → ticket.

---

## P. Cross-Category (ops #136–#140)

### P1 Category switching (#136) ✅ — tab bar + home category grid → filtered search.
### P2 Unified dashboard (#137) ✅ — H2 + home feed sections (quick actions, membership card, recent orders, flash deals, live deals banner, curated lists, recommendations, providers, nearby).
### P3 Share (#138) ✅ — order/booking share buttons; group-order/split/red-packet/referral/track-share links; web clipboard fallback.
### P4 Print (#139) ⚠️/CLIENT — invoice download is the print surface (native print planned).
### P5 Preferred providers (#140) ✅ — E7.

---

## Q. Super-App Deep Flows

### Q1 Group buy → vouchers ✅ — `/group-buys` (countdowns) → detail (savings, qty 1–20) → **Buy now** → vouchers issued → `/vouchers` (Use → code panel; redeemed/expired/refunded/void states; `VOUCHER_REFUND_PENDING` banner; 48h expiry reminder native).
### Q2 Dine-in QR → bill → split ✅ — `/dine-in`: manual QR / **Scan** (camera) → table menu → basket → **Open bill** → **Pay** (intent) → paid; **Split the bill** → presets/custom → `/dine-in-splits/{id}` → **Mark my share paid** → completed; `DINE_IN_TABLE_IN_USE` → jump to open bill.
### Q3 Red packets ✅ — wallet card → `/red-packets` → **Claim** (credits wallet) → **Share** (create: title/amount/count/expiry) → link/copy → deep link opens.
### Q4 Group ordering (拼单) ✅ — `/cart` → **Start group order** → `/group-order/{id}`: members, add/remove items, invite share, countdown, payment+address, **Finalize** → order confirmation.
### Q5 Split payments ✅ — checkout **Split the payment** (2/3/4 presets or custom, live sum validation) → `/splits/{id}` → **Pay my share** → **Complete**.
### Q6 Live deals + chat ✅ — `/live-deals` → session → `/live/{id}`: countdown, deals, **View merchant**, live chat (send/echo/rollback).
### Q7 Assistant ✅ — `/assistant` (home quick action): chat, suggestion chips, draft restore on failure.

---

## R. Offline & Resilience ✅

1. DevTools → Offline → offline banner; cart/favorites/chat still usable (cached).
2. Queue: perform a chat send while offline → queued with its idempotency key → go online → replayed (no double-send).
3. Sensitive ops fail fast offline (payments/cancel/quote) with clear copy — never queued.
4. Tracking keeps last-known data during poll failures; offline banner in tracking view.

## S. Deep Links (allow-list: order, booking, ticket, conversation, dine-in, reservation, red-packet, voucher, group-order, referral, split, track-share)

1. Each payload form: `hudumika://route/id`, `https://app.hudumika.tz/route/id`, bare `route/id` → correct screen; each screen refetches before render.
2. Unknown/malformed → no navigation (root stays).

## T. Regression gates (run after any change)

- [ ] `npm run typecheck` (app + component-tests + e2e)
- [ ] `npm run lint` (0 errors)
- [ ] `npm test` (598 expected)
- [ ] `npm run test:unit` (71 expected, 24 suites)
- [ ] `npx expo export --platform web` succeeds
- [ ] Parity harness exact (tests/contract-parity.test.ts) — 0 invented codes
- [ ] i18n parity: en/sw/ar identical key sets (1325+ keys)
- [ ] e2e specs typecheck (`tsc -p e2e/tsconfig.json`)

---

## Test-data cheat sheet (seeded ids)

| Entity | Ids |
|---|---|
| Orders | ord_active_001 (delivering), ord_intercity_002 (intercity), ord_warehouse_003 (warehouse), ord_rush_008 (preparing), ord_completed_004/005, ord_refunded_006, ord_disputed_007, ord_relay_005 |
| Bookings | bk_active_001, bk_quote_002 (quote), bk_declined_003, bk_noshow_004, bk_confirm_005, bk_disputed_101 |
| Conversations | conv_001 (open), conv_002 (blocked) |
| Coupons | WELCOME20, FREEDEL, SUMMER25, OLD50 |
| Group buys | gb_001 (2-for-1), gb_002 (pilau bucket) |
| Vouchers | VD-8F3K-2026 + 4 per-status |
| Wallet | TZS 29,981; transactions incl. top-up + reportable rows |
| Membership | 240 pts bronze; check-in streak; ledger |
| Hotels | hotel_seafront_001 (+2); rooms; hbk_seed_completed_001 |
| Travel | Dar→Mwanza bus/ferry; Dar→Arusha bus/flight; Dar→Dodoma bus/train (TAZARA) |
| Events | evt_concert_001 (Regular/VIP/VVIP) + 2 |
| Live deals | lds_live_001 (live, chat seeded) + 1 scheduled |
| Splits | spl_seed_001 (3×7,100 on ord_rush_008) |
| Group order | gor_seed_001 (Demo Customer + Juma) |
| Red packets | 1 claimable (count 5), 1 fully claimed |
| Invoices | INV-2026-0142 (issued) + 2 |
| Withdrawals | wdr_seed_001 (paid) + created |
| Disputes | disp_001 (open/order), disp_002 (resolving/booking), disp_003 (resolved) |
| Shipments | shp_1042-MWZ, shp_2048-DAR, shp_1107-DAR |
| Trip-share | token ts_ord_warehouse_003_demo8f |
| 2FA demo code | 123456 |
| Referral code | HUDU-DEMO-25 |
| Demo phone | +255700000000 (OTP debug code shown on screen) |
