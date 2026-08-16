/* Live API services repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/services               → ProviderService[]
 *   POST /providers/me/services               → ProviderService
 *   PATCH /providers/me/services/{serviceId}  → ProviderService
 *   DELETE /providers/me/services/{serviceId} → 204
 *   GET  /bookings/estimate?serviceId&area    → BookingEstimate
 */
import { api } from '@/api/client';
import type { ServicesRepository } from '../index';
import type { BookingEstimate, ProviderService } from '@hudumika/contract';

export class ApiServicesRepository implements ServicesRepository {
  async list(): Promise<ProviderService[]> {
    return api.get<ProviderService[]>('/providers/me/services');
  }

  async create(input: ProviderService): Promise<ProviderService> {
    return api.post<ProviderService>('/providers/me/services', input);
  }

  async update(serviceId: string, input: Partial<ProviderService>): Promise<ProviderService> {
    return api.patch<ProviderService>(`/providers/me/services/${serviceId}`, input);
  }

  async remove(serviceId: string): Promise<void> {
    await api.delete<void>(`/providers/me/services/${serviceId}`);
  }

  async getEstimate(serviceId: string, area?: string): Promise<BookingEstimate> {
    const qs = [`serviceId=${encodeURIComponent(serviceId)}`, area ? `area=${encodeURIComponent(area)}` : '']
      .filter(Boolean)
      .join('&');
    return api.get<BookingEstimate>(`/bookings/estimate?${qs}`);
  }
}
