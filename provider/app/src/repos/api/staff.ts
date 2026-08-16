/* Live API staff repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/staff                 → ProviderStaff[]
 *   POST /providers/me/staff                 → ProviderStaff
 *   PATCH /providers/me/staff/{staffId}      → ProviderStaff
 *   DELETE /providers/me/staff/{staffId}     → 204
 */
import { api } from '@/api/client';
import type { StaffRepository } from '../index';
import type { ProviderStaff } from '@hudumika/contract';

export class ApiStaffRepository implements StaffRepository {
  async list(): Promise<ProviderStaff[]> {
    return api.get<ProviderStaff[]>('/providers/me/staff');
  }

  async invite(input: ProviderStaff): Promise<ProviderStaff> {
    return api.post<ProviderStaff>('/providers/me/staff', input);
  }

  async update(staffId: string, input: Partial<ProviderStaff>): Promise<ProviderStaff> {
    return api.patch<ProviderStaff>(`/providers/me/staff/${staffId}`, input);
  }

  async remove(staffId: string): Promise<void> {
    await api.delete<void>(`/providers/me/staff/${staffId}`);
  }
}
