/* Live API vehicle tools repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /riders/me/vehicle/maintenance           → VehicleMaintenance[]
 *   POST /riders/me/vehicle/maintenance           {VehicleMaintenance} → 201 VehicleMaintenance
 *   GET  /riders/me/expenses?from&to              → RiderExpense[]
 *   POST /riders/me/expenses                      {RiderExpense} → 201 RiderExpense
 *   GET  /riders/me/goals                         → RiderGoals
 *   PUT  /riders/me/goals                         {RiderGoals} → RiderGoals
 *   POST /riders/me/exports                       {ExportRiderReportBody} → 202 ExportRiderReport202
 *   GET  /riders/me/training                      → TrainingModule[]
 *   POST /riders/me/training/{moduleId}/complete  → TrainingModule
 */
import { api } from '@/api/client';
import type { VehicleRepository } from '../index';
import type {
  ExportRiderReport202,
  ExportRiderReportBody,
  RiderExpense,
  RiderGoals,
  TrainingModule,
  VehicleMaintenance,
} from '@hudumika/contract';

export class ApiVehicleRepository implements VehicleRepository {
  async listMaintenance(): Promise<VehicleMaintenance[]> {
    return api.get<VehicleMaintenance[]>('/riders/me/vehicle/maintenance');
  }

  async createMaintenance(record: VehicleMaintenance): Promise<VehicleMaintenance> {
    return api.post<VehicleMaintenance>('/riders/me/vehicle/maintenance', record);
  }

  async listExpenses(from?: string, to?: string): Promise<RiderExpense[]> {
    const params: string[] = [];
    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to)}`);
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    return api.get<RiderExpense[]>(`/riders/me/expenses${query}`);
  }

  async createExpense(expense: RiderExpense): Promise<RiderExpense> {
    return api.post<RiderExpense>('/riders/me/expenses', expense);
  }

  async getGoals(): Promise<RiderGoals> {
    return api.get<RiderGoals>('/riders/me/goals');
  }

  async putGoals(goals: RiderGoals): Promise<RiderGoals> {
    return api.put<RiderGoals>('/riders/me/goals', goals);
  }

  async requestExport(body: ExportRiderReportBody): Promise<ExportRiderReport202> {
    return api.post<ExportRiderReport202>('/riders/me/exports', body);
  }

  async listTraining(): Promise<TrainingModule[]> {
    return api.get<TrainingModule[]>('/riders/me/training');
  }

  async completeTraining(moduleId: string): Promise<TrainingModule> {
    return api.post<TrainingModule>(`/riders/me/training/${moduleId}/complete`);
  }
}
