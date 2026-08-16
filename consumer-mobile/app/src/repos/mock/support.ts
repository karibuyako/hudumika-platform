/* In-memory support repository — POST /support/tickets, /support/tickets/me,
 * /support/tickets/{id}, reply, GET /help/articles.
 *
 * Ticket categories and the knowledge base are module-local: the contract
 * Ticket DTO does not carry category, so the mock keeps a category map here
 * (the live API persists it server-side), and the help articles are seeded
 * client content for the demo (the live server is the source of truth). */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, createNotification, getState, nowIso } from './mockState';
import type { HelpArticle, SupportRepository } from '../index';
import type { Ticket, TicketCreate, TicketDetail, TicketDetailMessagesItem } from '@hudumika/contract';
import { TicketStatus, TicketCreateCategory } from '@hudumika/contract';

/* ---------- seeded help center (GET /help/articles) ---------- */

const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'art_acc_001',
    title: 'How do I create an account?',
    category: 'account',
    body: 'Open the app and tap "Get code" on the sign-in screen. Enter your phone number, confirm the verification code we send you, and your account is ready. You can add your name and language preference after signing in.',
  },
  {
    id: 'art_acc_002',
    title: 'How do I reset my password?',
    category: 'account',
    body: 'On the sign-in screen tap "Forgot password?" and follow the steps. A verification code is sent to your phone, then you can set a new password.',
  },
  {
    id: 'art_pay_001',
    title: 'Which payment methods do you accept?',
    category: 'payments',
    body: 'We accept M-Pesa, Tigo Pesa, Airtel Money, Ezy Pesa, Halotel, card payments and cash on delivery. Your default method can be changed at checkout.',
  },
  {
    id: 'art_ord_001',
    title: 'How do I track my order?',
    category: 'orders',
    body: 'Open the order from your order history and tap "Track order". You see live rider location, the journey phases, and the delivery window in real time.',
  },
  {
    id: 'art_ord_002',
    title: 'Can I cancel my order?',
    category: 'orders',
    body: 'Yes — open the order and tap "Cancel order". Cancellations are free before the merchant accepts; after that a refund may apply depending on the merchant policy.',
  },
  {
    id: 'art_ord_003',
    title: 'Why is my delivery late?',
    category: 'orders',
    body: 'Traffic, weather and demand can delay riders. If your delivery is delayed you will see a banner with the new window. If it looks wrong, contact support and we will check with the rider and merchant.',
  },
  {
    id: 'art_ref_001',
    title: 'How do refunds work?',
    category: 'payments',
    body: 'Refunds are returned to the original payment method, usually within 1–3 working days for mobile money and cards. The order screen shows the refund status and reference.',
  },
];

/* Module-local ticket category map — Ticket DTO has no category field.
 * The union adds 'feedback' as a mock-only category (the contract
 * TicketCreateCategory enum has no such value — docs/CONTRACT-ADDITIONS.md
 * #6); the mock accepts and stores it so the feedback chip round-trips. */
export type MockTicketCategory = TicketCreateCategory | 'feedback';

const ticketCategories = new Map<string, MockTicketCategory>();

/** Dev/test-only: category stored for a mock ticket (contract Ticket omits it). */
export function mockTicketCategory(ticketId: string): MockTicketCategory | undefined {
  return ticketCategories.get(ticketId);
}

export class MockSupportRepository implements SupportRepository {
  async createTicket(input: TicketCreate & { category?: MockTicketCategory }, _idempotencyKey: string): Promise<Ticket> {
    const state = getState();
    const ticket: Ticket = {
      id: uid('ticket'),
      subject: input.subject,
      status: TicketStatus.open,
      priority: input.urgency === 'high' || input.urgency === 'critical' ? 'high' : 'normal',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (input.category) ticketCategories.set(ticket.id, input.category);
    state.tickets.unshift({
      ...ticket,
      subject: input.orderId
        ? `${input.subject} (order ${input.orderId})`
        : input.bookingId
          ? `${input.subject} (booking ${input.bookingId})`
          : input.subject,
      messages: [{ id: uid('tmsg'), authorRole: 'customer', body: input.body, createdAt: nowIso() }],
    });
    return clone(ticket);
  }

  async listTickets(): Promise<Ticket[]> {
    const state = getState();
    return clone(state.tickets.map(({ messages: _messages, ...t }) => t));
  }

  async getTicket(ticketId: string): Promise<TicketDetail> {
    const ticket = getState().tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new ApiError(404, 'TICKET_NOT_FOUND', `Ticket ${ticketId} not found`);
    return clone(ticket);
  }

  async reply(ticketId: string, body: string, _idempotencyKey: string): Promise<TicketDetailMessagesItem> {
    const state = getState();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new ApiError(404, 'TICKET_NOT_FOUND', `Ticket ${ticketId} not found`);
    if (ticket.status === TicketStatus.closed) throw new ApiError(422, 'TICKET_CLOSED', 'This ticket is closed');
    const message: TicketDetailMessagesItem = { id: uid('tmsg'), authorRole: 'customer', body, createdAt: nowIso() };
    ticket.messages.push(message);
    ticket.updatedAt = nowIso();
    createNotification(state, { type: 'support.reply', title: 'Ticket updated', body: ticket.subject, deepLink: `ticket/${ticket.id}` });
    return clone(message);
  }

  /** GET /help/articles — q matches title, body or category (case-insensitive). */
  async listArticles(query?: string): Promise<HelpArticle[]> {
    const q = query?.trim().toLowerCase();
    if (!q) return clone(HELP_ARTICLES);
    return clone(HELP_ARTICLES.filter((a) =>
      a.title.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      (a.body ?? '').toLowerCase().includes(q),
    ));
  }
}
