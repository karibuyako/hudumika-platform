/* In-memory staff repository. Mirrors GET/POST /providers/me/staff and
 * PATCH/DELETE /providers/me/staff/{id} against module state in mockState.ts.
 * Invites default to status 'invited' with role-based capabilities; removing
 * the only owner throws 409 PROVIDER_STAFF_LAST_OWNER and unknown ids throw
 * 404 PROVIDER_STAFF_NOT_FOUND.
 */
import { ApiError } from '@/api/client';
import { getState, clone, STAFF_ROLE_CAPABILITIES } from './mockState';
import { uid } from '@/lib/format';
import type { StaffRepository } from '../index';
import type { ProviderStaff } from '@hudumika/contract';

export class MockStaffRepository implements StaffRepository {
  async list(): Promise<ProviderStaff[]> {
    return clone(getState().staff);
  }

  async invite(input: ProviderStaff): Promise<ProviderStaff> {
    const state = getState();
    const member: ProviderStaff = {
      ...clone(input),
      id: uid('stf'),
      status: input.status ?? 'invited',
      capabilities: input.capabilities ?? [...(STAFF_ROLE_CAPABILITIES[input.role] ?? [])],
      createdAt: new Date().toISOString(),
    };
    state.staff.push(member);
    return clone(member);
  }

  async update(staffId: string, input: Partial<ProviderStaff>): Promise<ProviderStaff> {
    const state = getState();
    const member = state.staff.find((m) => m.id === staffId);
    if (!member) throw new ApiError(404, 'PROVIDER_STAFF_NOT_FOUND', `Staff member ${staffId} not found`);
    Object.assign(member, clone(input), { id: staffId });
    return clone(member);
  }

  async remove(staffId: string): Promise<void> {
    const state = getState();
    const index = state.staff.findIndex((m) => m.id === staffId);
    if (index < 0) throw new ApiError(404, 'PROVIDER_STAFF_NOT_FOUND', `Staff member ${staffId} not found`);
    if (state.staff[index].role === 'owner' && state.staff.filter((m) => m.role === 'owner').length === 1) {
      throw new ApiError(409, 'PROVIDER_STAFF_LAST_OWNER', 'Cannot remove the only owner');
    }
    state.staff.splice(index, 1);
  }
}
