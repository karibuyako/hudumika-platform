/* Live API contracts repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/contracts → ServiceContract[]
 *   POST /providers/me/contracts → ServiceContract
 */
import { api } from '@/api/client';
import type { ContractsRepository } from '../index';
import type { ServiceContract } from '@hudumika/contract';

export class ApiContractsRepository implements ContractsRepository {
  async list(): Promise<ServiceContract[]> {
    return api.get<ServiceContract[]>('/providers/me/contracts');
  }

  async create(input: ServiceContract): Promise<ServiceContract> {
    return api.post<ServiceContract>('/providers/me/contracts', input);
  }
}
