/* Streak display helpers (membership check-in). Pure + unit-testable —
 * screens only render what these derive from the server-provided streakDays
 * (DailyCheckIn200.streakDays / the loyalty ledger). No streak math lives in
 * the UI; the check-in streak itself is server-authoritative (mock
 * memberships.ts, contract DailyCheckIn200). */

/** Weekly check-in bonus rule. Mirrors the mock's WEEKLY_STREAK_BONUS (10)
 * and STREAK_BONUS_EVERY (7): the contract DailyCheckIn200.bonusPoints
 * carries the real amount on the check-in response, but there is no
 * static "bonus at day 7" field — so the milestone hint uses this mirrored
 * constant until the contract exposes the rule. */
export const WEEKLY_STREAK_BONUS_POINTS = 10;
export const STREAK_BONUS_EVERY_DAYS = 7;

/** 7-day streak strip: `true` for the streak days the server reports
 * (capped), `false` for the remaining slots. `streakDays <= 0` → all empty;
 * values above `cap` fill every slot (the label shows the real count). */
export function streakDots(streakDays: number, cap = 7): boolean[] {
  const n = Number.isFinite(streakDays) ? Math.max(0, Math.floor(streakDays)) : 0;
  return Array.from({ length: cap }, (_, i) => i < n);
}

/** Next streak day that pays the weekly bonus (mock rule: every 7th day).
 * A streak at an exact multiple has just earned it, so the next one is
 * `+ every`. Returns the 7-day position for any streak below it. */
export function nextBonusDay(streakDays: number, every = STREAK_BONUS_EVERY_DAYS): number {
  const n = Number.isFinite(streakDays) ? Math.max(0, Math.floor(streakDays)) : 0;
  if (n <= 0) return every;
  return Math.ceil((n + 1) / every) * every;
}
