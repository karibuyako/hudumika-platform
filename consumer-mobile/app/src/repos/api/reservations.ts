/* Live API reservations repository — POST /reservations, /reservations/me,
 * POST /reservations/{id}/cancel (P6b surface). */
import { api } from '@/api/client';
import type { ReservationsRepository } from '../index';
import type { Reservation } from '@hudumika/contract';

export class ApiReservationsRepository implements ReservationsRepository {
  async list(): Promise<Reservation[]> {
    return api.get<Reservation[]>('/reservations/me');
  }

  async create(input: { merchantId: string; partySize: number; scheduledFor: string; note?: string }, idempotencyKey: string): Promise<Reservation> {
    return api.post<Reservation>('/reservations', { ...input }, { idempotencyKey });
  }

  async cancel(reservationId: string, idempotencyKey: string): Promise<Reservation> {
    return api.post<Reservation>(`/reservations/${reservationId}/cancel`, {}, { idempotencyKey });
  }
}