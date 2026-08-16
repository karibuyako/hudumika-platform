/* Live API providers repository — GET /services, /providers, /providers/{id}. */
import { api } from '@/api/client';
import type { ProvidersRepository } from '../index';
import type { ProviderPublic, ServiceCategoryConfig, ServiceQuestion } from '@hudumika/contract';

export class ApiProvidersRepository implements ProvidersRepository {
  async listServices(params?: { cityId?: string; category?: string }): Promise<ServiceCategoryConfig[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<ServiceCategoryConfig[]>(`/services${qs ? `?${qs}` : ''}`);
  }

  async getQuestions(serviceCategoryId: string): Promise<ServiceQuestion[]> {
    return api.get<ServiceQuestion[]>(`/service-categories/${serviceCategoryId}/questions`);
  }

  async list(params?: { cityId?: string; trade?: string; cursor?: string; limit?: number }): Promise<ProviderPublic[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<ProviderPublic[]>(`/providers${qs ? `?${qs}` : ''}`);
  }

  async get(providerId: string): Promise<ProviderPublic> {
    return api.get<ProviderPublic>(`/providers/${providerId}`);
  }

  /* GET /providers/me/preferred — mock-only-until-adopted path
   * (OPERATIONS-COVERAGE #140 PLANNED, docs/CONTRACT-ADDITIONS.md #21): the
   * consumer contract exposes no preferred-provider surface, so this call
   * sits on the parity harness allow-list until Team 6 ships it. */
  async listPreferred(): Promise<ProviderPublic[]> {
    return api.get<ProviderPublic[]>('/providers/me/preferred');
  }

  /* PUT /providers/{providerId}/preference — mock-only-until-adopted path
   * (docs/CONTRACT-ADDITIONS.md #21); body {preferred: boolean} rides the
   * Idempotency-Key header so a retry replays, never double-applies. */
  async setPreferred(providerId: string, preferred: boolean, idempotencyKey: string): Promise<ProviderPublic> {
    return api.put<ProviderPublic>(`/providers/${providerId}/preference`, { preferred }, { idempotencyKey });
  }
}
