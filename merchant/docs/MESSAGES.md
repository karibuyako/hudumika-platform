# HUDumika Merchant — Messages Center

Customer conversations, platform messages, and order dynamics. Endpoints and error codes are exact contract values from `backend/API-CONTRACT.yaml`; events follow `backend/NOTIFICATIONS.md`.

## Customer conversations (1:1 chat)

One conversation per customer per merchant; the customer opens it (`ConversationCreate`: `merchantId`, `subject`, `initialMessage`, optional `orderId`), the merchant replies.

### List

| Aspect | Spec |
| --- | --- |
| Endpoint | `GET /conversations?status=open|archived|blocked&limit=&cursor=` → `Conversation[]` |
| Rows | `subject`, `lastMessagePreview`, `unreadCount`, `updatedAt` (local time) |
| Badge | `GET /conversations/unread-count` → `{count}`; refreshed on list refetch and on `message.received` |
| Filter chips | Open / Archived / Blocked (per `ConversationStatus`) |

### Detail

- `GET /conversations/{conversationId}` → `ConversationDetail`: `participants[]` with `role` (`customer` | `merchant_staff` | `system`), `displayName`, and `maskedPhone` (nullable). Phones always arrive masked; the UI never unmasks.
- Linked order: `orderId` (nullable) — rendered as a deep link to `GET /orders/{orderId}`.
- History: `GET /conversations/{conversationId}/messages?limit=&cursor=` → `ChatMessage[]` (cursor pagination, newest last).

### Send and receive

| Aspect | Spec |
| --- | --- |
| Endpoint | `POST /conversations/{conversationId}/messages` |
| Request | `ChatMessageCreate`: `body` (minLength 1, maxLength 2000), `attachments` (URIs, max 4) |
| Response | `ChatMessage` / 201 / 409 |
| Errors | `MESSAGE_EMPTY` (empty body), `MESSAGE_TOO_LONG` (>2000), `MESSAGE_RATE_LIMITED` (429, honor `Retry-After`), `MESSAGE_ATTACHMENT_INVALID` (bad/missing URI) |

Composer rules: send disabled while empty; 2000-character counter; attachment picker caps at 4; sending shows a pending state, failure keeps the draft and offers retry. Messages authored by merchant staff carry `authorRole: merchant_staff` and the staff user id — responses display the staff member's name, never a shared store identity.

### Mark read, archive, block

| Action | Endpoint | Notes |
| --- | --- | --- |
| Mark read | `POST /conversations/{conversationId}/read` | 204; called on conversation open; optimistic, rollback on error |
| Archive | `POST /conversations/{conversationId}/archive` | 204; either party; moves to `archived`, badge decrements |
| Block | `POST /conversations/{conversationId}/block` | staff-only moderation (403 `CONVERSATION_FORBIDDEN` otherwise); body `reason` ≤500; returns `Conversation` |

### Blocked state

`status: blocked` renders read-only with the block reason; sending is refused with `CONVERSATION_BLOCKED`; both parties receive the `conversation.blocked` in-app notification. Unblock is an operations action via `POST /support/tickets` — there is no merchant self-unblock endpoint.

### Errors

`CONVERSATION_NOT_FOUND` (404), `CONVERSATION_FORBIDDEN` (403 — not a party), `CONVERSATION_BLOCKED`, `CONVERSATION_ARCHIVED` (write refused), plus the `MESSAGE_*` codes above. 409 on send maps to a banner + refetch.

## Platform messages

Announcements, campaigns, and policy come through the notification center, not conversations: `GET /notifications/me` → `Notification[]` with `type` `platform.announcement` (all users, in-app + email for policy) or `platform.campaign` (targeted, in-app + push). Rendered as a read-only list with `title`/`body`/`createdAt` (local time); `deepLink` (nullable) opens the target screen when present. Mark read via `POST /notifications/{notificationId}/read` (204).

## Order dynamics

Order lifecycle alerts arrive as notifications and refetch `GET /orders/me`: `order.created` (new-order banner + queue badge), `order.rush_requested` (rush banner, `rushRequestedAt`), `order.delivered` / `order.completed`, `order.cancelled`, `order.scheduled_reminder` (advance orders, 30 min before), `refund.processed`. The Messages tab shows these as a dynamics feed alongside platform messages; the Orders tab consumes them as actions. Preferences: `GET/PUT /notifications/me/preferences`.

## Real-time

- `message.received` → push (Expo, mobile) + in-app; delivered to the conversation partner (customer or merchant staff). Tap routes via `deepLink` into the conversation detail.
- Active sessions additionally use WebSocket for instant list/thread updates; on reconnect, refetch `GET /conversations` and the unread badge.
- Web has no OS push; polling the conversations list + badge is the equivalent surface (feature parity, same events).

## Screen states (list, detail, thread)

- Loading: skeleton rows; thread loading indicator.
- Empty: "No conversations" (CTA: none — customers initiate) / "No messages yet".
- Error: network/session failure with retry; 429 honors `Retry-After`; 403/404 mapped to a "conversation unavailable" card.
- Success: badge count, read/unread styling, blocked banner, send states as above.

## Reviews

View and reply handling: the merchant views received reviews via counts (`MerchantPublic.rating`, `reviewCount`) and reports abusive reviews with `POST /reviews/{reviewId}/report` (`reason` ≤300, returns `ReviewReport`). `review.received` / `review.moderated` in-app notifications badge the surface.

Reviews live in the contract: `GET /reviews/me` lists received reviews (`ReviewDetail[]`), `POST /reviews/{reviewId}/reply` posts a merchant reply (`ReviewReply`, body 1–1000 chars, one per review — `REVIEW_REPLY_EXISTS` on repeat, `REVIEW_NOT_REPLIABLE` on hidden/deleted reviews), and `PATCH /reviews/{reviewId}/reply` edits the merchant's own reply (same body limits; 409 when no reply exists to edit). Edit history is audited server-side — the UI offers "edit reply" on owned replies, never on others'. See API.md.

## MSW parity

Mocks reproduce conversation statuses, unread counts, participant masking, `MESSAGE_*` codes, block/archive transitions, and notification types (`platform.announcement`, `platform.campaign`, `message.received`).
