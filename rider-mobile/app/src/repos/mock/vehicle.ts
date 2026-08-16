/* In-memory vehicle tools repository (maintenance, expenses, goals, exports, training).
 * Mirrors GET/POST /riders/me/vehicle/maintenance, GET/POST /riders/me/expenses,
 * GET/PUT /riders/me/goals, POST /riders/me/exports, GET /riders/me/training,
 * POST /riders/me/training/{moduleId}/complete against module state in mockState.ts.
 *
 * Contract-shaped errors:
 *   422 INVALID_INPUT   (maintenance type outside the enum, goals out of range,
 *                        export reportType/format outside the enums)
 *   404 TRAINING_MODULE_NOT_FOUND (unknown moduleId on complete)
 *
 * Training completion is idempotent: the contract defines no once-only conflict
 * for POST .../complete, so a second call returns the already-certified module.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { getState, clone, nowIso } from './mockState';
import type { VehicleRepository } from '../index';
import type {
  ExportRiderReport202,
  ExportRiderReportBody,
  RiderExpense,
  RiderGoals,
  TrainingModule,
  VehicleMaintenance,
} from '@hudumika/contract';
import { ExportRiderReportBodyFormat as EXPORT_FORMATS, ExportRiderReportBodyReportType as EXPORT_TYPES, RiderExpenseCategory as EXPENSE_CATEGORIES, VehicleMaintenanceType as MAINTENANCE_TYPES } from '@hudumika/contract';

export class MockVehicleRepository implements VehicleRepository {
  async listMaintenance(): Promise<VehicleMaintenance[]> {
    const list = [...getState().maintenance].sort(
      (a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt),
    );
    return clone(list);
  }

  async createMaintenance(record: VehicleMaintenance): Promise<VehicleMaintenance> {
    if (!MAINTENANCE_TYPES[record.type]) {
      throw new ApiError(422, 'INVALID_INPUT', `type: supported values are ${Object.keys(MAINTENANCE_TYPES).join(', ')}`);
    }
    const created: VehicleMaintenance = {
      id: uid('mnt'),
      riderId: getState().profile.id,
      type: record.type,
      performedAt: record.performedAt || nowIso(),
      mileageKm: record.mileageKm ?? null,
      costTZS: record.costTZS ?? null,
      notes: record.notes ?? '',
      nextDueAt: record.nextDueAt ?? null,
    };
    getState().maintenance.push(created);
    return clone(created);
  }

  async listExpenses(from?: string, to?: string): Promise<RiderExpense[]> {
    const fromMs = from ? Date.parse(from) : NaN;
    const toMs = to ? Date.parse(to) : NaN;
    const list = [...getState().expenses]
      .filter((e) => {
        const at = Date.parse(e.incurredAt);
        if (!Number.isNaN(fromMs) && at < fromMs) return false;
        if (!Number.isNaN(toMs) && at > toMs + 24 * 3600_000 - 1) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.incurredAt) - Date.parse(a.incurredAt));
    return clone(list);
  }

  async createExpense(expense: RiderExpense): Promise<RiderExpense> {
    if (!EXPENSE_CATEGORIES[expense.category]) {
      throw new ApiError(422, 'INVALID_INPUT', `category: supported values are ${Object.keys(EXPENSE_CATEGORIES).join(', ')}`);
    }
    if (!Number.isInteger(expense.amountTZS) || expense.amountTZS < 0) {
      throw new ApiError(422, 'INVALID_INPUT', 'amountTZS: must be an integer >= 0');
    }
    const created: RiderExpense = {
      id: uid('exp'),
      category: expense.category,
      amountTZS: expense.amountTZS,
      receiptUrl: expense.receiptUrl ?? null,
      deductible: expense.deductible ?? false,
      note: expense.note ?? '',
      incurredAt: expense.incurredAt || nowIso(),
    };
    getState().expenses.push(created);
    return clone(created);
  }

  async getGoals(): Promise<RiderGoals> {
    return clone(getState().goals);
  }

  async putGoals(goals: RiderGoals): Promise<RiderGoals> {
    const { hoursGoalPerWeek, earningsGoalTZS } = goals;
    if (!Number.isInteger(hoursGoalPerWeek) || hoursGoalPerWeek < 1 || hoursGoalPerWeek > 100) {
      throw new ApiError(422, 'INVALID_INPUT', 'hoursGoalPerWeek: must be an integer between 1 and 100');
    }
    if (!Number.isInteger(earningsGoalTZS) || earningsGoalTZS < 0) {
      throw new ApiError(422, 'INVALID_INPUT', 'earningsGoalTZS: must be an integer >= 0');
    }
    for (const day of goals.weeklyAvailability ?? []) {
      if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 0 || day.dayOfWeek > 6) {
        throw new ApiError(422, 'INVALID_INPUT', 'weeklyAvailability: dayOfWeek must be an integer between 0 and 6');
      }
    }
    getState().goals = { ...goals, weeklyAvailability: goals.weeklyAvailability ?? [] };
    return clone(getState().goals);
  }

  async requestExport(body: ExportRiderReportBody): Promise<ExportRiderReport202> {
    if (!EXPORT_TYPES[body.reportType]) {
      throw new ApiError(422, 'INVALID_INPUT', `reportType: supported values are ${Object.keys(EXPORT_TYPES).join(', ')}`);
    }
    if (!EXPORT_FORMATS[body.format]) {
      throw new ApiError(422, 'INVALID_INPUT', `format: supported values are ${Object.keys(EXPORT_FORMATS).join(', ')}`);
    }
    const job: ExportRiderReport202 = { jobId: uid('job'), status: 'queued' };
    getState().exportJobs.push(job);
    return clone(job);
  }

  async listTraining(): Promise<TrainingModule[]> {
    return clone(getState().training);
  }

  async completeTraining(moduleId: string): Promise<TrainingModule> {
    const state = getState();
    const module = state.training.find((m) => m.id === moduleId);
    if (!module) throw new ApiError(404, 'TRAINING_MODULE_NOT_FOUND', `Module ${moduleId} not found`);
    if (module.status === 'certified') return clone(module);
    module.status = 'certified';
    module.progressPct = 100;
    module.certificateUrl = `https://hudumika.example/cert/${module.id}`;
    module.completedAt = nowIso();
    return clone(module);
  }
}
