# Customer App — Notifications

Event catalog and channel defaults come from `backend/NOTIFICATIONS.md`. The app implements:
push registration, in-app notification center, per-event UI mapping, and a preferences screen.

## Push setup

| Step | Detail |
| --- | --- |
| 1. Permission copy | Explain why before requesting (OS requirement); copy in-app before the system dialog: e.g. "Tunakujulisha maagizo na mabadiliko" (we notify you about orders and changes) |
| 2. Token registration | On login: get Expo push token via `expo-notifications`, register per user; on logout: unregister |
| 3. Refresh | Re-register token on session refresh / app resume if changed |
| 4. Failure | `PUSH_TOKEN_INVALID` → retry registration; permission denied → preferences screen banner, in-app notifications still work |
| 5. Deep links | Payload `deepLink` navigates: `order/{orderId}`, `booking/{bookingId}`, `ticket/{ticketId}`, `conversation/{conversationId}` (validated — see `SECURITY.md`); dine-in bill, reservation, and voucher routes join the same allow-list as they ship |

High-priority system events (OTP, security, payout failures) cannot be disabled (backend rule).

## In-app notification center

- Source: `GET /notifications/me` (`?unreadOnly&limit&cursor`), pull-to-refresh, unread badge.
- Row: `title`, `body`, local time from `createdAt` (UTC → local), unread dot.
- Tap: mark read `POST /notifications/{notificationId}/read`, then navigate via `deepLink`.
- States: loading skeletons / empty ("Huna taarifa" — no notifications) / error + retry / success.
- Realtime: WebSocket updates while app is open; otherwise pull on resume.

## Per-event UI mapping

| Event (type) | UI behavior |
| --- | --- |
| `otp.requested` / `otp.verified` | Inline in auth flow (in-app); no center row required |
| `order.created` | In-app + push → order detail |
| `payment.success` | In-app + push → order/booking detail, "Paid" pill |
| `payment.failed` | In-app + push + SMS → payment retry screen |
| `order.accepted` | Push + in-app → timeline step `merchant_accepted` |
| `order.preparing` | Push → status update |
| `order.rider_assigned` | Push → tracking screen |
| `order.picked_up` / `order.delivering` | Push → live tracking |
| `order.delivered` | Push + in-app → "Confirm delivery" prompt + review CTA |
| `order.completed` | In-app → review prompt |
| `order.cancelled` | Push + in-app → cancel reason + refund info |
| `order.rejected` | Push + in-app → order detail: `rejectReason` banner + refund info |
| `order.rush_requested` | (merchant push, in-app — not a customer event; customer sees in-app confirmation + `rushRequestedAt`) |
| `order.scheduled_reminder` (30 min before advance order) | Push + SMS → advance order detail |
| `refund.processed` | SMS + in-app → refund card |
| `reservation.requested` / `reservation.confirmed` | Push + in-app → reservation detail |
| `reservation.reminder` | Push + in-app → reservation detail (both parties) |
| `dine_in.order_opened` / `dine_in.paid` | (merchant in-app; customer refetches the bill on pull-to-refresh) |
| `dine_in.bill_requested` | (merchant push + in-app; fires when the customer requests the bill via the app) |
| `group_buy.moderated` | Not a customer event — merchant-side only; customers see the deal status on detail |
| `voucher.redeemed` / `coupon.claimed` / `member.top_up` | Merchant-side events; not customer notifications |
| `booking.requested` | (provider push; customer sees `provider_requested` timeline) |
| `booking.accepted` | Push + in-app → `provider_accepted` |
| `booking.declined` | Push → "Request another provider" CTA |
| `booking.reminder` (1 h before) | Push + SMS → booking detail countdown |
| `booking.arrived` | Push → provider arrival banner |
| `booking.completed` | In-app + push → completion confirmation screen |
| `booking.no_show` | In-app → no-show banner + refund/dispute CTA |
| `dispute.opened` / `dispute.resolved` | In-app → dispute banner; resolved → `refunded`/`completed` |
| `review.received` | In-app (target sees it) |
| `review.moderated` | In-app → review state (`hidden`/`deleted` copy) |
| `ticket.reply` | Push + in-app → ticket detail |
| `message.received` | Push + in-app → chat thread (`conversation/{conversationId}`); increments the chat unread badge (`GET /conversations/unread-count`), cleared on thread open via `/read` |
| `platform.announcement` | In-app (email for policy changes) → announcement row in the center; tap opens the payload `deepLink` or the announcement body |
| `platform.campaign` | In-app + push → center row with campaign copy; tap navigates via `deepLink` only (no invented routes) |
| `conversation.blocked` | In-app (both parties) → chat thread banner + read-only composer; row tap opens `conversation/{conversationId}` |
| `lead.reviewed` | SMS + in-app (applicant path; not customer flow) |
| `leg.started` / `leg.completed` | Push + in-app → route timeline leg flips to `in_progress` / `completed` (ORDER-FLOW.md intercity section) |
| `handoff.completed` | In-app → custody-transfer row appears on the route timeline |
| `consignment.departed` / `consignment.arrived` | In-app → line-haul phase updates on the route timeline (orders on board) |
| `consignment.exception` | Ops + carrier critical push; customer sees the resulting `waybill.updated` exception row and the new ETA — no direct customer row |
| `waybill.updated` | In-app → waybill trail refresh, including `exception` events |
| `intercity.eta_updated` | Push + in-app → per-leg ETAs and the multi-day delivery window update on the route timeline |

## Logistics events — full customer mapping (intercity)

All logistics events the customer can receive, with the exact UI mapping, channel,
and refetch behavior. Physical internals (leg ids, hubs, vehicle numbers, custody
entries) are never rendered to the customer — only logical phases and windows.

| Event (type) | Channel | UI behavior | Refetch |
| --- | --- | --- | --- |
| `leg.started` | push + in-app | Route timeline leg flips to `in_progress` ("{city} → {city} leg started") | route timeline |
| `leg.completed` | push + in-app | Leg flips to `completed`; the next leg becomes visible; the six-phase timeline may advance a phase | route + tracking-phases |
| `handoff.completed` | in-app | Custody-transfer row appears on the route timeline ("Handed to next carrier"); no phase change alone | route |
| `consignment.departed` | in-app | Line-haul phase updates on the route timeline (orders on board) | route |
| `consignment.arrived` | in-app | Line-haul phase completes at the destination hub; `arrived_city` phase becomes `active`/`completed` | route + tracking-phases |
| `consignment.exception` | ops + carrier (critical push — not a customer row) | Customer sees the resulting `waybill.updated` exception row + the new ETA via `intercity.eta_updated` | tracking-phases + waybill |
| `waybill.updated` | in-app | Waybill trail refresh, including `exception` events (amber row on the trail) | waybill |
| `intercity.eta_updated` | push + in-app | Per-leg ETAs and the multi-day delivery window update ("Arrives Day 2, 09:00–14:00"); the active phase `eta` re-renders; delay banner when the window moved later | route + tracking-phases |
| `package.scanned` | in-app (next-handler event; customer-visible effect only) | `picked_up` phase completes with timestamp when the pickup scan fired | tracking-phases |
| `shipment.created` | merchant in-app — not a customer event | — | — |
| `trip.departed` / `trip.arrived` | driver + hubs — customer-visible effect only | `in_transit` phase completes at `trip.departed`; `arrived_city` at arrival | tracking-phases |

Customer-visible effect summary per phase: `confirmed` ← order paid; `picked_up`
← pickup scan; `in_transit` ← trip departed; `arrived_city` ← consignment
arrival scan; `out_for_delivery` ← last-mile assignment; `delivered` ← delivery
scan (also fires `order.delivered` — the standard delivery notification).

Timestamps in rows render local time; payload timestamps are UTC (backend rule).

Voucher expiry reminder: client-scheduled local notification from `Voucher.expiresAt` (~48 h
before) — no backend event exists yet, so it is never mapped in preferences as an unshipped event.
New-resource deep links (dine-in bill, reservation, voucher) use the same allow-list validation
as order/booking/ticket; unknown payloads open the app root.

## Preferences screen

- Source: `GET /notifications/me/preferences` → `NotificationPreferences`
  (`push`, `sms`, `email`, `inApp` maps, keys like `order.status:push`).
- UI: grouped toggle lists per event type and channel.
- Save: `PUT /notifications/me/preferences`; optimistic update + rollback on error.
- `PREFERENCE_INVALID_EVENT` (422) → highlight invalid row, show error state.
- Locked-off toggles (system/security events) render disabled with helper text.
- States: loading / empty (defaults) / error + retry / saved toast.

## Consent and privacy

- Push permission requested only after explanatory copy; revocable in OS settings and in-app.
- Notification list data never leaves the device except API calls; no analytics payloads contain
  `body` or `deepLink` content.
