export function tzs(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.round(Math.abs(n));
  try {
    return `${sign}TZS ${abs.toLocaleString('en-US')}`;
  } catch {
    // Hermes without Intl — fallback plain integer
    return `${sign}TZS ${String(abs)}`;
  }
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

export function dayLabel(ts: number, short = false): string {
  const d = new Date(ts);
  return short
    ? `${String(d.getMonth() + 1)}/${d.getDate()}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fullTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
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

/** Mask a phone for display: +255 ••• ••• •789 */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '—';
  const head = phone.startsWith('+') ? '+' : '';
  return `${head}${digits.slice(0, digits.length - 5)} ••• ••• •${digits.slice(-3)}`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const DECLINE_REASONS = [
  'Schedule conflict',
  'Too far from my service area',
  'Missing parts or equipment',
  'Outside my trade',
  'Pricing disagreement',
  'Customer unresponsive',
  'Other',
];
