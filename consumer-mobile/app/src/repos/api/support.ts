/* Live API support repository — POST /support/tickets, /support/tickets/me,
 * /support/tickets/{id}, reply, GET /help/articles. */
import { api } from '@/api/client';
import type { Ticket, TicketCreate, TicketDetail, TicketDetailMessagesItem } from '@hudumika/contract';
import type { HelpArticle, SupportRepository } from '../index';

export class ApiSupportRepository implements SupportRepository {
  async createTicket(input: TicketCreate, idempotencyKey: string): Promise<Ticket> {
    return api.post<Ticket>('/support/tickets', input, { idempotencyKey });
  }

  async listTickets(): Promise<Ticket[]> {
    return api.get<Ticket[]>('/support/tickets/me');
  }

  async getTicket(ticketId: string): Promise<TicketDetail> {
    return api.get<TicketDetail>(`/support/tickets/${ticketId}`);
  }

  async reply(ticketId: string, body: string, idempotencyKey: string): Promise<TicketDetailMessagesItem> {
    return api.post<TicketDetailMessagesItem>(`/support/tickets/${ticketId}/messages`, { body }, { idempotencyKey });
  }

  /** GET /help/articles — optional q filters the knowledge base server-side. */
  async listArticles(query?: string): Promise<HelpArticle[]> {
    const q = query?.trim();
    return api.get<HelpArticle[]>(`/help/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }
}
