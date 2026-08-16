/* In-memory service contracts repository. Mirrors GET/POST /providers/me/contracts
 * against module state in mockState.ts. Creates require organizationName,
 * coveredServices and slaResponseMinutes (422 CONTRACT_VALIDATION) and default
 * to status 'draft'.
 */
import { ApiError } from '@/api/client';
import { getState, clone } from './mockState';
import { uid } from '@/lib/format';
import type { ContractsRepository } from '../index';
import type { ServiceContract } from '@hudumika/contract';

export class MockContractsRepository implements ContractsRepository {
  async list(): Promise<ServiceContract[]> {
    return clone(getState().contracts);
  }

  async create(input: ServiceContract): Promise<ServiceContract> {
    if (
      !input.organizationName?.trim() ||
      !input.coveredServices?.length ||
      typeof input.slaResponseMinutes !== 'number'
    ) {
      throw new ApiError(422, 'CONTRACT_VALIDATION', 'organizationName, coveredServices and slaResponseMinutes are required');
    }
    const contract: ServiceContract = {
      ...clone(input),
      id: uid('ctr'),
      status: input.status ?? 'draft',
      createdAt: new Date().toISOString(),
    };
    getState().contracts.push(contract);
    return clone(contract);
  }
}
