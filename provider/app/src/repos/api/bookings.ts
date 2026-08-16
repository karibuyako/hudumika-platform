/* Live API bookings repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /bookings/me?status                       → Booking[]
 *   GET  /bookings/{bookingId}                     → BookingDetail
 *   POST /bookings/{bookingId}/accept              → Booking
 *   POST /bookings/{bookingId}/decline             → Booking
 *   POST /bookings/{bookingId}/status              → Booking
 *   POST /bookings/{bookingId}/complete            → Booking
 *   POST /bookings/{bookingId}/cancel              → Booking
 *   POST /bookings/{bookingId}/check-in            → Booking
 *   POST /bookings/{bookingId}/pause               → Booking
 *   POST /bookings/{bookingId}/quote               → Booking
 *   POST /bookings/{bookingId}/quote/decision      → Booking
 *   POST /bookings/{bookingId}/proof-of-service    → Booking
 *   POST /bookings/{bookingId}/parts               → Booking
 *   POST /bookings/{bookingId}/invoice             → ServiceInvoice
 *   POST /bookings/{bookingId}/warranty            → ServiceWarranty
 *   GET  /bookings/estimate?serviceId              → BookingEstimate
 *
 * Booking mutations respond with Booking per the contract; the interface needs
 * BookingDetail, so responses are cast. resume(), getInvoice() and getWarranty()
 * have no read path in the contract: resume() throws ApiError(404,
 * NOT_IMPLEMENTED) and the reads resolve to null until the backend exposes them.
 */
import { api, ApiError } from '@/api/client';
import { idemKey } from '@/lib/booking';
import type { BookingsRepository } from '../index';
import type {
  AddBookingPartsBody,
  AdvanceBookingBody,
  Booking,
  BookingDetail,
  BookingEstimate,
  BookingQuote,
  BookingStatus,
  CancelBookingBody,
  CheckInBookingBody,
  DecideBookingQuoteBody,
  DeclineBookingBody,
  IssueServiceInvoiceBody,
  PartsLine,
  PauseBookingBody,
  ProofOfService,
  ProofOfServiceType,
  ServiceInvoice,
  ServiceWarranty,
} from '@hudumika/contract';

export class ApiBookingsRepository implements BookingsRepository {
  async listMyBookings(status?: BookingStatus): Promise<Booking[]> {
    return api.get<Booking[]>(status ? `/bookings/me?status=${encodeURIComponent(status)}` : '/bookings/me');
  }

  async getBooking(bookingId: string): Promise<BookingDetail> {
    return api.get<BookingDetail>(`/bookings/${bookingId}`);
  }

  async accept(bookingId: string): Promise<BookingDetail> {
    const res = await api.post<Booking>(`/bookings/${bookingId}/accept`, undefined, {
      idempotencyKey: idemKey('booking'),
    });
    return res as unknown as BookingDetail;
  }

  async decline(bookingId: string, reason?: string): Promise<void> {
    const body: DeclineBookingBody = { reason: reason ?? 'Provider declined' };
    await api.post<Booking>(`/bookings/${bookingId}/decline`, body, { idempotencyKey: idemKey('booking') });
  }

  async advance(bookingId: string, status: BookingStatus, note?: string): Promise<BookingDetail> {
    const body: AdvanceBookingBody = { status, ...(note ? { note } : {}) };
    const res = await api.post<Booking>(`/bookings/${bookingId}/status`, body, { idempotencyKey: idemKey('booking') });
    return res as unknown as BookingDetail;
  }

  async complete(bookingId: string): Promise<BookingDetail> {
    const res = await api.post<Booking>(`/bookings/${bookingId}/complete`, undefined, {
      idempotencyKey: idemKey('booking'),
    });
    return res as unknown as BookingDetail;
  }

  async cancel(bookingId: string, reason: string): Promise<void> {
    const body: CancelBookingBody = { reason };
    await api.post<Booking>(`/bookings/${bookingId}/cancel`, body, { idempotencyKey: idemKey('booking') });
  }

  async checkIn(bookingId: string, lat: number, lon: number): Promise<BookingDetail> {
    const body: CheckInBookingBody = { lat, lon };
    const res = await api.post<Booking>(`/bookings/${bookingId}/check-in`, body, { idempotencyKey: idemKey('booking') });
    return res as unknown as BookingDetail;
  }

  async pause(bookingId: string, reason: string): Promise<BookingDetail> {
    const body: PauseBookingBody = { reason };
    const res = await api.post<Booking>(`/bookings/${bookingId}/pause`, body, { idempotencyKey: idemKey('booking') });
    return res as unknown as BookingDetail;
  }

  async resume(_bookingId: string): Promise<BookingDetail> {
    throw new ApiError(404, 'NOT_IMPLEMENTED', 'Resuming a paused booking is not available yet (no /bookings/{bookingId}/resume in the contract)');
  }

  async submitQuote(bookingId: string, quote: BookingQuote): Promise<BookingDetail> {
    const res = await api.post<Booking>(`/bookings/${bookingId}/quote`, quote, { idempotencyKey: idemKey('booking') });
    return res as unknown as BookingDetail;
  }

  async decideQuote(bookingId: string, decision: 'approved' | 'declined', note?: string): Promise<BookingDetail> {
    const body: DecideBookingQuoteBody = { decision, ...(note ? { note } : {}) };
    const res = await api.post<Booking>(`/bookings/${bookingId}/quote/decision`, body, {
      idempotencyKey: idemKey('booking'),
    });
    return res as unknown as BookingDetail;
  }

  async submitProof(bookingId: string, type: ProofOfServiceType, value: string): Promise<BookingDetail> {
    const body: ProofOfService = { type, value };
    const res = await api.post<Booking>(`/bookings/${bookingId}/proof-of-service`, body, {
      idempotencyKey: idemKey('booking'),
    });
    return res as unknown as BookingDetail;
  }

  async addParts(bookingId: string, parts: PartsLine[]): Promise<BookingDetail> {
    const body: AddBookingPartsBody = { parts };
    const res = await api.post<Booking>(`/bookings/${bookingId}/parts`, body, { idempotencyKey: idemKey('booking') });
    return res as unknown as BookingDetail;
  }

  async issueInvoice(bookingId: string, laborTZS: number, discountTZS?: number, note?: string): Promise<ServiceInvoice> {
    const body: IssueServiceInvoiceBody = {
      laborTZS,
      ...(discountTZS !== undefined ? { discountTZS } : {}),
      ...(note ? { note } : {}),
    };
    return api.post<ServiceInvoice>(`/bookings/${bookingId}/invoice`, body, { idempotencyKey: idemKey('booking') });
  }

  async issueWarranty(bookingId: string, validDays: number, coverage?: string, followUpAt?: string): Promise<ServiceWarranty> {
    const body: ServiceWarranty = {
      bookingId,
      validDays,
      ...(coverage ? { coverage } : {}),
      ...(followUpAt ? { followUpAt } : {}),
    };
    return api.post<ServiceWarranty>(`/bookings/${bookingId}/warranty`, body, { idempotencyKey: idemKey('booking') });
  }

  async getInvoice(_bookingId: string): Promise<ServiceInvoice | null> {
    return null;
  }

  async getWarranty(_bookingId: string): Promise<ServiceWarranty | null> {
    return null;
  }

  async getEstimatePreview(bookingId: string): Promise<BookingEstimate> {
    const detail = await api.get<BookingDetail>(`/bookings/${bookingId}`);
    return api.get<BookingEstimate>(`/bookings/estimate?serviceId=${encodeURIComponent(detail.serviceId)}`);
  }
}
