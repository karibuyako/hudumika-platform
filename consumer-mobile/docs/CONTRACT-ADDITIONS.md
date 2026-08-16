# Consumer App — Contract Additions Backlog

Living backlog of every contract addition the consumer app needs, derived
from the audits (parity harness, OPERATIONS-COVERAGE.md, milestone reviews).
Each entry records the current client behavior so Team 6 sees exactly what
the app does today.

Status vocabulary:
- **IMPLEMENTED — contract live + app wired**: the endpoint/field landed in
  `backend/API-CONTRACT.yaml` (regenerated), the app repo calls the live path,
  and this doc records the shipped surface. Shipped additions are collected in
  the "Implemented" section below.
- **awaiting Team 6**: still missing from the contract; the app runs the
  mock-first path (parity harness allow-list) or the feature stays hidden.

## Implemented — contract live + app wired

Additions that landed in `backend/API-CONTRACT.yaml` and are wired in the app
repo. The numbered entries further down remain the open backlog.

## Voice search — `POST /search/voice`

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `POST /search/voice` — body `VoiceSearchBody {query}`,
  response `SearchResults` (429 `RateLimitedResponse` possible — client
  retries).
- **Why**: OPERATIONS-COVERAGE #25 (voice search) tracked PLANNED with no
  server surface for the app's speech input.
- **Current app behavior**: speech input (src/app/search.tsx,
  `startVoiceInput`) pushes the transcript to the results screen, which runs
  `POST /search/voice` through `SearchRepository.voiceSearch`
  (src/repos/api/search.ts); filters/sort apply via the defensive client-side
  pass (the voice body carries no filter params). The mock implements it
  server-side (src/repos/mock/search.ts).

## Image search — `POST /search/image`

- **Status**: IMPLEMENTED — contract live + app wired (was a placeholder
  endpoint, now wired).
- **Endpoints**: `POST /search/image` — body `ImageSearchBody {imageUrl}`,
  response `SearchResults`.
- **Why**: OPERATIONS-COVERAGE #26 (image search) tracked PLANNED with only a
  placeholder path.
- **Current app behavior**: the results screen calls
  `SearchRepository.imageSearch({ imageUrl })` (src/repos/api/search.ts); the
  picked photo's local URI is the upload-less demo key — a live app uploads
  first and passes the returned URL (src/repos/mock/search.ts implements the
  deterministic visual search).

## Hotels — `/hotels` resource

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `GET /hotels` (city-scoped search, cursor), `GET /hotels/{hotelId}`,
  `POST /hotel-bookings` (Idempotency-Key; replay never double-books),
  `GET /hotel-bookings/me`.
- **Why**: OPERATIONS-COVERAGE #53–56 tracked PLANNED; no hotel surface
  existed.
- **Current app behavior**: hotels list/detail screens (src/app/hotels.tsx,
  src/app/hotels/[hotelId].tsx), booking flow and bookings list
  (src/app/hotel-bookings/[bookingId].tsx) through `HotelsRepository`
  (src/repos/api/hotels.ts) with `Hotel`/`HotelDetail`/`HotelBooking` DTOs
  from the generated contract.

## Travel — `/travel` resource

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `GET /travel/options` (bus/ferry/flight search),
  `POST /travel/bookings` (Idempotency-Key), `GET /travel/bookings/me`.
- **Current app behavior**: travel search/booking screens (src/app/travel.tsx,
  src/app/book.tsx, src/app/travel-bookings.tsx) through `TravelRepository`
  (src/repos/api/travel.ts) with `TravelOption`/`TravelBooking` DTOs
  (including `originCityName`/`destinationCityName`) from the generated
  contract.

## Entertainment events — `/entertainment` resource

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `GET /entertainment/events` (cursor pagination),
  `GET /entertainment/events/{eventId}`,
  `POST /entertainment/event-tickets` (Idempotency-Key; replay never
  double-issues), `GET /entertainment/event-tickets/me`.
- **Current app behavior**: events list/detail/tickets screens
  (src/app/events.tsx, src/app/events/[eventId].tsx, src/app/events/tickets.tsx)
  through `EventsRepository` (src/repos/api/events.ts) with
  `EventListing`/`EventDetail`/`EventTicket` DTOs from the generated contract.

## AI assistant — `POST /assistant/chat`

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `POST /assistant/chat` — body `AssistantChatBody {message}`
  (maxLength 1000) + optional context bag, reply `AssistantReply`.
- **Current app behavior**: assistant screen (src/app/assistant.tsx) through
  `AssistantRepository` (src/repos/api/assistant.ts). Reply text is server
  copy and renders verbatim — never i18n keys; chat is non-sensitive, so the
  hardened client queues it offline.

## Referral — `/referrals` resource

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `GET /referrals/me` (`ReferralSummary`),
  `POST /referrals/claim` — body `ClaimReferralBody {code}` (maxLength 20),
  Idempotency-Key.
- **Why**: OPERATIONS-COVERAGE #115–116 tracked PLANNED.
- **Current app behavior**: referrals screen (src/app/referrals.tsx, profile
  entry in src/app/(tabs)/profile/index.tsx) through
  `RewardsRepository.getMyReferral` / `claimReferral` (src/repos/api/rewards.ts).

## Birthday reward — `/rewards/birthday`

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `GET /rewards/birthday` (`BirthdayReward`),
  `POST /rewards/birthday/claim` (no body, Idempotency-Key).
- **Current app behavior**: reward surfaces through
  `RewardsRepository.getBirthdayReward` / `claimBirthdayReward`
  (src/repos/api/rewards.ts).

## Wallet withdrawals

- **Status**: IMPLEMENTED — contract live + app wired (paths already existed
  in the contract; now wired).
- **Endpoints**: `POST /wallet/withdrawals` — body `RequestWithdrawalBody`,
  Idempotency-Key; `GET /wallet/withdrawals` (list).
- **Current app behavior**: withdrawals screen (src/app/withdrawals.tsx) and
  wallet entry (src/app/wallet.tsx) through `WalletRepository.withdraw` /
  `listWithdrawals` (src/repos/api/wallet.ts). The payout-destination note
  stays hidden on a live backend — no contract endpoint exposes it yet.

## Invoices — `/finance/invoices`

- **Status**: IMPLEMENTED — contract live + app wired (paths already existed
  in the contract; now wired).
- **Endpoints**: `GET /finance/invoices`, `GET /finance/invoices/{invoiceId}`,
  `GET /finance/invoices/{invoiceId}/download` (PDF).
- **Why**: OPERATIONS-COVERAGE #90/#91 tracked PLANNED.
- **Current app behavior**: invoices list/detail screens with PDF download
  (src/app/invoices.tsx, src/app/invoices/[invoiceId].tsx) through
  `FinanceRepository` (src/repos/api/finance.ts). Distinct from backlog #9 —
  the booking-level `/bookings/{id}/invoice|warranty|proof-of-service` GETs
  remain pending below.

## Tips — `POST /orders/{orderId}/tip`

- **Status**: IMPLEMENTED — contract live + app wired (path already existed
  in the contract; now wired).
- **Endpoints**: `POST /orders/{orderId}/tip` — body `TipRiderBody
  {amountTZS ≥ 1, method, note maxLength 200}`, Idempotency-Key.
- **Current app behavior**: tip sheet on the order detail screen
  (src/app/order/[orderId].tsx) through `OrdersRepository.tip`
  (src/repos/api/orders.ts).

## Live deals — `GET /marketing/live-deals`

- **Status**: IMPLEMENTED — contract live + app wired.
- **Endpoints**: `GET /marketing/live-deals` — response `{sessions:
  LiveDealSession[], nextCursor}` (scheduled flash sessions with countdowns,
  神抢手-lite).
- **Current app behavior**: Live Deals zone (src/app/live-deals.tsx, entry
  points in src/app/promo-center.tsx and the home feed) through
  `MarketingRepository.listLiveDeals` (src/repos/api/marketing.ts). This
  ships backlog #13 (flash-sale zone) as the sessions zone; each session card
  opens the LIVE STREAMING-LITE broadcast screen (src/app/live/[sessionId].tsx)
  — a hero video placeholder (the honest "video arrives with the native
  build" note, `liveDeals.videoSoon`), the session countdown, the same deal
  cards, and a mock-first live chat (backlog #20 below). Video livestreaming
  itself is a native-phase concern (bandwidth) with no contract surface: the
  broadcast surface is mock-first lite and nothing implies a stream exists.

## 1. Public provider detail — `GET /providers/{id}`

- **Needed change**: `GET /providers/{id}` returning `ProviderPublic` (detail:
  bio, availability, services, reviews summary).
- **Why**: The contract exposes `GET /providers` (list), `GET /providers/me`
  and provider-role surfaces only — there is no public detail path. The app's
  provider detail screen calls `GET /providers/{id}` (src/repos/api/providers.ts)
  which 404s against a live backend; the parity harness flagged the gap.
- **Current app behavior**: provider detail renders from the mock repo only;
  the live API path is a dead call waiting for the endpoint.

## 2. Push-token registration — `POST /push/tokens` (+ unregister)

- **Needed change**: `POST /push/tokens` (register Expo/APNs/FCM token for the
  authenticated user) and a delete/unregister mutation (logout/revoke).
- **Why**: The consumer contract has NO push-token endpoint (grep of the
  generated endpoints finds only merchant printer/terminal devices under
  `/devices`). src/lib/push.ts documents the seam (`registerTokenForUser` /
  `unregisterTokenForUser`) and today persists the Expo token **device-locally**
  via SecureStore — cross-device push and server-side targeting are impossible.
- **Current app behavior**: token is obtained and stored on-device only;
  notification delivery is not wired server-side.
- **Update (mock-first batch, contract-additions v2)**: `AuthRepository` gains
  `registerPushToken` / `unregisterPushToken` (POST /push/tokens,
  DELETE /push/tokens/{token} — mock-only-until-adopted paths, added to the
  parity harness allow-list). The mock registers/unregisters in a module-local
  token set (register validates the Expo token format with the contract's
  `PUSH_TOKEN_INVALID`, and is idempotent — the same token twice succeeds).
  src/lib/push.ts now calls the repo through `getAuthRepository()` when
  registering for the session user (idempotency key per attempt), keeps the
  device-local SecureStore write as the fallback/audit, and a repo failure
  (a live backend that has not shipped the endpoint) only warns — the session
  flow never breaks (same fire-and-forget rule as the session wiring).

## 3. Server-side search filter/sort — `UnifiedSearchParams`

- **Needed change**: extend `UnifiedSearchParams` with `priceMin`/`priceMax`,
  `minRating`, `distance`, `sort` (relevance|rating|price_asc|price_desc|distance).
- **Why**: The contract `GET /search` accepts only `q, lat, lon, entityType,
  category, limit, cursor`; OPERATIONS-COVERAGE #20/#21 mark filter/sort as
  LIVE but the server cannot do it. The app's search screen exposes rating /
  max-price filters and a sort picker.
- **Current app behavior**: filters and sorting are applied **client-side** to
  the single-page result set in src/lib/search.ts — no pagination across
  filtered results, wrong results at scale.
- **Update (mock-first batch, contract-additions v1)**: the app now sends
  `priceMaxTZS`/`minRating`/`maxDistanceKm`/`sort` through
  `SearchRepository.search` (src/repos/api/search.ts appends them to the query
  string — ignored by a live backend until the contract ships them), and the
  mock implements them **server-side** (src/repos/mock/search.ts — the mock is
  the server: filters drop results missing the bound field, sort puts missing
  keys last, pagination runs over the filtered set). The search screen
  (src/app/search-results.tsx) passes the Filters/Sort sheets straight to the
  repo; src/lib/search.ts keeps the pure helpers as a defensive client-side
  pass for fields a result may be missing.

## 4. Search result dispatch linkage

- **Needed change**: `SearchResultsResultsItem` gains `merchantId` (on dish
  results, to open the merchant menu) and a group-buy reference (deal → group
  buy detail, e.g. `dealId` or a typed `target` discriminator).
- **Why**: A search hit for a dish or a group-buy deal currently carries only
  `id/title/rating/priceTZS/distanceKm` — the app cannot navigate from a result
  to the merchant catalogue or the deal without heuristics.
- **Current app behavior**: dish/provider taps fall back to generic screens;
  deal results are not dispatched to the group-buy detail route.

## 5. Delivery-window + route-city fields on order/tracking payloads

- **Needed change**: `deliveryWindowFrom` / `deliveryWindowTo` on order and
  tracking payloads, plus `originCityName` / `destinationCityName` for
  intercity/relay shipments.
- **Why**: The app renders "Delivery window" and route facts from the tracking
  payload (tracking.tsx), but the contract fields do not exist — the client
  reconstructs windows from checkout choices and city labels from guesswork.
- **Current app behavior**: window/route labels derived client-side;
  `track.delayedNewWindow` shows a window the server never sent.
- **Update (mock-first batch, contract-additions v1)**: the mock now rides a
  delivery window (`deliveryWindowFrom`/`deliveryWindowTo`, ISO) and the
  route city names (`originCityName`/`destinationCityName`) on the intercity
  route payload (mockState `buildRoute` — mock-only extension, stripped
  live). Screens read them through `OrdersRepository.getDeliveryWindow` /
  `getRouteCities` (the live repo returns `null` until the fields ship).
  tracking.tsx and shipment/[shipmentId] render the delivery-window card
  ("Arrives {window}" via the `windowLabel` helper in src/lib/dates.ts) and
  the origin → destination header line when the data exists; `simulateIntercityDelay`
  reposts a shifted window so the card follows the server event.

## 6. `TicketCreate` category `feedback`

- **Needed change**: add `'feedback'` to `TicketCreateCategory`
  (today: payment, order, account, safety, equipment, other).
- **Why**: OPERATIONS-COVERAGE #135 ("Submit feedback") is marked LIVE and
  calls `POST /support/tickets` with category `feedback`, but the enum has no
  such value — the field would be rejected server-side.
- **Current app behavior**: the app's support ticket screen offers the six
  contract categories (no feedback category); the feedback path is
  effectively unavailable.
- **Update (mock-first batch, contract-additions v1)**: the support screen
  (src/app/support.tsx) adds a mock-only **Feedback** chip (commented
  "mock-only until the contract ships the feedback category"); it sends
  `'feedback'` in the contract category field position, and the mock support
  repo accepts and stores it (module-local category map, widened to
  `TicketCreateCategory | 'feedback'`). A live backend would reject the value
  until Team 6 ships it — the chip is the mock-first surface.

## 7. Payment-methods mutations — add / remove / set-default

- **Needed change**: `POST /payments/methods` (add), `DELETE /payments/methods/{method}`
  (remove), and a set-default mutation (e.g. `PATCH /payments/methods/{method}/default`).
- **Why**: OPERATIONS-COVERAGE #78–80 were marked LIVE but the contract has
  only `GET /payments/methods` — no mutation exists.
- **Current app behavior**: the payments screen renders a read-only list with
  "Adding, removing and setting a default method are coming soon"
  (`payments.manageHint`).
- **Update (mock-first batch, contract-additions v2)**: the payments screen is
  now fully manageable against the mock. `PaymentsRepository` gains
  `addPaymentMethod` (POST /payments/methods), `removePaymentMethod`
  (DELETE /payments/methods/{methodId}) and `setDefaultPaymentMethod`
  (PUT /payments/methods/{methodId}/default) — mock-only-until-adopted paths,
  added to the parity harness allow-list. The mock keeps a module-local method
  registry: add validates against the contract `PaymentIntentCreateMethod`
  enum (VALIDATION_FAILED otherwise) and is idempotent per key; remove 404s
  unknown ids and promotes the next available method when the default is
  removed; set-default marks one `isDefault` and un-marks the rest. The screen
  stays read-only when the methods repo returns nothing (empty state).

## 8. Consumer shipment + dispute endpoints

- **Needed change**: a scoped customer shipment list (today the generated
  contract exposes `GET /shipments` + `GET /shipments/{shipmentId}` — orval
  `listShipments`/`getShipment` in `generated/endpoints/orders/orders.ts` —
  but the `Shipment` payload carries only the logistics envelope: id,
  shipmentNumber, orderId, packages, status; the waybill trail, tracking
  phases and route legs never reach the customer), plus customer dispute
  management (`GET /disputes`, `POST /disputes` open/attach evidence,
  resolution state).
- **Why**: Shipment endpoints exist but are ops-scoped; dispute tooling is
  admin voucher-dispute only (`/admin/vouchers/verify`). The app had no repo
  for either.
- **Current app behavior**: the disputes screen derives the list client-side
  from `disputed` order/booking statuses and refunded intents
  (src/app/disputes.tsx), and "Start a dispute" routes to a support ticket;
  the shipment view reads facts off the order tracking payload.
- **Update (mock-first batch, contract-additions v2)**: `ShipmentsRepository`
  (listMine/get) mirrors the contract shape — the api repo calls the EXISTING
  contract paths `GET /shipments` + `GET /shipments/{shipmentId}` (no parity
  allow-list entry), and the app-layer `ShipmentDetail` extends the contract
  `Shipment` with mock-only extras (`waybill`, `phases`, `route`; the live
  repo returns null for them until the payload carries them). The mock serves
  seeded shipments derived from the seeded intercity/relay/warehouse orders
  (SH-… numbers, the same phases/route/waybill tracking already renders) and
  resolves by shipment id OR order id (the route links `/shipment/{order.id}`).
  The shipment screen (src/app/shipment/[shipmentId].tsx) loads through the
  repo with an order-fallback for non-shipment ids. `DisputesRepository`
  (list/raise, `DisputeRecord` + mock-only status vocabulary open/resolving/
  resolved/dismissed) calls `GET /disputes/me` + `POST /disputes` — mock-only-
  until-adopted paths (parity harness allow-list entries); the mock seeds
  disputes from the disputed order + disputed booking + refunded order and
  `raise()` validates the reference (404 NOT_FOUND unknown) with per-key
  idempotency. The disputes screen (src/app/disputes.tsx) is now repo-sourced
  and raises via a sheet (reference picker + reason chips + description),
  keeping support tickets as a secondary link.

## 9. Customer invoice / warranty / proof-of-service endpoints

- **Needed change**: `GET /bookings/{id}/invoice`, `GET /bookings/{id}/warranty`,
  `GET /bookings/{id}/proof-of-service` (or one documents resource), incl. PDF
  download (OPERATIONS-COVERAGE #90/#91).
- **Why**: Blueprint §9 documents these for customers; the app has UI stubs.
- **Current app behavior**: the booking documents section shows
  "Invoice / Warranty / Proof of service — coming soon"
  (`booking.invoice.comingSoon` etc.).
- **Update (mock-first batch, contract-additions v1)**: `BookingsRepository`
  gains `getInvoice` / `getWarranty` / `getProofOfService`. The api repo calls
  `GET /bookings/{id}/invoice|warranty|proof-of-service` (mock-only-until-
  adopted paths — added to the parity harness allow-list) and maps 404 → null;
  the mock serves deterministic documents for terminal-completed bookings
  (invoice line items + subtotal/fees/total from the server-price breakdown,
  integer TZS; warranty coverage + expiry; proof photos + signature status).
  The booking detail screen replaces the coming-soon markers with real
  read-only cards after completion, with per-card loading/error/retry and the
  coming-soon fallback when a document is null (live backend that has not
  shipped the GETs).

## 10. `couponId` on `OrderCreate`

- **Needed change**: add optional `couponId` to `OrderCreate`; server applies
  and echoes the discount.
- **Why**: Coupon-at-checkout is feature-flagged behind
  `EXPO_PUBLIC_FEATURE_COUPON_CHECKOUT` (WALLET-COUPONS.md); the flag stays OFF
  because the contract `OrderCreate` has no coupon field and the server cannot
  honor a discount.
- **Current app behavior**: the checkout coupon selector is hidden by default;
  flipping the flag ON shows previews the server will not honor — so it stays off.
- **Update (mock-first batch, contract-additions v2)**: the flag default is now
  ON (`EXPO_PUBLIC_FEATURE_COUPON_CHECKOUT`, default `true` — .env.example +
  docs/ENV-VARS.md updated). `OrderCreateInput` gains an optional `couponId`
  (the live repo passes it through in the POST body; a backend that has not
  shipped the field ignores it). The mock honors it server-side: the coupon is
  validated (`COUPON_CAMPAIGN_NOT_FOUND` 404, `COUPON_EXPIRED` 422,
  `COUPON_ALREADY_USED` 409, `COUPON_MINIMUM_SPEND_NOT_MET` 422 when the
  subtotal is below `minimumSpendTZS` — all codes from backend/ERROR-CODES.md),
  the discount rides `totals.discountTZS`, and the coupon is marked `used`.
  The checkout screen passes the selected coupon's id and keeps the advisory
  pre-check; server rejections clear the coupon and render inline.

## 11. Group ordering (shared cart) — Meituan 拼单 parity

- **Needed change**: shared-cart resource (`POST /carts/shared` invite,
  member add/remove, totals, merchant confirmation) or order-side group
  session endpoints.
- **Why**: Blueprint §12 group ordering; the app's cart is strictly
  client-side and single-user (`cart.merchantGroup` labels exist but no
  server surface).
- **Current app behavior**: no group flow exists in the app; cart state is
  local and dies with the device.
- **Update (mock-first batch, contract-additions v3)**: the app now ships a
  full group-ordering flow against the mock. `GroupOrdersRepository`
  (create/get/addItem/removeItem/finalize) calls `POST /group-orders`,
  `GET /group-orders/{id}`, `POST /group-orders/{id}/items`,
  `DELETE /group-orders/{id}/items`, `POST /group-orders/{id}/finalize` —
  mock-only-until-adopted paths (parity harness allow-list entries). The
  mock (src/repos/mock/groupOrders.ts) keeps a **module-local** registry
  (mockState.ts untouched): create seeds the session with the local user +
  an invited "Juma" member with a couple of available catalogue items
  pre-added (deterministic per merchant, so the demo always renders);
  `expiresInMinutes` bounds the session and an expired/ordered session
  rejects every mutation with 409 `CONFLICT`. `addItem` reuses
  `validateOrderInput` (merchant closed / `ORDER_ITEM_UNAVAILABLE` /
  `ORDER_PRICE_CHANGED` / option validation) and merges same
  item+options lines; `finalize` reuses `buildOrderFrom` (one payer — the
  session member who taps "Place order & pay"; the per-member contribution
  ledger rides a mock-only `groupOrderContributions` field on the returned
  order, integer TZS). Entry: a "Start group order" button on the cart
  screen (cart group → session, lines copied as the local member's items);
  the session screen (src/app/group-order/[groupId].tsx) renders members
  with per-item rows and subtotals, a catalogue item-picker sheet with
  quantity steppers for the local member, a server-style totals breakdown,
  "Share invite" (react-native Share with `hudumika://group-order/{id}` —
  'group-order' added to the deep-link allow-list) and finalize → order
  confirmation. Honest scope: NO realtime presence (websockets) — the mock
  simulates members adding via the shared-cart model; a live backend
  without the endpoints 404s/405s and the screen falls back to its error
  state.

## 12. Red packets (P6c) — shareable coupon packets

- **Needed change**: red-packet endpoints (`POST /red-packets` create/split,
  `GET /red-packets/{id}`, claim, balances, transfers).
- **Why**: P6c parity feature; the wallet screen had a "coming soon" stub.
- **Update (mock-first batch, contract-additions v2)**: `RedPacketRepository`
  (src/repos/index.ts, app-layer types `RedPacket`/`RedPacketClaim`/
  `RedPacketCreateInput` — mock-only until the contract ships them) calls
  mock-only-until-adopted paths `GET /red-packets/me/received`,
  `POST /red-packets/{packetId}/claim` and `POST /red-packets/me/share`
  (src/repos/api/redPackets.ts, parity harness allow-list entries). The mock
  (src/repos/mock/redPackets.ts) keeps a module-local registry seeded with
  two packets — one claimable promotional packet (count 5, one credit per
  claim) and one already claimed. **Funding model: promotional.** Packets are
  marketing-funded platform credits (Meituan 红包 parity) — claiming never
  debits the recipient's wallet; the mock credits
  `totalTZS / count` (integer TZS) into the wallet balance and appends a
  `WalletTransaction` with `referenceType: 'red_packet'` (contract type
  `adjustment` — same contract-first trick as the mock top-up). Claim
  validation: unknown packet → `NOT_FOUND` 404, already claimed (per-user,
  once per packet) → `CONFLICT` 409, expired → `VALIDATION_FAILED` 422 (no
  `RED_PACKET_*` codes exist in backend/ERROR-CODES.md yet — using the
  generic codes; flagging for Team 6). `createSharePacket` builds a
  promotional packet with a `PK-…` `shareCode`; the share link
  `hudumika://red-packet/{shareCode}` is on the deep-link allow-list
  (src/lib/deep-link.ts) and maps to `/red-packets` (the screen takes no id
  param — it refetches the received list on mount, same pattern as the
  dine-in/reservation/voucher new-resource routes). The wallet screen's
  "coming soon" slot is now a live card (claimable count + Open → the
  red-packets screen, src/app/red-packets.tsx: list with claim buttons,
  success toast with the credited amount, per-code error toasts, empty/
  loading/error/retry, and a "Share a packet" sheet with promotional demo
  presets 2000/5000/10000 TZS, count 1–5, expiry 24h/48h/7d).
- **Current app behavior**: red packets are fully interactive against the
  mock; a live backend that has not adopted the paths errors the screen into
  its error/retry state (and the wallet card degrades to the zero-count
  state) until Team 6 ships the resource.

## 13. Flash-sale zone — `FlashDeal` resource (神抢手 parity)

- **Status**: IMPLEMENTED — contract live + app wired (shipped as
  `GET /marketing/live-deals` with `LiveDealSession` — see the Implemented
  section above; the `/flash-deals` resource naming never landed).
- **Needed change**: `FlashDeal` resource with `startsAt` / `endsAt` / `stock`
  (`GET /flash-deals`, `GET /flash-deals/{id}`, maybe `POST /flash-deals/{id}/claim`).
- **Why**: 神抢手-parity flash sales; no contract or app surface today.
- **Current app behavior**: the Live Deals zone (src/app/live-deals.tsx,
  promo-center.tsx, home feed) renders the sessions returned by
  `GET /marketing/live-deals` through `MarketingRepository.listLiveDeals`
  (src/repos/api/marketing.ts) — scheduled flash-sale sessions with
  countdowns. The `flash-deals`-named paths from the original ask are not
  shipped; the sessions zone covers the feature. Live streaming is served as
  LIVE STREAMING-LITE (backlog #20): each session opens the broadcast screen
  with a video placeholder + mock-first live chat. Full video livestreaming
  (Meituan 神抢手 livestream) remains a native-phase concern (bandwidth) with
  no contract surface — no video dependency ships in the consumer app.

## 14. Curated lists / rankings — `Lists` resource (必吃榜 parity)

- **Needed change**: `GET /lists` (curated rankings: 必吃榜-style), `GET /lists/{id}`
  with ordered merchant entries; hooks for favorites-organized lists
  (OPERATIONS-COVERAGE #120).
- **Why**: Home feed "Promotions"/"Nearby" and blueprint §30 curated lists;
  `POST /favorites` covers single items only.
- **Update (favorites organization batch, OPERATIONS-COVERAGE #120)**:
  - **Favorites lists (user-organized)**: `FavoritesRepository` gains
    `listLists` / `createList` / `addToList` / `removeFromList` / `deleteList`
    (app-layer `FavoriteList {id, name, merchantIds, createdAt}` —
    mock-only until the contract ships the resource) calling mock-only-
    until-adopted paths `GET /favorites/lists`, `POST /favorites/lists`,
    `POST /favorites/lists/{id}/merchants`,
    `DELETE /favorites/lists/{id}/merchants/{merchantId}` and
    `DELETE /favorites/lists/{id}` (src/repos/api/favorites.ts, parity
    harness allow-list entries). The mock (src/repos/mock/favorites.ts) keeps
    a module-local registry seeded with one default list "My favorites" that
    snapshots the favorites at first access; create validates the name
    (empty → 422 `VALIDATION_FAILED`, max 40 chars), drops unknown
    merchant-ids server-side and is idempotent per key (a replay returns the
    stored list; a key reuse with a different name → 422); add/remove
    validate the list AND the merchant (404 `NOT_FOUND` each) and are
    idempotent (adding a duplicate / removing an absent merchant is a no-op);
    delete 404s unknown lists. The favorites hub (src/app/favorites.tsx)
    gains a "Lists" segment: create sheet (name input), list overview
    (name + merchant count + "+ New list"), in-screen detail (merchant cards
    with remove, "Add merchant" sheet picking favorite merchants not yet in
    the list, delete with confirm), and an "Add to list" button on each
    merchant card (picks one of the user's lists). All mutations are
    optimistic with server rollback + toast; the segment renders
    loading/empty/error/retry and degrades to its retry state against a live
    backend that has not shipped the paths.
  - **Curated lists (必吃榜-lite)**: new `ListsRepository` (`listCurated` /
    `getCurated`) calling mock-only-until-adopted paths `GET /lists` and
    `GET /lists/{id}` (src/repos/api/lists.ts, parity harness allow-list
    entries). The mock (src/repos/mock/lists.ts) is the server for the seed
    the home rail renders from src/lib/lists.ts (the same constant — the
    pure helpers `getCuratedList`/`resolveList` stay in src/lib/lists.ts);
    an unknown id → 404 `NOT_FOUND`. The curated list detail screen
    (src/app/list/[listId].tsx) loads through the repo (the mock IS the
    server — no static-data fallback) and keeps the pure `resolveList`
    helper for merchant resolution, with loading/not-found/error/retry
    states.
- **Current app behavior**: favorites lists + curated lists are fully
  interactive against the mock; a live backend that has not adopted the
  paths errors the surfaces into their error/retry states until Team 6 ships
  the resource.

## 15. Merchant replies to reviews — `ReviewReply` on customer payloads

- **Needed change**: include the merchant `ReviewReply` on the customer-facing
  review payload (`review.ts` / `reviewDetail.ts`) so the consumer app can
  render replies; the model already exists for merchant-facing endpoints
  (`replyToReview`, `reviewReply.ts`).
- **Why**: The app displays reviews and review counts but cannot show merchant
  responses — reply data never reaches the customer payload.
- **Current app behavior**: replies are invisible; the reviews screen shows
  only the customer's text, rating and moderation state.
- **Update (m6c social layer)**: the mock repo now carries a merchant reply on
  a seeded review (mock-only `reply` extension, `ReviewReply` shape, module-
  local to `repos/mock/reviews.ts`) and the reviews list renders it when
  present. The live wire still never carries it — the UI simply hides the
  reply card when the field is absent.

## 16. Loyalty — points redemption + tier ladder fields

- **Needed change**: redemption mutation (e.g. `POST /memberships/me/redeem`)
  and tier-ladder fields on `GET /memberships/me` (next tier, thresholds,
  progress %) — OPERATIONS-COVERAGE #111/#113.
- **Why**: Membership screen shows current level/benefits; points can be
  earned but never spent.
- **Current app behavior**: membership shows balance and benefits only;
  redemption UI is absent (ledger shows `redeem` entries only in mock data).
- **Update (redemption mock-first)**: the membership screen now ships a full
  redemption flow against the mock. `MembershipsRepository` gains
  `redeemPoints` (`POST /loyalty/redemptions` — mock-only-until-adopted path,
  parity harness allow-list entry; body `{points, reward}`, Idempotency-Key).
  The reward catalog lives app-layer in `src/repos/index.ts`
  (`REDEMPTION_CATALOG` + `RedemptionReward`, the single source of truth the
  screen renders AND the mock validates against): `wallet_credit` = 500
  points → TZS 5,000 wallet credit; `delivery_discount` = 250 points → TZS
  2,500 delivery discount; `free_delivery` = 300 points → free delivery
  (integer TZS mapping — the live backend must ship the same mapping). The
  mock validates the reward key + integer points cost (`VALIDATION_FAILED`
  422, points must match the catalog cost) and the balance
  (`MEMBER_INSUFFICIENT_BALANCE` 422 — the Loyalty-section code in
  backend/ERROR-CODES.md), debits `membership.points`, appends a signed
  `redeem` ledger row (the contract `ListLoyaltyTransactions200ItemType`
  enum HAS a `redeem` value), and — wallet-credit rewards only — credits the
  wallet balance + appends a `WalletTransaction` exactly like the mock
  top-up (contract type `adjustment`, `referenceType: 'points_redeem'` — the
  contract `WalletTransactionType` has no topup/redeem value, same
  contract-first trick). Redemptions are idempotent per key (a retry replays
  the SAME redemption, never a double debit). The membership screen renders
  the catalog (reward name + points cost + value), disables rewards the
  balance cannot cover ("Need X more points"), and confirms each redemption
  in a sheet (cost, balance, wallet credit) with success toasts + membership/
  wallet/ledger refetch; a live backend that has not adopted the path errors
  the flow into its error/retry states.

## 17. Voucher expiry-reminder push events

- **Needed change**: server push event / scheduled notification for
  voucher expiry (`voucher.expiring_soon` event on `/events` WS or push).
- **Why**: src/lib/push.ts schedules the ~48 h reminder **locally on the
  device**; the reminder never fires on the user's other devices and is lost
  on reinstall.
- **Current app behavior**: `scheduleVoucherExpiryReminder` fires a local
  notification when the app has run and seen the voucher; no server-driven
  reminder exists.

## 18. Verified-purchase flag on review payloads

- **Needed change**: add `verifiedPurchase` (or `verified`) boolean to the
  customer-facing `Review` DTO (`review.ts` / `reviewDetail.ts`), set when the
  review's author completed a real transaction for that target.
- **Why**: The Meituan 必吃榜 trust loop needs a "Verified purchase" marker on
  reviews; the contract `Review` has no such field (only `rating`, `body`,
  `state`, `createdAt`, `target*`, `authorName`).
- **Current app behavior**: the reviews list renders a "Verified purchase" pill
  only when the data exists. The mock repo carries a module-local `verified`
  extension on its seeded reviews (including the demo customer's own published
  review) so the UI path is real and testable; the live wire never has the
  field, so the pill stays hidden against a live backend until Team 6 ships it.

## 19. Social login — `POST /auth/social`

- **Needed change**: OAuth sign-in (`POST /auth/social` — body `{provider:
  google|apple, code}`, response the contract `Session` shape, Idempotency-Key)
  or the platform's native OAuth exchange (Google Identity / Sign in with
  Apple).
- **Why**: OPERATIONS-COVERAGE #10 (social login) tracked PLANNED with no
  server surface — grep of the generated endpoints finds only
  /auth/request-otp | verify-otp | refresh | logout | change-password under
  /auth; no oauth/social/google paths anywhere.
- **Current app behavior (mock-first)**: the login screen
  (src/app/(auth)/login.tsx) offers Google + Apple buttons under an
  "or continue with" divider. Tapping one shows an honest mock-first
  explainer sheet (demo-account copy, i18n `auth.socialExplain`) and signs in
  with the **simulated** exchange: `AuthRepository.socialLogin`
  (src/repos/index.ts) calls the not-yet-contract path `POST /auth/social`
  (parity harness allow-list entry). The mock (src/repos/mock/auth.ts)
  accepts any non-empty code (or none at all — the demo flow, mirroring the
  OTP debugCode pattern; `MOCK_SOCIAL_CODE` is the documented demo code) and
  signs in the seeded demo customer reusing the session construction from
  verifyOtp; idempotent per key; an empty code → 422 VALIDATION_FAILED. The
  session applies exactly like the OTP path (setToken + store user + persist,
  store/session.ts verifyOtp mirror) and lands on the city picker. Honest
  scope: NO real OAuth redirect — a real Google/Apple SDK (e.g.
  expo-auth-session or a native module) is a native-phase concern documented
  in the sheet copy; no new npm packages.

---

## 20. Live-deals live chat — live streaming LITE (神抢手 livestream parity)

- **Needed change**: a live-deals broadcast chat resource
  (`GET /marketing/live-deals/{id}/chat`, `POST /marketing/live-deals/{id}/chat`
  — viewer messages about the deals, e.g. `{id, authorName, body, at}`,
  Idempotency-Key on post).
- **Why**: the Live Deals zone (implemented `GET /marketing/live-deals`)
  ships as the sessions zone; full video livestreaming (Meituan 神抢手
  livestream) is a native-phase concern (bandwidth) with no contract surface.
  The consumer app delivers a mock-first LITE broadcast surface today so the
  session screens are honest and interactive without any video dependency.
- **Current app behavior (mock-first)**: `MarketingRepository` gains
  `fetchLiveChat` / `postLiveChat` (src/repos/index.ts, app-layer
  `LiveChatMessage` type — mock-only until the contract ships them) calling
  the mock-only-until-adopted paths above (src/repos/api/marketing.ts, parity
  harness allow-list entry — the one literal covers GET + POST, the harness
  is method-agnostic). The mock (src/repos/mock/marketing.ts) keeps
  module-local threads seeded with viewer chatter for the live session
  (deterministic timestamps via the `setMockNow` clock seam); `postLiveChat`
  appends with per-key idempotency (a repeated key replays the same message,
  never a double post), empty body → 422 VALIDATION_FAILED, unknown session →
  404 NOT_FOUND (no live-chat codes exist in backend/ERROR-CODES.md yet —
  using the generic codes, flagging for Team 6). The broadcast screen
  (src/app/live/[sessionId].tsx) renders the hero video placeholder (static
  LIVE dot — reduced-motion safe by construction — + the honest
  `liveDeals.videoSoon` note), the countdown, the shared DealCard rail and
  the chat with an optimistic composer (mirrors the conversations thread:
  temp message → server echo replaces it, failure rolls back and restores the
  draft). NO video playback dependency and no event bus — the chat is
  repo-driven (src/store/events.ts untouched). A live backend that has not
  adopted the paths errors the screen into its error/retry state.

## 21. Preferred providers — `GET /providers/me/preferred` + preference mutation

- **Needed change**: `GET /providers/me/preferred` (my preferred providers)
  and a per-provider preference mutation (`PUT /providers/{providerId}/preference`
  — body `{preferred: boolean}`, Idempotency-Key).
- **Why**: OPERATIONS-COVERAGE #140 ("Set preferred providers", P2) is PLANNED
  as a contract addition. The consumer contract exposes NO preference surface
  (grep of the generated endpoints — only rider availability carries
  "preferred"), so the app runs the mock-first path.
- **Current app behavior (mock-first)**: `ProvidersRepository` gains
  `listPreferred` / `setPreferred` (src/repos/index.ts) calling the
  mock-only-until-adopted paths above (src/repos/api/providers.ts, parity
  harness allow-list entries — one GET literal + one `{param}/preference`
  PUT literal). The mock (src/repos/mock/providers.ts) keeps a module-local
  preferred-provider registry (mockState.ts untouched), seeded once with the
  first seeded provider (fixture provider ids are seed-deterministic UUIDs, so
  the seed resolves lazily against `state.home.providers`); `setPreferred`
  validates the provider (unknown → 404 `NOT_FOUND`) and the set semantics
  make it idempotent per key. The provider detail screen (src/app/provider/
  [providerId].tsx) renders a "Preferred provider" toggle (ToggleRow, toast on
  success/error) and the services tab (src/app/(tabs)/services/index.tsx) shows
  a "Your preferred providers" section above the provider list (hidden on
  empty; a live backend that has not adopted the paths hides both surfaces
  instead of erroring).

---

## 23. Two-factor authentication (2FA) — mock-first

- **Needed change**: a 2FA resource on the user — `GET /users/me/2fa`
  (status `{enabled, method}`), `POST /users/me/2fa` (enable, Idempotency-Key),
  `DELETE /users/me/2fa` (disable, body `{code}`, Idempotency-Key) and
  `POST /auth/2fa/verify` (verify `{code}` for a sensitive action,
  `{valid}` response). TOTP is the planned method.
- **Why**: OPERATIONS-COVERAGE #9 ("2FA on users") is PLANNED; the generated
  contract exposes NO 2FA surface (grep of the generated endpoints finds no
  `2fa`/`mfa`/`totp` paths). MASTER-BLUEPRINT §21 wants 2FA enforced on
  payment-method changes, wallet withdrawals, account deletion and
  suspicious-login confirmation.
- **Current app behavior (mock-first)**: `AuthRepository` gains
  `getTwoFactorStatus` / `enableTwoFactor` / `disableTwoFactor` /
  `verifyTwoFactor` (src/repos/index.ts, app-layer `TwoFactorStatus` —
  mock-only until the contract ships them) calling the mock-only-until-adopted
  paths above (src/repos/api/auth.ts, parity harness allow-list entries).
  The mock (src/repos/mock/auth.ts) owns the whole feature module-locally:
  default DISABLED so every existing flow keeps working; enable sets the flag
  and returns the fixed demo TOTP code `123456` (`demoCode` mock-only
  extension, same pattern as the OTP `debugCode`) which the security screen
  shows once in a sheet; disable requires that code (a wrong one → 401
  `UNAUTHORIZED`, the contract's generic credential code — no 2FA-specific
  code exists in backend/ERROR-CODES.md); `verifyTwoFactor` is the
  contract's `{valid}` check. Enable/disable are idempotent per key. The
  security screen (src/app/security.tsx) renders a "Two-factor
  authentication" card with an Enabled/Disabled pill, the enable flow with
  the one-time demo-code sheet and a disable sheet with inline error; against
  a live backend that has not adopted the paths the screen degrades to its
  error/retry state (same rule as the red-packet paths). Honest scope: NO
  real TOTP — the fixed demo code is the stand-in, and the withdrawal/
  payment/account-deletion §21 gates are NOT wired yet (the withdrawal
  confirm step lives in the wallet vertical, src/app/wallet.tsx).

## 22. Split payments — `POST /splits` resource

- **Needed change**: split-payment resource for group orders / shared services
  — `POST /splits` (create a plan with per-payer shares), `GET /splits/{id}`,
  `POST /splits/{id}/pay` (a payer pays their share via their own intent),
  `POST /splits/{id}/complete` (finalize once every share is covered).
- **Why**: the blueprint marks split payments PLANNED ("split payments (group
  orders, shared services) — PLANNED contract addition"); grep of the
  generated endpoints finds no /splits surface anywhere.
- **Current app behavior (mock-first)**: `SplitPaymentsRepository`
  (src/repos/index.ts, app-layer types `SplitPlan`/`SplitShare` — mock-only
  until the contract ships them) calls mock-only-until-adopted paths
  `POST /splits`, `GET /splits/{id}`, `POST /splits/{id}/pay`,
  `POST /splits/{id}/complete` (src/repos/api/splits.ts, parity harness
  allow-list entries). The mock (src/repos/mock/splits.ts) keeps a
  module-local registry (mockState.ts untouched) seeded with one demo split
  (`SEED_SPLIT_ID`, referencing the seeded rush order) so the split summary
  screen renders on first load and the share link is deep-linkable.
  Server rules: order must exist (404 `ORDER_NOT_FOUND`), at least two
  shares, every amount an integer ≥ 1 and labels non-empty (422
  `VALIDATION_FAILED`), shares must sum EXACTLY to the order total (422
  `VALIDATION_FAILED`), one split per order (a second create replays the
  existing plan), per-key idempotency on every mutation. The initiator's
  share is the FIRST share of the client-built list; `payMyShare` rides the
  normal intent lifecycle (create → confirm → webhook) scoped to the share
  amount — the intent lands in the payments history and settling it flips
  the share to paid; guards mirror the intent flow (`ORDER_NOT_PAYABLE` for a
  cancelled/refunded/failed order, 409 `CONFLICT` for an already-paid share,
  and the `simulatePaymentFailure` provider-outage path). `completeSplit`
  requires every share paid (409 `CONFLICT` otherwise) and settles the order
  on completion (webhook). **Honest scope**: only the PAYER side ships —
  checkout (src/app/checkout.tsx) offers a "Split the payment" toggle
  (even split across 2/3/4 people or custom rows with live sum validation,
  hidden for COD), creates the split after the order and pays the user's own
  share, then lands on the split summary (src/app/splits/[splitId].tsx: order
  ref, share rows with paid status, "Pay my share", "Complete split",
  completed state, an honest co-payer note, and a `hudumika://split/{id}`
  share link — 'split' added to the deep-link allow-list). The OTHER payers'
  flow is out of scope (they'd need the app too) — the mock SIMULATES their
  shares as pre-paid so the split can complete in the demo. A live backend
  without the endpoints 404s/405s and the screens fall back to their
  error/retry states.

---

## 24. Train mode — mock-only extension (`TravelOptionMode 'train'`)

- **Needed change**: add `'train'` to the contract `TravelOptionMode` enum
  (today: bus/ferry/flight) so the intercity travel search ships train
  departures for real.
- **Why**: the travel vertical landed with bus/ferry/flight only; trains are
  the fastest-growing intercity corridor in the blueprint.
- **Current app behavior (mock-only extension)**: the travel screen
  (`src/app/travel.tsx`) offers a **Train** mode chip and
  `src/repos/mock/travel.ts` widens the mode type locally
  (`TravelOptionModeMock = TravelOptionMode | 'train'`, commented
  "mock-only until the contract adds 'train'") and seeds a deterministic
  TAZARA sleeper on the Dar→Dodoma leg (SGR corridor: overnight departure,
  ~11 h journey, cast into the contract type at the boundary — the runtime
  `'train'` value survives the cast). The live repo (src/repos/api/travel.ts)
  forwards the `mode=train` query string verbatim — a backend that has not
  adopted the value simply returns no train rows, and the screen falls back
  to the empty state for that mode. Not a parity harness allow-list entry (no
  new URL — same `GET /travel/options` path).

---

## 25. Personalized recommendations — `GET /home/recommendations`

- **Needed change**: a recommendations surface on the home feed — e.g.
  `GET /home/recommendations` returning `{merchantId, businessName, rating,
  reviewCount, reason, deliveryMinutes}` rows, or a `recommendations` field on
  the `GetConsumerHome200` payload. The `reason` is SERVER copy (e.g.
  "Because you ordered from them" / "Top rated in your city") — the app
  renders it verbatim, never through i18n.
- **Why**: MASTER-BLUEPRINT §5 marks personalized recommendations "AI,
  PLANNED v3 — after consent + sufficient history; users can disable
  personalization." The generated `GetConsumerHome200` has NO recommendations
  field (verified — only generatedAt/location/categories/merchants/providers/
  promotions/groupBuys/recentOrders/unreadCount/membership), so the app ships
  the surface mock-first.
- **Current app behavior (mock-first, consent-gated)**: `HomeRepository`
  gains `getRecommendations` (src/repos/index.ts, app-layer
  `RecommendedMerchant` type — mock-only until the contract ships them)
  calling the mock-only-until-adopted path `GET /home/recommendations`
  (src/repos/api/home.ts, parity harness allow-list entry). The mock
  (src/repos/mock/home.ts, pure exported `buildRecommendations` over
  mockState) is the server: the demo user's order history is the signal —
  merchants they ordered from (cancelled/refunded/failed orders excluded),
  ranked by order count desc (ties: rating desc, then name asc), padded with
  top-rated merchants (rating desc, reviewCount desc, name asc) up to the
  3–5 range; NO order history → the top-rated fallback only. Deterministic
  (seed-derived names/ratings). The home feed rail ("Recommended for you",
  src/app/(tabs)/home/index.tsx) is gated on the 'personalization' consent
  purpose (src/store/consent.ts): without consent NO request fires and the
  section renders nothing but an honest "Enable recommendations" hint into
  /privacy; with consent it renders a per-section skeleton, error/retry, or
  the horizontal cards (merchant name, rating, reason caption, ETA — tap →
  /merchant/{id}). Revoking consent drops the served rows immediately. A live
  backend that has not adopted the path errors the section into its
  error/retry state.

---

## 25. Dine-in split bill — `POST/GET /dine-in/orders/{id}/splits`

- **Needed change**: a dine-in split-bill resource — `POST
  /dine-in/orders/{id}/splits` (create a split plan with per-diner shares),
  `GET /dine-in/orders/{id}/splits` (the bill's split with live share
  statuses), and a pay-my-share action on the bill's split (in the mock the
  POST literal carries it as `{action: 'pay_my_share'}` — a live backend would
  ship the real shape, e.g. `POST /dine-in/orders/{id}/splits/{shareId}/pay`).
- **Why**: `DINE-IN.md` marks split-bill between diners **planned** ("requires
  a contract addition"); grep of the generated endpoints finds nothing under
  `/dine-in/orders` beyond the bill paths (orders/me, orders/{id}, POST
  orders, tables/{tableId}/qr).
- **Current app behavior (mock-first)**: `DineInRepository.splitBill` /
  `getSplit` / `payMyShare` (src/repos/index.ts, app-layer type
  `DineInSplit`/`DineInSplitShare` — mock-only until the contract ships them)
  call the mock-only-until-adopted paths (src/repos/api/dineIn.ts, parity
  harness allow-list). The mock (src/repos/mock/dineIn.ts) keeps a
  module-local registry (mockState.ts untouched; `resetMockDineInSplitState()`
  between test cases). Server rules: bill must exist (404
  `DINE_IN_ORDER_NOT_FOUND`) and be payable — open/billing (409
  `DINE_IN_ORDER_STATUS_CONFLICT` otherwise), 2–8 shares with non-empty
  labels, integer amounts ≥ 1 that sum EXACTLY to the bill total (422
  `VALIDATION_FAILED`), one split per bill (a second create with a different
  key → 409 `CONFLICT`), per-key idempotency on every mutation. The
  initiator's share (the FIRST of the client-built list) is pending; the OTHER
  diners' shares are PRE-PAID — **honest scope**: only the initiator's side
  ships (the co-diners would need the app too; the mock SIMULATES their
  shares as paid). `payMyShare` runs the intent lifecycle scoped to MY share
  amount (create → confirm → "webhook", same machinery as mock/splits.ts);
  when every share is covered the split completes and the bill settles
  (webhook — the full total is covered by the shares). UI: the bill detail
  (src/app/dine-in.tsx) offers a "Split the bill" sheet — even-split presets
  (2/3/4 diners) or custom share rows with live sum validation — then lands
  on the split summary (src/app/dine-in-splits/[splitId].tsx, addressed by
  the bill's order id: bill ref, share rows with paid pills, "Mark my share
  paid", the completed state, and an honest co-diner note). A live backend
  without the paths 404s/405s and the sheet/summary fall back to their
  error/retry states.

---

## 26. Smart coupons — `POST /coupons/suggest`

- **Needed change**: a suggestion endpoint on the coupons resource —
  `POST /coupons/suggest` with body `{merchantId, subtotalTZS, couponIds}`
  returning the best applicable coupon (or `null`) for the cart, so checkout
  can auto-suggest instead of the customer hunting the selector.
- **Why**: MASTER-BLUEPRINT §16 marks smart coupons "PLANNED v3". The
  generated contract exposes only `GET /coupons/me` and
  `POST /coupons/{couponId}/claim` (grep of the generated endpoints finds no
  suggest path), so the surface ships mock-first.
- **Current app behavior (mock-first)**: `CouponsRepository.suggestForCart`
  (src/repos/index.ts, app-layer `CouponSuggestionInput`) calls the
  mock-only-until-adopted path `POST /coupons/suggest` (src/repos/api/coupons.ts,
  parity harness allow-list entry). The mock (src/repos/mock/coupons.ts) is
  the server through the pure exported engine `suggestBestCoupon(coupons,
  subtotalTZS)` (unit-tested): among the wallet coupon ids in the input, pick
  the largest discountTZS whose `minimumSpendTZS <= subtotalTZS`, status
  claimed/available (used/expired/void are dead) and not past `expiresAt`;
  `null` when nothing applies. The contract `Coupon` payload carries NO
  merchant linkage, so the rank is purely discount-vs-minimum-spend — a
  merchant-scoped rank is a server-side concern once the endpoint lands.
  READ-ONLY: nothing is claimed or consumed; the coupon is applied later at
  order create (the existing `couponId` on OrderCreate, #10). UI: checkout
  (src/app/checkout.tsx) renders an advisory "Best coupon for you" chip above
  the coupon selector, gated by the same EXPO_PUBLIC_FEATURE_COUPON_CHECKOUT
  flag — tapping it applies the suggested coupon through the selector's own
  path; loading/errors are silent and the chip hides when nothing applies or
  the suggestion is already applied. A live backend that has not shipped the
  path errors the call and the chip stays hidden (the manual selector is
  unaffected).

---

## 27. Share live location — trip-share pattern (mock-first)

- **Needed change**: a consumer tracking-share surface — `POST
  /orders/{id}/tracking-share` (create a view-only tracking share:
  `{token, expiresAt}`) and `GET /tracking-share/{token}` (resolve a share
  token to its order id). The share payload carries the token so the
  recipient opens the read-only tracking view.
- **Why**: OPERATIONS-COVERAGE #77 ("Share live location — trip-share
  pattern — contract addition for consumer") is PLANNED. The rider app has
  trip-share (recipients ≤ 5, token expiry); the CONSUMER side is sharing
  your live order tracking with a friend/family member (e.g. "share my
  rider location so my mom can watch") via a link with a token. Grep of the
  generated endpoints finds nothing under `/tracking-share`, so the surface
  ships mock-first.
- **Current app behavior (mock-first)**: `OrdersRepository.createTrackingShare`
  / `resolveTrackingShare` (src/repos/index.ts, app-layer `TrackingShare` —
  mock-only until the contract ships them) call the mock-only-until-adopted
  paths above (src/repos/api/orders.ts, parity harness allow-list entries).
  The mock (src/repos/mock/orders.ts) owns the tokens module-locally
  (mockState.ts untouched): `createTrackingShare` validates the order (404
  `ORDER_NOT_FOUND`), issues `ts_{order}_{randoms}` with `expiresAt` now+2h
  (**expiry rule**: tokens live 2h — the shared link stops resolving after
  that, mirroring the rider app's trip-share token expiry) and is idempotent
  per key (a replay returns the stored token); `resolveTrackingShare`
  returns the order id, 404 `NOT_FOUND` for an unknown token and 410
  `TRIP_SHARE_EXPIRED` (the ERROR-CODES.md trip-share code — no 4xx "Gone"
  code exists in the registry, so the documented 410 status rides the
  existing code) once expired. A seeded demo token
  (`SEED_TRACKING_SHARE_TOKEN`, resolving to the seeded delivering order) so
  the read-only screen renders on first load (same pattern as the split
  seed). UI: the tracking screen (src/app/order/[orderId]/tracking.tsx) adds
  a "Share trip" button in the header (accessibilityRole button) that
  creates the token and opens the share sheet with the payload
  `t('tripShare.message')` carrying the `hudumika://track-share/{token}`
  deep link ('track-share' added to the deep-link allow-list, mapped to
  `/track-share/{token}` — SECURITY.md allow-list rule: the recipient screen
  refetches everything before render). The recipient screen
  (src/app/track-share/[token].tsx) resolves the token, loads the order's
  tracking surfaces and renders the SAME tracking UI read-only through the
  extracted `OrderTrackingView` (src/components/OrderTrackingView.tsx,
  `readOnly` hides every action — no cancel/rush/support/review/masked-call/
  share, no dev delay trigger — and shows the shared-view banner);
  unknown/expired tokens render the "Tracking unavailable" state with retry.
  The api repo maps resolve 404 → null so a live backend that has not
  shipped the path keeps the recipient screen in that state. **Honest
  scope**: no recipient cap (the rider app's ≤ 5 rule is a server concern)
  and the 2h expiry is mock-configured (TRACKING_SHARE_TTL_MS) — a real
  backend owns both.

## 28. Points accrual on orders + reviews (P6d, mock-first)

- **Needed change**: server-side points accrual — 1 point per TZS 1,000 of a
  paid order total (integer floor) and 50 points per published review —
  exposed to the consumer as per-order/per-review earnings (e.g. an
  `earnedPoints` field on the order/review payloads, or a
  `GET /memberships/me/earnings` surface the app can query).
- **Why**: MASTER-BLUEPRINT §17 — points accrue on spend (orders) and
  engagement (reviews). Roadmap P6d tracked "points accrual mapping
  deferred/planned": the membership screen's how-to-earn card said the rules
  were "coming soon", and the contract carries no accrual surface (grep of
  the generated endpoints under /memberships|/loyalty: only GET
  /memberships/me, POST /check-in, GET /loyalty-transactions exist).
- **Current app behavior (mock-first)**: the mock IS the server —
  `earnOrderPoints(order, membership)` (1 pt per TZS 1,000, integer floor of
  `totals.totalTZS`, gated to paid+ order statuses) and `earnReviewPoints(review)`
  (50 pts) in src/repos/mock/memberships.ts append `earn` ledger rows (the
  contract `ListLoyaltyTransactions200ItemType` HAS an `earn` value — same
  value the seeded ledger already uses for historical order earns) and
  increment `membership.points`, recording each award in module maps.
  **Accrual rule point**: the orders mock calls `earnOrderPoints` on order
  CREATE when the order arrives paid (COD — `buildOrderFrom` marks COD orders
  paid at create; the orders mock has no status-transition surface and the
  payments mock's `pending_payment → paid` flip lives in mock/payments.ts,
  outside this vertical's hooks, so create-at-paid is the honest, testable
  point — a live backend accrues when an order reaches paid+; finalized group
  orders build their order directly in mock/groupOrders.ts and do not accrue
  today). The reviews mock calls `earnReviewPoints` on review create (the
  demo has no moderation transition — a live backend awards when the review
  is published). `MembershipsRepository` gains mock-only getters
  `earningsFor(orderId)` / `earningsForReview(reviewId)` → `{points} | null`
  — the live repo returns null WITHOUT calling any URL (hence NO parity
  harness allow-list entry); the order-detail screen (src/app/order/
  [orderId].tsx) renders a "You earned {n} points" pill on delivered/
  completed orders and the review success screen (src/app/review.tsx) on
  submit, from those getters. The membership how-to-earn card
  (src/app/membership.tsx) now states the real rules
  (`membership.howToEarn.orders` / `.reviews`, `membership.earnedOrders` /
  `.earnedReviews`). The earn pill surfaces hide against a live backend that
  has not shipped the surface.

## How to update

- When Team 6 ships an addition: flip this entry to **IMPLEMENTED — contract
  live + app wired** (or move it into the Implemented section), note the
  endpoint/field names, and link the repo wiring PR.
- When a new audit gap appears: add a row here before touching app code
  (contract-first rule — the app only consumes what the contract declares).
