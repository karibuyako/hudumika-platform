/* In-memory support repository. Mirrors POST /support/tickets,
 * GET /support/tickets, GET /support/tickets/{id} and
 * POST /support/tickets/{id}/messages against module state in mockState.ts.
 * New tickets open with priority 'normal'; replying to a closed ticket throws
 * 409 TICKET_CLOSED, bodies over 4000 chars throw 422, and replying moves an
 * open ticket to 'in_progress'.
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso } from './mockState';
import { uid } from '@/lib/format';
import type { SupportRepository } from '../index';
import type { Ticket, TicketCreate, TicketDetail } from '@hudumika/contract';

const MAX_MESSAGE_LENGTH = 4000;

function findTicket(ticketId: string): TicketDetail {
  const ticket = getState().tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new ApiError(404, 'TICKET_NOT_FOUND', `Ticket ${ticketId} not found`);
  return ticket;
}

export class MockSupportRepository implements SupportRepository {
  async create(input: TicketCreate): Promise<Ticket> {
    const ticket: TicketDetail = {
      id: uid('ticket'),
      subject: input.subject,
      status: 'open',
      priority: 'normal',
      assignedAgentId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
    };
    getState().tickets.push(ticket);
    return clone(ticket);
  }

  async list(): Promise<Ticket[]> {
    return clone(getState().tickets);
  }

  async get(ticketId: string): Promise<TicketDetail> {
    return clone(findTicket(ticketId));
  }

  async reply(ticketId: string, body: string): Promise<TicketDetail> {
    const ticket = findTicket(ticketId);
    if (ticket.status === 'closed') {
      throw new ApiError(409, 'TICKET_CLOSED', 'This ticket is closed');
    }
    if (body.length > MAX_MESSAGE_LENGTH) {
      throw new ApiError(422, 'TICKET_REPLY_TOO_LONG', `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
    }
    ticket.messages.push({ id: uid('msg'), authorRole: 'provider', body, createdAt: nowIso() });
    if (ticket.status === 'open') ticket.status = 'in_progress';
    ticket.updatedAt = nowIso();
    return clone(ticket);
  }
}
