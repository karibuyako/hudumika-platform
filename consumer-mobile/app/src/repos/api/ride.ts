/* Live API ride repository — POST /rides (Idempotency-Key), GET /rides/me, GET /rides/{id}. */
import { api } from '@/api/client';
import type { Ride, RideCreateInput, RideEstimate, RideRepository, RideType } from '../index';

export class ApiRideRepository implements RideRepository {
  async estimate(input: { pickup: string; destination: string; rideType: RideType }): Promise<RideEstimate> {
    return api.post<RideEstimate>('/rides/estimate', input);
  }

  async create(input: RideCreateInput, idempotencyKey: string): Promise<Ride> {
    return api.post<Ride>('/rides', input, { idempotencyKey });
  }

  async get(rideId: string): Promise<Ride> {
    return api.get<Ride>(`/rides/${rideId}`);
  }

  async list(): Promise<Ride[]> {
    return api.get<Ride[]>('/rides/me');
  }

  async cancel(rideId: string, idempotencyKey: string): Promise<Ride> {
    return api.post<Ride>(`/rides/${rideId}/cancel`, {}, { idempotencyKey });
  }
}
