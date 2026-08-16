import { getLocale } from '@/i18n';

export function tzs(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.round(Math.abs(n));
  return `${sign}TZS ${abs.toLocaleString('en-US')}`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function dayLabel(ts: number, short = false): string {
  const d = new Date(ts);
  return short
    ? `${String(d.getMonth() + 1)}/${d.getDate()}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/** Locale-aware local-time rendering (LOCALIZATION.md:38-40). en/sw keep the
 *  legacy `YYYY-MM-DD HH:mm` output (tests lock it); `ar` renders
 *  `15 أغسطس 2026، 14:05` with Arabic month names, Western numerals. */
export function fullTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  if (getLocale() === 'ar') {
    return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}، ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function weekdayShort(ts: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ts).getDay()];
}

export const RIDERS = ['Michael', 'Kevin', 'Jason', 'Tony', 'Leo'];

export function preorderIn(scheduledAt: number): string {
  const diff = scheduledAt - Date.now();
  if (diff <= 0) return 'Due now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `Starts in ${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `Starts in ${h}h ${rest}m`;
}

export const CANCEL_REASONS = [
  'Item sold out',
  'Store closing soon',
  'Delivery distance too far',
  'Could not reach customer',
  'Out of ingredients / equipment issue',
  'Other',
];