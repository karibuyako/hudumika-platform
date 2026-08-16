/* In-memory events repository — GET /entertainment/events (cursor
 * pagination + cityId/category filters), GET /entertainment/events/{eventId},
 * POST /entertainment/event-tickets (idempotent purchase, EV-XXXX codes),
 * GET /entertainment/event-tickets/me.
 *
 * Seeds are module-local (mockState.ts stays untouched, same pattern as
 * reviews.ts) and rebuilt idempotently across resetMockState(), so the list
 * and My Tickets have content on first load. Money is integer TZS; totals
 * are always tier price × quantity, never floats.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState } from './mockState';
import type { EventDetail, EventListing, EventTicket, EventTier } from '@hudumika/contract';
import type { EventsRepository } from '../index';

const PURCHASE_MAX_QUANTITY = 10;

/** Event seed as the server would store it — the listing plus detail extras
 * (description, tiers). Tickets issued by purchase and the idempotency-key
 * ledger also live here so resetMockState() never wipes them mid-session. */
type EventSeed = {
  event: EventListing;
  description: string;
  tiers: EventTier[];
};

let seeds: EventSeed[] | null = null;
let myTickets: EventTicket[] = [];
/** Idempotency-key → issued tickets (replay returns the same tickets without
 * decrementing remaining again). */
const purchases = new Map<string, EventTicket[]>();

/** Ticket code format EV-XXXX (EVENT-TICKETS.md; EventTicket.code). */
function ticketCode(): string {
  const block = (n: number) =>
    Array.from({ length: n }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
  return `EV-${block(4)}`;
}

function futureIso(days: number, hour = 19): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 30, 0, 0);
  return d.toISOString();
}

/** Seeded events — a Dar concert (music), a Dar theatre show (theatre) and a
 * Mwanza food festival (festival); city ids come from the seeded cities
 * (mockState buildCities), tiers are 2–3 each with integer priceTZS.
 * startingPriceTZS is the cheapest tier price (the server derives it). */
function buildSeeds(): EventSeed[] {
  const cityName = (id: string) => getState().cities.find((c) => c.id === id)?.name ?? id;
  const mkEvent = (id: string, title: string, cityId: string, category: string, venue: string, days: number, description: string, tiers: EventTier[]): EventSeed => ({
    event: {
      id,
      title,
      cityId,
      cityName: cityName(cityId),
      category,
      venue,
      startsAt: futureIso(days),
      imageUrl: null,
      startingPriceTZS: Math.min(...tiers.map((t) => t.priceTZS)),
    },
    description,
    tiers,
  });
  return [
    mkEvent(
      'evt_concert_001',
      'Sauti za Bongo Night',
      'city_dar',
      'music',
      'Uhuru Stadium, Dar es Salaam',
      12,
      'A night of live bongo flava and taarab headliners under the stars. Doors open at 17:30; show starts at 19:30. Food and drinks available inside the arena.',
      [
        { id: 'tier_concert_regular', name: 'Regular', priceTZS: 30000, available: true, remaining: 240 },
        { id: 'tier_concert_vip', name: 'VIP', priceTZS: 80000, available: true, remaining: 60 },
        { id: 'tier_concert_vvip', name: 'VVIP', priceTZS: 150000, available: true, remaining: 20 },
      ],
    ),
    mkEvent(
      'evt_theatre_001',
      'Tamthilia ya Kiswahili',
      'city_dar',
      'theatre',
      'Little Theatre, Oyster Bay',
      20,
      'A critically acclaimed Swahili play about life in the city — comedy, drama and song. Suitable for ages 12 and up.',
      [
        { id: 'tier_theatre_standard', name: 'Standard', priceTZS: 15000, available: true, remaining: 120 },
        { id: 'tier_theatre_front', name: 'Front row', priceTZS: 25000, available: true, remaining: 40 },
      ],
    ),
    mkEvent(
      'evt_festival_001',
      'Karibu Food Festival',
      'city_mwanza',
      'festival',
      'Kirumba Stadium, Mwanza',
      30,
      'A weekend of Tanzanian street food, live bands and family activities on the shores of Lake Victoria.',
      [
        { id: 'tier_festival_day', name: 'Day pass', priceTZS: 10000, available: true, remaining: 500 },
        { id: 'tier_festival_weekend', name: 'Weekend pass', priceTZS: 25000, available: true, remaining: 200 },
      ],
    ),
  ];
}

/** Idempotent seed install — runs once per module lifetime; resetMockEventsState()
 * clears it so tests start pristine. */
function ensureSeeds(): void {
  if (seeds) return;
  seeds = buildSeeds();
  myTickets = [
    {
      id: 'tkt_seed_used_001',
      eventId: 'evt_concert_001',
      eventTitle: 'Sauti za Bongo Night',
      venue: 'Uhuru Stadium, Dar es Salaam',
      startsAt: futureIso(5),
      tierName: 'Regular',
      priceTZS: 30000,
      code: 'EV-9K2M',
      status: 'used',
    },
  ];
}

/** Test-only: restore the pristine seed (mirrors resetMockRedPacketState). */
export function resetMockEventsState(): void {
  seeds = null;
  myTickets = [];
  purchases.clear();
}

/** Test-only: set a tier's remaining count (mirrors expireRedPacketForTests
 * in redPackets.ts). */
export function setEventTierRemainingForTests(eventId: string, tierId: string, remaining: number): void {
  ensureSeeds();
  const seed = (seeds ?? []).find((s) => s.event.id === eventId);
  const tier = seed?.tiers.find((t) => t.id === tierId);
  if (!seed || !tier) throw new ApiError(404, 'NOT_FOUND', 'Event or tier not found');
  tier.remaining = remaining;
  tier.available = remaining > 0;
}

export class MockEventsRepository implements EventsRepository {
  async list(params?: { cityId?: string; category?: string; cursor?: string; limit?: number }): Promise<{ results: EventListing[]; nextCursor: string | null }> {
    ensureSeeds();
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    const filtered = (seeds ?? []).filter(
      (s) =>
        (!params?.cityId || s.event.cityId === params.cityId) &&
        (!params?.category || s.event.category === params.category),
    );
    const page = filtered.slice(offset, offset + limit);
    const nextCursor = offset + page.length < filtered.length ? String(offset + page.length) : null;
    return { results: clone(page.map((s) => s.event)), nextCursor };
  }

  async get(eventId: string): Promise<EventDetail> {
    ensureSeeds();
    const seed = (seeds ?? []).find((s) => s.event.id === eventId);
    if (!seed) throw new ApiError(404, 'NOT_FOUND', 'Event not found');
    return clone({ event: seed.event, description: seed.description, tiers: seed.tiers });
  }

  async purchase(input: { eventId: string; tierId: string; quantity: number }, idempotencyKey: string): Promise<EventTicket[]> {
    ensureSeeds();
    // Idempotent replay: same key returns the originally issued tickets
    // without touching remaining counts again (PAYMENTS.md idempotency rule).
    const replay = purchases.get(idempotencyKey);
    if (replay) return clone(replay);
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > PURCHASE_MAX_QUANTITY) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Quantity must be between 1 and ${PURCHASE_MAX_QUANTITY}`);
    }
    const seed = (seeds ?? []).find((s) => s.event.id === input.eventId);
    if (!seed) throw new ApiError(404, 'NOT_FOUND', 'Event not found');
    const tier = seed.tiers.find((t) => t.id === input.tierId);
    if (!tier) throw new ApiError(404, 'NOT_FOUND', 'Ticket tier not found');
    if (!tier.available || (tier.remaining ?? 0) < input.quantity) {
      throw new ApiError(409, 'CONFLICT', 'Not enough tickets left in this tier');
    }
    const issued: EventTicket[] = Array.from({ length: input.quantity }, () => ({
      id: uid('tkt'),
      eventId: seed.event.id,
      eventTitle: seed.event.title,
      venue: seed.event.venue,
      startsAt: seed.event.startsAt,
      tierName: tier.name,
      priceTZS: tier.priceTZS,
      code: ticketCode(),
      status: 'active',
    }));
    tier.remaining = (tier.remaining ?? 0) - input.quantity;
    if (tier.remaining === 0) tier.available = false;
    myTickets.unshift(...issued);
    purchases.set(idempotencyKey, clone(issued));
    return clone(issued);
  }

  async listMyTickets(): Promise<EventTicket[]> {
    ensureSeeds();
    return clone(myTickets);
  }
}
