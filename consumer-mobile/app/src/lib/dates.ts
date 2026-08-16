/* UTC → local helpers. Contract timestamps are UTC ISO 8601; every render
 * goes through here — no ad-hoc new Date(str) in screens (INSTRUCTIONS §3.4). */

import { t } from '@/i18n';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const p2 = (n: number) => String(n).padStart(2, '0');

function toDate(ts?: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `14 Aug · 16:32` (local) — primary list/detail timestamp renderer. */
export function dateISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** `14 Aug 2026, 16:32` (local) — full stamp (LOCALIZATION.md). */
export function fullDateISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** `16:32` (local). */
export function clockISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Local calendar day → `YYYY-MM-DD` (travel search serialization — the mock
 * and the contract date param both interpret it as a local day). */
export function toISODate(d?: Date | null): string {
  const dt = d ?? new Date();
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}

/** `Aug 14` (local). */
export function dayLabelISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** `Fri` (local, locale-aware). */
const WEEKDAY_KEYS = ['weekday.short.sun', 'weekday.short.mon', 'weekday.short.tue', 'weekday.short.wed', 'weekday.short.thu', 'weekday.short.fri', 'weekday.short.sat'] as const;

export function weekdayLabelISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return t(WEEKDAY_KEYS[d.getDay()]);
}

/**
 * Local calendar slot → UTC ISO 8601 (booking form time chips). The Date
 * constructor with local components performs the local → UTC conversion; the
 * server receives UTC and renders it back via the display helpers above.
 */
export function localSlotISO(day: Date, hour: number, minute = 0): string {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
  return d.toISOString();
}

/** `2h 15m` remaining until a future UTC timestamp (scheduled countdown). */
export function countdownISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  const diff = Math.max(0, d.getTime() - Date.now());
  const min = Math.floor(diff / 60000);
  const h = Math.floor(min / 60);
  if (h > 0) return `${h}h ${min % 60}m`;
  if (min > 0) return `${min}m`;
  return '0m';
}

/** Group-buy sale countdown (GROUP-BUY.md expiry) — `2d 3h` / `4h 30m`
 * style while the sale clock is still running, `null` once `endsAt` has
 * passed (the caller renders the "Ended" state instead). `now` is injectable
 * for tests. */
export function formatDealCountdown(endsAt?: string | null, now = Date.now()): string | null {
  const d = toDate(endsAt);
  if (!d) return null;
  const diff = d.getTime() - now;
  if (diff <= 0) return null;
  const min = Math.floor(diff / 60000);
  const days = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (days > 0) return `${days}d ${h}h`;
  if (h > 0) return `${h}h ${min % 60}m`;
  if (min > 0) return `${min}m`;
  return '0m';
}

/** Notification-row switch (LOCALIZATION.md): under 24h old → relative time,
 * 24h or older → absolute stamp. Strict `<` so exactly-24h falls to absolute. */
export function shouldUseRelativeTime(ts?: string | null, now = Date.now()): boolean {
  const d = toDate(ts);
  if (!d) return false;
  return now - d.getTime() < 24 * 60 * 60 * 1000;
}

/** Full local stamp `2026-08-14 16:32`. */
export function fullTimeISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Relative time for a UTC ISO string (notification rows), locale-aware. */
export function timeAgoISO(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('timeAgo.justNow');
  if (min < 60) return t('timeAgo.minutes', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('timeAgo.hours', { n: h });
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return t('timeAgo.days', { n: d2 });
  return t('timeAgo.months', { n: Math.floor(d2 / 30) });
}

/**
 * Delivery-window promise — rendered ONLY from server leg ETAs, never
 * fabricated. `Aug 14, 09:00–14:00` (local).
 */
export function windowLabel(from?: string | null, to?: string | null): string {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return '—';
  return `${MONTHS[a.getMonth()]} ${a.getDate()}, ${p2(a.getHours())}:${p2(a.getMinutes())}–${p2(b.getHours())}:${p2(b.getMinutes())}`;
}
