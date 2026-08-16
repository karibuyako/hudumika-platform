/* In-memory conversations repository — customer ↔ merchant chat.
 * POST /conversations, list, detail, messages, send, read, archive, unread-count.
 *
 * Mock-only extensions kept module-local (mockState.ts is shared and may be
 * edited by other agents): the MESSAGE_RATE_LIMITED send window and the
 * deterministic attachment fixtures the composer picker sources from.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import type {
  ChatMessage,
  ChatMessageCreateAttachmentsItem,
  Conversation,
  ConversationCreate,
  ConversationDetail,
} from '@hudumika/contract';
import { ChatMessageAttachmentsItemMediaType, ConversationStatus } from '@hudumika/contract';
import type { ConversationsRepository } from '../index';

const MESSAGE_MAX = 2000;
const ATTACHMENT_MAX = 4;
/** Mock-only send window between consecutive sends in the same conversation
 * (module-local so it never leaks into shared mockState). */
const RATE_LIMIT_MS = 1000;

/* Chat pagination (CHAT.md): GET .../messages?limit=30&cursor= returns the
 * NEWEST page first and an opaque cursor for the previous (older) page. The
 * interface (listMessages) is array-shaped for wire parity, so the cursor is
 * derived client-side from the page size: the mock encodes "how many newest
 * messages are already loaded" as the cursor, and nextMessagesCursor() returns
 * the next one (null = no older messages). Live responses omit the mock-only
 * helpers; the server cursor would arrive from the API layer instead. */
export const MESSAGES_PAGE_SIZE = 30;

/** Next page cursor for a thread page: null when the page is short (no more
 * older messages), otherwise the offset of the next older page. */
export function nextMessagesCursor(page: ChatMessage[], cursor?: string): string | null {
  const loaded = cursor ? Number(cursor) : 0;
  return page.length === MESSAGES_PAGE_SIZE ? String(loaded + MESSAGES_PAGE_SIZE) : null;
}

/** Merge a fetched older page ABOVE the already-loaded messages, deduping by
 * id (pages from the offset cursor are disjoint, but a concurrent send or
 * refresh can make an id appear twice). */
export function mergeOlderMessages(existing: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const seen = new Set(existing.map((m) => m.id));
  return [...older.filter((m) => !seen.has(m.id)), ...existing];
}

/** Test helper: append `count` deterministic history messages to a seeded
 * conversation so pagination tests have more than one page. Module-local —
 * resetMockState cannot touch this. */
export function seedMessageHistory(conversationId: string, count: number): void {
  const conversation = getState().conversations.find((c) => c.id === conversationId);
  if (!conversation) return;
  const base = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    conversation.messages.push({
      id: `seed_msg_${i}`,
      conversationId,
      authorRole: 'merchant_staff',
      body: `history message ${i}`,
      createdAt: new Date(base + i * 60_000).toISOString(),
      readAt: null,
    });
  }
}

/** Deterministic attachment fixtures for the composer picker. The contract has
 * no image fixture (@hudumika/contract/fixtures menu imageUrl is null), so the
 * mock seeds a small local set; live mode the server owns uploaded URIs. */
export const MOCK_ATTACHMENT_URLS = [
  'https://cdn.hudumika.dev/mock/fixture/receipt_01.jpg',
  'https://cdn.hudumika.dev/mock/fixture/receipt_02.jpg',
  'https://cdn.hudumika.dev/mock/fixture/photo_01.jpg',
  'https://cdn.hudumika.dev/mock/fixture/photo_02.jpg',
  'https://cdn.hudumika.dev/mock/fixture/photo_03.jpg',
] as const;

const lastSendAtByConversation = new Map<string, number>();

/** Test helper: clear the rate-limit window (resetMockState cannot touch this
 * module-local state). */
export function resetMessageRateLimit(): void {
  lastSendAtByConversation.clear();
}

export class MockConversationsRepository implements ConversationsRepository {
  async list(status?: 'open' | 'archived' | 'blocked', cursor?: string): Promise<Conversation[]> {
    const state = getState();
    let list = state.conversations;
    if (status) list = list.filter((c) => c.status === status);
    const offset = cursor ? Number(cursor) : 0;
    return clone(list.slice(offset, offset + 20).map(({ messages: _m, ...c }) => c));
  }

  async create(input: ConversationCreate, _idempotencyKey: string): Promise<Conversation> {
    const state = getState();
    const existing = state.conversations.find((c) => c.merchantId === input.merchantId && c.status === ConversationStatus.open);
    if (existing) return clone(existing);
    const conversation = {
      id: uid('conv'),
      merchantId: input.merchantId,
      orderId: input.orderId ?? null,
      subject: input.subject,
      status: ConversationStatus.open,
      unreadCount: 0,
      lastMessagePreview: input.initialMessage,
      participants: [
        { role: 'customer' as const, displayName: 'You', maskedPhone: state.user.phone },
        { role: 'merchant_staff' as const, displayName: 'Merchant', maskedPhone: '+2557******00' },
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [
        { id: uid('msg'), conversationId: '', authorRole: 'customer' as const, body: input.initialMessage, createdAt: nowIso(), readAt: nowIso() },
      ],
    };
    conversation.messages[0].conversationId = conversation.id;
    state.conversations.unshift(conversation);
    return clone({ ...conversation, messages: undefined });
  }

  async get(conversationId: string): Promise<ConversationDetail> {
    const conversation = getState().conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    return clone({ ...conversation, messages: undefined });
  }

  async listMessages(conversationId: string, cursor?: string): Promise<ChatMessage[]> {
    const conversation = getState().conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    // Tail-first: no cursor → the NEWEST page (messages are stored oldest →
    // newest); cursor = how many newest messages are already loaded, so the
    // next call returns the previous (older) page above them.
    const loaded = cursor ? Number(cursor) : 0;
    const from = Math.max(0, conversation.messages.length - MESSAGES_PAGE_SIZE - loaded);
    return clone(conversation.messages.slice(from, conversation.messages.length - loaded));
  }

  async send(conversationId: string, body: string, _idempotencyKey: string, attachments?: ChatMessageCreateAttachmentsItem[]): Promise<ChatMessage> {
    const state = getState();
    const conversation = state.conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    if (conversation.status === ConversationStatus.blocked) {
      throw new ApiError(409, 'CONVERSATION_BLOCKED', 'This conversation was closed by support');
    }
    if (conversation.status === ConversationStatus.archived) {
      throw new ApiError(409, 'CONVERSATION_ARCHIVED', 'This conversation is archived');
    }
    if (!body.trim()) throw new ApiError(422, 'MESSAGE_EMPTY', 'Message cannot be empty');
    if (body.length > MESSAGE_MAX) throw new ApiError(422, 'MESSAGE_TOO_LONG', 'Message is too long');
    if (attachments) {
      if (attachments.length > ATTACHMENT_MAX) {
        throw new ApiError(422, 'MESSAGE_ATTACHMENT_INVALID', 'At most 4 attachments per message');
      }
      for (const a of attachments) {
        if (!Object.values(ChatMessageAttachmentsItemMediaType).includes(a.mediaType) || !a.url.trim()) {
          throw new ApiError(422, 'MESSAGE_ATTACHMENT_INVALID', 'Attachment must have a valid media type and url');
        }
      }
    }
    const now = Date.now();
    const elapsed = now - (lastSendAtByConversation.get(conversationId) ?? 0);
    if (elapsed < RATE_LIMIT_MS) {
      throw new ApiError(429, 'MESSAGE_RATE_LIMITED', 'Too many messages — try again shortly', true, {
        retryAfterSeconds: Math.max(1, Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)),
      });
    }
    lastSendAtByConversation.set(conversationId, now);
    const message: ChatMessage = {
      id: uid('msg'),
      conversationId,
      authorRole: 'customer',
      body,
      ...(attachments && attachments.length ? { attachments: clone(attachments) } : {}),
      createdAt: nowIso(),
      readAt: nowIso(),
    };
    conversation.messages.push(message);
    conversation.updatedAt = nowIso();
    conversation.lastMessagePreview = body;
    return clone(message);
  }

  async markRead(conversationId: string): Promise<void> {
    const conversation = getState().conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    conversation.unreadCount = 0;
    for (const m of conversation.messages) {
      if (m.authorRole !== 'customer' && !m.readAt) m.readAt = nowIso();
    }
  }

  async archive(conversationId: string): Promise<void> {
    const conversation = getState().conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    conversation.status = ConversationStatus.archived;
  }

  async unreadCount(): Promise<number> {
    const state = getState();
    return state.conversations.reduce((acc, c) => acc + c.unreadCount, 0);
  }
}
