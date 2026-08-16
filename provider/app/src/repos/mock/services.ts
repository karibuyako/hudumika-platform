/* In-memory provider services repository. Mirrors GET/POST /providers/me/services,
 * PATCH/DELETE /providers/me/services/{serviceId} and
 * GET /providers/me/services/{serviceId}/estimate against module state in
 * mockState.ts.
 *
 * Estimates are fixed integer ranges (lowTZS 20000 / highTZS 35000 / tripFeeTZS
 * 5000 / 60 minutes) for any known service; unknown serviceIds throw 404
 * ESTIMATE_UNAVAILABLE. Removing a service still referenced by a booking throws
 * 409 SERVICE_IN_USE.
 */
import { ApiError } from '@/api/client';
import { getState, clone, estimateForService } from './mockState';
import { uid } from '@/lib/format';
import type { ServicesRepository } from '../index';
import type { BookingEstimate, ProviderService } from '@hudumika/contract';

export class MockServicesRepository implements ServicesRepository {
  async list(): Promise<ProviderService[]> {
    return clone(getState().services);
  }

  async create(input: ProviderService): Promise<ProviderService> {
    const state = getState();
    // CERTIFICATION_EXPIRED listing gate: an expired certification for the
    // service's trade blocks the listing until it is renewed (re-enters pending).
    const trade = (input.trade ?? '').toLowerCase();
    if (trade) {
      const expired = state.certifications.some(
        (c) => c.status === 'expired' && c.type.toLowerCase().includes(trade),
      );
      if (expired) {
        throw new ApiError(422, 'CERTIFICATION_EXPIRED', `An expired certification blocks ${trade} listings until renewed`);
      }
    }
    const service: ProviderService = {
      ...clone(input),
      id: uid('srv'),
      active: input.active ?? true,
      createdAt: new Date().toISOString(),
    };
    state.services.push(service);
    return clone(service);
  }

  async update(serviceId: string, input: Partial<ProviderService>): Promise<ProviderService> {
    const state = getState();
    const service = state.services.find((s) => s.id === serviceId);
    if (!service) throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service ${serviceId} not found`);
    Object.assign(service, clone(input), { id: serviceId });
    return clone(service);
  }

  async remove(serviceId: string): Promise<void> {
    const state = getState();
    const index = state.services.findIndex((s) => s.id === serviceId);
    if (index < 0) throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service ${serviceId} not found`);
    if (state.bookings.some((b) => b.serviceId === serviceId)) {
      throw new ApiError(409, 'SERVICE_IN_USE', 'Service is referenced by an existing booking');
    }
    state.services.splice(index, 1);
  }

  async getEstimate(serviceId: string, _area?: string): Promise<BookingEstimate> {
    return clone(estimateForService(serviceId));
  }
}
