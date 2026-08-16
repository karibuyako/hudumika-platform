# HUDumika Merchant — Notifications

Push (mobile), in-app center, preferences. Event names and channels follow `backend/NOTIFICATIONS.md`; payloads follow `Notification`/`NotificationPreferences` from the contract.

## Push setup (Expo, mobile)

1. Request permission only after explaining why (SHARED-FLOWS: explain before asking; OS copy + custom reason).
2. On grant, register the Expo push token per device and refresh it on login; tokens are stored server-side per user.
3. High-priority events (OTP, security, payout failures) bypass preferences — they cannot be disabled (`backend/NOTIFICATIONS.md`).
4. Push taps carry a `deepLink` (order detail, ticket, payout statement). `src/lib/push.ts` exposes `subscribePushTaps`/`currentPushTap` for routing them (cold start included), but deep-link routing is not wired to the navigator yet — tracked with ROADMAP P6.

Web has no OS push; the notification center plus server-event delivery (long-poll + WebSocket, `src/api/events.ts` / `src/api/socket.ts`) is the equivalent surface. Feature parity: web shows the same events, in-app only.

## Notification center

| Aspect | Spec |
| --- | --- |
| List | `GET /notifications/me?unreadOnly=&limit=&cursor=` → `Notification[]` (id, type, title, body, deepLink, read, createdAt) |
| Unread | badge count; `read: false` styling |
| Mark read | `POST /notifications/{notificationId}/read` (204) on open/tap; optimistic with rollback |
| Pagination | cursor-based, infinite scroll |
| Time | `createdAt` is UTC; render local time via i18n formatter |

Screen states: loading skeleton → empty ("No notifications") → error + retry → list; tap actions handle missing deep-link targets gracefully (404 → toast, stay on list).

## Event → UI mapping (merchant-relevant)

| Event | UI surface | Priority |
| --- | --- | --- |
| `order.created` | push + in-app; banner + queue badge "New order" | high (mobile) |
| `order.delivered` | push + in-app; order row updates | high |
| `order.completed` | in-app; earnings refresh signal | normal |
| `order.cancelled` | push + in-app; queue row + reason | high |
| `order.rejected` | push + in-app (customer-facing; merchant sees the queue state change) | normal |
| `order.rush_requested` | push + in-app; rush banner on the order card (`rushRequestedAt` in local time) | high |
| `order.scheduled_reminder` | push + SMS; scheduled-orders tab refetch (30 min before `scheduledAt`) | normal |
| `refund.processed` | in-app; order/statement badge | normal |
| `withdrawal.paid` | in-app; wallet card refresh | normal |
| `withdrawal.failed` | push + in-app (failure high-priority, cannot be disabled); wallet error card with `reason` | high |
| `dine_in.order_opened` | in-app; table chip turns occupied | normal |
| `dine_in.bill_requested` | push + in-app; cashier terminal alert + kitchen sees billing state | high |
| `dine_in.paid` | in-app; table chip turns paid, close CTA appears | normal |
| `reservation.requested` / `reservation.confirmed` | push + in-app; reservation list badge | normal |
| `reservation.reminder` | in-app; pre-arrival heads-up | normal |
| `group_buy.created` | in-app; deal list badge | low |
| `group_buy.moderated` | in-app; deal card shows decision + `rejectReason` | high |
| `group_buy.sold` | in-app; deal `soldCount` refresh (first sale / milestone) | normal |
| `voucher.redeemed` | in-app; voucher list + verification history refresh | normal |
| `promotion.moderated` | in-app; campaign card shows decision + `rejectReason` | high |
| `coupon.claimed` | in-app; coupon campaign `claimedCount` refresh (daily digest) | low |
| `member.top_up` | in-app; member balance refresh | normal |
| `staff.invited` / `staff.suspended` | in-app; staff list refresh (delivered to the staff user) | high |
| `analytics.diagnostic` | in-app; diagnostics card unlock (weekly AI report — M7e, not built yet) | low |
| `payout.paid` | in-app; earnings card refresh | normal |
| `payout.failed` | push + in-app (failure is high-priority, cannot be disabled) | high |
| `payout.exception` | in-app; exception banner in earnings | high |
| `dispute.opened` / `dispute.resolved` | in-app; held-amount card in earnings | normal |
| `review.received` | in-app; reviews surface badge | low |
| `review.moderated` | in-app | low |
| `ticket.reply` | push + in-app; ticket detail badge | normal |
| `lead.reviewed` | SMS + in-app; onboarding status change | high |
| `otp.requested` / `otp.verified` | SMS/in-app; login screen | system |

Order events trigger a refetch of `GET /orders/me` so list and notification never diverge; payout/wallet/review events refetch their surfaces; dine-in/group buy/promotion events refetch their list surfaces. `deepLink` targets for new events: order detail, table/bill detail, deal detail, wallet.

## Preferences

- `GET`/`PUT /notifications/me/preferences` → `NotificationPreferences`: `push`, `sms`, `email`, `inApp` maps of event key → boolean (e.g. `order.status:push`).
- Settings screen: channel columns (push/sms/email/in-app) × event rows; system events render locked-on.
- Mobile additionally shows the OS-level push permission state and a "disable all except system" quick toggle.
- Screen states: loading → toggle grid → saving spinner → success toast → error + retry (preferences PUT is idempotent; safe to retry).

## Rules

- Push permission requested with reason copy; there is always a settings screen (never only the OS dialog).
- Deep links are `deepLink` values from the API — never hardcoded.
- MSW parity: notification payloads (`type`, `deepLink`, `read`) and preferences shape must match the contract.
