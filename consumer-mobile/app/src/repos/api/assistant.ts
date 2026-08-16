/* Live API assistant repository — POST /assistant/chat (Xiaomei-lite,
 * mock-first). Body follows the generated AssistantChatBody: message
 * (required, maxLength 1000) + optional context bag. Reply text is server
 * copy and renders verbatim — never i18n keys. The hardened client handles
 * auth, retries and offline queueing (chat is non-sensitive, so it queues). */
import { api } from '@/api/client';
import type { AssistantChatBody, AssistantReply } from '@hudumika/contract';
import type { AssistantRepository } from '../index';

export class ApiAssistantRepository implements AssistantRepository {
  async chat(message: string, context?: Record<string, unknown>): Promise<AssistantReply> {
    const body: AssistantChatBody = { message, ...(context ? { context } : {}) };
    return api.post<AssistantReply>('/assistant/chat', body);
  }
}
