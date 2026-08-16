/* Live API service plans repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/service-plans → ServicePlan[]
 *   POST /providers/me/service-plans → ServicePlan
 *
 * update() has no PATCH path in the contract → throws ApiError(404,
 * NOT_IMPLEMENTED) until the backend exposes it.
 */
import { api, ApiError } from '@/api/client';
import type { PlansRepository } from '../index';
import type { ServicePlan } from '@hudumika/contract';

export class ApiPlansRepository implements PlansRepository {
  async list(): Promise<ServicePlan[]> {
    return api.get<ServicePlan[]>('/providers/me/service-plans');
  }

  async create(input: ServicePlan): Promise<ServicePlan> {
    return api.post<ServicePlan>('/providers/me/service-plans', input);
  }

  async update(_planId: string, _input: Partial<ServicePlan>): Promise<ServicePlan> {
    throw new ApiError(404, 'NOT_IMPLEMENTED', 'Updating a service plan is not available yet (no PATCH /providers/me/service-plans/{planId} in the contract)');
  }
}
