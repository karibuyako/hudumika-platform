/* In-memory service plans repository. Mirrors GET/POST /providers/me/plans and
 * PATCH /providers/me/plans/{id} against module state in mockState.ts.
 * Frequency must be weekly|biweekly|monthly|quarterly|annually and priceTZS a
 * non-negative integer (422 PLAN_VALIDATION); customerCount is
 * server-maintained and defaults to 0. Deactivating a plan that still has
 * customers throws 409 PLAN_IN_USE.
 */
import { ApiError } from '@/api/client';
import { getState, clone } from './mockState';
import { uid } from '@/lib/format';
import type { PlansRepository } from '../index';
import type { ServicePlan, ServicePlanFrequency } from '@hudumika/contract';

const FREQUENCIES: ServicePlanFrequency[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annually'];

export class MockPlansRepository implements PlansRepository {
  async list(): Promise<ServicePlan[]> {
    return clone(getState().plans);
  }

  async create(input: ServicePlan): Promise<ServicePlan> {
    if (!FREQUENCIES.includes(input.frequency)) {
      throw new ApiError(422, 'PLAN_VALIDATION', 'frequency must be weekly, biweekly, monthly, quarterly or annually');
    }
    if (!Number.isInteger(input.priceTZS) || input.priceTZS < 0) {
      throw new ApiError(422, 'PLAN_VALIDATION', 'priceTZS must be a non-negative integer');
    }
    const plan: ServicePlan = {
      ...clone(input),
      id: uid('plan'),
      active: input.active ?? true,
      customerCount: input.customerCount ?? 0,
      createdAt: new Date().toISOString(),
    };
    getState().plans.push(plan);
    return clone(plan);
  }

  async update(planId: string, input: Partial<ServicePlan>): Promise<ServicePlan> {
    const state = getState();
    const plan = state.plans.find((p) => p.id === planId);
    if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', `Plan ${planId} not found`);
    if (input.frequency !== undefined && !FREQUENCIES.includes(input.frequency)) {
      throw new ApiError(422, 'PLAN_VALIDATION', 'frequency must be weekly, biweekly, monthly, quarterly or annually');
    }
    if (input.priceTZS !== undefined && (!Number.isInteger(input.priceTZS) || input.priceTZS < 0)) {
      throw new ApiError(422, 'PLAN_VALIDATION', 'priceTZS must be a non-negative integer');
    }
    if (input.active === false && (plan.customerCount ?? 0) > 0) {
      throw new ApiError(409, 'PLAN_IN_USE', 'Plan still has active customers and cannot be deactivated');
    }
    Object.assign(plan, clone(input), { id: planId });
    return clone(plan);
  }
}
