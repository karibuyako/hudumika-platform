/* Live API bookings repository — POST /bookings (Idempotency-Key),
 * /bookings/me, /bookings/{id}, cancel, complete, quote decision.
 *
 * Customer documents: the contract exposes POST-only issue endpoints
 * (issueServiceInvoice / submitProofOfService / warranty issue) and NO
 * customer GET — GET /bookings/{id}/invoice|warranty|proof-of-service are
 * mock-only-until-adopted paths (docs/CONTRACT-ADDITIONS.md #9, tracked in
 * the parity allow-list). 404 (not issued / not implemented live) → null,
   * the honest "document not issued" state for the booking screen. */
import { api, ApiError } from '@/api/client';
import type { Booking, BookingCreate, BookingDetail, BookingEstimate, DecideBookingQuoteBodyDecision } from '@hudumika/contract';
import type { BookingInvoice, BookingProof, BookingWarranty, BookingsRepository } from '../index';

export class ApiBookingsRepository implements BookingsRepository {
  /** GET /bookings/{id}/invoice — mock-only-until-adopted (CONTRACT-ADDITIONS
   * #9): the live backend does not serve it until Team 6 ships the GET, so a
   * 404 maps to null and the screen renders the "not issued" fallback. */
  private async documentOrNull<T>(path: string): Promise<T | null> {
    try {
      return await api.get<T>(path);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async estimate(input: { serviceId: string; cityId?: string }): Promise<BookingEstimate> {
    const qs = new URLSearchParams({ serviceId: input.serviceId, ...(input.cityId ? { cityId: input.cityId } : {}) }).toString();
    return api.get<BookingEstimate>(`/bookings/estimate?${qs}`);
  }

  async create(input: BookingCreate, idempotencyKey: string): Promise<Booking> {
    return api.post<Booking>('/bookings', input, { idempotencyKey });
  }

  async list(params?: { status?: string; cursor?: string; limit?: number }): Promise<Booking[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<Booking[]>(`/bookings/me${qs ? `?${qs}` : ''}`);
  }

  async get(bookingId: string): Promise<BookingDetail> {
    return api.get<BookingDetail>(`/bookings/${bookingId}`);
  }

  async cancel(bookingId: string, reason: string, idempotencyKey: string): Promise<Booking> {
    return api.post<Booking>(`/bookings/${bookingId}/cancel`, { reason }, { idempotencyKey });
  }

  async complete(bookingId: string, idempotencyKey: string): Promise<Booking> {
    return api.post<Booking>(`/bookings/${bookingId}/complete`, {}, { idempotencyKey });
  }

  async decideQuote(bookingId: string, decision: DecideBookingQuoteBodyDecision, note: string | undefined, idempotencyKey: string): Promise<Booking> {
    return api.post<Booking>(
      `/bookings/${bookingId}/quote/decision`,
      { decision, ...(note ? { note } : {}) },
      { idempotencyKey },
    );
  }

  async getInvoice(bookingId: string): Promise<BookingInvoice | null> {
    return this.documentOrNull<BookingInvoice>(`/bookings/${bookingId}/invoice`);
  }

  async getWarranty(bookingId: string): Promise<BookingWarranty | null> {
    return this.documentOrNull<BookingWarranty>(`/bookings/${bookingId}/warranty`);
  }

  async getProofOfService(bookingId: string): Promise<BookingProof | null> {
    return this.documentOrNull<BookingProof>(`/bookings/${bookingId}/proof-of-service`);
  }
}
