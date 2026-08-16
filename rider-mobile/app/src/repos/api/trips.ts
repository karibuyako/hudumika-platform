/* Live API batch-trips repository (P10c). Thin typed wrapper over the
 * hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /riders/me/trips                     → Trip | 404 (no active trip)
 *   GET  /riders/me/trips/{tripId}            → Trip
 *   POST /riders/me/trips/{tripId}/reorder    {orderIds} → Trip | 409
 */
import { api, ApiError } from '@/api/client';
import type { TripsRepository } from '../index';
import type { Trip } from '@hudumika/contract';

export class ApiTripsRepository implements TripsRepository {
  async getActiveTrip(): Promise<Trip | null> {
    try {
      return await api.get<Trip>('/riders/me/trips');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async getTrip(tripId: string): Promise<Trip> {
    return api.get<Trip>(`/riders/me/trips/${tripId}`);
  }

  async reorderStops(tripId: string, orderIds: string[]): Promise<Trip> {
    return api.post<Trip>(`/riders/me/trips/${tripId}/reorder`, { orderIds });
  }
}