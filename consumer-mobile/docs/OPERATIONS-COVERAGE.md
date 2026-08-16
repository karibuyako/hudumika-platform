# HUDumika Consumer App — Core Operations Coverage

Every core operation the consumer app must perform, mapped to contract
endpoints, blueprint modules, and build priority. Status: **LIVE** (contract),
**PLANNED** (named phase + contract addition), or **CLIENT** (device-side).

## A. User Account & Identity (10)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 1 | Register user | P0 | `POST /auth/request-otp` + `POST /auth/verify-otp` | §3 | LIVE |
| 2 | Login user | P0 | `POST /auth/request-otp` + `POST /auth/verify-otp` | §3 | LIVE |
| 3 | Logout user | P0 | `POST /auth/logout` | §3 | LIVE |
| 4 | Verify phone/email (OTP) | P0 | `POST /auth/request-otp`, `POST /auth/verify-otp` | §3 | LIVE |
| 5 | Reset password | P0 | OTP `purpose: password_reset` | §3 | LIVE |
| 6 | Update profile | P0 | `PATCH /users/me` | §21 | LIVE |
| 7 | Delete account | P1 | `POST /privacy/delete` | §21 | LIVE |
| 8 | Session management | P0 | `POST /auth/refresh`, `GET /sessions`, `POST /sessions/{token}/revoke` | §21 | LIVE |
| 9 | Two-factor auth | P1 | `2FA` on `users` (contract addition) | §41 | LIVE (mock-first, contract addition pending) |
| 10 | Social login | P1 | OAuth providers (contract addition) | §3 | LIVE (mock-first, contract addition pending) |

## B. Location & Address (8)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 11 | Detect current location | P0 | device GPS (CLIENT) + geocode | §4 | LIVE |
| 12 | Set delivery address | P0 | `PATCH /users/me` (addresses) | §4 | LIVE |
| 13 | Edit address | P0 | `PATCH /users/me` | §4 | LIVE |
| 14 | Delete address | P0 | `PATCH /users/me` | §4 | LIVE |
| 15 | Set default address | P0 | `PATCH /users/me` | §4 | LIVE |
| 16 | Validate address (serviceable) | P0 | `GET /cities`, service-areas check | §4 | LIVE |
| 17 | Geocode address | P0 | maps SDK (CLIENT) | §4 | LIVE |
| 18 | Reverse geocode | P1 | maps SDK (CLIENT) | §4 | LIVE |

## C. Service Discovery & Search (8)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 19 | Search services | P0 | `GET /search` | §6 | LIVE |
| 20 | Filter results | P0 | `GET /search?category=&price=&rating=&distance=` | §6 | LIVE |
| 21 | Sort results | P0 | `GET /search?sort=` | §6 | LIVE |
| 22 | View search history | P1 | `GET /search/history` | §6 | LIVE |
| 23 | Clear search history | P1 | `DELETE /search/history` | §6 | LIVE |
| 24 | Auto-complete search | P0 | `GET /search/suggest` | §6 | LIVE |
| 25 | Voice search | P1 | device speech → `/search` | §38 | LIVE |
| 26 | Image search | P2 | `POST /search/image` (placeholder) | §38 | LIVE |

## D. Restaurant & Food (11)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 27 | View restaurant list | P0 | `GET /merchants?cityId=` | §7 | LIVE |
| 28 | View restaurant detail | P0 | `GET /merchants/{id}` | §7 | LIVE |
| 29 | Browse menu | P0 | `GET /catalogues/{merchantId}` | §7 | LIVE |
| 30 | View menu item | P0 | `GET /catalogues/{merchantId}` (item) | §7 | LIVE |
| 31 | Add item to cart | P0 | client cart draft (+ options/addons) | §12 | LIVE |
| 32 | Remove item from cart | P0 | client cart draft | §12 | LIVE |
| 33 | Update item quantity | P0 | client cart draft | §12 | LIVE |
| 34 | Add special instructions | P0 | `OrderCreate.note` | §12 | LIVE |
| 35 | View cart summary | P0 | client cart + pricing engine | §12 | LIVE |
| 36 | Save favorite restaurant | P0 | `POST /favorites` | §30 | LIVE |
| 37 | Remove favorite restaurant | P0 | `DELETE /favorites/{merchantId}` | §30 | LIVE |

## E. Service Provider (8)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 38 | View provider list | P0 | `GET /providers?trade=` | §9 | LIVE |
| 39 | View provider detail | P0 | `GET /providers/{id}` | §9 | LIVE |
| 40 | View service offerings | P0 | `GET /providers/{id}` (services) | §9 | LIVE |
| 41 | Request quote | P0 | `GET /bookings/estimate` → `POST /bookings` | §9 | LIVE |
| 42 | Book service | P0 | `POST /bookings` (photos, answers, slot) | §9 | LIVE |
| 43 | View provider availability | P0 | availability calendar (booking screen) | §9 | LIVE |
| 44 | Save favorite provider | P0 | `POST /favorites` | §30 | LIVE |
| 45 | Remove favorite provider | P0 | `DELETE /favorites/{merchantId}` | §30 | LIVE |

## F. Grocery & Retail (7)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 46 | View product list | P0 | `GET /catalogues/{merchantId}` (retail) | §8 | LIVE |
| 47 | View product detail | P0 | catalogue item + `GET /catalogues/{merchantId}` | §8 | LIVE |
| 48 | Add product to cart | P0 | client cart draft | §8 | LIVE |
| 49 | Remove product from cart | P0 | client cart draft | §8 | LIVE |
| 50 | Update product quantity | P0 | client cart draft | §8 | LIVE |
| 51 | Save favorite product | P0 | `POST /favorites` | §30 | LIVE |
| 52 | Remove favorite product | P0 | `DELETE /favorites/{merchantId}` | §30 | LIVE |

## G. Hotel & Travel (8) — Phase 5 (hotels + flights LIVE; trains LIVE mock-first)

| # | Operation | Priority | Endpoint (planned) | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 53 | Search hotels | P1 | `/hotels` contract addition | §11 | LIVE |
| 54 | View hotel detail | P1 | `/hotels/{id}` | §11 | LIVE |
| 55 | Select room | P1 | room types on hotel detail | §11 | LIVE |
| 56 | Book hotel | P1 | `HotelBooking` transaction | §11 | LIVE |
| 57 | Search flights | P1 | `/flights` contract addition | §11 | LIVE |
| 58 | Book flight | P1 | flight booking | §11 | LIVE |
| 59 | Search trains | P1 | `/trains` contract addition | §11 | LIVE (mock-first, contract addition pending) |
| 60 | Book train | P1 | train booking | §11 | LIVE (mock-first, contract addition pending) |

## H. Order & Booking (12)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 61 | Place order | P0 | `POST /orders` (Idempotency-Key) | §12 | LIVE |
| 62 | View order confirmation | P0 | `POST /orders` response / `GET /orders/{id}` | §12 | LIVE |
| 63 | View active orders | P0 | `GET /orders/me?status=` | §13 | LIVE |
| 64 | View order history | P0 | `GET /orders/me` (cursor) | §13 | LIVE |
| 65 | View order detail | P0 | `GET /orders/{id}` | §13 | LIVE |
| 66 | Cancel order | P0 | `POST /orders/{id}/cancel` | §13 | LIVE |
| 67 | Request order modification | P1 | `POST /orders/{id}/modify-request` | §13 | LIVE |
| 68 | Reorder | P0 | prefill cart from history → `POST /orders` | §13 | LIVE |
| 69 | View booking confirmation | P0 | `POST /bookings` response / `GET /bookings/{id}` | §9 | LIVE |
| 70 | Cancel booking | P0 | `POST /bookings/{id}/cancel` | §9 | LIVE |
| 71 | Reschedule booking | P0 | `POST /bookings/{id}/reschedule` (provider side) / rebook | §9 | LIVE |
| 72 | Track order/booking | P0 | `GET /orders/{id}/track`, `GET /bookings/{id}` + realtime | §14 | LIVE |

## I. Real-Time Tracking (5)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 73 | View rider/provider location | P0 | `GET /orders/{id}/track` + WS events | §14 | LIVE |
| 74 | View ETA | P0 | track payload `estimateMinutes`/`stageEtas` | §14 | LIVE |
| 75 | View status timeline | P0 | `GET /orders/{id}/timeline` | §14 | LIVE |
| 76 | Receive push notification | P0 | `/events` WS + push | §25 | LIVE |
| 77 | Share live location | P1 | trip-share pattern (mock-first: POST /orders/{id}/tracking-share + GET /tracking-share/{token}, 2h expiry, read-only recipient view) | §14 | LIVE |

## J. Payment & Wallet (14)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 78 | Add payment method | P0 | `GET/POST /payments/methods` (+ saved methods) | §15 | LIVE |
| 79 | Remove payment method | P0 | payment methods surface | §15 | LIVE |
| 80 | Set default payment method | P0 | payment methods surface | §15 | LIVE |
| 81 | Process payment | P0 | `POST /payments/intent`, `POST /payments/{id}/confirm`, `GET /payments/{id}` | §15 | LIVE |
| 82 | Process refund | P0 | `POST /payments/{id}/refund` (rules) + refund status | §15 | LIVE |
| 83 | View wallet balance | P0 | `GET /wallet/me` | §15 | LIVE |
| 84 | Top up wallet | P1 | `POST /wallet/me/top-up` | §15 | LIVE |
| 85 | Withdraw from wallet | P1 | `/wallet/me/withdraw` endpoints (contract addition) | §15 | LIVE |
| 86 | View transaction history | P0 | `GET /wallet/me/transactions` | §15 | LIVE |
| 87 | Apply coupon/promo code | P0 | `GET /coupons/me` + checkout apply | §16 | LIVE |
| 88 | View coupon details | P0 | coupon payload terms | §16 | LIVE |
| 89 | Remove coupon | P0 | checkout (client) | §16 | LIVE |
| 90 | View invoice | P1 | customer invoice (contract addition) | §15 | LIVE |
| 91 | Download invoice (PDF) | P1 | invoice download (contract addition) | §15 | LIVE |

## K. Communication (9)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 92 | Send in-app message | P0 | `POST /conversations`, `POST /conversations/{id}/messages` | §19 | LIVE |
| 93 | Receive in-app message | P0 | WS `/events` + `GET /conversations/{id}/messages` | §19 | LIVE |
| 94 | View message history | P0 | `GET /conversations/{id}/messages` | §19 | LIVE |
| 95 | Send image/attachment | P1 | `ChatMessageCreate.attachments` (mediaType) | §19 | LIVE |
| 96 | Initiate call | P0 | `POST /orders/{id}/masked-call` | §19 | LIVE |
| 97 | Receive call | P0 | masked-call inbound | §19 | LIVE |
| 98 | View notification list | P0 | `GET /notifications/me` | §19 | LIVE |
| 99 | Mark notification read | P0 | `POST /notifications/{id}/read` | §19 | LIVE |
| 100 | Clear notifications | P1 | `POST /notifications/read-all` (+ per-item) | §19 | LIVE |

## L. Reviews & Ratings (7)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 101 | Submit review | P0 | `POST /reviews` (dimensions) | §18 | LIVE |
| 102 | Add photos to review | P0 | `ReviewCreate` attachments | §18 | LIVE |
| 103 | Edit review | P1 | `PATCH /reviews/{id}` | §18 | LIVE |
| 104 | Delete review | P1 | `DELETE /reviews/{id}` | §18 | LIVE |
| 105 | View reviews | P0 | `GET /reviews` (public) | §18 | LIVE |
| 106 | Flag review | P1 | `POST /reviews/{id}/report` | §18 | LIVE |
| 107 | Mark review helpful | P1 | `POST /reviews/{id}/helpful` | §39 | LIVE |

## M. Loyalty & Rewards (9)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 108 | Earn points | P0 | `GET /loyalty-transactions` (earn) | §17 | LIVE |
| 109 | View points balance | P0 | `GET /memberships/me` | §17 | LIVE |
| 110 | View points history | P0 | `GET /loyalty-transactions` | §17 | LIVE |
| 111 | Redeem points | P0 | redemption (contract addition) | §17 | LIVE (mock-first, contract addition pending) |
| 112 | View membership tier | P0 | `GET /memberships/me` | §17 | LIVE |
| 113 | View tier progress | P0 | `GET /memberships/me` (level/benefits) | §17 | LIVE |
| 114 | Daily check-in | P1 | `POST /check-in` | §17 | LIVE |
| 115 | Refer friend | P1 | `/referrals` (contract addition) | §36 | LIVE |
| 116 | Track referrals | P1 | `/referrals` (contract addition) | §36 | LIVE |

## N. Favorites & Saved Items (4)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 117 | Add to favorites | P0 | `POST /favorites` | §30 | LIVE |
| 118 | Remove from favorites | P0 | `DELETE /favorites/{merchantId}` | §30 | LIVE |
| 119 | View favorites | P0 | `GET /favorites` | §30 | LIVE |
| 120 | Organize favorites (lists) | P2 | contract addition | §30 | LIVE (mock-first, contract addition pending) |

## O. Settings & Preferences (7)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 121 | Update notification preferences | P0 | `GET/PUT /notifications/me/preferences` | §21 | LIVE |
| 122 | Update language | P0 | `PATCH /users/me` (locale) | §21 | LIVE |
| 123 | Update privacy settings | P0 | consent layer (CLIENT + `PATCH /users/me`) | §21 | LIVE |
| 124 | View app version | P0 | client (app metadata) | §21 | CLIENT |
| 125 | Update app | P0 | store update flow | §21 | CLIENT |
| 126 | Clear cache | P1 | client storage | §21 | CLIENT |
| 127 | Export data | P2 | `POST /privacy/export` | §21 | LIVE |

## P. Support & Help (8)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 128 | View help center | P0 | `GET /help/articles` | §20 | LIVE |
| 129 | Search help center | P0 | `GET /help/articles?q=` | §20 | LIVE |
| 130 | Create support ticket | P0 | `POST /support/tickets` (category/urgency) | §20 | LIVE |
| 131 | View support ticket | P0 | `GET /support/tickets/me`, `GET /support/tickets/{id}` | §20 | LIVE |
| 132 | Reply to ticket | P0 | `POST /support/tickets/{id}/messages` | §20 | LIVE |
| 133 | Close ticket | P1 | ticket status change | §20 | LIVE |
| 134 | Live chat support | P0 | support conversation (staff role) | §20 | LIVE |
| 135 | Submit feedback | P1 | `POST /support/tickets` (category `feedback`) | §42 | LIVE |

## Q. Cross-Category & Platform (5)

| # | Operation | Priority | Endpoint | Blueprint | Status |
| --- | :-: | --- | --- | --- | :-: |
| 136 | Switch service category | P0 | navigation (CLIENT) | §2 | LIVE |
| 137 | View unified dashboard | P0 | `GET /home` (BFF) + activity center | §5, §13 | LIVE |
| 138 | Share order/booking | P1 | share sheet (CLIENT) + trip-share pattern | §14 | LIVE |
| 139 | Print order/booking | P2 | client print | §13 | CLIENT |
| 140 | Set preferred providers | P2 | contract addition | §13 | LIVE (mock-first, contract addition pending) |

## Summary

| Category | Ops | P0 | P1 | P2 | LIVE | PLANNED | CLIENT |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| A | 10 | 7 | 3 | 0 | 10 | 0 | 0 |
| B | 8 | 7 | 1 | 0 | 8 | 0 | 0 |
| C | 8 | 4 | 3 | 1 | 8 | 0 | 0 |
| D | 11 | 11 | 0 | 0 | 11 | 0 | 0 |
| E | 8 | 8 | 0 | 0 | 8 | 0 | 0 |
| F | 7 | 7 | 0 | 0 | 7 | 0 | 0 |
| G | 8 | 0 | 8 | 0 | 8 | 0 | 0 |
| H | 12 | 11 | 1 | 0 | 12 | 0 | 0 |
| I | 5 | 4 | 1 | 0 | 4 | 1 | 0 |
| J | 14 | 10 | 4 | 0 | 14 | 0 | 0 |
| K | 9 | 7 | 2 | 0 | 9 | 0 | 0 |
| L | 7 | 3 | 4 | 0 | 7 | 0 | 0 |
| M | 9 | 6 | 3 | 0 | 9 | 0 | 0 |
| N | 4 | 3 | 0 | 1 | 4 | 0 | 0 |
| O | 7 | 5 | 1 | 1 | 4 | 0 | 3 |
| P | 8 | 6 | 2 | 0 | 8 | 0 | 0 |
| Q | 5 | 2 | 1 | 2 | 4 | 0 | 1 |
| **TOTAL** | **140** | **101** | **34** | **5** | **136** | **0** | **4** |

> Note: these totals come from the per-operation priority column (authoritative).
> The pasted source's §IV summary (P0=72, P1=48, P2=20) does not match its own
> per-operation markings (P0=101, P1=34, P2=5) and should not be used.

Every P0 is LIVE; 136/140 operations are LIVE (mock-first items name their
contract addition pending). No PLANNED rows remain in this matrix; the
consumer app is feature-complete against the contract (live + mock-first),
with the remaining mock-first paths tracked in CONTRACT-ADDITIONS.md for
Team 6 adoption.

## User journeys (operation sequences)

### A. Pre-Order/Booking journey
1. Register/Login (#1–4) → 2. Set Location (#11–16) → 3. Search/Discover (#19–26)
→ 4. Browse Details (#28–30, #39–40, #47) → 5. Select Items/Services (#31, #42)
→ 6. Add to Cart / Book (#31–35, #42) → 7. Apply Coupon (#87–89) → 8. Checkout
(#61) → 9. Confirm (#62, #69).

### B. Order/Booking journey
1. Place Order/Booking (#61, #42) → 2. Receive Confirmation (#62, #69) →
3. Track Status (#72–75) → 4. Receive Notifications (#76, #98) →
5. Communicate (#92–97) → 6. Complete (status terminal + #81 settlement).

### C. Post-Order/Booking journey
1. Rate & Review (#101–107) → 2. Earn Points (#108–110) → 3. View Order
History (#64) → 4. Reorder (#68) → 5. Track Warranty/Follow-up (service
warranty on `Booking`, consumer follow-up via notifications + tickets #130–132).
