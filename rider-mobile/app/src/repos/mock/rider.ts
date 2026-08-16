/* In-memory rider repository (profile, availability, shifts, missions, performance).
 * Mirrors GET/PATCH /riders/me, PUT /riders/me/availability, POST /riders/me/location,
 * GET /riders/reject-reasons, GET /riders/me/performance, GET /riders/me/missions,
 * GET /riders/me/shifts, POST /riders/me/shifts/clock-in|out, GET/PUT /riders/me/preferences.
 */
import { ApiError } from '@/api/client';
import { getState, clone, expectedShiftCod } from './mockState';
import type { RiderRepository } from '../index';
import type { RiderMission, RiderPerformance, RiderPreferences, RiderPrivate, RiderShift, RiderUpdate } from '@hudumika/contract';

const nowIso = () => new Date().toISOString();

export class MockRiderRepository implements RiderRepository {
  async getProfile(): Promise<RiderPrivate> {
    return clone(getState().profile);
  }

  async updateProfile(patch: RiderUpdate): Promise<RiderPrivate> {
    const profile = getState().profile;
    if (patch.deliveryZone !== undefined) profile.deliveryZone = patch.deliveryZone;
    if (patch.vehicle !== undefined) profile.vehicle = patch.vehicle;
    if (patch.licensePlate !== undefined) profile.licensePlate = patch.licensePlate;
    if (patch.vehicleMake !== undefined) profile.vehicleMake = patch.vehicleMake;
    if (patch.vehicleYear !== undefined) profile.vehicleYear = patch.vehicleYear;
    if (patch.hubId !== undefined) profile.hubId = patch.hubId;
    if (patch.fleetType !== undefined) profile.fleetType = patch.fleetType;
    if (patch.transportMode !== undefined) profile.transportMode = patch.transportMode;
    if (patch.employmentType !== undefined) profile.employmentType = patch.employmentType;
    if (patch.ratingFilterMin !== undefined) profile.ratingFilterMin = patch.ratingFilterMin;
    if (patch.availability !== undefined) profile.availability = patch.availability ?? null;
    return clone(profile);
  }

  async setAvailability(online: boolean): Promise<RiderPrivate> {
    const profile = getState().profile;
    profile.online = online;
    profile.onlineSince = online ? nowIso() : null;
    return clone(profile);
  }

  async reportLocation(lat: number, lon: number): Promise<void> {
    const profile = getState().profile;
    profile.lastLocation = { lat, lon, updatedAt: nowIso() };
  }

  async listRejectReasons(): Promise<string[]> {
    return [...getState().rejectReasons];
  }

  async listIssueReasons(): Promise<string[]> {
    return [...getState().issueReasons];
  }

  async updateUserLocale(locale: 'en' | 'sw'): Promise<void> {
    if (locale !== 'en' && locale !== 'sw') {
      throw new ApiError(422, 'PROFILE_INVALID', 'locale: supported values are en and sw');
    }
  }

  async getPerformance(): Promise<RiderPerformance> {
    return clone(getState().performance);
  }

  async listMissions(): Promise<RiderMission[]> {
    return clone(getState().missions);
  }

  async listShifts(scope: 'current' | 'history'): Promise<RiderShift[]> {
    const shifts = getState().shifts;
    const filtered = scope === 'current' ? shifts.filter((s) => s.status === 'active') : shifts.filter((s) => s.status !== 'active');
    return clone(filtered);
  }

  async clockIn(): Promise<RiderShift> {
    const state = getState();
    const existing = state.shifts.find((s) => s.status === 'active');
    if (existing) throw new ApiError(409, 'SHIFT_ALREADY_ACTIVE', 'A shift is already active');
    const shift: RiderShift = {
      id: `shift_${String(state.shifts.length + 1).padStart(3, '0')}`,
      riderId: state.profile.id,
      startsAt: nowIso(),
      status: 'active',
      deliveriesCompleted: 0,
      earningsTZS: 0,
      cashCollectedTZS: 0,
      cashReconciled: false,
      clockedInAt: nowIso(),
      continuousDrivingMinutes: 0,
    };
    state.shifts.push(shift);
    return clone(shift);
  }

  async clockOut(
    shiftId?: string,
    cash?: { cashCollectedTZS: number; cashReconciled: boolean },
  ): Promise<RiderShift> {
    const state = getState();
    const shift =
      state.shifts.find((s) => s.status === 'active' && (shiftId === undefined || s.id === shiftId)) ??
      state.shifts.find((s) => s.status === 'active');
    if (!shift) throw new ApiError(409, 'NO_ACTIVE_SHIFT', 'No active shift to clock out of');
    const expected = expectedShiftCod(shift.id);
    if (expected > 0 && !cash?.cashReconciled) {
      throw new ApiError(
        409,
        'SHIFT_CASH_MISMATCH',
        `COD reconciliation required — expected ${expected} TZS`,
        false,
        { expectedTZS: expected },
      );
    }
    if (cash?.cashReconciled && cash.cashCollectedTZS !== expected) {
      throw new ApiError(
        409,
        'SHIFT_CASH_MISMATCH',
        `Collected ${cash.cashCollectedTZS} TZS does not match expected ${expected} TZS`,
        false,
        { expectedTZS: expected },
      );
    }
    const earningsTZS = state.ledger.reduce((sum, e) => (e.amountTZS > 0 ? sum + e.amountTZS : sum), 0);
    shift.status = 'completed';
    shift.clockedOutAt = nowIso();
    shift.endsAt = nowIso();
    shift.earningsTZS = earningsTZS;
    shift.deliveriesCompleted = state.orders.filter((o) => o.status === 'delivered').length;
    shift.cashCollectedTZS = cash?.cashCollectedTZS ?? 0;
    shift.cashReconciled = cash?.cashReconciled ?? expected === 0;
    return clone(shift);
  }

  async getPreferences(): Promise<RiderPreferences> {
    return clone(getState().preferences);
  }

  async putPreferences(prefs: RiderPreferences): Promise<RiderPreferences> {
    const state = getState();
    if ((prefs.destinationFilters?.length ?? 0) > 5) {
      throw new ApiError(422, 'PREFERENCES_INVALID', 'destinationFilters: maximum of 5 filters');
    }
    if (prefs.language !== undefined && prefs.language !== 'en' && prefs.language !== 'sw') {
      throw new ApiError(422, 'PREFERENCES_INVALID', 'language: supported values are en and sw');
    }
    state.preferences = { ...state.preferences, ...prefs };
    return clone(state.preferences);
  }
}