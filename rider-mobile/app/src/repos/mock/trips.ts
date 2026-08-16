/* In-memory batch-trips repository (P10c). Mirrors GET /riders/me/trips,
 * GET /riders/me/trips/{tripId}, POST /riders/me/trips/{tripId}/reorder.
 *
 * The trip is derived from the rider's live orders (buildTripFromState) so
 * stop statuses never drift from the order state machine; reorderStops()
 * persists the manual sequence. Completed trips stay retrievable via getTrip()
 * until resetMockState() — the trip.completed summary the rider saw is never
 * silently deleted.
 */
import { ApiError } from '@/api/client';
import { getState, clone, buildTripFromState } from './mockState';
import type { TripsRepository } from '../index';
import type { Trip } from '@hudumika/contract';

export const MOCK_TRIP_ID = 'trip_active';

export class MockTripsRepository implements TripsRepository {
  async getActiveTrip(): Promise<Trip | null> {
    const trip = buildTripFromState();
    return trip ? clone(trip) : null;
  }

  async getTrip(tripId: string): Promise<Trip> {
    const state = getState();
    buildTripFromState();
    if (tripId === MOCK_TRIP_ID) {
      const trip = buildTripFromState() ?? state.completedTrip;
      if (trip) return clone(trip);
    }
    throw new ApiError(404, 'TRIP_NOT_FOUND', `Trip ${tripId} not found`);
  }

  async reorderStops(tripId: string, orderIds: string[]): Promise<Trip> {
    const state = getState();
    const trip = buildTripFromState();
    if (tripId !== MOCK_TRIP_ID) {
      throw new ApiError(404, 'TRIP_NOT_FOUND', `Trip ${tripId} not found`);
    }
    if (!trip) {
      if (state.completedTrip) {
        throw new ApiError(409, 'TRIP_ALREADY_COMPLETED', `Trip ${tripId} is completed`);
      }
      throw new ApiError(404, 'TRIP_NOT_FOUND', `No active trip`);
    }
    const current = new Set(trip.orderIds);
    if (orderIds.length !== new Set(orderIds).size || orderIds.some((id) => !current.has(id))) {
      throw new ApiError(409, 'INVALID_TRIP_SEQUENCE', 'Stop sequence must be a duplicate-free subset of the trip orders');
    }
    state.tripSequence = orderIds;
    const updated = buildTripFromState();
    if (!updated) throw new ApiError(409, 'INVALID_TRIP_SEQUENCE', 'Stop sequence must be a duplicate-free subset of the trip orders');
    return clone(updated);
  }
}