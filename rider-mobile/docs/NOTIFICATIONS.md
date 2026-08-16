# HUDumika RIDER — Notifications

Source: `backend/NOTIFICATIONS.md` + contract endpoints. Push via Expo Push Service (FCM/APNs behind it).

## Push setup

- Use `expo-notifications`; register the device token after login and refresh it on every login (tokens stored per user server-side).
- Request permission only after explaining why (in-app explainer: assignments, order status, payout failures), with a settings screen fallback.
- Critical assignment notifications: the `order.rider_assigned` push should use the priority/critical channel so the offer is visible during the 120 s window even when the phone is locked; local "new offer" sound handled by the OS channel.
- Token registration failures: retry with backoff; degrade gracefully (in-app pull still works).

## In-app notification center

- `GET /notifications/me?unreadOnly=&limit=&cursor=` — cursor-paginated list.
- Pull-to-refresh on open; realtime via WebSocket for the active session (invalidate the query on events).
- Row: title, body, relative/local time (`createdAt` UTC → local), unread dot.
- Tap: mark read (`POST /notifications/{notificationId}/read`) then navigate via `deepLink` (order detail, ticket, payout statement).
- Unread badge on the Notifications tab from `unreadOnly=true` count.
- Loading / empty ("No notifications") / error+retry / success states on the list screen.

## Event → UI mapping (rider-relevant)

From the `NOTIFICATIONS.md` event catalog:

| Event | Rider UI | Channel (default) |
| --- | --- | --- |
| `order.rider_assigned` | OfferModal with 120 s countdown; deep link to offer/order | push, in-app |
| `order.rider_arrived_pickup` | DeliveryDetail updates to "Arrived at pickup"; merchant + customer notified (rider sees the state, no own action) | in-app |
| `order.picked_up` | Active card updates to "En route to customer" | push, in-app |
| `order.failed_delivery` | Active card → danger pill "Delivery failed"; opens the failure state with reason summary | push, in-app |
| `order.returning` | Card → "Returning to merchant" state (RTO); timeline shows `returning` | push, in-app |
| `order.rescheduled` | Card → "Rescheduled — {local time}" or removed if rider released; order detail shows `rescheduled` | push, in-app |
| `order.delivered` | Delivery summary + earnings card refresh | push, in-app |
| `order.completed` | Order list refresh | in-app |
| `order.transfer_requested` | Not shown to riders (dispatch/ops only); transfer outcome arrives via the transfer endpoint state or re-assign event | in-app |
| `pod.submitted` | Merchant-facing; rider sees `ProofOfDelivery.verified` read-only on refetch | in-app |
| `rider.mission_completed` | Mission card → `completed`, reward banner, earnings/statement refresh | push, in-app |
| `sos.created` | Staff-facing; rider SOS screen stays in "Alert sent — open" state | push, in-app (critical) |
| `sos.acknowledged` | SOS screen banner → "Acknowledged by safety ops"; follow-up guidance shown | in-app |
| `order.cancelled` | Remove active card, toast explains (all parties) | push, in-app |
| `payout.paid` | Payout list refresh, success banner | in-app |
| `payout.failed` | Danger banner + CTA to support (cannot be disabled) | push, in-app, SMS |
| `payout.exception` | Danger banner + CTA to support | in-app, push |
| `review.received` | Rating refresh (`riders/me`) | in-app |
| `ticket.reply` | Ticket detail badge | push, in-app |
| `lead.reviewed` | Verification state refresh (approval changes) | SMS, in-app |
| `booking.*` / `order.*` (customer-only) | never shown to riders | — |

`order.created`, `payment.*`, `order.accepted`, `order.preparing` are customer/merchant events — the rider app ignores them (no route, no badge).

## Planned events (contract additions)

Consistent with the backend `domain.action` naming in `backend/NOTIFICATIONS.md`, these events are planned additions to the event catalog; the rider app maps them when they ship:

| Event | Roles notified | Channels | Rider UI |
| --- | --- | --- | --- |
| `penalty.issued` | rider | in-app, push | Danger banner + deep link to penalty detail / prefilled appeal ticket |
| `appeal.resolved` | rider | in-app, push | Decision banner (upheld/overruled) + reliability score refresh |
| `course.certified` | rider | in-app | Certificate card + Academy badge refresh |

## Preferences

- `GET/PUT /notifications/me/preferences` — per-channel per-event toggles (`push`, `sms`, `email`, `inApp` maps; example key `order.status:push`).
- Defaults: dispatch offers (`order.rider_assigned`) push ON; payout failures ON.
- High-priority system events (OTP, security, payout failures) cannot be disabled — the app renders those toggles as locked/disabled with explanation.
- Preference changes apply immediately; PUT returns the updated `NotificationPreferences`.

## Client rules

- Deep links (`Notification.deepLink`) navigate: order detail (`hudumika-rider://order/{orderId}`), ticket, payout statement.
- Render times in local time; payload timestamps are UTC.
- Never allow push to spoof order state: taps always re-fetch `GET /orders/{orderId}` — push bodies are presentation only.
- Permission revoked mid-session: banner with re-enable instructions in Settings.

## State checklist (notification center)

| State | Behavior |
| --- | --- |
| Loading | list skeletons |
| Empty | "No notifications yet" |
| Error | `ErrorResponse.message` + retry |
| Retry | refetch list |
| Success | rows with unread styling; mark-read on tap |
