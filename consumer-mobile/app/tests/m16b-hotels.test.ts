/* M16b — Hotels vertical (contract: GET /hotels, GET /hotels/{hotelId},
 * POST /hotel-bookings, GET /hotel-bookings/me).
 *
 * Covers the mock repository surface: seeded city-scoped listing (with
 * cursor pagination), detail + 404, booking validation (dates / room /
 * guests) with integer-TZS totals (nights × rate), per-key idempotency, and
 * the My bookings list carrying created + seeded records.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState } from '@/repos/mock/mockState';
import { MockHotelsRepository, resetMockHotelsState } from '@/repos/mock/hotels';
import { rejectsApiError } from './helpers';

const hotels = new MockHotelsRepository();

const DAY_MS = 86400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

beforeEach(() => {
  resetMockState();
  resetMockHotelsState();
});

test('list returns the seeded hotels, filterable by city, with cursor pagination', async () => {
  const all = await hotels.list();
  assert.equal(all.results.length, 3);
  assert.equal(all.nextCursor, null);

  const dar = await hotels.list({ cityId: 'city_dar' });
  assert.equal(dar.results.length, 1);
  assert.equal(dar.results[0].id, 'hotel_seafront_001');
  assert.equal(dar.results[0].cityName, 'Dar es Salaam');
  assert.equal(dar.results[0].starRating, 5);
  assert.ok(dar.results[0].startingPriceTZS > 0, 'starting price is set');
  assert.ok((dar.results[0].amenities ?? []).length > 0);
  assert.ok(Number.isInteger(dar.results[0].startingPriceTZS), 'money is integer TZS');

  const arusha = await hotels.list({ cityId: 'city_arusha' });
  assert.equal(arusha.results[0].cityName, 'Arusha');

  const first = await hotels.list({ limit: 2 });
  assert.equal(first.results.length, 2);
  assert.ok(first.nextCursor, 'more pages remain');
  const second = await hotels.list({ cursor: first.nextCursor ?? undefined, limit: 2 });
  assert.equal(second.results.length, 1);
  assert.equal(second.nextCursor, null);
  const ids = [...first.results.map((h) => h.id), ...second.results.map((h) => h.id)];
  assert.equal(new Set(ids).size, 3, 'pagination never duplicates hotels');
});

test('get resolves the detail with rooms; unknown ids 404 with NOT_FOUND', async () => {
  const detail = await hotels.get('hotel_seafront_001');
  assert.equal(detail.hotel.name, 'Seafront Hotel Dar');
  assert.ok(detail.description && detail.description.length > 0);
  assert.equal(detail.rooms.length, 3);
  const std = detail.rooms.find((r) => r.id === 'room_sf_std')!;
  assert.equal(std.pricePerNightTZS, 145000);
  assert.equal(std.capacity, 2);
  assert.ok(Number.isInteger(std.pricePerNightTZS));
  assert.equal(std.available, true);
  assert.ok(detail.rooms.some((r) => r.available === false), 'one room per hotel is unavailable');

  await rejectsApiError(hotels.get('hotel_does_not_exist'), 404, 'NOT_FOUND');
});

test('book validates the room, dates and guests, and computes integer-TZS totals (nights × rate)', async () => {
  const today = new Date();
  const checkIn = isoDate(today);
  const checkOut = isoDate(new Date(today.getTime() + 2 * DAY_MS));

  // Unknown hotel.
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_nope', roomId: 'room_sf_std', checkIn, checkOut, guests: 2 }, 'k-hotel'),
    404,
    'NOT_FOUND',
  );
  // Unknown room in a real hotel.
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_seafront_001', roomId: 'room_nope', checkIn, checkOut, guests: 2 }, 'k-room'),
    404,
    'NOT_FOUND',
  );
  // Unavailable room.
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_seafront_001', roomId: 'room_sf_suite', checkIn, checkOut, guests: 2 }, 'k-unavail'),
    422,
    'VALIDATION_FAILED',
  );
  // Check-out before check-in.
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_seafront_001', roomId: 'room_sf_std', checkIn: checkOut, checkOut: checkIn, guests: 2 }, 'k-dates'),
    422,
    'VALIDATION_FAILED',
  );
  // Same-day stay.
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_seafront_001', roomId: 'room_sf_std', checkIn, checkOut: checkIn, guests: 2 }, 'k-same'),
    422,
    'VALIDATION_FAILED',
  );
  // Guests out of the 1–10 contract range.
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_seafront_001', roomId: 'room_sf_std', checkIn, checkOut, guests: 0 }, 'k-g0'),
    422,
    'VALIDATION_FAILED',
  );
  await rejectsApiError(
    hotels.book({ hotelId: 'hotel_seafront_001', roomId: 'room_sf_std', checkIn, checkOut, guests: 11 }, 'k-g11'),
    422,
    'VALIDATION_FAILED',
  );

  // Happy path: 2 nights × 145,000 = 290,000 (integer minor units of TZS).
  const booking = await hotels.book(
    { hotelId: 'hotel_seafront_001', roomId: 'room_sf_std', checkIn, checkOut, guests: 2, contactPhone: '+255700000000' },
    'k-ok',
  );
  assert.equal(booking.hotelName, 'Seafront Hotel Dar');
  assert.equal(booking.roomName, 'Standard Room');
  assert.equal(booking.nights, 2);
  assert.equal(booking.totalTZS, 290000);
  assert.equal(booking.status, 'pending_payment');
  assert.equal(booking.guests, 2);
  assert.ok(booking.createdAt, 'createdAt is stamped');
});

test('book is idempotent per key — the same key replays the same booking, never double-books', async () => {
  const today = new Date();
  const checkIn = isoDate(today);
  const checkOut = isoDate(new Date(today.getTime() + 3 * DAY_MS));
  const input = { hotelId: 'hotel_lakeview_002', roomId: 'room_lv_std', checkIn, checkOut, guests: 2 };

  const first = await hotels.book(input, 'hbk-key-1');
  const before = await hotels.listMyBookings();
  const replay = await hotels.book({ ...input, guests: 4 }, 'hbk-key-1');
  const after = await hotels.listMyBookings();

  assert.equal(replay.id, first.id, 'same key returns the same booking');
  assert.equal(replay.guests, first.guests, 'the first write wins — later body is ignored');
  assert.equal(replay.totalTZS, first.totalTZS);
  assert.equal(after.length, before.length, 'no second booking is created');
  assert.equal(after.filter((b) => b.id === first.id).length, 1);

  // A different key books a genuinely new stay.
  const second = await hotels.book({ ...input, roomId: 'room_lv_lake' }, 'hbk-key-2');
  assert.notEqual(second.id, first.id);
  assert.equal((await hotels.listMyBookings()).length, before.length + 1);
});

test('listMyBookings includes created bookings and the seeded completed stay', async () => {
  const seeded = await hotels.listMyBookings();
  const done = seeded.find((b) => b.id === 'hbk_seed_completed_001')!;
  assert.ok(done, 'the seeded completed booking is present');
  assert.equal(done.status, 'completed');
  assert.equal(done.hotelName, 'Seafront Hotel Dar');
  assert.equal(done.nights, 2);
  assert.equal(done.totalTZS, 290000);

  const today = new Date();
  const checkIn = isoDate(today);
  const checkOut = isoDate(new Date(today.getTime() + 1 * DAY_MS));
  await hotels.book({ hotelId: 'hotel_meru_003', roomId: 'room_mv_std', checkIn, checkOut, guests: 1 }, 'hbk-key-3');

  const after = await hotels.listMyBookings();
  assert.equal(after.length, seeded.length + 1);
  const created = after.find((b) => b.hotelName === 'Meru View Lodge Arusha')!;
  assert.equal(created.status, 'pending_payment');
  assert.equal(created.totalTZS, 65000, '1 night × 65,000');
});
