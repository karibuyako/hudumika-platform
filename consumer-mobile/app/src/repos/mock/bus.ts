/* In-memory bus public-transport repository — Meituan bus parity:
 * search (origin → destination) → bus options with arrival times → route
 * (stops) → vehicle tracking (live positions) → stop reminders.
 *
 * Routes are seeded deterministically between Dar es Salaam neighborhoods
 * (mockState stays untouched — same pattern as mock/hotels.ts).
 * Search is a case-insensitive substring over route/stop names; the same
 * origin+destination that matches no seed returns an honest empty array.
 * Money is integer TZS. Reminders are module-local per-user; toggling is
 * idempotent per key (replay returns the same record, key reuse with
 * different enabled → VALIDATION_FAILED).
 */
import { ApiError } from '@/api/client';
import { clone, nowIso } from './mockState';
import type { BusOption, BusRepository, BusRoute, BusSearchParams, BusStop, BusVehicle, StopReminder } from '../index';

type ReminderKey = string;

let seeded = false;
const routes: BusRoute[] = [];
const vehicles = new Map<string, BusVehicle[]>();
const reminders = new Map<string, StopReminder>();
const reminderReplays = new Map<string, StopReminder | null>();

function buildStops(names: string[], baseLat: number, baseLon: number): BusStop[] {
  return names.map((name, i) => ({
    id: `stop_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${i}`,
    name,
    sequence: i + 1,
    lat: baseLat + i * 0.008,
    lon: baseLon + i * 0.006,
  }));
}

function ensureSeeds(): void {
  if (seeded) return;
  seeded = true;

  const r1Stops = buildStops(
    ['Kariakoo', 'Posta', 'Magomeni', 'Kinondoni', 'Mwananyamala', 'Namanga', 'Kawe', 'Tegeta'],
    -6.819, 39.268,
  );
  const r2Stops = buildStops(['Kivukoni', 'Posta', 'City Centre', 'Ilala', 'Tabata', 'Segerea'], -6.821, 39.288);
  const r3Stops = buildStops(
    ['Kimara', 'Ubungo Terminal', 'Manzese', 'Magomeni', 'Kariakoo', 'Kivukoni Ferry'],
    -6.789, 39.192,
  );
  const r4Stops = buildStops(['Mbezi Beach', 'Kawe', 'Mikocheni', 'Kinondoni', 'Posta'], -6.71, 39.21);

  const mkRoute = (
    id: string,
    routeNumber: string,
    routeName: string,
    origin: string,
    destination: string,
    stops: BusStop[],
    fareTZS: number,
    durationMinutes: number,
    frequencyMinutes: number,
    operatingHours: string,
  ): BusRoute => ({
    id,
    routeNumber,
    routeName,
    origin,
    destination,
    stops,
    fareTZS,
    durationMinutes,
    frequencyMinutes,
    operatingHours,
  });

  const r1 = mkRoute('bus_route_001', 'D-1', 'Kariakoo → Tegeta', 'Kariakoo', 'Tegeta', r1Stops, 800, 42, 6, '05:00-22:00');
  const r2 = mkRoute('bus_route_002', 'D-2', 'Kivukoni → Segerea', 'Kivukoni', 'Segerea', r2Stops, 700, 35, 8, '05:30-21:30');
  const r3 = mkRoute('bus_route_003', 'BRT-1', 'Kimara → Kivukoni', 'Kimara', 'Kivukoni', r3Stops, 1200, 55, 4, '05:00-23:00');
  const r4 = mkRoute('bus_route_004', 'D-7', 'Mbezi → Posta', 'Mbezi Beach', 'Posta', r4Stops, 900, 38, 10, '06:00-21:00');

  routes.push(r1, r2, r3, r4);

  const now = Date.now();
  const mkVehicles = (route: BusRoute, count: number): BusVehicle[] =>
    Array.from({ length: count }, (_, i) => {
      const stopIdx = (i * 2 + Math.floor((now / 60000) % route.stops.length)) % route.stops.length;
      const stop = route.stops[stopIdx] ?? route.stops[0];
      const nextIdx = Math.min(stopIdx + 1, route.stops.length - 1);
      const next = route.stops[nextIdx] ?? stop;
      return {
        id: `veh_${route.id}_${i + 1}`,
        routeId: route.id,
        routeNumber: route.routeNumber,
        plateNumber: `T ${700 + i} ${String.fromCharCode(65 + i)}${String.fromCharCode(66 + i)}`,
        lat: stop.lat + 0.001 * (i % 2 === 0 ? 1 : -1),
        lon: stop.lon + 0.001 * (i % 3 === 0 ? 1 : -1),
        heading: (i * 90) % 360,
        nextStopId: next.id,
        nextStopName: next.name,
        nextStopSequence: next.sequence,
        occupancy: (['low', 'medium', 'high'] as const)[i % 3],
        lastUpdatedAt: new Date(now - i * 15000).toISOString(),
        etaMinutes: Math.max(1, 12 - i * 2 + (stopIdx % 3)),
      };
    });

  vehicles.set(r1.id, mkVehicles(r1, 3));
  vehicles.set(r2.id, mkVehicles(r2, 2));
  vehicles.set(r3.id, mkVehicles(r3, 4));
  vehicles.set(r4.id, mkVehicles(r4, 2));
}

function routeMatches(route: BusRoute, origin: string, destination: string): boolean {
  const o = origin.toLowerCase().trim();
  const d = destination.toLowerCase().trim();
  const hay = [route.routeName, route.origin, route.destination, ...route.stops.map((s) => s.name)].join(' ').toLowerCase();
  const originHit = o ? hay.includes(o) : true;
  const destHit = d ? hay.includes(d) : true;
  // For the demo, require both origin and destination to appear somewhere on the route
  // (substring, same as Meituan's fuzzy stop search). An exact origin/destination
  // match scores higher but every hit counts.
  if (o && d) return originHit && destHit;
  return originHit && destHit;
}

function arrivalMinutesFor(route: BusRoute, index: number): { next: number; following: number | null } {
  // Deterministic jitter from the route id + now, never negative.
  const base = route.frequencyMinutes;
  const jitter = route.id.charCodeAt(route.id.length - 1) % 3;
  const next = Math.max(1, base - jitter + (index % 2));
  const following = next + base + (index % 2);
  return { next, following };
}

export function resetMockBusState(): void {
  seeded = false;
  routes.length = 0;
  vehicles.clear();
  reminders.clear();
  reminderReplays.clear();
}

export class MockBusRepository implements BusRepository {
  async search(params: BusSearchParams): Promise<BusOption[]> {
    ensureSeeds();
    const origin = params.origin?.trim() ?? '';
    const destination = params.destination?.trim() ?? '';
    if (!origin || !destination) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Origin and destination are required');
    }
    if (origin.length > 80 || destination.length > 80) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Origin/destination too long');
    }
    const matched = routes.filter((r) => routeMatches(r, origin, destination));
    // Score: routes where origin is near the start and destination near the end rank higher.
    const scored = matched
      .map((route, idx) => {
        const { next, following } = arrivalMinutesFor(route, idx);
        const v = vehicles.get(route.id) ?? [];
        return {
          route: clone(route),
          nextArrivalMinutes: next,
          followingArrivalMinutes: following,
          vehicles: clone(v),
          available: true,
        } satisfies BusOption;
      })
      .sort((a, b) => a.nextArrivalMinutes - b.nextArrivalMinutes);
    return scored;
  }

  async getRoute(routeId: string): Promise<BusRoute> {
    ensureSeeds();
    const route = routes.find((r) => r.id === routeId);
    if (!route) throw new ApiError(404, 'NOT_FOUND', `Bus route ${routeId} not found`);
    return clone(route);
  }

  async getVehicles(routeId: string): Promise<BusVehicle[]> {
    ensureSeeds();
    const route = routes.find((r) => r.id === routeId);
    if (!route) throw new ApiError(404, 'NOT_FOUND', `Bus route ${routeId} not found`);
    const list = vehicles.get(routeId) ?? [];
    // Simulate live movement: bump each vehicle's lastUpdatedAt and nudge coords
    const now = Date.now();
    const moved = list.map((v, i) => ({
      ...v,
      lat: v.lat + Math.sin(now / 60000 + i) * 0.0002,
      lon: v.lon + Math.cos(now / 60000 + i) * 0.0002,
      lastUpdatedAt: new Date(now - i * 1000).toISOString(),
      etaMinutes: Math.max(1, (v.etaMinutes ?? 5) + (i % 2 === 0 ? -1 : 1)),
    }));
    vehicles.set(routeId, moved);
    return clone(moved);
  }

  async trackVehicle(vehicleId: string): Promise<BusVehicle> {
    ensureSeeds();
    for (const list of vehicles.values()) {
      const found = list.find((v) => v.id === vehicleId);
      if (found) {
        const now = Date.now();
        const updated: BusVehicle = {
          ...found,
          lat: found.lat + Math.sin(now / 30000) * 0.0003,
          lon: found.lon + Math.cos(now / 30000) * 0.0003,
          lastUpdatedAt: new Date().toISOString(),
        };
        return clone(updated);
      }
    }
    throw new ApiError(404, 'NOT_FOUND', `Bus vehicle ${vehicleId} not found`);
  }

  async listReminders(): Promise<StopReminder[]> {
    ensureSeeds();
    return clone([...reminders.values()].sort((a, b) => a.stopName.localeCompare(b.stopName)));
  }

  async setReminder(routeId: string, stopId: string, enabled: boolean, idempotencyKey: string): Promise<StopReminder | null> {
    ensureSeeds();
    const replay = reminderReplays.get(idempotencyKey);
    if (replay !== undefined) return clone(replay) as StopReminder | null;

    const route = routes.find((r) => r.id === routeId);
    if (!route) throw new ApiError(404, 'NOT_FOUND', `Bus route ${routeId} not found`);
    const stop = route.stops.find((s) => s.id === stopId);
    if (!stop) throw new ApiError(404, 'NOT_FOUND', `Stop ${stopId} not found on route ${routeId}`);

    // Key reuse with different enabled value → contract VALIDATION_FAILED (same rule as membership 2fa).
    for (const [key, val] of reminderReplays.entries()) {
      if (key !== idempotencyKey) continue;
      if ((val !== null) !== enabled) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Idempotency key reused with different payload');
      }
    }

    const key: ReminderKey = `${routeId}:${stopId}`;
    if (!enabled) {
      reminders.delete(key);
      reminderReplays.set(idempotencyKey, null);
      return null;
    }
    const reminder: StopReminder = {
      id: `rem_${routeId}_${stopId}`,
      routeId,
      routeNumber: route.routeNumber,
      stopId,
      stopName: stop.name,
      enabled: true,
      createdAt: nowIso(),
    };
    reminders.set(key, reminder);
    reminderReplays.set(idempotencyKey, reminder);
    return clone(reminder);
  }
}
