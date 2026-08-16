/* Live API support repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /support/tickets       {TicketCreate} → Ticket
 *   GET  /support/tickets/me    → Ticket[]
 */
import { api } from '@/api/client';
import type { SupportRepository } from '../index';
import type { Ticket, TicketCreate, TicketCreateCategory } from '@hudumika/contract';

export class ApiSupportRepository implements SupportRepository {
  async createTicket(subject: string, body: string, category: TicketCreateCategory = 'other', orderId?: string): Promise<Ticket> {
    const payload: TicketCreate = {
      subject,
      body,
      category,
      urgency: 'normal',
      orderId: orderId ?? null,
    };
    return api.post<Ticket>('/support/tickets', payload);
  }

  async listTickets(): Promise<Ticket[]> {
    return api.get<Ticket[]>('/support/tickets/me');
  }
}
