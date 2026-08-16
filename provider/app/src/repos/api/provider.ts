/* Live API provider repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me                 → ProviderPrivate
 *   POST /providers                    → LeadCreated
 *   PATCH /providers/me                → ProviderPrivate
 *   GET  /providers/me/capabilities    → ListProviderCapabilities200
 */
import { api } from '@/api/client';
import type { ProviderRepository } from '../index';
import type { LeadCreated, ListProviderCapabilities200, ProviderApplication, ProviderPrivate, ProviderUpdate } from '@hudumika/contract';

export class ApiProviderRepository implements ProviderRepository {
  async getProfile(): Promise<ProviderPrivate> {
    return api.get<ProviderPrivate>('/providers/me');
  }

  async apply(payload: ProviderApplication): Promise<{ status: 'submitted' | 'under_review' }> {
    const res = await api.post<LeadCreated>('/providers', payload);
    return { status: res.status };
  }

  async updateProfile(patch: ProviderUpdate): Promise<ProviderPrivate> {
    return api.patch<ProviderPrivate>('/providers/me', patch);
  }

  async getCapabilities(): Promise<ListProviderCapabilities200> {
    return api.get<ListProviderCapabilities200>('/providers/me/capabilities');
  }
}
