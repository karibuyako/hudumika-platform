/* Live API rider repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET/PATCH /riders/me, PUT /riders/me/availability ({online}),
 *   POST /riders/me/location ({lat,lon}), GET /riders/reject-reasons,
 *   GET /riders/me/performance, GET /riders/me/missions,
 *   GET /riders/me/shifts?scope=current|past,
 *   POST /riders/me/shifts/clock-in|clock-out,
 *   GET/PUT /riders/me/preferences
 */
import { api, ApiError } from '@/api/client';
import type { RiderRepository } from '../index';
import type { RiderMission, RiderPerformance, RiderPreferences, RiderPrivate, RiderShift, RiderUpdate, SetRiderAvailabilityBody, ReportRiderLocationBody } from '@hudumika/contract';

export class ApiRiderRepository implements RiderRepository {
  async getProfile(): Promise<RiderPrivate> {
    return api.get<RiderPrivate>('/riders/me');
  }

  async updateProfile(patch: RiderUpdate): Promise<RiderPrivate> {
    return api.patch<RiderPrivate>('/riders/me', patch);
  }

  async setAvailability(online: boolean): Promise<RiderPrivate> {
    const body: SetRiderAvailabilityBody = { online };
    await api.put<void>('/riders/me/availability', body);
    return this.getProfile();
  }

  async reportLocation(lat: number, lon: number): Promise<void> {
    const body: ReportRiderLocationBody = { lat, lon };
    await api.post<void>('/riders/me/location', body);
  }

  async listRejectReasons(): Promise<string[]> {
    return api.get<string[]>('/riders/reject-reasons');
  }

  async listIssueReasons(): Promise<string[]> {
    return api.get<string[]>('/orders/issue-reasons');
  }

  async updateUserLocale(locale: 'en' | 'sw'): Promise<void> {
    await api.patch<void>('/users/me', { locale });
  }

  async getPerformance(): Promise<RiderPerformance> {
    return api.get<RiderPerformance>('/riders/me/performance');
  }

  async listMissions(): Promise<RiderMission[]> {
    return api.get<RiderMission[]>('/riders/me/missions');
  }

  async listShifts(scope: 'current' | 'history'): Promise<RiderShift[]> {
    const contractScope = scope === 'current' ? 'current' : 'past';
    return api.get<RiderShift[]>(`/riders/me/shifts?scope=${contractScope}`);
  }

  async clockIn(): Promise<RiderShift> {
    const shiftId = await this.latestShiftId();
    return api.post<RiderShift>('/riders/me/shifts/clock-in', { shiftId });
  }

  async clockOut(shiftId: string, cash?: { cashCollectedTZS: number; cashReconciled: boolean }): Promise<RiderShift> {
    return api.post<RiderShift>('/riders/me/shifts/clock-out', {
      shiftId,
      cashCollectedTZS: cash?.cashCollectedTZS ?? 0,
      cashReconciled: cash?.cashReconciled ?? false,
    });
  }

  private async latestShiftId(): Promise<string> {
    const current = await api.get<RiderShift[]>('/riders/me/shifts?scope=current');
    if (current.length) return current[0].id;
    const upcoming = await api.get<RiderShift[]>('/riders/me/shifts?scope=upcoming');
    if (upcoming.length) return upcoming[0].id;
    throw new ApiError(409, 'NO_SHIFT_SCHEDULED', 'No scheduled shift to clock in/out of');
  }

  async getPreferences(): Promise<RiderPreferences> {
    return api.get<RiderPreferences>('/riders/me/preferences');
  }

  async putPreferences(prefs: RiderPreferences): Promise<RiderPreferences> {
    return api.put<RiderPreferences>('/riders/me/preferences', prefs);
  }
}