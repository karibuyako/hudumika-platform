/* In-memory bike/e-bike repository — Meituan bike flow:
 * Map → Nearby bikes → Select bike → Scan QR/Bluetooth unlock → Ride →
 * Temporary lock → Finish → Lock → Geofence → Fare → Payment → History
 *
 * Bikes are seeded around Dar es Salaam (mockState.customerLocation).
 * One active ride at a time; finishing computes fare from duration +
 * unlock fee + geofence surcharge, then moves to history.
 * Money is integer TZS.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, nowIso } from './mockState';
import { haversineKm } from '@/lib/geolocation';
import {
  BIKE_PER_MINUTE_TZS,
  BIKE_UNLOCK_FEE_TZS,
  EBIKE_PER_MINUTE_TZS,
  GEOFENCE_CENTER,
  GEOFENCE_RADIUS_KM,
  GEOFENCE_SURCHARGE_TZS,
} from '@/lib/bike';
import type { Bike, BikeRide, BikeRepository } from '../index';

/** Seeded bikes around Dar (offsets in degrees, ~1km ≈ 0.009°). */
const SEED_BIKES: Bike[] = [
  { id: 'bike_001', code: 'BK-8F3K-4D2A', type: 'bike', status: 'available', lat: -6.789, lon: 39.21, pricePerMinuteTZS: BIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_002', code: 'BK-7QW2-Z9P1', type: 'ebike', status: 'available', lat: -6.785, lon: 39.205, batteryPct: 87, pricePerMinuteTZS: EBIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_003', code: 'BK-M4RT-6X3C', type: 'bike', status: 'available', lat: -6.795, lon: 39.215, pricePerMinuteTZS: BIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_004', code: 'BK-K2VL-8N5E', type: 'ebike', status: 'available', lat: -6.792, lon: 39.198, batteryPct: 62, pricePerMinuteTZS: EBIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_005', code: 'BK-Q7JA-1H8U', type: 'bike', status: 'available', lat: -6.8, lon: 39.208, pricePerMinuteTZS: BIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_006', code: 'BK-T2NB-9K4P', type: 'ebike', status: 'available', lat: -6.788, lon: 39.22, batteryPct: 45, pricePerMinuteTZS: EBIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_007', code: 'BK-R9LC-3M7Y', type: 'bike', status: 'available', lat: -6.798, lon: 39.2, pricePerMinuteTZS: BIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
  { id: 'bike_008', code: 'BK-PL4K-2N8Q', type: 'bike', status: 'disabled', lat: -6.79, lon: 39.195, pricePerMinuteTZS: BIKE_PER_MINUTE_TZS, unlockFeeTZS: BIKE_UNLOCK_FEE_TZS },
];

let bikes: Bike[] = clone(SEED_BIKES);
let activeRide: BikeRide | null = null;
let history: BikeRide[] = [];

const unlockReplays = new Map<string, BikeRide>();
const finishReplays = new Map<string, BikeRide>();
const lockReplays = new Map<string, BikeRide>();
const payReplays = new Map<string, BikeRide>();

/** Reset between tests — mirrors mockState.resetMockState() coverage. */
export function resetMockBikeState(): void {
  bikes = clone(SEED_BIKES);
  activeRide = null;
  history = [];
  unlockReplays.clear();
  finishReplays.clear();
  lockReplays.clear();
  payReplays.clear();
  // Seed one completed ride so history is not empty on first load.
  const completed: BikeRide = {
    id: 'ride_seed_001',
    bikeId: 'bike_001',
    bikeCode: 'BK-8F3K-4D2A',
    bikeType: 'bike',
    status: 'completed',
    lockStatus: 'locked',
    startAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    endAt: new Date(Date.now() - 2 * 3600_000 + 18 * 60_000).toISOString(),
    startLat: -6.789,
    startLon: 39.21,
    endLat: -6.7924,
    endLon: 39.2083,
    durationMinutes: 18,
    distanceKm: 2.4,
    fareTZS: BIKE_UNLOCK_FEE_TZS + 18 * BIKE_PER_MINUTE_TZS,
    fareBreakdown: { unlockFeeTZS: BIKE_UNLOCK_FEE_TZS, rideFeeTZS: 18 * BIKE_PER_MINUTE_TZS, geofenceSurchargeTZS: 0, totalTZS: BIKE_UNLOCK_FEE_TZS + 18 * BIKE_PER_MINUTE_TZS },
    geofenceViolation: false,
    paymentStatus: 'paid',
    paymentMethod: 'wallet',
  };
  history.push(completed);
}

function ensureSeedHistory(): void {
  if (history.length === 0) resetMockBikeState();
}

function findBike(bikeId: string): Bike {
  const bike = bikes.find((b) => b.id === bikeId);
  if (!bike) throw new ApiError(404, 'BIKE_NOT_FOUND', `Bike ${bikeId} not found`);
  return bike;
}

function findBikeByCode(code: string): Bike {
  const bike = bikes.find((b) => b.code === code || b.id === code);
  if (!bike) throw new ApiError(404, 'BIKE_NOT_FOUND', `Bike code ${code} not found`);
  return bike;
}

function fareFor(bikeType: Bike['type'], durationMinutes: number, geofenceViolation: boolean) {
  const perMinute = bikeType === 'ebike' ? EBIKE_PER_MINUTE_TZS : BIKE_PER_MINUTE_TZS;
  const rideFeeTZS = durationMinutes * perMinute;
  const geofenceSurchargeTZS = geofenceViolation ? GEOFENCE_SURCHARGE_TZS : 0;
  const totalTZS = BIKE_UNLOCK_FEE_TZS + rideFeeTZS + geofenceSurchargeTZS;
  return { unlockFeeTZS: BIKE_UNLOCK_FEE_TZS, rideFeeTZS, geofenceSurchargeTZS, totalTZS };
}

export class MockBikeRepository implements BikeRepository {
  async listNearby(params?: { lat?: number; lon?: number; radiusKm?: number }): Promise<Bike[]> {
    ensureSeedHistory();
    const lat = params?.lat ?? GEOFENCE_CENTER.lat;
    const lon = params?.lon ?? GEOFENCE_CENTER.lon;
    const radiusKm = params?.radiusKm ?? GEOFENCE_RADIUS_KM * 2;
    const withDistance = bikes
      .filter((b) => b.status !== 'disabled')
      .map((b) => ({
        ...b,
        distanceM: Math.round(haversineKm(lat, lon, b.lat, b.lon) * 1000),
      }))
      .filter((b) => (b.distanceM ?? 0) <= radiusKm * 1000)
      .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
    return clone(withDistance);
  }

  async getBike(bikeId: string): Promise<Bike> {
    ensureSeedHistory();
    return clone(findBike(bikeId));
  }

  async getActiveRide(): Promise<BikeRide | null> {
    ensureSeedHistory();
    return clone(activeRide);
  }

  async unlock(input: { bikeId?: string; code?: string }, idempotencyKey: string): Promise<BikeRide> {
    ensureSeedHistory();
    const replay = unlockReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    if (activeRide) throw new ApiError(409, 'RIDE_ALREADY_ACTIVE', 'You already have an active ride — finish it first');
    let bike: Bike;
    if (input.code) bike = findBikeByCode(input.code);
    else if (input.bikeId) bike = findBike(input.bikeId);
    else throw new ApiError(422, 'VALIDATION_FAILED', 'Provide a bike id or QR code');
    if (bike.status !== 'available') throw new ApiError(409, 'BIKE_NOT_AVAILABLE', 'This bike is not available');
    if (bike.batteryPct !== undefined && bike.batteryPct < 10) throw new ApiError(409, 'BIKE_LOW_BATTERY', 'This e-bike battery is too low');
    bike.status = 'riding';
    const ride: BikeRide = {
      id: uid('ride'),
      bikeId: bike.id,
      bikeCode: bike.code,
      bikeType: bike.type,
      status: 'riding',
      lockStatus: 'unlocked',
      startAt: nowIso(),
      startLat: bike.lat,
      startLon: bike.lon,
      paymentStatus: 'pending',
    };
    activeRide = ride;
    unlockReplays.set(idempotencyKey, ride);
    return clone(ride);
  }

  async temporaryLock(rideId: string, idempotencyKey: string): Promise<BikeRide> {
    const replay = lockReplays.get(`lock_${idempotencyKey}`);
    if (replay) return clone(replay);
    if (!activeRide || activeRide.id !== rideId) throw new ApiError(404, 'RIDE_NOT_FOUND', 'Active ride not found');
    if (activeRide.status !== 'riding') throw new ApiError(409, 'RIDE_NOT_ACTIVE', 'Ride is not active');
    if (activeRide.lockStatus === 'locked') throw new ApiError(409, 'RIDE_ALREADY_LOCKED', 'Bike is already locked');
    activeRide.lockStatus = 'locked';
    activeRide.status = 'locked';
    const dto = clone(activeRide);
    lockReplays.set(`lock_${idempotencyKey}`, dto);
    return dto;
  }

  async temporaryUnlock(rideId: string, idempotencyKey: string): Promise<BikeRide> {
    const replay = lockReplays.get(`unlock_${idempotencyKey}`);
    if (replay) return clone(replay);
    if (!activeRide || activeRide.id !== rideId) throw new ApiError(404, 'RIDE_NOT_FOUND', 'Active ride not found');
    if (activeRide.lockStatus !== 'locked') throw new ApiError(409, 'RIDE_NOT_LOCKED', 'Bike is not locked');
    activeRide.lockStatus = 'unlocked';
    activeRide.status = 'riding';
    const dto = clone(activeRide);
    lockReplays.set(`unlock_${idempotencyKey}`, dto);
    return dto;
  }

  async finish(input: { rideId: string; lat: number; lon: number }, idempotencyKey: string): Promise<BikeRide> {
    const replay = finishReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    if (!activeRide || activeRide.id !== input.rideId) throw new ApiError(404, 'RIDE_NOT_FOUND', 'Active ride not found');
    if (activeRide.status === 'completed') throw new ApiError(409, 'RIDE_ALREADY_COMPLETED', 'Ride already completed');
    const bike = findBike(activeRide.bikeId);
    // Geofence: outside allowed radius → violation + surcharge.
    const distFromCenter = haversineKm(input.lat, input.lon, GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lon);
    const geofenceViolation = distFromCenter > GEOFENCE_RADIUS_KM;
    const durationMinutes = Math.max(1, Math.round((Date.now() - Date.parse(activeRide.startAt)) / 60000));
    const distanceKm = Number(haversineKm(activeRide.startLat, activeRide.startLon, input.lat, input.lon).toFixed(2));
    const breakdown = fareFor(activeRide.bikeType, durationMinutes, geofenceViolation);
    const completed: BikeRide = {
      ...activeRide,
      status: 'completed',
      lockStatus: 'locked',
      endAt: nowIso(),
      endLat: input.lat,
      endLon: input.lon,
      durationMinutes,
      distanceKm,
      fareTZS: breakdown.totalTZS,
      fareBreakdown: breakdown,
      geofenceViolation,
      paymentStatus: 'pending',
    };
    // Return bike to fleet — update its position to where it was left.
    bike.lat = input.lat;
    bike.lon = input.lon;
    bike.status = geofenceViolation ? 'disabled' : 'available';
    history.unshift(completed);
    activeRide = null;
    finishReplays.set(idempotencyKey, completed);
    return clone(completed);
  }

  async pay(rideId: string, method: string, idempotencyKey: string): Promise<BikeRide> {
    const replay = payReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const ride = history.find((r) => r.id === rideId);
    if (!ride) throw new ApiError(404, 'RIDE_NOT_FOUND', 'Ride not found');
    if (ride.paymentStatus === 'paid') throw new ApiError(409, 'RIDE_ALREADY_PAID', 'Ride already paid');
    if (!ride.fareTZS) throw new ApiError(409, 'RIDE_NOT_COMPLETED', 'Ride fare not ready');
    ride.paymentStatus = 'paid';
    ride.paymentMethod = method;
    const dto = clone(ride);
    payReplays.set(idempotencyKey, dto);
    return dto;
  }

  async listHistory(): Promise<BikeRide[]> {
    ensureSeedHistory();
    return clone(history);
  }

  async getRide(rideId: string): Promise<BikeRide> {
    ensureSeedHistory();
    if (activeRide?.id === rideId) return clone(activeRide);
    const ride = history.find((r) => r.id === rideId);
    if (!ride) throw new ApiError(404, 'RIDE_NOT_FOUND', 'Ride not found');
    return clone(ride);
  }
}
