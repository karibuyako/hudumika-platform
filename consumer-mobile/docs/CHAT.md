# Customer App — Chat with Merchants

Glossary terms: conversation, message, merchant staff, deep link. The customer app has one
1:1 conversation channel per customer + merchant (support tickets are separate — they go to
platform staff, not the merchant). Chat is realtime-lite: fetch + poll/WebSocket refresh, no
custom transport.

## Conversation model

`ConversationStatus`: `open` → `archived` (either party) or `blocked` (moderation only, staff).

- One **general** conversation per customer + merchant, opened from the merchant page.
- An **order-linked** conversation can be opened from an order detail (`orderId` set) with the
  subject auto-prefilled (e.g. "Order #... help"); it still belongs to the same customer +
  merchant pair.
- Messages: `ChatMessage` with `authorRole` `customer` / `merchant_staff` / `system`, `body`,
  `attachments[]` (URIs), `readAt`, `createdAt`. `system` messages render as centered notices
  (e.g. conversation blocked).

## Opening a conversation

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Merchant page | — | "Chat with merchant" opens general conversation; if one exists it is reopened, never duplicated |
| 2 | Order detail | — | "Chat about this order" opens/prefills subject; `orderId` sent so merchant sees the linked order |
| 3 | Create | `POST /conversations` | Body `ConversationCreate` (`merchantId`, optional `orderId`, `subject` ≤160, `initialMessage` ≤2000). 201 → `Conversation` (`open`). 422 → validation card |
| 4 | Thread | `GET /conversations/{conversationId}` | `ConversationDetail` (`participants[]`, `orderId`, `status`) |

- Composer requires a non-empty `initialMessage` (server `MESSAGE_EMPTY` guard).
- 403 / 404 (`CONVERSATION_NOT_FOUND`) → "conversation not available" error card + retry.

## Thread and messages

| Step | Detail |
| --- | --- |
| History | `GET /conversations/{conversationId}/messages?limit=30&cursor=` — cursor pagination, newest at the bottom; "load older" fetches the previous page via the returned cursor |
| Send | `POST /conversations/{conversationId}/messages` body `ChatMessageCreate` (`body` 1–2000, `attachments` ≤4 URIs). 201 → `ChatMessage` appended optimistically |
| Delivery | Optimistic append with pending state; rollback on failure + toast |
| Read receipts | `readAt` per message; the app shows "Read" on own messages once set (poll on thread focus) |
| Rate limit | `MESSAGE_RATE_LIMITED` → toast "Try again shortly", composer keeps the draft, countdown shown from `retryAfterSeconds` |
| Attachments | Pick up to 4 images; `MESSAGE_ATTACHMENT_INVALID` → inline field error (type/size); the contract allows 4 max — the picker enforces the same bound |

- Empty history state: "No messages yet — say hello".
- Mark read: `POST /conversations/{conversationId}/read` (204) on thread open and on new
  incoming `message.received` while the thread is focused.

## Conversation list and unread badge

- List: `GET /conversations` (`?status` filter `open` / `archived` / `blocked`, cursor pagination).
  Row: merchant, `subject`/`lastMessagePreview`, `updatedAt` local time, unread dot + count.
- Badge: `GET /conversations/unread-count` → `{count}`; refreshed on app open, on resume, and
  on `message.received` push. Opening a thread clears the badge via `/read`.
- Archive: `POST /conversations/{conversationId}/archive` (204) from thread header menu;
  archived threads move to the `archived` filter and stay readable.
- Deleted/blocked rows still list under their filter (never silently dropped).

## Blocked conversations

- `conversation.blocked` (in-app notification, both parties) + thread reads back as
  `CONVERSATION_BLOCKED` (send → 409 conflict) / status `blocked`.
- UI: read-only thread — banner "This conversation was closed by HUDumika support", composer
  removed, `system` notice message shown, history remains viewable.
- Blocking is staff-only (`POST /conversations/{conversationId}/block`) — never called by the
  app; the app only renders the outcome.

## Privacy

- Participants render `displayName` and `maskedPhone` only — the full phone never reaches the
  app; customer identity stays masked for merchant staff (contract rule).
- No contact details in message bodies beyond what the user types; `SECURITY.md` deep-link
  rules apply to any `deepLink` navigation (chat opens only via `conversation/{conversationId}`).

## Per-screen states

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Conversation list | Skeleton rows | "No conversations yet" + CTA | Error card + retry | Retry | Rows + unread badge |
| Thread | Skeleton bubbles | "No messages yet" | `CONVERSATION_NOT_FOUND` / `CONVERSATION_FORBIDDEN` card | Retry | Bubbles + composer |
| New conversation | Submitting spinner | — | 422 validation card | Re-submit | Thread opens |

Error codes (from `backend/ERROR-CODES.md`): `CONVERSATION_NOT_FOUND`, `CONVERSATION_FORBIDDEN`,
`CONVERSATION_BLOCKED`, `CONVERSATION_ARCHIVED`, `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`,
`MESSAGE_RATE_LIMITED`, `MESSAGE_ATTACHMENT_INVALID`.
