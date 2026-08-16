/* In-memory reservations repository — GET /reservations/me, POST /reservations,
 * POST /reservations/{id}/cancel (P6b surface). Party size 1–50 per the
 * contract; 201 → status 'pending'. */
import { ApiError } from '@/api/client';
import { clone, getState, nowIso } from './mockState';
import type { ReservationsRepository } from '../index';
import type { Reservation } from '@hudumika/contract';

const MAX_PARTY = 50;

/* The seed reserves two tables for the demo customer (mockState.reservations
 * starts empty): a pending booking and a confirmed one. Module-local so the
 * activity center Reservations segment has data to render out of the box. */
function seedReservations(): void {
  const state = getState();
  if (state.reservations.length > 0) return;
  const merchantId = state.merchants[0]?.id ?? 'merchant_0001';
  const hour = 3600_000;
  state.reservations.push(
    {
      id: 'resv_seed_001',
      merchantId,
      partySize: 4,
      scheduledFor: new Date(Date.now() + 6 * hour).toISOString(),
      status: 'pending',
      note: 'Window table',
      createdAt: nowIso(),
    },
    {
      id: 'resv_seed_002',
      merchantId,
      partySize: 2,
      scheduledFor: new Date(Date.now() + 26 * hour).toISOString(),
      status: 'confirmed',
      createdAt: nowIso(),
    },
  );
}

export class MockReservationsRepository implements ReservationsRepository {
  async list(): Promise<Reservation[]> {
    seedReservations();
    return clone(getState().reservations);
  }

  async create(input: { merchantId: string; partySize: number; scheduledFor: string; note?: string }, _idempotencyKey: string): Promise<Reservation> {
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > MAX_PARTY) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Party size must be between 1 and ${MAX_PARTY}`);
    }
    if (!input.merchantId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a restaurant');
    if (new Date(input.scheduledFor).getTime() <= Date.now()) {
      throw new ApiError(422, 'RESERVATION_TIME_IN_PAST', 'Reservation time is in the past');
    }
    const state = getState();
    const reservation: Reservation = {
      id: `resv_${Math.random().toString(36).slice(2, 8)}`,
      merchantId: input.merchantId,
      partySize: input.partySize,
      scheduledFor: input.scheduledFor,
      status: 'pending',
      note: input.note,
      createdAt: nowIso(),
    };
    state.reservations.push(reservation);
    return clone(reservation);
  }

  async cancel(reservationId: string, _idempotencyKey: string): Promise<Reservation> {
    const state = getState();
    const resv = state.reservations.find((r) => r.id === reservationId);
    if (!resv) throw new ApiError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
    if (resv.status !== 'confirmed' && resv.status !== 'pending') {
      throw new ApiError(409, 'RESERVATION_NOT_CANCELLABLE', 'This reservation can no longer be cancelled');
    }
    resv.status = 'cancelled';
    return clone(resv);
  }
}
