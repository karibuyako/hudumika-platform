/* Time/format helpers. Money is formatted by the single shared formatter
 * formatTZS in src/i18n — never inline toLocaleString.
 * This module re-exports that formatter as `tzs` for legacy call-sites that
 * imported from lib/format; new code should import formatTZS from '@/i18n'. */
export { formatTZS, formatTZS as tzs } from '@/i18n';
export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function clockISO(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : clock(d.getTime());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateISO(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function minutesLabel(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Seconds until `expiresAt` (ms epoch), clamped to [0, cap]. The home screen
 * offer countdown uses the same formula (cap 120) — keep both in sync. */
export function countdownRemaining(expiresAt: number, now: number, cap = 120): number {
  return Math.max(0, Math.min(cap, Math.floor((expiresAt - now) / 1000)));
}