/* Money + misc helpers (rider pattern). Dates live in dates.ts, idempotency
 * in idempotency.ts, order-status sets in order.ts.
 *
 * Money is integer minor units of TZS (1 TZS = 1 unit). Never floats. */
const TZS_FORMAT = new Intl.NumberFormat('en-TZ');
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function tzs(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.round(Math.abs(n));
  return `${sign}TZS ${TZS_FORMAT.format(abs)}`;
}

export function formatTZS(n: number): string {
  return tzs(n);
}

/** Format integer points/counts with en-US grouping (no currency). */
export function formatNumber(n: number): string {
  return NUMBER_FORMAT.format(Math.round(n));
}

export function formatPoints(n: number): string {
  return formatNumber(n);
}

export function minutesLabel(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
