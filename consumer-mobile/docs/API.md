# Customer App — API Surface

Source of truth: `backend/API-CONTRACT.yaml`; base path is `/api/v1` (see `ARCHITECTURE.md`).
All mutations require `Authorization: Bearer` and an `Idempotency-Key` where noted. Errors:
`ErrorResponse` (`code`, `message`, `requestId`, optional `retryAfterSeconds`); validation returns
`ValidationResponse` (`errors[]`). MSW dev mocks implement this exact surface (`src/mocks/`).

## Auth

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| POST | `/auth/request-otp` | Request OTP (channel `phone`/`email`, purpose `login`/`signup`) | Returns `OtpDelivery` (`requestId`, `expiresInSeconds`, `resendInSeconds`). Never reveals if account exists. 429 → resend timer. |
| POST | `/auth/verify-otp` | Verify code (`requestId`, `code` 4–8) | Returns `Session`. 401 → `OTP_INVALID` / `OTP_EXPIRED` / `OTP_MAX_ATTEMPTS`. Role switch = new verify call (`purpose: verify_role`). |
| POST | `/auth/refresh` | Rotate access token | Returns `Session`; 401 → `REFRESH_TOKEN_REVOKED` → force logout. |
| POST | `/auth/logout` | Revoke session | 204. Also clears device push token. |

## Users

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET/PATCH | `/users/me` | Profile with `activeRole` / update (`fullName`, `email`, `avatarUrl`, `locale` en/sw/ar) | GET drives role-aware redirect; PATCH locale change re-renders i18n. |
| GET | `/users/me/roles` | Roles for switching | `RoleSummary[]` (`customer`, `merchant`, `provider`, `rider`). Switching never mixes sessions. |

## Discovery (cities, services, merchants, providers)

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| GET | `/cities` | Cities + `serviceAreas` | `?country=TZ`. Empty → "No service available in selected city". |
| GET | `/services` | Service catalogue | `?cityId&category&limit&cursor`; `unit` per_order/per_hour/per_visit/per_item. |
| GET | `/merchants` | Approved merchant discovery | `?cityId&category&limit&cursor`. `isOpen` gates ordering. |
| GET | `/merchants/{merchantId}` | Merchant public profile | `MerchantPublic` (rating, `reviewCount`, `deliveryMinutes`, `isOpen`). 404 → not visible. |
| GET | `/catalogues/{merchantId}` | Public catalogue | `Catalogue` → `CatalogueItem` (`priceTZS`, `available`, `options[]`). |
| GET | `/providers` | Approved provider discovery | `?cityId&trade&limit&cursor`. `ProviderPublic` (`verified`, `baseRateTZS`). Empty → "No providers for requested time/area". |

## Orders

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| POST | `/orders` | Create order draft + payment intent | Header `Idempotency-Key` required. Body `OrderCreate` (`merchantId`, `items[{catalogueItemId, quantity, options}]`, `paymentMethod` mpesa/tigo_pesa/airtel_money/card/cod, `deliveryAddress`, `note`, optional `scheduledAt` for advance orders). 422 → `ORDER_*` codes (`ORDER_MERCHANT_CLOSED`, `ORDER_ITEM_UNAVAILABLE`, `ORDER_PRICE_CHANGED`, `ORDER_SCHEDULED_IN_PAST`). Returns `Order` (`status`, `totals`, `scheduledAt`). |
| GET | `/orders/me` | Own orders | `?status&limit&cursor`. Cursor pagination; status chips. |
| GET | `/orders/{orderId}` | Order detail + events | `OrderDetail` (`items`, `deliveryAddress`, `events[]`). 403/404 → not yours/not visible. |
| POST | `/orders/{orderId}/cancel` | Cancel order | Body `reason` ≤500. 409 → `ORDER_NOT_CANCELLABLE`; shows cancellation fee first. |
| POST | `/orders/{orderId}/rush` | Hurry-up on an active order | 204; event recorded + `rushRequestedAt` set, merchant notified (`order.rush_requested`). 409 → `ORDER_RUSH_NOT_ALLOWED` → toast. |
| GET | `/orders/{orderId}/track` | Live tracking | `TrackingEvent` (`status`, `riderLocation{lat,lon}`, `updatedAt`, `estimateMinutes`). |
| GET | `/orders/{orderId}/route` | Multi-leg route (intercity/relay) | Read-only for customers; `RouteSegment[]` — per-leg `type` (`first_mile`/`linehaul`/`hub_transfer`/`last_mile`/`return`), `mode`, `fromHubId`/`toHubId`, `status` (`pending`/`in_progress`/`completed`/`skipped`), `etaAt`. 404 → not visible / no route yet. |
| GET | `/orders/{orderId}/waybill` | Waybill trail (intercity/relay) | Read-only for customers; `{waybillNumber, events[]}` — event `type` `scanned`/`handoff`/`loaded`/`departed`/`arrived`/`sorted`/`exception`/`delivered` with `location`, `actor?`, `note?`. 404 → not visible. |
| GET | `/orders/{orderId}/tracking-phases` | Logical tracking phases (intercity) | Read-only for customers; `TrackingPhase[]` — `phase` `confirmed`/`picked_up`/`in_transit`/`arrived_city`/`out_for_delivery`/`delivered`, `label`, `status` `pending`/`active`/`completed`, `at?`, `eta?`. 404 → not visible / no phases yet. Physical leg states are hidden (ORDER-FLOW.md). |

`Order.fulfillmentType` (`local`/`intercity`/`relay`), `Order.waybillNumber`,
`Order.dispatchStrategy` (`nearest`/`zone`/`multi_leg`/`relay`/`warehouse`), and
`Order.fulfillmentSource` (`merchant`/`warehouse`) are read-only customer fields
(server-set); leg advancement and handoffs are rider/carrier-scoped (rider
API.md, LONG-HAUL-RELAY.md) — the customer app never calls
`/legs/{legId}/advance` or `/handoff`. Warehouse-fulfilled orders
(`fulfillmentSource: warehouse`) render the warehouse as the journey origin and
the server-provided strategy label (ORDER-FLOW.md); `dispatchStrategy` never
changes cancel/refund rules or support routing.

### `GET /orders/{orderId}/tracking-phases` — full reference

- Purpose: logical tracking phases for the customer (physical leg/vehicle states are hidden — privacy + simplicity).
- Security: customer-role, order-scoped; 403/404 for orders not visible to the caller.
- Response 200: `TrackingPhase[]`:

```json
[
  { "phase": "confirmed", "label": "Order confirmed", "status": "completed",
    "at": "2026-08-13T08:02:00Z", "eta": null },
  { "phase": "picked_up", "label": "Picked up", "status": "completed",
    "at": "2026-08-13T10:14:00Z", "eta": null },
  { "phase": "in_transit", "label": "Traveling", "status": "active",
    "at": null, "eta": "2026-08-14T12:00:00Z" },
  { "phase": "arrived_city", "label": "Arrived in your city", "status": "pending",
    "at": null, "eta": null },
  { "phase": "out_for_delivery", "label": "Out for delivery", "status": "pending",
    "at": null, "eta": null },
  { "phase": "delivered", "label": "Delivered", "status": "pending",
    "at": null, "eta": null }
]
```

| Field | Type | Values / meaning |
| --- | --- | --- |
| `phase` | enum | `confirmed`, `picked_up`, `in_transit`, `arrived_city`, `out_for_delivery`, `delivered` (fixed order; the client renders the strip in this order) |
| `label` | string | server copy, localized (e.g. "Order confirmed") |
| `status` | enum | `pending` (no time — never render a fabricated one), `active` (current phase, highlighted), `completed` (timestamp shown) |
| `at` | date-time, nullable | when the phase completed (UTC → local rendering) |
| `eta` | date-time, nullable | per-phase ETA; renders the delivery-window promise only when present |

- Error responses: 404 (order not visible / no phases yet → "Tracking unavailable" + retry), 401 `UNAUTHORIZED`, 403 `FORBIDDEN`.
- Refresh: `intercity.eta_updated` (push + in-app) and `waybill.updated` (in-app) trigger a refetch; phases never advance from client logic.

### Warehouse-fulfilled orders (tracking-phases note)

For `Order.fulfillmentSource: warehouse` orders the endpoint behaves identically,
with the warehouse as the journey origin:

| Scenario | Phase mapping (same six phases) |
| --- | --- |
| Warehouse in the delivery city (`fulfillmentType: local`) | `confirmed` → `picked_up` (warehouse pickup scan) → `out_for_delivery` → `delivered`; `in_transit`/`arrived_city` complete quickly or are skipped server-side — the client always renders the fixed six-phase strip and marks phases per the returned statuses (never invents skips) |
| Warehouse in another city (`fulfillmentType: intercity`) | full six-phase strip with the warehouse as the first-mile origin: `confirmed` → `picked_up` (warehouse scan) → `in_transit` (line-haul) → `arrived_city` → `out_for_delivery` → `delivered` |

- `warehouse.fulfilled` (push + in-app) triggers a refetch of the order + phases;
  the header renders the server-provided strategy label (e.g. "Arrives today via
  nearest warehouse") when `Order.dispatchStrategy: warehouse` — the client
  renders the label from the server, never composing it.
- `warehouse.stock_low` never reaches the customer app (merchant/ops channel).
- Warehouse/exception internals (`WAREHOUSE_STOCK_UNAVAILABLE`,
  `EXCEPTION_*`, `autoReplanned`) are never surfaced to the customer: delays
  render only through `intercity.eta_updated` + the amber banner (ORDER-FLOW.md).

Rejection awareness: `POST /orders/{orderId}/reject` is merchant-side (never called by the app);
`order.rejected` push + `Order.rejectReason` render the terminal `OrderStatus` with a reason
banner (`ORDER_ALREADY_REJECTED`, `ORDER_REJECT_AFTER_ACCEPTANCE` → refetch on conflict).
UI statuses rendered (from `OrderStatus`): `draft`, `pending_payment`, `paid`,
`merchant_accepted`, `preparing`, `rider_assigned`, `picked_up`, `delivering`, `delivered`,
`completed` (timeline), terminal `cancelled`, `refunded`, `failed`, `disputed`.

## Bookings

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| POST | `/bookings` | Create booking draft + intent | Header `Idempotency-Key`. Body `BookingCreate` (`providerId`, `serviceId`, `scheduledFor`, `durationMinutes` 15–480, `paymentMethod`, `address`, `description` ≤2000). 422 → `BOOKING_TIME_IN_PAST`, `BOOKING_DURATION_INVALID`, `BOOKING_PROVIDER_UNAVAILABLE`. |
| GET | `/bookings/me` | Own bookings | `?status&limit&cursor`. |
| GET | `/bookings/{bookingId}` | Booking detail + events | `BookingDetail` (`address`, `description`, `events[]`). |
| POST | `/bookings/{bookingId}/cancel` | Cancel booking | Body `reason` ≤500. 409 → `BOOKING_NOT_CANCELLABLE`; fee shown before confirm. |
| POST | `/bookings/{bookingId}/complete` | Customer completion confirmation | Only from `awaiting_customer_confirmation`. 409 → `BOOKING_STATUS_CONFLICT`. |

UI statuses (from `BookingStatus`): `draft`, `pending_payment`, `paid`, `provider_requested`,
`provider_accepted`, `scheduled`, `provider_arrived`, `in_progress`,
`awaiting_customer_confirmation`, `completed`; terminal `declined`, `cancelled`, `refunded`,
`disputed`, `no_show`.

## Payments

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| POST | `/payments/intent` | Create/confirm intent | Header `Idempotency-Key`. Body `PaymentIntentCreate` (`orderId`, `method`). Returns `PaymentIntent` (`status`, `amountTZS`, `providerReference`). UI statuses: `created`, `pending`, `paid`, `failed`, `refunded`, `partially_refunded`. |
| POST | `/payments/{intentId}/confirm` | Client-side confirm where provider requires | Only drives provider UX; state changes come from webhooks. |
| POST | `/payments/{intentId}/refund` | Refund paid intent | Body `amount`, `reason`. UI displays refund status only (`refunded`, `partially_refunded`); never initiated by customer from the app UI except via cancel/auto-refund rules. |
| — | `/payments/webhooks/{provider}` | (server) signed webhook | Not called by the app; client never trusts callbacks. |

## Reviews

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| POST | `/reviews` | Create review after completion | `ReviewCreate` (`targetType` merchant/provider/rider, `targetId`, `rating` 1–5, `body` ≤2000). 422 → `REVIEW_NOT_ELIGIBLE`, `REVIEW_ALREADY_EXISTS`. |
| POST | `/reviews/{reviewId}/report` | Report abuse | Body `reason` ≤300 → `ReviewReport`. |

## Notifications

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET | `/notifications/me` | Notification list | `?unreadOnly&limit&cursor`. `Notification` (`type`, `title`, `body`, `deepLink`, `read`). |
| GET/PUT | `/notifications/me/preferences` | Read / save preferences | `NotificationPreferences` (`push`/`sms`/`email`/`inApp` maps); PUT 422 → `PREFERENCE_INVALID_EVENT`. |
| POST | `/notifications/{notificationId}/read` | Mark read | 204. |

## Support tickets

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| POST | `/support/tickets` | Open ticket | `TicketCreate` (`subject` ≤160, `body` ≤4000, optional `orderId`/`bookingId`). |
| GET | `/support/tickets/me` | Own tickets | `Ticket` (`status` open/assigned/in_progress/resolved/closed, `priority`). |
| GET | `/support/tickets/{ticketId}` | Ticket detail | `TicketDetail` (`messages[]` with `authorRole`, `body`). |
| POST | `/support/tickets/{ticketId}/messages` | Reply | Body `body` ≤4000; 422 → `TICKET_CLOSED`. |

## Dine-in and reservations

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| GET | `/dine-in/tables/{tableId}/qr` | QR payload + menu URL | Returns `qrPayload` (`hudumika:dinein:table:{tableId}`) + `menuUrl` (browser fallback). |
| POST | `/dine-in/orders` | Open a dine-in order | `Idempotency-Key`. Body `DineInOrderCreate` (`merchantId`, `tableId`, `items[{catalogueItemId, quantity, options}]`). 201 → `DineInOrder`. 422 → `DINE_IN_TABLE_IN_USE`. |
| GET | `/dine-in/orders/me` · `/dine-in/orders/{dineInOrderId}` | Own dine-in bills / bill detail | `?status` filter; `DineInOrderStatus` `open`→`billing`→`paid`→`closed`; parties only, 403/404 → not visible. |
| POST | `/reservations` | Reserve table/queue slot | Body `{merchantId, partySize 1–50, scheduledFor, note ≤300}`. 201 → `Reservation` (`pending`). 422 → `RESERVATION_TIME_IN_PAST`, `RESERVATION_TABLE_FULL`. |
| GET | `/reservations/me` | Own reservations | Statuses `pending`/`confirmed`/`seated`/`completed`/`cancelled`/`no_show`. |
| POST | `/reservations/{reservationId}/cancel` | Cancel reservation | 409 → `RESERVATION_NOT_CANCELLABLE`. |

## Group buy and vouchers

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| GET | `/group-buys` | Live deals feed | `?cityId&limit&cursor`; `GroupBuyDeal` (`priceTZS` vs `originalPriceTZS`, `validityDays` default 90, `salesEndAt`). |
| GET | `/group-buys/{groupId}` | Deal detail | 404 → `GROUP_BUY_NOT_FOUND`. |
| POST | `/group-buys/{groupId}/purchase` | Buy deal, issue vouchers | `Idempotency-Key`. Body `{quantity 1–20}`. 201 → `Voucher[]`. `GROUP_BUY_ENDED`, `GROUP_BUY_QUANTITY_EXCEEDED`. |
| GET | `/vouchers/me` | Own vouchers | `?status` filter; `unused`/`redeemed`/`expired`/`refunded`/`void`. |
| (merchant) | `POST /vouchers/{voucherCode}/verify` | Verify at merchant | App shows code + QR only; outcomes `redeemed`/`invalid`/`expired`/`already_used`. |

## Coupons, membership, favorites

| Method | Path | Purpose | Notes / UI statuses |
| --- | --- | --- | --- |
| GET | `/promotions?merchantId=` | Active promotions on a merchant | `Promotion` types discount/spend_based/instant_discount/bargain/coupon/traffic; campaign pill on merchant cards. |
| GET | `/coupons/me` | Own coupon wallet | `?status`; `available`/`claimed`/`used`/`expired`/`void`. |
| POST | `/coupons/{couponId}/claim` | Claim a coupon | 201 → `Coupon`. 409/422 → `COUPON_ALREADY_CLAIMED`, `COUPON_CAMPAIGN_SOLD_OUT`, `COUPON_EXPIRED`. |
| GET | `/memberships/me` | Platform membership | `CustomerMembership` (`points`, `level`, `memberSince`, `benefits[]`); read-only. |
| GET | `/favorites` | Favorite merchants | `MerchantPublic[]`; empty → "No favorites yet". |
| POST/DELETE | `/favorites{/merchantId}` | Favorite / unfavorite a merchant | POST body `{merchantId}` → 204; DELETE → 204. |

## Conversations (chat)

Customer ↔ merchant staff 1:1 chat (see `CHAT.md`). Staff-only routes (`/admin/conversations`,
`/conversations/{id}/block`) are never called by the app. Error codes:
`CONVERSATION_NOT_FOUND`, `CONVERSATION_FORBIDDEN`, `CONVERSATION_BLOCKED`,
`CONVERSATION_ARCHIVED`, `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`, `MESSAGE_RATE_LIMITED`,
`MESSAGE_ATTACHMENT_INVALID`.

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| GET | `/conversations` | Own conversations | `?status` (`open`/`archived`/`blocked`) `&limit&cursor`; `Conversation` (`status`, `unreadCount`, `lastMessagePreview`). |
| POST | `/conversations` | Open conversation with merchant | Body `ConversationCreate` (`merchantId`, optional `orderId`, `subject` ≤160, `initialMessage` ≤2000). 201 → `Conversation`. 422 → validation. |
| GET | `/conversations/{conversationId}` | Detail + participants | `ConversationDetail` (`participants[]` with `role` customer/merchant_staff/system, `displayName`, `maskedPhone` only, optional `orderId`). 403/404 → not visible. |
| GET | `/conversations/{conversationId}/messages` | Message history | `?limit` (default 30) `&cursor`; `ChatMessage` (`authorRole`, `body` ≤2000, `attachments[]`, `readAt`, `createdAt`). |
| POST | `/conversations/{conversationId}/messages` | Send message | Body `ChatMessageCreate` (`body` 1–2000, `attachments` ≤4 URIs). 201 → `ChatMessage`. 409 → `CONVERSATION_BLOCKED`/`CONVERSATION_ARCHIVED`/`MESSAGE_RATE_LIMITED`. |
| POST | `/conversations/{conversationId}/read` | Mark conversation read | 204; clears the unread badge on thread open. |
| POST | `/conversations/{conversationId}/archive` | Archive (either party) | 204; archived stays readable under `?status=archived`. |
| GET | `/conversations/unread-count` | Badge count | `{count}`; drives the chat tab badge. |
