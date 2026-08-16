/* Live API technicians repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/technicians                 → Technician[]
 *   POST /providers/me/technicians                 → Technician
 *   PATCH /providers/me/technicians/{technicianId} → Technician
 *   DELETE /providers/me/technicians/{technicianId} → 204
 */
import { api } from '@/api/client';
import type { TechniciansRepository } from '../index';
import type { Technician } from '@hudumika/contract';

export class ApiTechniciansRepository implements TechniciansRepository {
  async list(): Promise<Technician[]> {
    return api.get<Technician[]>('/providers/me/technicians');
  }

  async create(input: Technician): Promise<Technician> {
    return api.post<Technician>('/providers/me/technicians', input);
  }

  async update(technicianId: string, input: Partial<Technician>): Promise<Technician> {
    return api.patch<Technician>(`/providers/me/technicians/${technicianId}`, input);
  }

  async remove(technicianId: string): Promise<void> {
    await api.delete<void>(`/providers/me/technicians/${technicianId}`);
  }
}
