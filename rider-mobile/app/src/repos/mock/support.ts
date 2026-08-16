/* In-memory support repository. Mirrors POST /support/tickets,
 * GET /support/tickets/me against module state in mockState.ts.
 */
import { getState, clone, nowIso } from './mockState';
import { uid } from '@/lib/format';
import type { SupportRepository } from '../index';
import type { Ticket, TicketCreateCategory } from '@hudumika/contract';

export class MockSupportRepository implements SupportRepository {
  async createTicket(subject: string, _body: string, _category: TicketCreateCategory = 'other', _orderId?: string): Promise<Ticket> {
    const state = getState();
    const ticket: Ticket = {
      id: uid('ticket'),
      subject,
      status: 'open',
      priority: 'normal',
      createdAt: nowIso(),
    };
    state.tickets.unshift(ticket);
    return clone(ticket);
  }

  async listTickets(): Promise<Ticket[]> {
    return clone(getState().tickets);
  }
}
