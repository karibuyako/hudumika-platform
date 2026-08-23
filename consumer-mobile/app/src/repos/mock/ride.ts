/* In-memory ride-hailing repository — Meituan ride flow.
 *
 * Current location → Destination → Ride type → Fare estimate → Confirm pickup
 * → Driver matching → Driver details → Arrival → Ride → Route tracking → Payment → Rating
 *
 * Mock-first until the contract ships the ride surface (POST /rides).
 * Fare is deterministic per input (no floats, integer TZS). Rides progress
 * through matching → matched → arriving → in_ride → completed via elapsed time
 * so the tracking screen can poll get() and see progression without extra mocks.
 * Idempotent per key: same idempotencyKey replays the stored ride.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, nowIso } from './mockState';
import type { Ride, RideCreateInput, RideDriver, RideEstimate, RideRepository, RideStatus, RideType } from '../index';

const RIDE_TYPES: RideType[] = ['express', 'premier', 'taxi'];

/** Base fare + per-km for each type (integer TZS). Premier is comfort premium. */
const FARE_TABLE: Record<RideType, { base: number; perKm: number }> = {
  express: { base: 3500, perKm: 900 },
  premier: { base: 6500, perKm: 1500 },
  taxi: { base: 5000, perKm: 1100 },
};

const DRIVERS: RideDriver[] = [
  { id: 'drv_001', name: 'Juma Hassan', phone: '+255712345678', plate: 'T 123 ABC', carModel: 'Toyota Corolla', carColor: 'White', rating: 4.8 },
  { id: 'drv_002', name: 'Asha Mwinyi', phone: '+255754987654', plate: 'T 456 DEF', carModel: 'Honda Fit', carColor: 'Silver', rating: 4.9 },
  { id: 'drv_003', name: 'Bakari Ali', phone: '+255767112233', plate: 'T 789 GHI', carModel: 'Suzuki Alto', carColor: 'Blue', rating: 4.7 },
];

/** In-memory rides, newest first. Module-local, like mock/travel bookings. */
const rides: Ride[] = [];
const rideReplays = new Map<string, Ride>();
const ridesById = new Map<string, Ride>();

export function resetMockRideState(): void {
  rides.length = 0;
  rideReplays.clear();
  ridesById.clear();
}

function hashDistanceKm(pickup: string, destination: string): number {
  const h = (pickup.length * 7 + destination.length * 11) % 11;
  return 2 + h + (pickup.charCodeAt(0) % 3); // 2–14 km deterministic
}

export function estimateFare(pickup: string, destination: string, rideType: RideType): RideEstimate {
  const distanceKm = hashDistanceKm(pickup, destination);
  const durationMin = Math.max(6, Math.round(distanceKm * 2.8 + 4));
  const table = FARE_TABLE[rideType];
  const fareTZS = table.base + Math.round(distanceKm * table.perKm);
  return { fareTZS, distanceKm, durationMin };
}

function pickDriver(rideId: string): RideDriver {
  const idx = parseInt(rideId.slice(-1), 36) % DRIVERS.length;
  return DRIVERS[idx] ?? DRIVERS[0];
}

/** Progress a ride's status based on elapsed ms since creation — so polling shows live movement. */
function progressedStatus(ride: Ride, elapsedMs: number): RideStatus {
  if (ride.status === 'cancelled' || ride.status === 'completed') return ride.status;
  if (elapsedMs < 3000) return 'matching';
  if (elapsedMs < 8000) return 'matched';
  if (elapsedMs < 14000) return 'arriving';
  if (elapsedMs < 24000) return 'in_ride';
  return 'completed';
}

function deriveEta(ride: Ride, status: RideStatus): number | undefined {
  if (status === 'matching') return 3;
  if (status === 'matched') return 5;
  if (status === 'arriving') return 2;
  if (status === 'in_ride') return ride.durationMin;
  return undefined;
}

function cloneRideWithProgress(stored: Ride): Ride {
  const elapsed = Date.now() - Date.parse(stored.createdAt);
  const status = progressedStatus(stored, elapsed);
  const ride: Ride = { ...stored, status, updatedAt: nowIso() };
  if ((status === 'matched' || status === 'arriving' || status === 'in_ride' || status === 'completed') && !ride.driver) {
    ride.driver = pickDriver(ride.id);
  }
  ride.etaMin = deriveEta(ride, status);
  return clone(ride);
}

export class MockRideRepository implements RideRepository {
  async estimate(input: { pickup: string; destination: string; rideType: RideType }): Promise<RideEstimate> {
    if (!input.pickup.trim() || !input.destination.trim()) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Pickup and destination are required');
    }
    if (!RIDE_TYPES.includes(input.rideType)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown ride type');
    }
    return estimateFare(input.pickup.trim(), input.destination.trim(), input.rideType);
  }

  async create(input: RideCreateInput, idempotencyKey: string): Promise<Ride> {
    const replay = rideReplays.get(idempotencyKey);
    if (replay) return cloneRideWithProgress(replay);
    const pickup = input.pickup.trim();
    const destination = input.destination.trim();
    if (!pickup) throw new ApiError(422, 'VALIDATION_FAILED', 'Pickup is required');
    if (!destination) throw new ApiError(422, 'VALIDATION_FAILED', 'Destination is required');
    if (pickup === destination) throw new ApiError(422, 'VALIDATION_FAILED', 'Pickup and destination must be different');
    if (!RIDE_TYPES.includes(input.rideType)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown ride type');
    }
    const est = estimateFare(pickup, destination, input.rideType);
    const ride: Ride = {
      id: uid('ride'),
      pickup,
      destination,
      pickupCoord: input.pickupCoord,
      destinationCoord: input.destinationCoord,
      rideType: input.rideType,
      fareTZS: est.fareTZS,
      distanceKm: est.distanceKm,
      durationMin: est.durationMin,
      status: 'matching',
      etaMin: 3,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    rides.unshift(ride);
    ridesById.set(ride.id, ride);
    rideReplays.set(idempotencyKey, ride);
    return cloneRideWithProgress(ride);
  }

  async get(rideId: string): Promise<Ride> {
    const ride = ridesById.get(rideId);
    if (!ride) throw new ApiError(404, 'RIDE_NOT_FOUND', `Ride ${rideId} not found`);
    return cloneRideWithProgress(ride);
  }

  async list(): Promise<Ride[]> {
    return clone(rides.map((r) => cloneRideWithProgress(r)));
  }

  async cancel(rideId: string, idempotencyKey: string): Promise<Ride> {
    const ride = ridesById.get(rideId);
    if (!ride) throw new ApiError(404, 'RIDE_NOT_FOUND', `Ride ${rideId} not found`);
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      throw new ApiError(409, 'RIDE_NOT_CANCELLABLE', 'Ride can no longer be cancelled');
    }
    if (rideReplays.has(`cancel_${idempotencyKey}`)) {
      return cloneRideWithProgress(ride);
    }
    ride.status = 'cancelled';
    ride.updatedAt = nowIso();
    ride.etaMin = undefined;
    rideReplays.set(`cancel_${idempotencyKey}`, ride);
    return clone(ride);
  }
}
