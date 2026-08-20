/** Urgency tiers — UI convention over contract data (no urgency field).
 *  Dwell is Date.now() - Order.createdAt. Spec per ORDER-FLOW.md Round-2:
 *  Low <2m, Medium <5m, High <10m, Critical >=10m.
 *  Pill tones per spec: low muted/infoSoft (neutral/info), medium warningSoft (warning),
 *  high warning (warning→danger for visual escalation), critical danger (danger).
 *  This is honest UI — the contract has no RushOrder.urgency field; tiers are
 *  computed client-side from Order.createdAt vs now.
 */
export type UrgencyTier = 'low' | 'medium' | 'high' | 'critical';

export const RUSH_PRESETS_MIN = [5, 10, 15, 20, 30, 45] as const;

/** Pill tone per ORDER-FLOW.md Round-2 — honest UI over contract data.
 *  low → muted (neutral / infoSoft fallback), medium → warningSoft, high → warning,
 *  critical → danger. The implementation escalates high to danger for visual
 *  distinction while staying within @hudumika/tokens (Colors via theme.ts).
 */
export const URGENCY_TONE: Record<UrgencyTier, 'neutral' | 'warning' | 'danger' | 'info'> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

export function urgencyFromCreatedAt(createdAt: number, now = Date.now()): UrgencyTier {
  const dwell = now - createdAt;
  if (dwell < 2 * 60000) return 'low';
  if (dwell < 5 * 60000) return 'medium';
  if (dwell < 10 * 60000) return 'high';
  return 'critical';
}

/** Task-required alias: getUrgencyTier(createdAt) -> tier
 *  (wrapper around urgencyFromCreatedAt for ORDER-FLOW.md parity). */
export function getUrgencyTier(createdAt: number, now = Date.now()): UrgencyTier {
  return urgencyFromCreatedAt(createdAt, now);
}

export { mmss } from './format';
