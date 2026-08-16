
import type { ChatThreadDto, NotificationDto } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, permissionsOf, requireSession } from '@/mock/security';
import { ApiHttpError, h, INTERNAL_KEY, readJson } from '@/mock/handlers/common';

/* Max message body length — contract ChatMessageCreate.body maxLength 2000
 * (API-CONTRACT.yaml); attachments capped at 4 (MESSAGES.md §Send). */
const MESSAGE_MAX = 2000;
const MAX_ATTACHMENTS = 4;
const ATTACHMENT_TYPES = new Set(['image', 'document', 'voice', 'location']);

/* Send-side rate limit: MESSAGE_RATE_LIMITED (429) with retryAfterSeconds
 * (MESSAGES.md §Send — the client honors the Retry-After header). */
const sendBuckets = new Map<string, { windowStart: number; count: number }>();
const SEND_WINDOW_MS = 10_000;
const SEND_MAX = 20;

function rateLimitSend(key: string) {
  const now = Date.now();
  const b = sendBuckets.get(key);
  if (!b || b.windowStart + SEND_WINDOW_MS < now) {
    sendBuckets.set(key, { windowStart: now, count: 1 });
    return;
  }
  b.count += 1;
  if (b.count > SEND_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((b.windowStart + SEND_WINDOW_MS - now) / 1000));
    throw new ApiHttpError(429, 'MESSAGE_RATE_LIMITED', `Too many messages — try again in ${retryAfterSeconds}s`, true, { retryAfterSeconds });
  }
}

/** Parse the send body (body text + attachments) with contract validation. */
function parseSendBody(body: Record<string, unknown>): { text: string; attachments: { mediaType: string; url: string }[] } {
  const text = String(body.body ?? body.text ?? '').trim();
  if (!text) throw new ApiHttpError(400, 'MESSAGE_EMPTY', 'Message cannot be empty');
  if (text.length > MESSAGE_MAX) throw new ApiHttpError(400, 'MESSAGE_TOO_LONG', `Message must be at most ${MESSAGE_MAX} characters`);
  const raw = body.attachments;
  const attachments: { mediaType: string; url: string }[] = [];
  if (raw !== undefined) {
    if (!Array.isArray(raw)) throw new ApiHttpError(400, 'MESSAGE_ATTACHMENT_INVALID', 'attachments must be an array');
    if (raw.length > MAX_ATTACHMENTS) throw new ApiHttpError(400, 'MESSAGE_ATTACHMENT_INVALID', `At most ${MAX_ATTACHMENTS} attachments are allowed`);
    for (const a of raw) {
      const mediaType = String((a as Record<string, unknown> | null)?.mediaType ?? '');
      const url = String((a as Record<string, unknown> | null)?.url ?? '').trim();
      if (!ATTACHMENT_TYPES.has(mediaType) || !url) {
        throw new ApiHttpError(400, 'MESSAGE_ATTACHMENT_INVALID', 'Each attachment needs a mediaType (image|document|voice|location) and a URI');
      }
      attachments.push({ mediaType, url });
    }
  }
  return { text, attachments };
}

export const messagingHandlers = [
  /* ---- Notifications ---- */
  h.get('/api/notifications', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const category = url.searchParams.get('category');
    let list = db.table<NotificationDto>('notifications').where((n) => n.merchantId === session.merchantId);
    if (type) list = list.filter((n) => n.type === type);
    if (category) list = list.filter((n) => n.category === category);
    return ok({
      notifications: [...list].sort((a, b) => b.ts - a.ts).slice(0, 200),
      unread: list.filter((n) => !n.read).length,
    });
  }),

  h.post('/api/notifications/read', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const id = body.id;
    if (id) {
      db.table<NotificationDto>('notifications').update(String(id), { read: true });
    } else {
      db.table<NotificationDto>('notifications').where((n) => n.merchantId === session.merchantId).forEach((n) => db.table<NotificationDto>('notifications').update(n.id, { read: true }));
    }
    return ok({ ok: true });
  }),

  /* ---- Chat threads (merchant session OR internal customer-platform) ---- */
  h.get('/api/chat/threads', ({ request }) => {
    const internal = request.headers.get('x-internal-key');
    const session = internal === INTERNAL_KEY ? undefined : requireSession(request);
    const merchantId = session ? session.merchantId : 'm_demo';
    const list = db.table<ChatThreadDto>('chatThreads')
      .where((t) => t.merchantId === merchantId)
      .sort((a, b) => b.lastTs - a.lastTs);
    const unread = list.reduce((s, t) => s + t.unread, 0);
    return ok({ threads: list, unreadTotal: unread });
  }),

  h.post('/api/chat/threads/:id/read', async ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Thread not found');
    db.table<ChatThreadDto>('chatThreads').update(t.id, { unread: 0 });
    return ok({ ok: true });
  }),

  /* ---- Merchant sends message ---- */
  h.post('/api/chat/threads/:id/messages', async ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const body = await readJson(request);
    const { text } = parseSendBody(body);
    const msg = { id: uid('im'), from: 'merchant' as const, text, ts: Date.now() };
    const updated = db.table<ChatThreadDto>('chatThreads').update(t.id, {
      lastMessage: text,
      lastTs: msg.ts,
      unread: 0,
      messages: [...t.messages, msg],
    })!;
    emit({ type: 'chat.message', thread: updated, at: Date.now() });
    return ok({ message: msg, thread: updated });
  }),

  /* ---- Customer platform sends message (internal) ---- */
  h.post('/api/chat/threads/:id/customer-messages', async ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const body = await readJson(request);
    const { text } = parseSendBody(body);
    const msg = { id: uid('im'), from: 'customer' as const, text, ts: Date.now() };
    const updated = db.table<ChatThreadDto>('chatThreads').update(t.id, {
      lastMessage: text,
      lastTs: msg.ts,
      unread: t.unread + 1,
      messages: [...t.messages, msg],
    })!;
    emit({ type: 'chat.message', thread: updated, at: Date.now() });
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'im',
      title: `New message from ${t.customerName}`,
      body: text,
      ts: Date.now(),
      read: false,
      deepLink: `/dashboard/im/${t.id}`,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    return ok({ message: msg, thread: updated });
  }),

  /* ---- P6: conversations (contract /conversations — API-CONTRACT.yaml).
   * Rows live in the chatThreads store; the thread row's extra conversation
   * fields (subject/status/blockReason) are optional, so the legacy
   * /api/chat/threads endpoints keep working untouched. ---- */

  h.get('/api/conversations/unread-count', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<ChatThreadDto>('chatThreads').where((t) => t.merchantId === session.merchantId && (t.status ?? 'open') !== 'blocked');
    const count = rows.reduce((s, t) => s + t.unread, 0);
    return ok({ count });
  }),

  h.get('/api/conversations/:conversationId', ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.conversationId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    return ok(toConversationDetail(t));
  }),

  h.get('/api/conversations/:conversationId/messages', ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.conversationId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const url = new URL(request.url);
    const hasLimit = url.searchParams.has('limit');
    const limit = hasLimit ? Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 30))) : undefined;
    const cursor = url.searchParams.get('cursor');
    const messages = t.messages.map((m) => ({
      id: m.id,
      conversationId: t.id,
      authorRole: m.from === 'merchant' ? 'merchant_staff' : 'customer',
      authorUserId: m.from === 'merchant' ? session.staffId : null,
      body: m.text,
      attachments: (m as { attachments?: { mediaType: string; url: string }[] }).attachments ?? [],
      readAt: m.from === 'merchant' ? null : Date.now(),
      createdAt: m.ts,
    }));
    /* Cursor pagination, newest last: no cursor → the newest `limit` rows;
     * with cursor → the `limit` rows older than the cursor row. */
    let rows = messages;
    if (cursor) {
      const idx = rows.findIndex((m) => m.id === cursor);
      if (idx >= 0) rows = rows.slice(0, idx);
    }
    if (limit !== undefined) {
      rows = rows.slice(Math.max(0, rows.length - limit));
    }
    return Response.json(rows);
  }),

  h.post('/api/conversations', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const subject = String(body.subject ?? '').trim();
    const initial = String(body.initialMessage ?? '').trim();
    if (!subject || !initial) throw new ApiHttpError(422, 'VALIDATION_ERROR', 'subject and initialMessage are required');
    const merchantId = String(body.merchantId ?? session.merchantId);
    const now = Date.now();
    const thread: ChatThreadDto = {
      id: uid('cv'),
      merchantId,
      subject: subject.slice(0, 160),
      status: 'open',
      customerName: 'Demo customer',
      customerInitial: 'D',
      lastMessage: initial.slice(0, 2000),
      lastTs: now,
      unread: 1,
      context: 'New conversation',
      messages: [{ id: uid('im'), from: 'customer', text: initial.slice(0, 2000), ts: now }],
    };
    db.table<ChatThreadDto>('chatThreads').insert(thread);
    return json(201, toConversationDetail(thread));
  }),

  h.post('/api/conversations/:conversationId/archive', ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.conversationId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    if ((t.status ?? 'open') === 'blocked') throw new ApiHttpError(409, 'CONVERSATION_BLOCKED', 'Blocked conversations cannot be archived');
    db.table<ChatThreadDto>('chatThreads').update(t.id, { status: 'archived', unread: 0 });
    return new Response(null, { status: 204 });
  }),

  /* Block is staff-only moderation: 403 CONVERSATION_FORBIDDEN without the
   * `support` scope (MESSAGES.md §Mark read, archive, block). Emits the
   * `conversation.blocked` in-app notification to the merchant side (the
   * customer side is the platform's surface; the event carries both). */
  h.post('/api/conversations/:conversationId/block', async ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.conversationId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const perms = permissionsOf(session);
    if (!perms.includes('*') && !perms.includes('support')) {
      throw new ApiHttpError(403, 'CONVERSATION_FORBIDDEN', 'Blocking a conversation is a staff-only moderation action');
    }
    const body = await readJson(request);
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(400, 'BLOCK_REASON_REQUIRED', 'A block reason is required');
    const updated = db.table<ChatThreadDto>('chatThreads').update(t.id, { status: 'blocked', blockReason: reason.slice(0, 500), blockedAt: Date.now() })!;
    const detail = toConversationDetail(updated);
    emit({ type: 'conversation.blocked', conversation: detail, at: Date.now() });
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'im',
      title: `Conversation with ${t.customerName} blocked`,
      body: `Blocked: ${reason.slice(0, 300)}`,
      ts: Date.now(),
      read: false,
      deepLink: `/dashboard/im/${t.id}`,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'conversation:block', 'conversation', t.id, `blocked a conversation (${reason.slice(0, 200)})`);
    return ok(detail);
  }),

  /* ---- Drift-D aliases: contract paths (API-CONTRACT.yaml) serve the SAME
   * behavior as their legacy siblings (docs/CONTRACT-ADDITIONS.md
   * "Resolution status"). ---- */

  /* GET /conversations ≡ GET /chat/threads — with optional ?status=&limit=
   * &cursor= (contract list params; the default no-params response stays
   * byte-identical to the legacy list for drift parity). */
  h.get('/api/conversations', ({ request }) => {
    const internal = request.headers.get('x-internal-key');
    const session = internal === INTERNAL_KEY ? undefined : requireSession(request);
    const merchantId = session ? session.merchantId : 'm_demo';
    const url = new URL(request.url);
    let list = db.table<ChatThreadDto>('chatThreads')
      .where((t) => t.merchantId === merchantId)
      .sort((a, b) => b.lastTs - a.lastTs);
    const status = url.searchParams.get('status');
    if (status === 'open' || status === 'archived' || status === 'blocked') {
      list = list.filter((t) => (t.status ?? 'open') === status);
    }
    const hasLimit = url.searchParams.has('limit');
    const limit = hasLimit ? Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20))) : undefined;
    const cursor = url.searchParams.get('cursor');
    let rows = [...list];
    if (cursor) {
      const idx = rows.findIndex((r) => r.id === cursor);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    if (limit !== undefined) rows = rows.slice(0, limit);
    const unread = rows.reduce((s, t) => s + t.unread, 0);
    return ok({ threads: rows, unreadTotal: unread });
  }),

  /* POST /conversations/{conversationId}/messages ≡ POST /chat/threads/:id/messages
   * (merchant session) and ≡ POST /chat/threads/:id/customer-messages (customer
   * platform via x-internal-key). Contract validation: MESSAGE_EMPTY,
   * MESSAGE_TOO_LONG (>2000), MESSAGE_ATTACHMENT_INVALID (max 4, typed URIs),
   * MESSAGE_RATE_LIMITED (429 + retryAfterSeconds), and writes are refused on
   * blocked (CONVERSATION_BLOCKED) / archived (CONVERSATION_ARCHIVED) threads. */
  h.post('/api/conversations/:conversationId/messages', async ({ request, params }) => {
    const session = requireSession(request);
    const internal = request.headers.get('x-internal-key') === INTERNAL_KEY;
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.conversationId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const status = t.status ?? 'open';
    if (status === 'blocked') throw new ApiHttpError(409, 'CONVERSATION_BLOCKED', 'This conversation is blocked — sending is disabled');
    if (status === 'archived') throw new ApiHttpError(409, 'CONVERSATION_ARCHIVED', 'This conversation is archived — sending is disabled');
    const body = await readJson(request);
    const { text, attachments } = parseSendBody(body);
    rateLimitSend(internal ? `in:${t.id}` : `${session.merchantId}:${session.staffId}`);
    const msg = { id: uid('im'), from: (internal ? 'customer' : 'merchant') as 'customer' | 'merchant', text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) };
    const updated = db.table<ChatThreadDto>('chatThreads').update(t.id, {
      lastMessage: text,
      lastTs: msg.ts,
      unread: internal ? t.unread + 1 : 0,
      messages: [...t.messages, msg],
    })!;
    emit({ type: 'chat.message', thread: updated, at: Date.now() });
    if (internal) {
      const note: NotificationDto = {
        id: uid('n'),
        merchantId: session.merchantId,
        type: 'system',
        category: 'im',
        title: `New message from ${t.customerName}`,
        body: text,
        ts: Date.now(),
        read: false,
        deepLink: `/dashboard/im/${t.id}`,
      };
      db.table<NotificationDto>('notifications').insert(note);
      emit({ type: 'notification.created', notification: note, at: Date.now() });
    }
    return ok({ message: msg, thread: updated });
  }),

  /* POST /conversations/{conversationId}/read ≡ POST /chat/threads/:id/read */
  h.post('/api/conversations/:conversationId/read', ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<ChatThreadDto>('chatThreads').find(String(params.conversationId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Thread not found');
    db.table<ChatThreadDto>('chatThreads').update(t.id, { unread: 0 });
    return ok({ ok: true });
  }),

  /* GET /notifications/me ≡ GET /notifications — plus the contract cursor
   * params (?unreadOnly=&limit=&cursor=); the default no-params response
   * stays identical to the legacy list for drift parity. */
  h.get('/api/notifications/me', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const category = url.searchParams.get('category');
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true' || url.searchParams.get('unreadOnly') === '1';
    let list = db.table<NotificationDto>('notifications').where((n) => n.merchantId === session.merchantId);
    if (type) list = list.filter((n) => n.type === type);
    if (category) list = list.filter((n) => n.category === category);
    if (unreadOnly) list = list.filter((n) => !n.read);
    const hasLimit = url.searchParams.has('limit');
    const limit = hasLimit ? Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20))) : undefined;
    const cursor = url.searchParams.get('cursor');
    let rows = [...list].sort((a, b) => b.ts - a.ts);
    if (cursor) {
      const idx = rows.findIndex((n) => n.id === cursor);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    let nextCursor: string | null = null;
    if (hasLimit) {
      if (rows.length > limit!) nextCursor = rows[limit! - 1].id;
      rows = rows.slice(0, limit);
    }
    return ok({
      notifications: rows,
      unread: list.filter((n) => !n.read).length,
      ...(hasLimit ? { nextCursor } : {}),
    });
  }),

  /* POST /notifications/read-all ≡ POST /notifications/read */
  h.post('/api/notifications/read-all', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const id = body.id;
    if (id) {
      db.table<NotificationDto>('notifications').update(String(id), { read: true });
    } else {
      db.table<NotificationDto>('notifications').where((n) => n.merchantId === session.merchantId).forEach((n) => db.table<NotificationDto>('notifications').update(n.id, { read: true }));
    }
    return ok({ ok: true });
  }),

  /* POST /notifications/{notificationId}/read (204) — per-item mark. */
  h.post('/api/notifications/:notificationId/read', ({ request, params }) => {
    const session = requireSession(request);
    const n = db.table<NotificationDto>('notifications').find(String(params.notificationId));
    if (!n || n.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Notification not found');
    db.table<NotificationDto>('notifications').update(n.id, { read: true });
    return new Response(null, { status: 204 });
  }),

  /* ---- Mock-only: Expo push-token registration (NOTIFICATIONS.md §Push
   * setup — "tokens are stored server-side per user"). The contract has no
   * push-token endpoint yet (no match in API-CONTRACT.yaml), so this stays
   * mock-only; a contract-additions proposal is tracked in the app README. ---- */
  h.post('/api/devices/push-token', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const token = String(body.token ?? '').trim();
    const platform = String(body.platform ?? 'native');
    if (!token || token.length > 512) {
      throw new ApiHttpError(400, 'PUSH_TOKEN_INVALID', 'A valid Expo push token is required');
    }
    db.table<{ id: string; merchantId: string; staffId: string; token: string; platform: string; ts: number }>('pushTokens').insert({
      id: uid('pt'),
      merchantId: session.merchantId,
      staffId: session.staffId,
      token,
      platform,
      ts: Date.now(),
    });
    return ok({ registered: true });
  }),
];

function toConversationDetail(t: ChatThreadDto): {
  id: string;
  merchantId: string;
  customerUserId?: string;
  orderId: string | null;
  subject: string;
  status: 'open' | 'archived' | 'blocked';
  lastMessagePreview: string;
  unreadCount: number;
  createdAt: number;
  updatedAt: number;
  blockReason: string | null;
  blockedAt: number | null;
  participants: { role: 'customer' | 'merchant_staff' | 'system'; displayName: string; maskedPhone: string | null }[];
} {
  return {
    id: t.id,
    merchantId: t.merchantId,
    customerUserId: undefined,
    orderId: null,
    subject: t.subject ?? t.customerName,
    status: t.status ?? 'open',
    lastMessagePreview: t.lastMessage,
    unreadCount: t.unread,
    createdAt: t.lastTs,
    updatedAt: t.lastTs,
    blockReason: t.blockReason ?? null,
    blockedAt: t.blockedAt ?? null,
    participants: [
      { role: 'customer', displayName: t.customerName, maskedPhone: '+2557****' },
      { role: 'merchant_staff', displayName: 'Merchant', maskedPhone: null },
    ],
  };
}
