/* Enterprise dispatch: anti-fatigue timers (Meituan 2025 anti-fatigue parity).
 * Tracks continuous on-duty hours, enforces mandatory rest, and surfaces live status.
 */

export type FatigueLevel = 'ok' | 'warning' | 'critical';

export interface ShiftRecord {
  technicianId: string;
  startedAt: number; // epoch ms
  lastBreakAt?: number | null;
  hoursToday: number; // cumulative today
}

const WARN_HOURS = 8;
const CRITICAL_HOURS = 12;
const MAX_CONTINUOUS_HOURS = 12;
const REQUIRED_BREAK_MIN = 30;

export function fatigueLevel(shift: ShiftRecord | null, now = Date.now()): FatigueLevel {
  if (!shift) return 'ok';
  const continuous = (now - shift.startedAt) / 3_600_000;
  if (continuous >= CRITICAL_HOURS) return 'critical';
  if (continuous >= WARN_HOURS) return 'warning';
  return 'ok';
}

export function hoursOnDuty(shift: ShiftRecord, now = Date.now()): number {
  return (now - shift.startedAt) / 3_600_000;
}

export function requiresBreak(shift: ShiftRecord, now = Date.now()): boolean {
  return hoursOnDuty(shift, now) >= MAX_CONTINUOUS_HOURS;
}

export function breakRemaining(shift: ShiftRecord, now = Date.now()): number {
  if (!shift.lastBreakAt) return REQUIRED_BREAK_MIN;
  const elapsed = (now - shift.lastBreakAt) / 60_000;
  return Math.max(0, REQUIRED_BREAK_MIN - elapsed);
}

export function liveStatus(technicianStatus: string, shift: ShiftRecord | null, now = Date.now()): string {
  if (technicianStatus === 'offline') return 'Offline';
  if (!shift) return technicianStatus === 'idle' ? 'Idle — not on shift' : 'On job';
  const level = fatigueLevel(shift, now);
  if (level === 'critical') return 'Fatigue: mandatory rest';
  if (level === 'warning') return 'Fatigue: break recommended';
  if (technicianStatus === 'on_job') return `On job · ${hoursOnDuty(shift, now).toFixed(1)}h on duty`;
  return `Idle · ${hoursOnDuty(shift, now).toFixed(1)}h on duty`;
}
