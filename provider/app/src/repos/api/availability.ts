/* Live API availability repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   PUT /providers/me/availability → 204 (weekly full replace)
 *
 * getAvailability() has no dedicated GET path in the contract; it reads
 * ProviderPrivate.availability via GET /providers/me.
 */
import { api } from '@/api/client';
import type { AvailabilityRepository } from '../index';
import type { AvailabilityWindow, ProviderPrivate } from '@hudumika/contract';

export class ApiAvailabilityRepository implements AvailabilityRepository {
  async getAvailability(): Promise<AvailabilityWindow[]> {
    const profile = await api.get<ProviderPrivate>('/providers/me');
    return profile.availability ?? [];
  }

  async putAvailability(windows: AvailabilityWindow[]): Promise<void> {
    await api.put<void>('/providers/me/availability', windows);
  }
}
