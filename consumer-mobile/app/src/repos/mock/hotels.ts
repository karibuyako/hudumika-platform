/* In-memory hotels repository — GET /hotels (city-scoped search),
 * GET /hotels/{hotelId}, POST /hotel-bookings (idempotent per key),
 * GET /hotel-bookings/me.
 *
 * Seeds live here module-locally (mockState.ts stays untouched — same pattern
 * as mock/reviews.ts) and are idempotent across resetMockState(). Bookings
 * accumulate module-locally too: the same idempotency key replays the same
 * booking (never double-books). Money is integer TZS: totalTZS = nights ×
 * room pricePerNightTZS.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import type { Hotel, HotelBooking, HotelDetail, HotelRoom } from '@hudumika/contract';
import type { HotelSearchParams, HotelsRepository } from '../index';

const DAY_MS = 86400_000;

/* Module-local seeds + bookings — resetMockState covers mockState only, so
 * tests call resetMockHotelsState() between cases (mock/orders.ts pattern). */
let seeded = false;
const hotels: Hotel[] = [];
const rooms = new Map<string, HotelRoom[]>();
const descriptions = new Map<string, string>();
const bookings: HotelBooking[] = [];
const bookReplays = new Map<string, HotelBooking>();

export function resetMockHotelsState(): void {
  seeded = false;
  hotels.length = 0;
  rooms.clear();
  descriptions.clear();
  bookings.length = 0;
  bookReplays.clear();
}

/** Day-index (UTC) of an ISO string — normalizes full timestamps and bare
 * YYYY-MM-DD dates so night counts are timezone-stable. NaN for garbage. */
function dayIndex(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS;
}

/** Hotel seeds reference the mockState cities (city_dar / city_mwanza /
 * city_arusha) so the city filter and the list header agree with the rest of
 * the app. One room per hotel is intentionally unavailable so the booking
 * validation path is reachable in the demo. */
function ensureSeeds(): void {
  if (seeded) return;
  seeded = true;
  const state = getState();
  const cityName = (id: string) => state.cities.find((c) => c.id === id)?.name ?? id;
  const h1: Hotel = {
    id: 'hotel_seafront_001',
    name: 'Seafront Hotel Dar',
    cityId: 'city_dar',
    cityName: cityName('city_dar'),
    starRating: 5,
    rating: 4.7,
    reviewCount: 412,
    startingPriceTZS: 145000,
    imageUrl: null,
    amenities: ['Free Wi-Fi', 'Pool', 'Beachfront', 'Breakfast included'],
    addressLine: 'Ocean Road, Kinondoni, Dar es Salaam',
  };
  const h2: Hotel = {
    id: 'hotel_lakeview_002',
    name: 'Lakeview Gardens Mwanza',
    cityId: 'city_mwanza',
    cityName: cityName('city_mwanza'),
    starRating: 4,
    rating: 4.4,
    reviewCount: 187,
    startingPriceTZS: 98000,
    imageUrl: null,
    amenities: ['Free Wi-Fi', 'Lake view', 'Restaurant'],
    addressLine: 'Capri Point, Nyamagana, Mwanza',
  };
  const h3: Hotel = {
    id: 'hotel_meru_003',
    name: 'Meru View Lodge Arusha',
    cityId: 'city_arusha',
    cityName: cityName('city_arusha'),
    starRating: 3,
    rating: 4.1,
    reviewCount: 96,
    startingPriceTZS: 65000,
    imageUrl: null,
    amenities: ['Free Wi-Fi', 'Mountain view', 'Parking'],
    addressLine: 'Boma Road, Arumeru, Arusha',
  };
  hotels.push(h1, h2, h3);

  rooms.set(h1.id, [
    { id: 'room_sf_std', hotelId: h1.id, name: 'Standard Room', pricePerNightTZS: 145000, capacity: 2, available: true, amenities: ['City view', 'Air conditioning'] },
    { id: 'room_sf_dlx', hotelId: h1.id, name: 'Deluxe Ocean View', pricePerNightTZS: 230000, capacity: 3, available: true, amenities: ['Sea view', 'Balcony', 'Air conditioning'] },
    { id: 'room_sf_suite', hotelId: h1.id, name: 'Executive Suite', pricePerNightTZS: 420000, capacity: 4, available: false, amenities: ['Sea view', 'Living room', 'Butler service'] },
  ]);
  rooms.set(h2.id, [
    { id: 'room_lv_std', hotelId: h2.id, name: 'Standard Garden Room', pricePerNightTZS: 98000, capacity: 2, available: true, amenities: ['Garden view'] },
    { id: 'room_lv_lake', hotelId: h2.id, name: 'Lake View Room', pricePerNightTZS: 165000, capacity: 2, available: true, amenities: ['Lake view', 'Balcony'] },
  ]);
  rooms.set(h3.id, [
    { id: 'room_mv_std', hotelId: h3.id, name: 'Standard Lodge Room', pricePerNightTZS: 65000, capacity: 2, available: true, amenities: ['Mountain view'] },
    { id: 'room_mv_fam', hotelId: h3.id, name: 'Family Room', pricePerNightTZS: 115000, capacity: 4, available: false, amenities: ['Mountain view', 'Extra beds'] },
  ]);

  descriptions.set(h1.id, 'A five-star seafront escape on Ocean Road — ocean-view balconies, an infinity pool and a seafood restaurant steps from the water.');
  descriptions.set(h2.id, 'A lakeside retreat on Capri Point with sweeping views of Lake Victoria, an in-house restaurant and easy access to Mwanza’s markets.');
  descriptions.set(h3.id, 'A cozy lodge at the foot of Mount Meru — quiet gardens, mountain views and a short drive from Arusha National Park.');

  // Seeded completed booking (past stay) so My hotels has content on first load.
  const pastOut = dayIndex(nowIso());
  bookings.push({
    id: 'hbk_seed_completed_001',
    hotelId: h1.id,
    hotelName: h1.name,
    roomId: 'room_sf_std',
    roomName: 'Standard Room',
    checkIn: new Date((pastOut - 3) * DAY_MS).toISOString().slice(0, 10),
    checkOut: new Date((pastOut - 1) * DAY_MS).toISOString().slice(0, 10),
    guests: 2,
    nights: 2,
    totalTZS: 290000,
    status: 'completed',
    createdAt: new Date((pastOut - 5) * DAY_MS).toISOString(),
  });
}

function findHotel(hotelId: string): Hotel {
  const hotel = hotels.find((h) => h.id === hotelId);
  if (!hotel) throw new ApiError(404, 'NOT_FOUND', `Hotel ${hotelId} not found`);
  return hotel;
}

export class MockHotelsRepository implements HotelsRepository {
  async list(params?: HotelSearchParams): Promise<{ results: Hotel[]; nextCursor: string | null }> {
    ensureSeeds();
    let list = hotels;
    if (params?.cityId) list = list.filter((h) => h.cityId === params.cityId);
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    const page = list.slice(offset, offset + limit);
    const nextCursor = offset + page.length < list.length ? String(offset + page.length) : null;
    return { results: clone(page), nextCursor };
  }

  async get(hotelId: string): Promise<HotelDetail> {
    ensureSeeds();
    const hotel = findHotel(hotelId);
    return clone({ hotel, description: descriptions.get(hotelId), rooms: rooms.get(hotelId) ?? [] });
  }

  async book(input: { hotelId: string; roomId: string; checkIn: string; checkOut: string; guests: number; contactPhone?: string }, idempotencyKey: string): Promise<HotelBooking> {
    ensureSeeds();
    const replay = bookReplays.get(idempotencyKey);
    if (replay) return clone(replay);

    const hotel = findHotel(input.hotelId);
    const room = (rooms.get(input.hotelId) ?? []).find((r) => r.id === input.roomId);
    if (!room) throw new ApiError(404, 'NOT_FOUND', `Room ${input.roomId} not found in hotel ${input.hotelId}`);
    if (room.available === false) throw new ApiError(422, 'VALIDATION_FAILED', `${room.name} is not available for booking`);
    if (!Number.isInteger(input.guests) || input.guests < 1 || input.guests > 10) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Guests must be between 1 and 10');
    }
    const inDay = dayIndex(input.checkIn);
    const outDay = dayIndex(input.checkOut);
    if (Number.isNaN(inDay) || Number.isNaN(outDay)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Check-in and check-out must be valid dates');
    }
    if (outDay <= inDay) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Check-out must be after check-in');
    }
    const nights = outDay - inDay;
    // Integer minor units of TZS — nights × rate, never floats.
    const totalTZS = nights * room.pricePerNightTZS;

    const booking: HotelBooking = {
      id: uid('hbk'),
      hotelId: hotel.id,
      hotelName: hotel.name,
      roomId: room.id,
      roomName: room.name,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      nights,
      totalTZS,
      status: 'pending_payment',
      createdAt: nowIso(),
    };
    bookings.unshift(booking);
    bookReplays.set(idempotencyKey, booking);
    return clone(booking);
  }

  async listMyBookings(): Promise<HotelBooking[]> {
    ensureSeeds();
    return clone(bookings);
  }
}
