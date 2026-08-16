/* In-memory travel repository — GET /travel/options (search), POST
 * /travel/bookings (idempotent per key), GET /travel/bookings/me.
 *
 * The schedule is a deterministic daily-repeating seed between the mock
 * cities (mockState.ts stays untouched): every route departs at a fixed
 * local offset from midnight of the REQUESTED date (search derives the exact
 * departure/arrival timestamps for that day). Search issues concrete
 * departures into a module-local registry, and book() resolves the option id
 * against that registry — so a booking always records the exact departure the
 * user saw, and a never-issued id is a 404. Money is integer TZS.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import type { TravelBooking, TravelOption, TravelOptionMode } from '@hudumika/contract';
import type { TravelRepository } from '../index';

const MAX_PASSENGERS = 20;

/** Mock-only until the contract adds 'train' to TravelOptionMode
 * (packages/contract/src/generated/model/travelOptionMode.ts still ships
 * bus | ferry | flight — OPERATIONS-COVERAGE #59/#60): the mock accepts and
 * serves train departures, casting them into the contract type at the
 * boundary (the runtime value 'train' survives the cast). The live API repo
 * passes the mode through as a query string value; nothing is added to the
 * contract. */
type TravelOptionModeMock = TravelOptionMode | 'train';

/** Module-local seeded completed booking id — the bookings list has content
 * on first load (same pattern as mock/reviews.ts seed ids). */
export const SEED_TRAVEL_BOOKING_ID = 'tb_seed_001';

interface SeedRoute {
  id: string;
  mode: TravelOptionModeMock;
  provider: string;
  originCityId: string;
  destinationCityId: string;
  /** Departure offset in minutes after local midnight of the requested date. */
  departMinutes: number;
  /** Trip length in minutes (arrival = departure + duration). */
  durationMinutes: number;
  priceTZS: number;
  seatsAvailable: number;
}

/* Fixed daily schedule between the seeded cities (city_dar/city_mwanza/
 * city_arusha/city_dodoma — see mockState.buildCities). Times are local. */
const SEED_ROUTES: SeedRoute[] = [
  { id: 'topt_dar_mwanza_bus', mode: 'bus', provider: 'Kampala Coach', originCityId: 'city_dar', destinationCityId: 'city_mwanza', departMinutes: 360, durationMinutes: 810, priceTZS: 45000, seatsAvailable: 32 },
  { id: 'topt_dar_mwanza_ferry', mode: 'ferry', provider: 'MV Victoria', originCityId: 'city_dar', destinationCityId: 'city_mwanza', departMinutes: 540, durationMinutes: 480, priceTZS: 35000, seatsAvailable: 60 },
  { id: 'topt_dar_arusha_bus', mode: 'bus', provider: 'Kilimanjaro Express', originCityId: 'city_dar', destinationCityId: 'city_arusha', departMinutes: 450, durationMinutes: 540, priceTZS: 40000, seatsAvailable: 28 },
  { id: 'topt_dar_arusha_flight', mode: 'flight', provider: 'AirTZ Connect', originCityId: 'city_dar', destinationCityId: 'city_arusha', departMinutes: 615, durationMinutes: 80, priceTZS: 165000, seatsAvailable: 12 },
  { id: 'topt_dar_dodoma_bus', mode: 'bus', provider: 'Central Shuttle', originCityId: 'city_dar', destinationCityId: 'city_dodoma', departMinutes: 480, durationMinutes: 360, priceTZS: 28000, seatsAvailable: 40 },
  /* TAZARA-style sleeper on the Dar→Dodoma leg (SGR corridor): overnight
   * departure, ~11h journey. Mode 'train' is a mock-only extension until the
   * contract ships the value (see TravelOptionModeMock above). */
  { id: 'topt_dar_dodoma_train', mode: 'train', provider: 'TAZARA Railway', originCityId: 'city_dar', destinationCityId: 'city_dodoma', departMinutes: 780, durationMinutes: 660, priceTZS: 65000, seatsAvailable: 24 },
];

/** The server's issued departures (id → concrete instance for a date). Search
 * fills it; book() resolves against it. Reset between tests like the rest of
 * the module-local state. */
const issuedOptions = new Map<string, TravelOption>();
const bookingReplays = new Map<string, TravelBooking>();
/** Created bookings, newest first; the seeded completed booking sits at the end. */
const travelBookings: TravelBooking[] = [];

export function resetMockTravelState(): void {
  issuedOptions.clear();
  bookingReplays.clear();
  travelBookings.length = 0;
}

function cityName(cityId: string): string | undefined {
  return getState().cities.find((c) => c.id === cityId)?.name;
}

/** Parse a YYYY-MM-DD param as a LOCAL calendar day (null → malformed;
 * rejects out-of-range parts and Date rollovers like 2026-13-40). */
function parseDateParam(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed;
}

/** The route's concrete departure for a local day: fixed offset from local
 * midnight, serialized as UTC ISO 8601 (clients render local time). */
function optionFor(route: SeedRoute, day: Date): TravelOption {
  const base = day.getTime() + route.departMinutes * 60_000;
  return {
    id: route.id,
    // Mock-only cast (see TravelOptionModeMock): the runtime 'train' value
    // survives; the contract type cannot express it until the enum grows.
    mode: route.mode as TravelOptionMode,
    provider: route.provider,
    originCityId: route.originCityId,
    originCityName: cityName(route.originCityId),
    destinationCityId: route.destinationCityId,
    destinationCityName: cityName(route.destinationCityId),
    departureAt: new Date(base).toISOString(),
    arrivalAt: new Date(base + route.durationMinutes * 60_000).toISOString(),
    priceTZS: route.priceTZS,
    seatsAvailable: route.seatsAvailable,
  };
}

/** Module-local seed (mockState.ts stays untouched, mirroring mock/reviews.ts
 * ensureSeeds): one completed intercity booking for the demo customer so the
 * My bookings screen renders content on first load. Idempotent across
 * resetMockTravelState(). */
function ensureSeeds(): void {
  if (travelBookings.some((b) => b.id === SEED_TRAVEL_BOOKING_ID)) return;
  const day = new Date();
  day.setDate(day.getDate() - 10);
  const option = optionFor(SEED_ROUTES[0], day);
  travelBookings.push({
    id: SEED_TRAVEL_BOOKING_ID,
    travelOptionId: option.id,
    mode: option.mode,
    originCityName: option.originCityName,
    destinationCityName: option.destinationCityName,
    departureAt: option.departureAt,
    passengers: 2,
    contactPhone: '+255700000000',
    totalTZS: option.priceTZS * 2,
    status: 'completed',
    createdAt: option.departureAt,
  });
}

export class MockTravelRepository implements TravelRepository {
  async search(params: { originCityId: string; destinationCityId: string; date: string; mode?: TravelOptionModeMock }): Promise<TravelOption[]> {
    const day = parseDateParam(params.date);
    if (!day) throw new ApiError(422, 'VALIDATION_FAILED', 'Travel date must be a YYYY-MM-DD local day');
    const matches = SEED_ROUTES.filter(
      (r) =>
        r.originCityId === params.originCityId &&
        r.destinationCityId === params.destinationCityId &&
        (params.mode === undefined || r.mode === params.mode),
    ).map((r) => optionFor(r, day));
    for (const option of matches) issuedOptions.set(option.id, option);
    return clone(matches);
  }

  async book(input: { travelOptionId: string; passengers: number; contactPhone: string }, idempotencyKey: string): Promise<TravelBooking> {
    // Same key replays the recorded booking — even if the departure has since
    // gone, the booking stands (a retry must never double-book).
    const replay = bookingReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const option = issuedOptions.get(input.travelOptionId);
    if (!option) throw new ApiError(404, 'NOT_FOUND', 'Travel option not found');
    if (!Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > MAX_PASSENGERS) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Passengers must be between 1 and ${MAX_PASSENGERS}`);
    }
    if (Date.parse(option.departureAt) <= Date.now()) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'This departure has already left — search for a later date');
    }
    if (input.passengers > option.seatsAvailable) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Only ${option.seatsAvailable} seat${option.seatsAvailable === 1 ? '' : 's'} left on this departure`);
    }
    const contactPhone = input.contactPhone.trim();
    if (!contactPhone || contactPhone.length > 20) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'A valid contact phone is required');
    }
    const booking: TravelBooking = {
      id: uid('tb'),
      travelOptionId: option.id,
      mode: option.mode,
      originCityName: option.originCityName,
      destinationCityName: option.destinationCityName,
      departureAt: option.departureAt,
      passengers: input.passengers,
      contactPhone,
      // The server is the price authority: total = unit price × passengers.
      totalTZS: option.priceTZS * input.passengers,
      status: 'pending_payment',
      createdAt: nowIso(),
    };
    travelBookings.unshift(booking);
    bookingReplays.set(idempotencyKey, booking);
    return clone(booking);
  }

  async listMyBookings(): Promise<TravelBooking[]> {
    ensureSeeds();
    return clone(travelBookings);
  }
}
