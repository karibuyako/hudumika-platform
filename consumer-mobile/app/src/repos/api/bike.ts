/* Live API bike repository — Meituan bike/e-bike rental.
 *
 * Endpoints are mock-only-until-adopted (no contract surface yet):
 *   GET  /bikes/nearby
 *   GET  /bikes/{id}
 *   POST /bikes/unlock
 *   POST /bikes/rides/{id}/lock
 *   POST /bikes/rides/{id}/unlock
 *   POST /bikes/rides/{id}/finish
 *   POST /bikes/rides/{id}/pay
 *   GET  /bikes/rides/me
 *   GET  /bikes/rides/{id}
 *   GET  /bikes/rides/active
 *
 * The live backend that has not shipped these paths 404s; the UI degrades to
 * its error/retry states (same pattern as travel, DineIn, etc.).
 */
import { api } from '@/api/client';
import type { Bike, BikeRepository, BikeRide } from '../index';

export class ApiBikeRepository implements BikeRepository {
  async listNearby(params?: { lat?: number; lon?: number; radiusKm?: number }): Promise<Bike[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    return api.get<Bike[]>(`/bikes/nearby${qs ? `?${qs}` : ''}`);
  }

  async getBike(bikeId: string): Promise<Bike> {
    return api.get<Bike>(`/bikes/${bikeId}`);
  }

  async getActiveRide(): Promise<BikeRide | null> {
    try {
      return await api.get<BikeRide | null>('/bikes/rides/active');
    } catch {
      return null;
    }
  }

  async unlock(input: { bikeId?: string; code?: string }, idempotencyKey: string): Promise<BikeRide> {
    return api.post<BikeRide>('/bikes/unlock', input, { idempotencyKey });
  }

  async temporaryLock(rideId: string, idempotencyKey: string): Promise<BikeRide> {
    return api.post<BikeRide>(`/bikes/rides/${rideId}/lock`, {}, { idempotencyKey });
  }

  async temporaryUnlock(rideId: string, idempotencyKey: string): Promise<BikeRide> {
    return api.post<BikeRide>(`/bikes/rides/${rideId}/unlock`, {}, { idempotencyKey });
  }

  async finish(input: { rideId: string; lat: number; lon: number }, idempotencyKey: string): Promise<BikeRide> {
    return api.post<BikeRide>(`/bikes/rides/${input.rideId}/finish`, { lat: input.lat, lon: input.lon }, { idempotencyKey });
  }

  async pay(rideId: string, method: string, idempotencyKey: string): Promise<BikeRide> {
    return api.post<BikeRide>(`/bikes/rides/${rideId}/pay`, { method }, { idempotencyKey });
  }

  async listHistory(): Promise<BikeRide[]> {
    return api.get<BikeRide[]>('/bikes/rides/me');
  }

  async getRide(rideId: string): Promise<BikeRide> {
    return api.get<BikeRide>(`/bikes/rides/${rideId}`);
  }
}
