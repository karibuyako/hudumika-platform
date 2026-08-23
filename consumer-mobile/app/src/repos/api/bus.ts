/* Live API bus repository — Meituan bus parity:
 * GET /bus/routes (search) + GET /bus/routes/{id} + GET /bus/routes/{id}/vehicles
 * + GET /bus/vehicles/{id} + GET /bus/reminders + POST /bus/reminders.
 *
 * Mock-only-until-adopted until the contract ships the bus surface:
 * the server currently 404s; the UI gracefully falls back to its error/empty
 * states (same pattern as the marketing live-chat gallery).
 */
import { api } from '@/api/client';
import type { BusOption, BusRepository, BusRoute, BusSearchParams, BusVehicle, StopReminder } from '../index';

export class ApiBusRepository implements BusRepository {
  async search(params: BusSearchParams): Promise<BusOption[]> {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && String(v).trim() !== '') as [string, string][],
    ).toString();
    return api.get<BusOption[]>(`/bus/routes${qs ? `?${qs}` : ''}`);
  }

  async getRoute(routeId: string): Promise<BusRoute> {
    return api.get<BusRoute>(`/bus/routes/${encodeURIComponent(routeId)}`);
  }

  async getVehicles(routeId: string): Promise<BusVehicle[]> {
    return api.get<BusVehicle[]>(`/bus/routes/${encodeURIComponent(routeId)}/vehicles`);
  }

  async trackVehicle(vehicleId: string): Promise<BusVehicle> {
    return api.get<BusVehicle>(`/bus/vehicles/${encodeURIComponent(vehicleId)}`);
  }

  async listReminders(): Promise<StopReminder[]> {
    return api.get<StopReminder[]>('/bus/reminders');
  }

  async setReminder(routeId: string, stopId: string, enabled: boolean, idempotencyKey: string): Promise<StopReminder | null> {
    // Enabled → POST /bus/reminders {routeId, stopId, enabled}; disabled → DELETE via POST with enabled=false
    // (the server interprets enabled false as removal; returns null).
    const body = { routeId, stopId, enabled };
    const result = await api.post<StopReminder | null>('/bus/reminders', body, { idempotencyKey });
    return result;
  }
}
