/**
 * Money helpers — integer TZS minor units only (1 TZS = 1 unit).
 * Never use floats or doubles; never inline toLocaleString() in components.
 */

/**
 * Format an integer TZS amount with thousands separators.
 * `15000` -> `TZS 15,000`. Signed values (e.g. variance) render their sign explicitly.
 */
export function formatTZS(amount: number | null | undefined): string {
  if (amount == null) return 'TZS —'
  if (!Number.isInteger(amount)) throw new Error('formatTZS requires an integer amount')
  const sign = amount < 0 ? '-' : ''
  return `${sign}TZS ${Math.abs(amount).toLocaleString()}`
}
