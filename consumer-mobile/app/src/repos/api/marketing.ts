/* Live API marketing repository — GET /marketing/live-deals (the LIVE DEALS
 * ZONE, 神抢手-lite): scheduled flash-sale sessions with countdowns, plus the
 * live broadcast chat (GET/POST /marketing/live-deals/{id}/chat — mock-only
 * until the contract ships a live-chat surface, docs/CONTRACT-ADDITIONS.md
 * #20, parity harness allow-list). Thin wrapper over the hardened client; the
 * contract DTO allows the collections to be absent, so this repo normalizes
 * to the app shape the screens consume. NOTE: this is the sessions zone
 * (scheduled flash sessions + a mock-first chat) — video livestreaming is a
 * native-phase concern and has no contract surface here. */
import { api } from '@/api/client';
import type { ListLiveDeals200 } from '@hudumika/contract';
import type { LiveChatMessage, LiveDealsResult, MarketingRepository } from '../index';

export class ApiMarketingRepository implements MarketingRepository {
  async listLiveDeals(): Promise<LiveDealsResult> {
    const data = await api.get<ListLiveDeals200>('/marketing/live-deals');
    return { sessions: data.sessions ?? [], nextCursor: data.nextCursor ?? null };
  }

  async fetchLiveChat(sessionId: string): Promise<LiveChatMessage[]> {
    // Mock-only-until-adopted path (docs/CONTRACT-ADDITIONS.md #22, parity
    // harness allow-list): the contract exposes no live-deals chat surface,
    // so a live backend that has not shipped it 404s/405s and the broadcast
    // screen falls back to its error/retry state.
    return api.get<LiveChatMessage[]>(`/marketing/live-deals/${sessionId}/chat`);
  }

  async postLiveChat(sessionId: string, message: string, idempotencyKey: string): Promise<LiveChatMessage> {
    // Mock-only-until-adopted path (docs/CONTRACT-ADDITIONS.md #22, parity
    // harness allow-list); idempotent per key (the server replays the stored
    // message for a repeated key).
    return api.post<LiveChatMessage>(`/marketing/live-deals/${sessionId}/chat`, { message }, { idempotencyKey });
  }
}
