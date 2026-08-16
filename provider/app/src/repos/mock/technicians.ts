/* In-memory technicians repository. Mirrors GET/POST /providers/me/technicians
 * and PATCH/DELETE /providers/me/technicians/{id} against module state in
 * mockState.ts. Removing a technician who is on a job throws 409
 * TECHNICIAN_BUSY; unknown ids throw 404 TECHNICIAN_NOT_FOUND.
 */
import { ApiError } from '@/api/client';
import { getState, clone } from './mockState';
import { uid } from '@/lib/format';
import type { TechniciansRepository } from '../index';
import type { Technician } from '@hudumika/contract';

export class MockTechniciansRepository implements TechniciansRepository {
  async list(): Promise<Technician[]> {
    return clone(getState().technicians);
  }

  async create(input: Technician): Promise<Technician> {
    const state = getState();
    const tech: Technician = {
      ...clone(input),
      id: uid('tech'),
      status: input.status ?? 'idle',
      currentBookingId: input.currentBookingId ?? null,
      certifications: input.certifications ?? [],
      rating: input.rating ?? null,
      createdAt: new Date().toISOString(),
    };
    state.technicians.push(tech);
    return clone(tech);
  }

  async update(technicianId: string, input: Partial<Technician>): Promise<Technician> {
    const state = getState();
    const tech = state.technicians.find((t) => t.id === technicianId);
    if (!tech) throw new ApiError(404, 'TECHNICIAN_NOT_FOUND', `Technician ${technicianId} not found`);
    Object.assign(tech, clone(input), { id: technicianId });
    return clone(tech);
  }

  async remove(technicianId: string): Promise<void> {
    const state = getState();
    const index = state.technicians.findIndex((t) => t.id === technicianId);
    if (index < 0) throw new ApiError(404, 'TECHNICIAN_NOT_FOUND', `Technician ${technicianId} not found`);
    const tech = state.technicians[index];
    if (tech.status === 'on_job' || tech.currentBookingId) {
      throw new ApiError(409, 'TECHNICIAN_BUSY', 'Technician is currently on a job');
    }
    state.technicians.splice(index, 1);
  }
}
