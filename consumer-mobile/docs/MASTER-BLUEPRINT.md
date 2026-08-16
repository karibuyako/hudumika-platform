# HUDumika Consumer App — Master Blueprint (v1 → Enterprise)

The complete specification the coding agent builds from. Every module, every
screen, every sub-screen, every modal/bottom-sheet, every state, every
transition, every API dependency, every permission, every realtime event, every
backend entity. Nothing is invented during development — it is all specified
here.

Source-of-truth documents: `backend/API-CONTRACT.yaml` (endpoints/schemas),
`functionalities/SHARED-FLOWS.md` (business rules), `functionalities/DESIGN-SYSTEM.md`
(tokens/components), `backend/LOGISTICS-OS.md` (multi-leg tracking model).

---

## 0. Vision and core principles

The consumer app is not an "ordering app" — it is the customer's **unified
marketplace and service-control center**:

```
                    CONSUMER APP
                         │
        ┌────────────────┼────────────────┐
        │                │                │
    DISCOVER          TRANSACT         MANAGE
        │                │                │
   Search            Orders           Account
   Browse            Bookings         Addresses
   Recommend         Payments         Wallet
   Maps              Delivery         Favorites
   Categories        Services         Reviews
```

Underlying verticals: Food · Retail · Home Services · Local Services · Travel ·
Hotels · Entertainment · Tickets · Appointments · On-demand Delivery ·
Long-distance Delivery · Subscriptions.

**The architectural rule**: the consumer UI is unified, but the underlying
transaction model changes per service — a restaurant order is not a plumber
booking is not an intercity shipment.

**The universal consumer promise**: *I need something → I describe/select it →
platform finds supply → I choose/confirm → I pay → platform coordinates
fulfillment → I track it → I receive it → I can get help.*

---

## 1. Universal transaction abstraction

Every consumer transaction shares a core shell (`Experience`):

```
EXPERIENCE
├── id
├── transactionType   (commerce | delivery | service | booking | reservation)
├── status            (typed per kind)
├── timeline          (events, UTC → local)
├── price             (PricingBreakdown)
├── provider          (merchant/provider/rider/hotel — masked as needed)
├── location          (delivery/service address; pickup)
├── payment           (intent, method, refund state)
├── support           (contextual help + ticket link)
├── dispute           (case id when open)
└── reviews           (eligibility + submitted state)
```

Specialized objects: `FoodOrder`, `RetailOrder`, `ServiceJob`, `DineInBill`,
`GroupBuyVoucher`, `HotelBooking`, `TicketBooking`, `Shipment`.

Mapping to contract:

| Transaction | Contract object | Status machine (customer view) |
| --- | --- | --- |
| Food/retail order | `Order` | confirmed → preparing → picked_up → delivering → delivered → completed |
| Service job | `Booking` | requested → provider_assigned → scheduled → en_route → arrived → in_progress → awaiting_confirmation → completed |
| Intercity shipment | `Shipment` + `TrackingPhase[]` | picked up → departed origin → in transit → arrived city → out for delivery → delivered |
| Dine-in | `DineInOrder` | open → billing → paid → closed |
| Group buy | `Voucher` | unused → redeemed/expired/refunded |
| Reservation | `Reservation` | pending → confirmed → seated → completed |

**Do NOT build five separate consumer experiences.** One `TransactionDetail`
shell renders the correct sections per `transactionType`.

---

## 2. App shell and navigation

```
┌─────────────────────────────────────────┐
│ Location      Search                🔔 │
├─────────────────────────────────────────┤
│              CURRENT SCREEN             │
├─────────────────────────────────────────┤
│  Home │ Orders │ Services │ Messages │ Me│
└─────────────────────────────────────────┘
```

Bottom tabs: **Home | Orders (Activity) | Services | Messages | Me**.
Specialized categories live inside Home/Explore — the tab bar stays stable
while the platform grows.

### Typed routes

```
/home
/search
/search/results?q=&category=&filters=
/restaurant/:merchantId
/product/:catalogueItemId
/provider/:providerId
/service/:serviceId
/cart
/checkout/:transactionType
/order/:orderId
/order/:orderId/tracking
/service-request/:bookingId
/booking/:bookingId
/shipment/:shipmentId
/vouchers
/coupons
/membership
/messages
/messages/:conversationId
/notifications
/support
/support/ticket/:ticketId
/dispute/:disputeId
/profile
/settings
/addresses
/payments
/wallet
/favorites
/reviews
```

Domain flows hang under these typed routes; no feature navigates directly to
another feature's internals.

---

## 3. Module: Onboarding & Authentication

### Screens
1. **Splash** — brand, session restore, reduced-motion aware; routes `/home` if
   authed else `/login`.
2. **Onboarding** (3 swipes: order anything / track everything / safety) —
   skippable, stored locally.
3. **Login** — phone-first OTP (`POST /auth/request-otp` +
   `POST /auth/verify-otp`), 6-digit code, resend countdown (60 s), debug-code
   box in staging; "Forgot password" reuses OTP (`purpose: password_reset`).
4. **Registration** — phone/email → OTP → profile setup (name, avatar,
   preferences).
5. **Profile Setup** — name, avatar, notification prefs, language.
6. **Address Setup** — first delivery address (see Location module).
7. **Payment Setup** — first payment method (M-Pesa/Tigo/Airtel/EzyPesa/
   Halotel/card/bank).
8. **Social login** — PLANNED (Google/Facebook), not v1; OTP is primary.

### States (every screen)
Loading spinner → error + retry (network) → invalid-input inline errors →
success transition. OTP: wrong-code error, max-attempts locked state.

### API dependencies
`POST /auth/request-otp`, `POST /auth/verify-otp`, `POST /auth/refresh`,
`POST /auth/logout`, `GET /users/me`, `PATCH /users/me`,
`GET /users/me/roles`, `POST /privacy/delete`.

### Permissions requested
None beyond network + storage; push permission is asked post-onboarding.

### Realtime events
`notification.created` (security alerts only pre-auth).

### Backend entities
`users`, `sessions`, `otp_requests`, `consents`.

---

## 4. Module: Location

### Data model (Address)
`country, region, city, district, street, building, apartment, floor, entrance,
landmark, lat, lon, label (Home/Work/Other), deliveryInstructions,
isDefault`.

### Screens
1. **Location bar** (persistent in header) — current + switch.
2. **Address picker** (bottom sheet) — saved addresses, recent, current GPS,
   map-selected, manual entry.
3. **Address form** (add/edit) — full address fields + landmark +
   instructions; geocode on save.
4. **Map selector** — full-screen map, pin, reverse-geocode.

### Rules
- Every marketplace decision derives from location: merchants, providers,
  delivery fee, ETA, service area, stock availability, hotel availability,
  transport availability.
- Address edits on active orders are read-only until completion.
- Purpose-limited: the app stores addresses the user saved; supply-side actors
  see only what fulfillment requires.

### API dependencies
`GET /cities`, `GET /cities/{id}/service-areas` (via cities resource),
saved addresses live under `users/me` profile surface or `PATCH /users/me`.

### Backend entities
`addresses`, `service_areas`, `geopoints`.

---

## 5. Module: Home (dynamic dashboard)

### Screen composition (dynamic order)
```
Location bar | Search | Notifications | Profile shortcut
├── Primary categories (grid, order changes by context)
├── Personalized recommendations (AI, PLANNED v3)
├── Nearby restaurants / stores / providers
├── Promotional banners (sliding)
├── Time-sensitive offers / flash sales (countdown)
├── Recent purchases / Reorder
├── Quick actions: Reorder · Track Order · Scan QR · Coupons
├── Daily check-in (points)
└── Membership status card
```

### Dynamic context inputs
Location · Time · Day · Weather · History · Inventory · Merchant availability ·
Promotions · Events · Season.

### States
Loading skeleton per section (not one giant loader) → per-section empty
("No restaurants near you yet") → per-section error + retry → content.
Banner carousel: dots, swipe, tap-through.

### API dependencies (BFF-aggregated — see §26)
`GET /home` (BFF) aggregating: `GET /services`, `GET /merchants` (nearby),
`GET /providers` (nearby), `GET /promotions` (active on merchants),
`GET /group-buys` (live), `GET /coupons/me` (claimable),
`GET /memberships/me`, `GET /orders/me` (recent, for reorder),
`GET /notifications/me` (unread count).

### Realtime events
`order.updated` (badge), `notification.created`, `campaign.updated`,
`settlement.created` (not customer), `chat.message` (badge).

### Backend entities
`categories`, `merchants`, `providers`, `promotions`, `group_buy_deals`,
`coupons`, `memberships`, `orders`, `notifications`.

---

## 6. Module: Search & Discovery (unified search engine)

Not `GET /products?q=`. A unified search with intent understanding.

### Screens
1. **Search entry** — input + voice button (IMPLEMENTED) + image button
   (IMPLEMENTED) + recent searches + saved searches + trending.
2. **Search results** — mixed result types by `entityType`:
   restaurant card, dish card, product card, store card, provider card,
   service package card, hotel card (v2), ticket card (v2), deal card.
3. **Filters sheet** — price range, rating, distance, availability, cuisine/
   category, delivery time, certifications (providers).
4. **Sort sheet** — relevance, rating, price asc/desc, distance, popularity.

### Search inputs to the engine
`query, intent, category, location, time, price, availability, distance,
rating, personalization`.

### Result type dispatch (by `entityType`)
| entityType | Card | Tap → |
| --- | --- | --- |
| restaurant | name/rating/distance/ETA/delivery fee/promos | `/restaurant/:id` |
| dish | name/price/restaurant/sales | `/restaurant/:id` (item highlighted) |
| product | image/price/stock | `/product/:id` |
| store | name/rating/distance/stock | store page (v2) |
| provider | verified/rating/jobs/price/available | `/provider/:id` |
| service_package | name/duration/price | `/service/:id` |
| hotel | photos/price/reviews | `/hotel/:id` (v2) |
| deal | discount/original price | `/group-buys/:id` |

### States
Typing → debounce (300 ms) → suggestions dropdown → results skeleton →
empty ("No results for 'xyz'") with suggestion chips → error + retry →
results grid/list toggle.

### API dependencies
`GET /search?q=&lat=&lon=&category=&entityType=` (BFF), `GET /search/suggest`
(autocomplete), `GET /search/history` (recent), saved searches (profile
surface). Image search `POST /search/image` IMPLEMENTED.

### Backend entities
`search_index` (Elasticsearch), `search_history`, `saved_searches`,
`categories`.

---

## 7. Module: Food ordering

### Screens
1. **Restaurant list** — grid/list cards: name, rating + review count, cuisine,
   distance, ETA range, delivery fee, promo badges, favorite heart;
   filters: cuisine, rating, delivery fee, distance, promos; sort: relevance/
   rating/delivery time/distance.
2. **Restaurant detail** — header (photo, rating, distance, ETA, delivery fee,
   status open/closed), promos strip, menu categories (sticky), items
   (name, description, price, image, customization chevron), dish detail sheet,
   reviews section, photos, store info + policies, favorite, "reorder"
   (from history).
3. **Dish detail** (bottom sheet/modal) — customization (options/addons with
   prices), quantity stepper, special instruction, "Add to cart".
4. **Cart** — grouped by merchant (see §13), item lines with options, quantity
   steppers, remove, subtotal, coupons (apply sheet), delivery fee preview,
   "Go to checkout".
5. **Checkout** — address (picker sheet), delivery time (ASAP/scheduled),
   payment method, coupon application, promo codes, price breakdown
   (subtotal/delivery/platform/tax/discount/total), tip (optional, IMPLEMENTED
   live via `POST /orders/{id}/tip`), special instructions, "Place order"
   (one-click reorder path).
6. **Order confirmation** — order number, ETA, items, address, payment,
   "Track order" + "Back to home".
7. **Order tracking** — see Module 14.
8. **Reorder** — from history, pre-fills cart → checkout.

### Customization model
```
base price
├── option group (size/crust) — one required choice
├── addons (extra cheese) — multi-select, +price
├── quantity
└── instructions (free text)
```
Pricing, inventory constraints, and promotion eligibility are computed
server-side at checkout — never trust cart state older than the validation
pass.

### States (all screens)
Loading skeleton → empty (restaurant list: "No restaurants match"; menu:
"Menu unavailable — store closed") → error + retry → success. Cart badge
animates on add. Checkout revalidates: item unavailable / price changed /
store closed / destination unservable → inline banners with reasons.

### API dependencies
`GET /merchants?cityId=&category=`, `GET /merchants/{id}`,
`GET /catalogues/{merchantId}`, `GET /orders/me` (history/reorder),
`POST /orders` (Idempotency-Key), `GET /orders/{id}`,
`POST /orders/{id}/cancel`, `POST /orders/{id}/rush`, `GET /orders/{id}/track`,
`GET /orders/{id}/timeline`, `POST /payments/intent`,
`POST /payments/{id}/confirm`, `POST /orders/{id}/tip`,
`GET /coupons/me`, `POST /coupons/{id}/claim`, `POST /orders/{id}/report-issue`
(via tickets), `GET /riders/assigned` (rider card).

### Realtime events
`order.created`, `order.updated` (status → each tracking step), `payment.captured`,
`chat.message`, `notification.created`, `order.rush` (ack).

### Backend entities
`orders`, `order_items`, `order_events`, `catalogues`, `catalogue_items`,
`payment_intents`, `coupons`, `conversations`, `chat_messages`.

---

## 8. Module: Instant retail (grocery & goods)

### Screens
1. **Store/product list** — departments grid (Fresh, Dairy, Snacks, Household…),
   product cards with stock badge, quick-add button.
2. **Product detail** — images, description, nutritional/attributes, price +
   compare-at, stock, reviews, related products, variants (size/color),
   quantity stepper, "Add to cart".
3. **Cart/checkout** — same as food but `transactionType=commerce`; supports
   intercity items with delivery-window promise (1–3 days) and
   warehouse-fulfilled items (`fulfillmentSource=warehouse`).

### States
Stock states: In stock · Low (n left) · Sold out (disabled add).
Warehouse fulfillment shows "Ships from nearest warehouse — arrives in X days".

### API dependencies
`GET /merchants?category=retail`, `GET /catalogues/{merchantId}`,
`POST /orders` (retail), `GET /orders/{id}/tracking-phases` (intercity),
`GET /warehouses` (stock hints, read-only), search endpoints.

### Realtime events
As food + `shipment.*` phase events for intercity retail.

---

## 9. Module: Services marketplace (plumbers, electricians, cleaners…)

### Screens
1. **Service category browse** — categories grid (Home Repair, Electrical,
   Plumbing, Cleaning, Beauty, Pets, Automotive…) from `GET /service-categories`.
2. **Category questionnaire** — dynamic intake from
   `GET /service-categories/{id}/questions`: what's wrong (single/multi
   choice), where (room), photos/video upload, urgency (Emergency/Today/
   Scheduled), preferred time. Answers travel with the booking
   (`BookingCreate.answers`).
3. **Provider list** — verified badge, rating, jobs completed, starting price,
   availability today, ETA, service area; filters: price/rating/distance/
   availability/experience/certifications/emergency.
4. **Provider detail** — bio, qualifications, certifications (verified),
   portfolio, service offerings (name/duration/pricing model), availability
   calendar, reviews, response time, completion rate, "Book".
5. **Booking screen** — service selection, date/time slot (availability),
   address, instructions, estimate display (`GET /bookings/estimate`),
   quote request option, payment method.
6. **Booking confirmation** — booking number, provider summary, slot, price
   (or "quote pending"), "Track provider".
7. **Quote approval** (bottom sheet/modal) — full breakdown labor/materials/
   travel/tax, reason, Previous vs Updated comparison when revised,
   Approve/Reject/Ask provider; every revision visible with timestamp.
8. **Booking tracking** — provider status + live location (see Module 14).
9. **Service completion** — proof summary (photos/signature), invoice,
   pay on-site (QR), warranty issued card, review prompt.

### States
Provider list: skeleton → empty ("No providers available in your area for
Plumbing") → error+retry → results. Availability calendar: month grid →
slot chips → selected state → booked (disabled). Quote: pending state with
countdown → approved/rejected/updated banners.

### API dependencies
`GET /service-categories`, `GET /service-categories/{id}/questions`,
`GET /providers?trade=&area=`, `GET /providers/{id}` (public),
`GET /providers/{id}/portfolio` (public), `GET /bookings/estimate`,
`POST /bookings` (photos, answers, contractId), `GET /bookings/me`,
`GET /bookings/{id}`, `POST /bookings/{id}/quote/decision`,
`POST /bookings/{id}/proof-of-service` (view), `POST /bookings/{id}/invoice`
(view), `POST /bookings/{id}/warranty` (view), `POST /bookings/{id}/cancel`,
`POST /bookings/{id}/complete`, `POST /payments/qr` (on-site pay),
`GET /reviews/me`.

### Realtime events
`booking.requested` (ack), `quote.issued`, `job.reminder`, `booking.*`
status events, `job.check_in`, `proof_of_service.submitted`, `invoice.issued`,
`warranty.issued`.

### Backend entities
`service_categories_config`, `service_questions`, `providers`,
`provider_services`, `provider_certifications`, `bookings`, `booking_quotes`,
`booking_parts`, `service_invoices`, `service_warranties`.

---

## 10. Module: Dine-in, group buy, vouchers, reservations

### Dine-in
1. **QR scan** (`hudumika:dinein:table:{id}`) → table menu.
2. **Table order** — menu → cart → send to kitchen → bill status.
3. **Bill** — items, pay (QR/intent), split PLANNED, close.
States: bill open → billing → paid → closed.

API: `POST /dine-in/orders`, `GET /dine-in/orders/me`,
`GET /dine-in/orders/{id}`.

### Group buy
1. **Deal list** (live) — discount badge, savings, expiry countdown.
2. **Deal detail** — buy quantity (1–20) → vouchers issued.
3. **Voucher wallet** — statuses unused/redeemed/expired/refunded; QR + code
   for redemption; expiry reminder.
API: `GET /group-buys`, `GET /group-buys/{id}`,
`POST /group-buys/{id}/purchase`, `GET /vouchers/me`.

### Reservations
1. **Reservation form** — merchant, party size, time, note.
2. **My reservations** — pending/confirmed/seated/completed/cancelled/no_show.
API: `POST /reservations`, `GET /reservations/me`,
`POST /reservations/{id}/cancel`.

---

## 11. Module: Travel, hotels, entertainment (IMPLEMENTED — formerly Phase 5)

Hotels, travel, and entertainment events are IMPLEMENTED (screens
`src/app/{hotels,hotel-bookings,events,travel,travel-bookings}.tsx`; live
repos `src/repos/api/{hotels,travel,events}.ts`); ride-hailing/mobility
remains PLANNED long-term. Specified:

- **Hotel search/detail/booking** — destination, dates, guests; room types,
  amenities, reviews, map; `HotelBooking` transaction (Booked → Check-in →
  Stay → Check-out). Contract additions planned (rooms as catalogue items,
  `reservation` reuse for stays).
- **Movie/event listings** — showtimes, theaters, seat selection, tickets;
  `TicketBooking`.
- **Ride-hailing/mobility** — PLANNED long-term; reuses `DispatchOffer`
  pattern.

These modules reuse the universal shell; only the detail/booking UIs are new.

---

## 12. Module: Cart & checkout (multi-merchant boundaries)

### Cart model
```
CART
└── CartGroup (per merchant)
      ├── merchantId, merchant name
      ├── items[] (item, options, qty, unit price)
      ├── special instructions
      ├── coupon (per merchant)
      └── subtotal
```

Checkout boundaries are explicit: each CartGroup becomes its own `Order`
with its own payment, delivery, tax, discount, ETA, cancellation, and refund
rules. A mixed cart never merges into one logistics transaction.

### Checkout pipeline (server-side validation, never trust stale cart)
```
CART → Validate (availability, open, servable, price, promotion, delivery)
     → Pricing (Pricing Engine) → Promotion → Delivery → Tax/fees → Payment
     → Order creation (Idempotency-Key) → Confirmation
```

### Screens
1. **Cart** — grouped, per-group coupon apply, collapse/expand groups,
   "Checkout all" vs per-group checkout (v1: per-group).
2. **Checkout** — the universal checkout shell per `transactionType`:
   address → time → payment → coupon → price breakdown → confirm.
3. **Payment** — method selection, provider flow (STK/USSD/card page),
   processing state, success/failure with retry, 3-DS where required.
4. **Confirmation** — per transaction type (order/booking/reservation).

### States
Cart empty state with "browse" CTA; item-unavailable → removed with banner;
price-changed → updated with banner; payment failure → retry + alternative
method; success animation (haptic).

### API dependencies
Cart is client state (persisted locally, draft). Checkout: `POST /orders`,
`POST /bookings`, `POST /payments/intent`, `POST /payments/{id}/confirm`,
`POST /coupons/{id}/claim`, `GET /coupons/me`, `POST /dine-in/orders`,
`POST /group-buys/{id}/purchase`, `POST /reservations`.

---

## 13. Module: Orders — universal activity center

### Screens
1. **Activity home** (Orders tab) — segments: Orders · Deliveries · Bookings ·
   Services · Vouchers · Reservations; active first, history below; each row:
   type icon, title, status pill, amount, time.
2. **Order detail** (universal shell per §1) — status, timeline, items/service,
   amount breakdown, provider card, location, communication (chat/call),
   contextual help, actions (track/cancel/rebook/rate/report).
3. **Active orders list** — live statuses + tracking entry.
4. **Order history** — filters: type, date range, status; reorder/rebook.
5. **Shipment view** — intercity detail with phases + ETA range + delay
   explanation + change delivery date/address (business rules) + pickup-at-hub.

### States
Empty ("No orders yet — order something") with CTA; per-type empty states;
error+retry; pull-to-refresh; pagination (cursor).

### API dependencies
`GET /orders/me`, `GET /orders/{id}`, `GET /bookings/me`, `GET /bookings/{id}`,
`GET /dine-in/orders/me`, `GET /reservations/me`, `GET /vouchers/me`,
`GET /shipments` (mine), `GET /shipments/{id}`,
`GET /orders/{id}/tracking-phases`, `GET /orders/{id}/route`,
`GET /orders/{id}/waybill`, `GET /orders/{id}/timeline`,
`POST /orders/{id}/cancel`, `POST /bookings/{id}/cancel`,
`POST /reservations/{id}/cancel`.

---

## 14. Module: Tracking (multi-leg aware)

### Delivery tracking (food/retail local)
Real-time map (rider), status strip (confirmed → preparing → picked up →
delivering → delivered), ETA with updates, contact rider (chat/call via masked),
contact merchant, cancel (policy), delivery delay banner.

### Service booking tracking
Provider status (confirmed → en route → arrived → in progress → completed),
live provider location, contact provider, reschedule, cancel.

### Intercity shipment tracking
**Logical phases** (primary experience):
```
✓ Picked up
✓ Departed origin city
● Traveling to your city
○ Arrived at destination hub
○ Out for delivery
○ Delivered
ETA: Tomorrow, 3:40 PM
[View detailed tracking]
```
**Detailed tracking** (secondary, expandable): the leg view
(merchant → Hub A motorcycle · complete; Hub A → Hub B bus · in transit;
Hub B → customer motorcycle · pending) + waybill scan trail + delay
explanation + actions (change date/address, pickup at hub, contact support)
subject to business rules.

### States
Map loading → tracking skeleton → live updates (WS) → offline: last-known
state + "live updates resume on connection" → delivered completion animation →
review prompt.

### API dependencies
`GET /orders/{id}/track` (local), `GET /orders/{id}/tracking-phases`
(logical), `GET /orders/{id}/route` (legs), `GET /orders/{id}/waybill`
(events), realtime via `/events` WS + push.

### Realtime events (customer-facing)
`order.created` · `order.updated` (per status) · `leg.started` ·
`leg.completed` · `handoff.completed` · `consignment.departed` ·
`consignment.arrived` · `intercity.eta_updated` · `waybill.updated` ·
`shipment.frozen` (alert) · `delivery.delayed` (banner).

---

## 15. Module: Payments & wallet

### Payment methods (provider-agnostic abstraction)
Cards · Mobile money (M-Pesa/Tigo/Airtel/EzyPesa/Halotel) · Bank transfer ·
Wallet balance · Cash on delivery · Gift balance · Coupons · Credits ·
Promotional balance. The UI talks to the Payment Service, never to a provider
API directly.

### Screens
1. **Payment methods** — list, add (method wizard), edit, remove, default,
   verification status.
2. **Wallet** — balance, top-up, transaction history, refund status.
3. **Checkout payment** — method selector, provider flow, processing,
   success/failure.
4. **Transaction history** — all payments, filters, details, receipt
   download (invoice), report issue (amount mismatch/missing items).
5. **Refunds** — status tracking (requested → approved → processed),
   refund receipt.

### States
Add-method wizard steps; provider flow: STK push wait → success/fail/timeout;
wallet empty state; refund pending/paid banners; PCI note (never touch PANs —
tokenized only).

### API dependencies
`GET /payments/methods`, `GET /payments/history`, `POST /payments/intent`,
`POST /payments/{id}/confirm`, `GET /payments/{id}` (status poll),
`POST /payments/{id}/refund` (rules), `POST /payments/qr` (on-site),
`GET /wallet`, `GET /wallet/transactions`, `POST /wallet/withdrawals`
(customer wallets — IMPLEMENTED), `GET /finance/invoices` (receipts —
IMPLEMENTED, incl. `GET /finance/invoices/{id}` and `/{id}/download`),
`POST /finance/transactions/{id}/issue`.

### Realtime events
`payment.captured`, `refund.decision`, `notification.created`
(payment/refund category).

---

## 16. Module: Promotions & coupons

### Consumer surface
Coupon wallet (available/claimed/used/expired) · promo codes · merchant
promotions on cards · flash sales with countdown · group-buy deals · first-
order promotions · platform promotions · referral rewards · birthday rewards ·
membership benefits.

### Screens
1. **Coupons** — list by status, claim button, apply-from-checkout sheet,
   "smart coupon" auto-apply (PLANNED v3).
2. **Promo center** — active platform + merchant offers, countdown timers.
3. **Referral** — code share sheet, reward progress (IMPLEMENTED).

### States
Empty ("No coupons yet — check the promo center"); expired section;
claim success animation; sold-out/expired codes error; smart-coupon applied
banner at checkout.

### API dependencies
`GET /coupons/me`, `POST /coupons/{id}/claim`, `GET /coupon-campaigns`
(public/active), `GET /promotions?merchantId=`, `GET /group-buys`,
`POST /group-buys/{id}/purchase`, `GET /memberships/me`.

---

## 17. Module: Membership & loyalty

### Screens
1. **Membership** — tier (bronze/silver/gold/platinum), benefits list,
   points balance, earn/redeem progress, member-only offers.
2. **Rewards redemption** — points → discounts/free items/exclusive perks.
3. **Daily check-in** — calendar, streak, points awarded.
4. **Birthday rewards** — banner on profile on birthday (IMPLEMENTED).

### States
Tier-up celebration modal; check-in success animation; points ledger view
(transparent).

### API dependencies
`GET /memberships/me` (points, level, benefits),
`POST /check-in` (PLANNED), `GET /loyalty-transactions` (PLANNED),
referral endpoints (IMPLEMENTED — `/referrals/me`, `/referrals/claim`).

---

## 18. Module: Reviews, disputes & safety center

### Reviews
1. **Review prompt** — after completed transaction; eligibility enforced
   server-side (one review per transaction).
2. **Write review** — dimension sliders per type:
   - Food: taste, packaging, temperature, accuracy, delivery.
   - Service: punctuality, professionalism, quality, communication, value
     (`ReviewCreate.dimensions`).
   - Optional text/photos/video; would-recommend toggle.
3. **Reviews list** — merchant/provider reviews, helpful votes, report
   inappropriate.
4. **Reply view** — merchant/provider replies visible.

### Disputes
1. **Dispute center** — select issue → describe → upload evidence
   (photos/video) → conversation → resolution → appeal.
2. **Contextual entry** — from order detail ("Need help?" menu) and booking
   detail ("Service issue" menu) per §23.

### Safety center
1. **Report** — report provider/rider/merchant, suspicious activity,
   safety incident (emergency escalation).
2. **Account security** — sessions list + revoke, login activity,
   change password, 2FA (planned).
3. **Emergency assistance** — one-tap (customer SOS path).

### States
Review submission states; dispute case timeline (open → investigating →
decision → appeal window); evidence upload with progress.

### API dependencies
`POST /reviews` (dimensions), `GET /reviews` (public on entities),
`POST /reviews/{id}/report`, `POST /reviews/{id}/reply` (view), disputes: `POST /support/tickets`
(dispute category), `POST /finance/transactions/{id}/issue`,
`POST /sos` (customer safety — planned), `GET /sessions`,
`POST /sessions/{token}/revoke`, `POST /privacy/delete`.

---

## 19. Module: Messages & notifications

### Messages
Conversations with: merchant, provider, rider, support, system — permission-
bounded (masked contact, masked calls `POST /orders/{id}/masked-call`).
Screens: thread list (unread badges) · chat detail (bubbles, quick replies,
attachments incl. image/voice/location pins, mark read) · call sheet
(masked).

### Notifications
Categories: ORDER · PAYMENT · DELIVERY · PROMOTION · SECURITY · ACCOUNT ·
SERVICE · BOOKING · SUPPORT · SYSTEM. User preferences per channel
(push/SMS/email/in-app) — operational notifications cannot be disabled;
marketing can.

Screens: notification center (filters by category, read-all, deep links) ·
preferences.

### Realtime
WS/long-poll `/events` + push wake + local cache.

### API dependencies
`GET /conversations`, `GET /conversations/{id}`,
`GET /conversations/{id}/messages`, `POST /conversations/{id}/messages`,
`POST /conversations/{id}/read`, `GET /conversations/unread-count`,
`POST /orders/{id}/masked-call`, `GET /notifications/me`,
`POST /notifications/{id}/read`, `POST /notifications/read-all`,
`GET/PUT /notifications/me/preferences`.

---

## 20. Module: Support & help

### Contextual support (from order/booking screens)
```
Need help?
├── Where is my order?       (→ tracking)
├── Order is late            (→ delay banner + ticket prefilled)
├── Wrong item / Missing item / Damaged item   (→ ticket + evidence)
├── Cancel order             (→ cancellation flow with policy)
├── Payment problem          (→ payment history + ticket)
├── Delivery problem         (→ delivery ticket)
└── Other
```
From a service booking:
```
Service issue
├── Provider late / didn't arrive
├── Wrong service
├── Price dispute
├── Safety issue
├── Quality issue
├── Warranty
└── Refund
```

### Screens
Help center (FAQ + articles `GET /help/articles`) · ticket create/list/detail
with replies · live chat support · call support (when available) · dispute
center · feedback form.

### States
Ticket statuses (open/replied/resolved); SLA expectations shown; evidence
upload; escalation notice.

### API dependencies
`GET /help/articles`, `POST /support/tickets` (category/urgency),
`GET /support/tickets/me`, `GET /support/tickets/{id}`,
`POST /support/tickets/{id}/messages`, `POST /finance/transactions/{id}/issue`.

---

## 21. Module: Profile, settings, privacy

### Profile ("Me")
Profile · Addresses · Payment methods · Wallet · Orders · Bookings · Coupons ·
Membership · Favorites · Reviews · Messages · Support cases · Devices ·
Security · Privacy · Settings.

### Settings
Profile management · address management · payment management · notification
preferences · privacy & consent · language · theme (light/dark) · app version ·
logout · delete account.

### Privacy & consent layer
Consent tracking for: location, notifications, marketing, contacts, camera,
microphone, photos, background location, personalization. Consent can be
revoked per-purpose; sensitive surfaces (payment, cancellation, quote
approval, address change) require fresh server confirmation.

### Security
OTP login · password/passkey (PLANNED) · device management · session
management (list + revoke) · token rotation · rate limiting (server) · fraud
detection (server) · account recovery · suspicious-login detection ·
sensitive-action confirmation · privacy export (`POST /privacy/export`) ·
account deletion (`POST /privacy/delete`).

### API dependencies
`GET/PATCH /users/me`, `GET /sessions`, `POST /sessions/{token}/revoke`,
`POST /auth/change-password`, `GET/PUT /notifications/me/preferences`,
`POST /privacy/export`, `POST /privacy/delete`, `GET /experiments`
(feature flags), `GET /help/articles`.

---

## 22. Complete screen inventory (numbered master list)

Onboarding & auth (1–8): Splash · Onboarding · Login · Registration · OTP ·
Profile Setup · Address Setup · Payment Setup.

Shell (9–13): Home · Search · Categories · Orders (Activity) · Wallet ·
Profile (Me) — with the 5-tab bar.

Discovery (14–25): Restaurant list · Restaurant detail · Dish detail sheet ·
Provider list · Provider detail · Product list · Product detail · Service
category browse · Service questionnaire · Hotel list (v2) · Hotel detail
(v2) · Movie list (v2).

Transactions (26–38): Cart · Cart group sheet · Checkout (universal) ·
Payment · Order confirmation · Booking confirmation · Reservation
confirmation · Quote approval sheet · Dine-in order · Group-buy detail ·
Voucher wallet · Order detail (universal) · Shipment detail.

Tracking (39–43): Delivery tracking (map) · Service tracking · Intercity
tracking (phases) · Intercity detailed (legs + waybill) · Active orders.

Communication (44–46): Thread list · Chat detail · Call sheet.

Reviews & disputes (47–51): Review prompt · Write review · Reviews list ·
Dispute center · Dispute detail.

Loyalty & favorites (52–56): Membership · Rewards redemption · Check-in ·
Favorites · Saved searches.

Support (57–61): Help center · Support ticket list · Ticket detail · Live
chat support · Feedback.

Settings (62–68): Profile edit · Addresses · Payment methods · Notifications
prefs · Privacy & consent · Language/theme · Security (sessions, 2FA) ·
About/logout/delete.

Edge/system states (69+): order cancelled · payment failed · app offline
banner · GPS error · fraud warning · account suspended · low balance ·
coupon expired · deal sold out · provider unavailable · quote declined ·
delivery delayed · shipment frozen · document expiry n/a (consumer) ·
incentive unlocked (membership).

**Every screen has a state contract**: loading skeleton · empty state with
CTA · error + retry · success. Every mutation: in-flight spinner · optimistic
update with server rollback · toast.

---

## 23. Screen-to-screen transition map (key flows)

**Food**: Home → restaurant list → restaurant detail → dish sheet → cart →
checkout → payment → confirmation → tracking → detail → review.
**Service**: Home → services → category → questionnaire → provider list →
provider detail → booking → estimate/quote → confirmation → tracking →
completion → invoice/warranty → review.
**Intercity retail**: Home → search → product → cart → checkout (window
promise) → confirmation → tracking phases → detailed legs → delivery.
**Dine-in**: Scan QR → table menu → cart → order → bill → pay.
**Group buy**: Home → deal → purchase → voucher wallet → redeem (QR).
**Reservation**: Restaurant detail → reserve → confirmation → my
reservations.

---

## 24. Permissions matrix (consumer app)

| Permission | When | Purpose |
| --- | --- | --- |
| Location (foreground) | first checkout/tracking | delivery address, ETA, discovery |
| Location (background) | during active delivery/booking | live tracking |
| Notifications (push) | post-onboarding | order updates, promos (configurable) |
| Camera | reviews, dispute evidence, questionnaire photos | photos/video |
| Microphone | voice search, chat voice notes | input |
| Photos/media | evidence, profile avatar | upload |
| Contacts | sharing trip/delivery (opt-in) | safety share |

Consent is per-purpose and revocable; sensitive actions need fresh
confirmation. Supply-side actors see only purpose-limited data (restaurant →
destination; rider → delivery location when assigned; provider → service
address when booked; other riders → nothing).

---

## 25. Realtime event catalog (consumer)

`order.created` · `order.updated` (per status) · `payment.captured` ·
`payment.failed` · `refund.decision` · `notification.created` ·
`chat.message` · `quote.issued` · `booking.*` status events · `job.reminder` ·
`job.check_in` · `proof_of_service.submitted` · `invoice.issued` ·
`warranty.issued` · `leg.started/completed` · `handoff.completed` ·
`consignment.departed/arrived` · `intercity.eta_updated` · `waybill.updated` ·
`shipment.frozen/unfrozen` · `delivery.delayed` · `plan.replanned` ·
`campaign.updated` · `coupon.claimed` · `membership.tier_up`.

Transport: REST (initial state) + WebSocket/long-poll `/events` (live
changes) + push (wake/alert) + local cache (offline).

---

## 26. Frontend architecture

```
consumer-app/
├── core/          networking · auth · storage · analytics · location ·
│                  notifications · payments · errors
├── design_system/ colors · typography · spacing · buttons · cards · forms ·
│                  sheets · navigation (from DESIGN-SYSTEM.md)
├── features/      home · search · food · retail · services · bookings ·
│                  orders · tracking · cart · checkout · payments ·
│                  promotions · reviews · messages · support · profile ·
│                  settings
└── app/           routes · navigation · bootstrap · dependency_injection
```

### State management (three separate stores)
1. **UI state**: selected tab, open modal, filter, sort — local/component.
2. **Server state**: restaurants, products, orders, tracking, providers,
   bookings — cached server state with invalidation (React Query-style).
3. **Persistent local**: auth, addresses, preferences, cart draft, feature
   flags — storage-backed.

### BFF / API gateway
The app talks to a **Consumer BFF** that aggregates domain services into
consumer-friendly payloads (Home = merchants + recommendations + promotions +
availability + location in one response). The BFF never exposes internal
logistics fields (leg_id, manifest_id, hub_id, vehicle_id, scan_events,
routing_algorithm_version).

### Maps abstraction
One `Location/Maps` SDK abstraction used by address selection, merchant
distance, delivery/provider/rider tracking, service arrival, travel, and
intercity — never embed a map provider directly.

### Analytics events (instrument everything)
`home_viewed · search_started · search_submitted · category_opened ·
merchant_viewed · product_viewed · cart_item_added · checkout_started ·
payment_started · order_created · order_cancelled · tracking_viewed ·
review_submitted · support_opened · coupon_claimed` — feeding conversion,
retention, funnel drop-off, search success, delivery satisfaction, booking
conversion.

### Experimentation
Feature flags, A/B testing, remote config, gradual rollout, kill switches
(`GET /experiments`) — no app release needed for banners or feature toggles.

### Offline behavior
Cache: home content, previous orders, order details, addresses, favorites,
static config. Sensitive actions (payment, cancellation, quote approval,
address change) always require fresh server confirmation.

---

## 27. Backend entities owned by the consumer domain

Identity: `users`, `sessions`, `devices`, `consents`.
Location: `addresses`, `geopoints`, `service_areas`.
Discovery: `categories`, `search_history`, `saved_searches`,
`recommendations`.
Commerce: `orders`, `order_items`, `order_events`, `carts` (draft),
`catalogues`, `catalogue_items`.
Services: `service_categories_config`, `service_questions`, `bookings`,
`booking_quotes`, `service_invoices`, `service_warranties`.
Logistics: `shipments`, `tracking_phases`, `route_segments` (view),
`waybill_events` (view).
Payments: `payment_methods`, `payment_intents`, `refunds`, `wallets`.
Engagement: `coupons`, `promotions`, `memberships`, `loyalty_transactions`.
Communication: `conversations`, `chat_messages`, `notifications`.
Trust: `reviews`, `disputes`, `safety_cases`.

---

## 28. What NOT to do

❌ One giant User table with every role field · ❌ one Order object for food,
hotels, plumbers, shipments · ❌ payment logic inside the app · ❌ price
calculation inside the app · ❌ tracking based only on GPS · ❌ no event
history · ❌ no immutable audit trail · ❌ hard-coded categories · ❌ frontend
deciding authorization · ❌ supply-side seeing unnecessary customer data ·
❌ poll-only realtime.

---

## 29. Build phases

**Phase 1 — Core platform**: auth, location, home, search, restaurant
discovery, restaurant page, menu, cart, checkout, payment, orders, delivery
tracking, profile, addresses, support, reviews, notifications.
**Phase 2 — Instant retail**: stores, products, inventory availability,
retail cart/checkout, fast delivery, intercity retail + phase tracking.
**Phase 3 — Service marketplace**: categories, questionnaires, provider
search/profiles, quotes, scheduling, provider tracking, completion, warranty.
**Phase 4 — Logistics network**: intercity shipping, hubs, multi-leg tracking,
manifests, long-distance, multi-rider.
**Phase 5 — Super-app**: hotels, travel, tickets, entertainment,
subscriptions, membership, advanced personalization, AI assistant, image
search, smart coupons.

Status: hotels, travel, entertainment events (+ tickets), the AI assistant,
voice/image search, and membership are IMPLEMENTED; subscriptions, advanced
personalization, and smart coupons remain planned.

Phase gates in `functionalities/customer/ROADMAP.md`; the BFF, typed routes,
universal transaction shell, and analytics are built in Phase 1 and never
rebuilt.

## 30. Module: Favorites & saved items

Favorite restaurants · favorite dishes · favorite stores · favorite products ·
favorite providers · favorite hotels · saved searches · wishlist.

Screens: Favorites hub (segmented by type) · Favorites list per type ·
Add/remove (heart on cards and detail pages) · Saved searches management.

States: empty ("No favorites yet — tap the heart to save") · list with quick
entry (restaurant → menu; product → add to cart) · error + retry.

API: `GET /favorites`, `POST /favorites` (merchantId), `DELETE /favorites/{merchantId}`.
Realtime: none (read + local optimistic heart). Backend entity: `favorites`.

## 31. Accessibility (design-system requirement)

Every screen: text scaling (Dynamic Type) · screen-reader labels and live
announcements for status changes · contrast ≥ 4.5:1 body text · touch targets
≥ 48 pt · motion reduction (kills infinite animations) · keyboard navigation
where applicable · voice input on search · clear, actionable error states with
recovery hints. WCAG 2.1 AA target.

## 32. Recommendation engine pipeline (v3)

```
Recommendation Engine
  → candidate generation (history, location, time, trends)
  → ranking (relevance, price sensitivity, frequency)
  → availability filter (never recommend what is unavailable)
  → business rules (promotions, membership)
  → personalization (user controls + privacy)
  → Home feed
```

Inputs: purchase history · search history · location · time · preferences ·
price sensitivity · frequency. Users can disable personalization (consent).

## 33. Internationalization

Multi-language (en first; sw + ar ready) · currencies (TZS v1; multi-currency
planned) · tax systems (config per region) · date/time formats · time zones ·
phone formats · address formats · payment methods · regional service
categories. Tanzania-specific assumptions never baked into the domain model —
see `LOCALIZATION.md`.

## 34. Key metrics & KPIs (instrument from day one)

| Metric | Category | Source |
| --- | --- | --- |
| Daily Active Users (DAU) | Engagement | analytics `app_open` |
| Monthly Active Users (MAU) | Engagement | analytics |
| Order Volume | Transaction | `order_created` |
| Average Order Value (AOV) | Transaction | pricing engine |
| Conversion Rate | Funnel | search→checkout funnels |
| Cart Abandonment Rate | Funnel | `checkout_started` vs `order_created` |
| Customer Acquisition Cost (CAC) | Growth | marketing attribution |
| Customer Lifetime Value (LTV) | Growth | cohort model |
| Net Promoter Score (NPS) | Satisfaction | in-app survey |
| App Crash Rate | Performance | crash reporting (Sentry) |
| App Load Time | Performance | bootstrap instrumentation |

All tracked via the analytics events catalog (§26) in `core/analytics`.

## 35. Gamification & retention (depth)

Daily check-in (points + streak, bonus on 7-day streaks) · badges (first order,
10 orders, 100 points, verified rater) · consumer leaderboards (PLANNED v3) ·
tier progress (bronze→silver→gold→platinum with visible benefits) ·
time-limited offers with countdowns · referral rewards · birthday rewards.

## 36. Referral & birthday rewards (specified)

- **Referral**: share code/sheet → friend completes first order → both earn
  wallet credits; progress screen shows referrals, pending rewards, history
  (IMPLEMENTED — `GET /referrals/me`, `POST /referrals/claim`).
- **Birthday**: profile stores birthdate (opt-in); on the day, a birthday
  banner + member-only offer appears (IMPLEMENTED — `GET /rewards/birthday`,
  `POST /rewards/birthday/claim`).

## 37. Smart defaults & behavioral UX

Pre-fill: last-used address, default payment method, preferred language,
recent search context, dietary tags, quick-reorder list. The checkout screen
pre-selects the most likely delivery time (ASAP vs last scheduled) and applies
the best available coupon automatically when `smart_coupons` flag is enabled
(PLANNED v3). Every default can be overridden; nothing is applied silently
without a visible line.

## 38. Live streaming, AR, and advanced input (voice/image/assistant IMPLEMENTED; live streaming + AR planned)

- **AI assistant** (voice ordering, recommendations, support) — IMPLEMENTED
  (text chat → recommendations/support; the assistant recommends, business
  rules decide — never lets the assistant authorize payments). Hands-free
  voice ordering remains planned.

- **Restaurant live streams** (kitchen prep) — PLANNED v3; deep-linkable from
  restaurant detail via `GET /merchants/{id}/stream` (contract addition).
- **AR features** (product preview, service measurement) — PLANNED v3+.
- **Voice search / voice ordering** — voice search IMPLEMENTED (device
  speech→text → `/search`); full hands-free ordering remains planned.
- **Image search** — IMPLEMENTED (`POST /search/image`; image-picker button on
  the search entry; model integration done).

## 39. Helpful votes on reviews

`POST /reviews/{reviewId}/helpful {helpful: true|false}` — toggling vote;
response returns `helpfulCount`, `notHelpfulCount`, `myVote`. One active vote
per user per review (`REVIEW_HELPFUL_VOTE_INVALID` on bad state). UI: thumbs
up/down under each review with live counts.

## 40. Complete payment method catalog (consumer)

Cards · Mobile money (M-Pesa, Tigo Pesa, Airtel Money, EzyPesa, Halotel) ·
Bank transfer · Wallet balance · **Cash on delivery** · Saved payment methods ·
Gift balance · Coupons (discount instruments) · Credits (refunded funds) ·
Promotional balance (campaign grants). **Split payments** (group orders,
shared services) PLANNED — escrow baseline remains. All behind the Payment
Service abstraction; the UI never talks to a provider API directly.

## 41. Two-factor authentication

Optional per user: TOTP app or SMS second factor (`2FA` on `users`).
Enforced for: payment method changes, wallet withdrawals, account deletion,
suspicious-login confirmation. Device management lists trusted devices; a new
device triggers re-verification.

## 42. Feedback loop

In-app feedback form (rating + text + optional screenshot) → `POST
/support/tickets` (category `feedback`) → product team triage; "what's new"
changelog screen ties releases to user feedback. Feature requests tracked as
tickets; upvotes on requests PLANNED.

## 43. UI/UX design principles (design-system floor)

- **Simplicity despite complexity**: clear information hierarchy; every action in
  as few taps as possible; consistent UI patterns across all services (one card
  language, one sheet behavior, one checkout shell) reduce the learning curve.
- **Personalization**: adaptive interface that responds to behavior; personalized
  recommendations; smart defaults (see §37).
- **Trust & safety in the UI**: transparent pricing (full breakdown before any
  payment), verified badges on merchants/providers, visible security indicators
  during payment, transparent reviews.
- **Engagement**: gamified check-ins, points, badges, tiered membership with
  visible benefits, timely push, targeted offers — always opt-in and never at
  the cost of operational clarity.

## 44. Consumer app technical stack (build reference)

- **Framework**: React Native (Expo) or Flutter — cross-platform iOS/Android.
- **State**: three-store split (§26): UI / server / persistent-local; Redux or
  Provider-style per framework.
- **Navigation**: React Navigation (or equivalent) with the typed-route map (§2).
- **Maps**: one Location/Maps SDK abstraction (Mapbox or Google Maps) for
  address selection, distance, delivery/provider/rider tracking, service
  arrival, travel, intercity.
- **Push**: FCM/APNs via Expo push; silent updates via the realtime gateway.
- **Performance**: lazy loading, image optimization, code splitting, FlatList
  virtualization, image caching — measured by App Load Time and Crash Rate KPIs.
- **Offline**: local cache (§26) with fresh-confirmation rule for sensitive
  actions.
- **Backend interface**: Consumer BFF/API gateway (§26) over the domain
  microservices (auth, orders, payments, notifications, search, catalogues,
  services, logistics); realtime via WebSocket/long-poll `/events`; async via
  Kafka/RabbitMQ; caching via Redis.
- **Data**: PostgreSQL (relational), PostGIS (geospatial), Elasticsearch
  (unified search), TimescaleDB (analytics time-series), Redis (sessions +
  realtime).
- **Infra**: Docker + Kubernetes, CI/CD, Prometheus/Grafana monitoring,
  ELK log aggregation.
- **Security**: JWT + refresh tokens, RBAC, encryption at rest/in transit,
  PCI via gateway tokenization, GDPR/CCPA/PDPA consent, audit logging.

## 45. Terminology cross-reference (this document ↔ build language)

| Build term | Blueprint reference |
| --- | --- |
| Search bar | Shell header (§2, §5) |
| Push notification permissions | Permissions matrix (§24) |
| AI Menu | Food module §7 "AI Menu" recommendations (PLANNED v3) |
| Location-based results | Search §6 (`location` input) |
| Add-ons (hotel/room) | Travel module §11 (IMPLEMENTED) |
| Status updates | Realtime event catalog (§25) |
| Food ordering flow | Transition map §23 (Food) |
| Multi-Modal Cross-City flow | Transition map §23 (Intercity retail) + §14 |
| Phase 2 "Expansion & Scale" | Build phases §29 (Instant retail + Service marketplace) |
| Phase 3 "Intelligence & Ecosystem" | Build phases §29 (Logistics + Super-app) + §38 |
