/* Live API hotels repository — GET /hotels (city-scoped search),
 * GET /hotels/{hotelId}, POST /hotel-bookings (Idempotency-Key),
 * GET /hotel-bookings/me. */
import { api } from '@/api/client';
import type { Hotel, HotelBooking, HotelBookingCreate, HotelDetail, ListHotels200 } from '@hudumika/contract';
import type { HotelSearchParams, HotelsRepository } from '../index';

export class ApiHotelsRepository implements HotelsRepository {
  async list(params?: HotelSearchParams): Promise<{ results: Hotel[]; nextCursor: string | null }> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    const data = await api.get<ListHotels200>(`/hotels${qs ? `?${qs}` : ''}`);
    return { results: data.results ?? [], nextCursor: data.nextCursor ?? null };
  }

  async get(hotelId: string): Promise<HotelDetail> {
    return api.get<HotelDetail>(`/hotels/${hotelId}`);
  }

  async book(input: { hotelId: string; roomId: string; checkIn: string; checkOut: string; guests: number; contactPhone?: string }, idempotencyKey: string): Promise<HotelBooking> {
    const body: HotelBookingCreate = {
      hotelId: input.hotelId,
      roomId: input.roomId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      contactPhone: input.contactPhone,
    };
    return api.post<HotelBooking>('/hotel-bookings', body, { idempotencyKey });
  }

  async listMyBookings(): Promise<HotelBooking[]> {
    return api.get<HotelBooking[]>('/hotel-bookings/me');
  }
}
