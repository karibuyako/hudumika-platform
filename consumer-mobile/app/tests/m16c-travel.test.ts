/* M16c — Travel vertical (intercity bus / ferry / flight + mock-only train
 * until the contract adds 'train' to TravelOptionMode): search returns the
 * deterministic seeded departures for a requested local date, filtered by
 * mode; book() prices from the option (totalTZS = price × passengers),
 * validates (unknown option 404, past departure / seats / passenger range /
 * phone → 422), is idempotent per key, and lands in My bookings next to the
 * seeded completed booking. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { MockTravelRepository, resetMockTravelState, SEED_TRAVEL_BOOKING_ID } from '@/repos/mock/travel';
import { resetMockState } from '@/repos/mock/mockState';

const repo = new MockTravelRepository();

const p2 = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDays = (base: Date, days: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
};
const sameLocalDay = (iso: string, day: Date) => {
  const d = new Date(iso);
  return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
};

beforeEach(() => {
  resetMockState();
  resetMockTravelState();
});

async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal(caught.status, status);
  if (code) assert.equal(caught.code, code);
  return caught as ApiError;
}

test('search returns the seeded Dar→Mwanza options on the requested date', async () => {
  const day = addDays(new Date(), 3);
  const opts = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(day) });
  assert.equal(opts.length, 2, 'bus + ferry for Dar→Mwanza');
  assert.deepEqual(opts.map((o) => o.mode).sort(), ['bus', 'ferry']);
  for (const o of opts) {
    assert.ok(o.provider, 'provider name is set');
    assert.equal(o.originCityId, 'city_dar');
    assert.equal(o.destinationCityId, 'city_mwanza');
    assert.equal(o.originCityName, 'Dar es Salaam', 'city names resolve from the seeded cities');
    assert.equal(o.destinationCityName, 'Mwanza');
    assert.ok(Number.isInteger(o.priceTZS) && o.priceTZS > 0, 'integer TZS price');
    assert.ok(Number.isInteger(o.seatsAvailable) && o.seatsAvailable > 0);
    assert.ok(sameLocalDay(o.departureAt, day), 'departure falls on the requested local day');
    assert.ok(Date.parse(o.arrivalAt) > Date.parse(o.departureAt));
  }
  const bus = opts.find((o) => o.mode === 'bus')!;
  const dep = new Date(bus.departureAt);
  assert.equal(dep.getHours() * 60 + dep.getMinutes(), 360, 'bus departs 06:00 local every day');
  assert.equal(Date.parse(bus.arrivalAt) - Date.parse(bus.departureAt), 810 * 60_000, 'fixed 13h30 duration');
});

test('search filters by mode and returns nothing for an unseeded route', async () => {
  const day = addDays(new Date(), 2);
  const buses = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(day), mode: 'bus' });
  assert.equal(buses.length, 1);
  assert.equal(buses[0].mode, 'bus');
  const flights = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(day), mode: 'flight' });
  assert.equal(flights.length, 0, 'no flight on the Dar→Mwanza leg');
  const reverse = await repo.search({ originCityId: 'city_mwanza', destinationCityId: 'city_dar', date: localDay(day) });
  assert.equal(reverse.length, 0, 'routes are one-directional');
  const arusha = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_arusha', date: localDay(day) });
  assert.deepEqual(arusha.map((o) => o.mode).sort(), ['bus', 'flight']);
  const dodoma = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day) });
  assert.deepEqual(dodoma.map((o) => o.mode).sort(), ['bus', 'train'], 'bus + mock-only train on the Dar→Dodoma leg');
});

test('search departs on the requested date, not the current one', async () => {
  const today = new Date();
  const tomorrow = addDays(today, 1);
  const todayOpts = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_arusha', date: localDay(today) });
  const tomorrowOpts = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_arusha', date: localDay(tomorrow) });
  assert.equal(todayOpts.length, 2);
  assert.ok(todayOpts.every((o) => sameLocalDay(o.departureAt, today)), 'today search departs today');
  assert.ok(tomorrowOpts.every((o) => sameLocalDay(o.departureAt, tomorrow)), 'tomorrow search departs tomorrow');
  assert.notEqual(todayOpts[0].departureAt, tomorrowOpts[0].departureAt, 'departures differ across dates');
  assert.equal(Date.parse(todayOpts[0].departureAt) - Date.parse(tomorrowOpts[0].departureAt), -86400_000, 'exactly one local day apart');
});

test('search rejects a malformed date with VALIDATION_FAILED', async () => {
  await rejectsApiError(repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: 'not-a-date' }), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: '2026-13-40' }), 422, 'VALIDATION_FAILED');
});

test('book prices passengers at the option price (integer TZS) and returns pending_payment', async () => {
  const day = addDays(new Date(), 3);
  const [option] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(day), mode: 'bus' });
  const booking = await repo.book({ travelOptionId: option.id, passengers: 2, contactPhone: '+255712345678' }, 'key-book-1');
  assert.equal(booking.travelOptionId, option.id);
  assert.equal(booking.totalTZS, option.priceTZS * 2, 'total = price × passengers');
  assert.ok(Number.isInteger(booking.totalTZS));
  assert.equal(booking.status, 'pending_payment');
  assert.equal(booking.passengers, 2);
  assert.equal(booking.contactPhone, '+255712345678');
  assert.equal(booking.departureAt, option.departureAt, 'the booked departure is the exact one shown in search');
  assert.equal(booking.mode, option.mode);
  assert.equal(booking.originCityName, 'Dar es Salaam');
  assert.equal(booking.destinationCityName, 'Mwanza');
  assert.ok(Date.parse(booking.createdAt) > 0);
});

test('book rejects an unknown option with NOT_FOUND', async () => {
  await rejectsApiError(repo.book({ travelOptionId: 'topt_nope', passengers: 1, contactPhone: '+255712345678' }, 'k1'), 404, 'NOT_FOUND');
  // A seeded route id is NOT bookable until its departure was issued by a search.
  await rejectsApiError(repo.book({ travelOptionId: 'topt_dar_mwanza_bus', passengers: 1, contactPhone: '+255712345678' }, 'k2'), 404, 'NOT_FOUND');
});

test('book rejects a departure in the past (VALIDATION_FAILED)', async () => {
  const yesterday = addDays(new Date(), -1);
  const [option] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(yesterday) });
  assert.ok(Date.parse(option.departureAt) < Date.now(), 'yesterday option is in the past');
  await rejectsApiError(repo.book({ travelOptionId: option.id, passengers: 1, contactPhone: '+255712345678' }, 'k-past'), 422, 'VALIDATION_FAILED');
});

test('book rejects when passengers exceed the seats available', async () => {
  const day = addDays(new Date(), 2);
  const [, flight] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_arusha', date: localDay(day) });
  assert.equal(flight.mode, 'flight');
  assert.equal(flight.seatsAvailable, 12);
  await rejectsApiError(repo.book({ travelOptionId: flight.id, passengers: 15, contactPhone: '+255712345678' }, 'k-seats'), 422, 'VALIDATION_FAILED');
});

test('book validates the passenger range and contact phone', async () => {
  const day = addDays(new Date(), 2);
  const [option] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(day), mode: 'bus' });
  await rejectsApiError(repo.book({ travelOptionId: option.id, passengers: 0, contactPhone: '+255712345678' }, 'k-0'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.book({ travelOptionId: option.id, passengers: 21, contactPhone: '+255712345678' }, 'k-21'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.book({ travelOptionId: option.id, passengers: 1.5, contactPhone: '+255712345678' }, 'k-frac'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.book({ travelOptionId: option.id, passengers: 1, contactPhone: '   ' }, 'k-phone'), 422, 'VALIDATION_FAILED');
});

test('the same key replays the same booking (idempotent, no double-booking)', async () => {
  const day = addDays(new Date(), 3);
  const [option] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_mwanza', date: localDay(day), mode: 'bus' });
  const first = await repo.book({ travelOptionId: option.id, passengers: 2, contactPhone: '+255712345678' }, 'key-replay');
  const second = await repo.book({ travelOptionId: option.id, passengers: 4, contactPhone: '+255799999999' }, 'key-replay');
  assert.deepEqual(second, first, 'replay returns the recorded booking');
  const mine = await repo.listMyBookings();
  assert.equal(mine.filter((b) => b.id === first.id).length, 1, 'no duplicate created');
});

test('listMyBookings returns the seeded completed booking plus created ones', async () => {
  const mine = await repo.listMyBookings();
  assert.equal(mine.length, 1, 'seeded completed booking on first load');
  const seed = mine[0];
  assert.equal(seed.id, SEED_TRAVEL_BOOKING_ID);
  assert.equal(seed.status, 'completed');
  assert.equal(seed.passengers, 2);
  assert.ok(Number.isInteger(seed.totalTZS) && seed.totalTZS > 0);
  assert.equal(seed.originCityName, 'Dar es Salaam');
  assert.equal(seed.destinationCityName, 'Mwanza');

  const day = addDays(new Date(), 2);
  const [option] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_arusha', date: localDay(day), mode: 'flight' });
  await repo.book({ travelOptionId: option.id, passengers: 1, contactPhone: '+255712345678' }, 'key-book');
  const after = await repo.listMyBookings();
  assert.equal(after.length, 2);
  assert.equal(after[0].status, 'pending_payment', 'newest booking first');
  assert.equal(after[1].id, SEED_TRAVEL_BOOKING_ID);
  assert.equal(after[0].totalTZS, option.priceTZS * 1, 'flight priced per passenger');
});

test('search returns the TAZARA-style train for mode train on the seeded Dar→Dodoma leg', async () => {
  const day = addDays(new Date(), 4);
  const trains = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day), mode: 'train' });
  assert.equal(trains.length, 1, 'the train mode filter returns the seeded sleeper');
  const train = trains[0];
  assert.equal(train.id, 'topt_dar_dodoma_train');
  assert.equal(train.mode, 'train');
  assert.equal(train.provider, 'TAZARA Railway');
  assert.equal(train.originCityId, 'city_dar');
  assert.equal(train.destinationCityId, 'city_dodoma');
  assert.equal(train.originCityName, 'Dar es Salaam');
  assert.equal(train.destinationCityName, 'Dodoma');
  assert.ok(Number.isInteger(train.priceTZS) && train.priceTZS > 0, 'integer TZS price');
  assert.equal(train.seatsAvailable, 24);
  assert.ok(sameLocalDay(train.departureAt, day), 'departure falls on the requested local day');
  const dep = new Date(train.departureAt);
  assert.equal(dep.getHours() * 60 + dep.getMinutes(), 780, 'sleeper departs 13:00 local every day');
  assert.equal(Date.parse(train.arrivalAt) - Date.parse(train.departureAt), 660 * 60_000, 'fixed 11h sleeper journey');
});

test('booking a train option works — total = price × passengers (integer TZS), pending_payment', async () => {
  const day = addDays(new Date(), 4);
  const [train] = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day), mode: 'train' });
  const booking = await repo.book({ travelOptionId: train.id, passengers: 3, contactPhone: '+255712345678' }, 'key-train-book');
  assert.equal(booking.travelOptionId, train.id);
  assert.equal(booking.mode, 'train');
  assert.equal(booking.totalTZS, train.priceTZS * 3, 'total = price × passengers');
  assert.ok(Number.isInteger(booking.totalTZS));
  assert.equal(booking.status, 'pending_payment');
  assert.equal(booking.passengers, 3);
  assert.equal(booking.originCityName, 'Dar es Salaam');
  assert.equal(booking.destinationCityName, 'Dodoma');
  assert.equal(booking.departureAt, train.departureAt, 'the booked departure is the exact one shown in search');
  const mine = await repo.listMyBookings();
  assert.equal(mine[0].id, booking.id, 'train booking lands in My bookings, newest first');
  assert.equal(mine[0].mode, 'train');
});

test('the mode filter isolates train from bus on the shared Dar→Dodoma leg', async () => {
  const day = addDays(new Date(), 3);
  const all = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day) });
  assert.deepEqual(all.map((o) => o.mode).sort(), ['bus', 'train'], 'unfiltered search returns bus + train');
  const buses = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day), mode: 'bus' });
  assert.deepEqual(buses.map((o) => o.mode), ['bus']);
  const trains = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day), mode: 'train' });
  assert.deepEqual(trains.map((o) => o.mode), ['train']);
  const ferries = await repo.search({ originCityId: 'city_dar', destinationCityId: 'city_dodoma', date: localDay(day), mode: 'ferry' });
  assert.equal(ferries.length, 0, 'no ferry on the Dar→Dodoma leg');
});
