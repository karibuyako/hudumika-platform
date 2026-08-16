/* Live API travel repository — GET /travel/options (search), POST
 * /travel/bookings (Idempotency-Key), GET /travel/bookings/me. */
import { api } from '@/api/client';
import type { CreateTravelBookingBody, ListTravelOptionsParams, TravelBooking, TravelOption } from '@hudumika/contract';
import type { TravelBookingInput, TravelRepository, TravelSearchParams } from '../index';

export class ApiTravelRepository implements TravelRepository {
  async search(params: TravelSearchParams): Promise<TravelOption[]> {
    // Mock-only until the contract adds 'train' to TravelOptionMode: the mode
    // passes through as a plain query string value, so a backend that has not
    // shipped the enum value simply ignores the unknown filter.
    const query: ListTravelOptionsParams = params;
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<TravelOption[]>(`/travel/options${qs ? `?${qs}` : ''}`);
  }

  async book(input: TravelBookingInput, idempotencyKey: string): Promise<TravelBooking> {
    const body: CreateTravelBookingBody = {
      travelOptionId: input.travelOptionId,
      passengers: input.passengers,
      contactPhone: input.contactPhone,
      // Contract body field + the Idempotency-Key header (client.ts).
      idempotencyKey,
    };
    return api.post<TravelBooking>('/travel/bookings', body, { idempotencyKey });
  }

  async listMyBookings(): Promise<TravelBooking[]> {
    return api.get<TravelBooking[]>('/travel/bookings/me');
  }
}
