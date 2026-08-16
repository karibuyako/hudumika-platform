/* Live API support repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /support/tickets                      → Ticket
 *   GET  /support/tickets/me                   → Ticket[]
 *   GET  /support/tickets/{ticketId}           → TicketDetail
 *   POST /support/tickets/{ticketId}/messages  → TicketDetail
 */
import { api } from '@/api/client';
import type { SupportRepository } from '../index';
import type { ReplyTicketBody, Ticket, TicketCreate, TicketDetail } from '@hudumika/contract';

export class ApiSupportRepository implements SupportRepository {
  async create(input: TicketCreate): Promise<Ticket> {
    return api.post<Ticket>('/support/tickets', input);
  }

  async list(): Promise<Ticket[]> {
    return api.get<Ticket[]>('/support/tickets/me');
  }

  async get(ticketId: string): Promise<TicketDetail> {
    return api.get<TicketDetail>(`/support/tickets/${ticketId}`);
  }

  async reply(ticketId: string, body: string): Promise<TicketDetail> {
    const payload: ReplyTicketBody = { body };
    return api.post<TicketDetail>(`/support/tickets/${ticketId}/messages`, payload);
  }
}
