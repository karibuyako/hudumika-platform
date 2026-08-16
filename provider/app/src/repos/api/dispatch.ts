/* Live API dispatch repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /dispatch/provider-jobs?kind&trade               → ProviderJobOffer[]
 *   POST /dispatch/provider-jobs/{bookingId}/accept       → Booking
 *   GET  /providers/me/dispatch                           → GetProviderDispatchConsole200
 *   POST /bookings/{bookingId}/assign-technician          → Booking
 *
 * acceptOffer/assignTechnician respond with Booking; the interface needs
 * BookingDetail, so responses are cast (full detail comes from
 * GET /bookings/{bookingId}).
 */
import { api } from '@/api/client';
import { idemKey } from '@/lib/booking';
import type { DispatchRepository } from '../index';
import type {
  AssignBookingTechnicianBody,
  Booking,
  BookingDetail,
  GetProviderDispatchConsole200,
  ProviderJobOffer,
} from '@hudumika/contract';

export class ApiDispatchRepository implements DispatchRepository {
  async listProviderJobs(kind: string, trade?: string): Promise<ProviderJobOffer[]> {
    const qs = [kind ? `kind=${encodeURIComponent(kind)}` : '', trade ? `trade=${encodeURIComponent(trade)}` : '']
      .filter(Boolean)
      .join('&');
    return api.get<ProviderJobOffer[]>(`/dispatch/provider-jobs${qs ? `?${qs}` : ''}`);
  }

  async acceptOffer(bookingId: string): Promise<BookingDetail> {
    const res = await api.post<Booking>(`/dispatch/provider-jobs/${bookingId}/accept`, undefined, {
      idempotencyKey: idemKey('booking'),
    });
    return res as unknown as BookingDetail;
  }

  async getConsole(): Promise<GetProviderDispatchConsole200> {
    return api.get<GetProviderDispatchConsole200>('/providers/me/dispatch');
  }

  async assignTechnician(bookingId: string, technicianId: string, note?: string): Promise<BookingDetail> {
    const body: AssignBookingTechnicianBody = { technicianId, ...(note ? { note } : {}) };
    const res = await api.post<Booking>(`/bookings/${bookingId}/assign-technician`, body, {
      idempotencyKey: idemKey('booking'),
    });
    return res as unknown as BookingDetail;
  }
}
