/* Live API events repository — GET /entertainment/events (cursor
 * pagination), GET /entertainment/events/{eventId}, POST
 * /entertainment/event-tickets (Idempotency-Key header; replay never
 * double-issues), GET /entertainment/event-tickets/me. */
import { api } from '@/api/client';
import type { EventDetail, EventListing, EventTicket, PurchaseEventTicketsBody } from '@hudumika/contract';
import type { EventsRepository } from '../index';

export class ApiEventsRepository implements EventsRepository {
  async list(params?: { cityId?: string; category?: string; cursor?: string; limit?: number }): Promise<{ results: EventListing[]; nextCursor: string | null }> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<{ results: EventListing[]; nextCursor: string | null }>(`/entertainment/events${qs ? `?${qs}` : ''}`);
  }

  async get(eventId: string): Promise<EventDetail> {
    return api.get<EventDetail>(`/entertainment/events/${eventId}`);
  }

  async purchase(input: { eventId: string; tierId: string; quantity: number }, idempotencyKey: string): Promise<EventTicket[]> {
    const body: PurchaseEventTicketsBody = {
      eventId: input.eventId,
      tierId: input.tierId,
      quantity: input.quantity,
    };
    return api.post<EventTicket[]>('/entertainment/event-tickets', body, { idempotencyKey });
  }

  async listMyTickets(): Promise<EventTicket[]> {
    return api.get<EventTicket[]>('/entertainment/event-tickets/me');
  }
}
