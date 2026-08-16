/* Live API conversations repository — customer ↔ merchant chat. */
import { api } from '@/api/client';
import type { ChatMessage, ChatMessageCreateAttachmentsItem, Conversation, ConversationCreate, ConversationDetail } from '@hudumika/contract';
import type { ConversationsRepository } from '../index';

export class ApiConversationsRepository implements ConversationsRepository {
  async list(status?: 'open' | 'archived' | 'blocked', cursor?: string): Promise<Conversation[]> {
    const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }).toString();
    return api.get<Conversation[]>(`/conversations${qs ? `?${qs}` : ''}`);
  }

  async create(input: ConversationCreate, idempotencyKey: string): Promise<Conversation> {
    return api.post<Conversation>('/conversations', input, { idempotencyKey });
  }

  async get(conversationId: string): Promise<ConversationDetail> {
    return api.get<ConversationDetail>(`/conversations/${conversationId}`);
  }

  async listMessages(conversationId: string, cursor?: string): Promise<ChatMessage[]> {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return api.get<ChatMessage[]>(`/conversations/${conversationId}/messages${qs}`);
  }

  async send(conversationId: string, body: string, idempotencyKey: string, attachments?: ChatMessageCreateAttachmentsItem[]): Promise<ChatMessage> {
    return api.post<ChatMessage>(`/conversations/${conversationId}/messages`, { body, ...(attachments && attachments.length ? { attachments } : {}) }, { idempotencyKey });
  }

  async markRead(conversationId: string): Promise<void> {
    await api.post<void>(`/conversations/${conversationId}/read`);
  }

  async archive(conversationId: string): Promise<void> {
    await api.post<void>(`/conversations/${conversationId}/archive`);
  }

  async unreadCount(): Promise<number> {
    return api.get<{ count: number }>('/conversations/unread-count').then((r) => r.count);
  }
}
