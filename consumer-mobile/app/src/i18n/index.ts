/* Lightweight i18n: dictionary + t() + money/date formatting.
 * en is primary; sw is a working stub — extend keys in both dicts together.
 * LOCALE persists locally and syncs via PATCH /users/me (locale).
 */

import en from './locales/en';
import sw from './locales/sw';
import ar from './locales/ar';

export type Locale = 'en' | 'sw' | 'ar';

const dict = { en, sw, ar } as const;

export type Key = keyof (typeof dict)['en'];

const STORAGE_KEY = 'consumer.locale';

let current: Locale = 'en';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'sw' || saved === 'en' || saved === 'ar') current = saved;
} catch {
  /* storage unavailable */
}

const listeners = new Set<() => void>();

export function setLocale(locale: Locale) {
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function getLocale(): Locale {
  return current;
}

export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: Key, params?: Record<string, string | number>): string {
  const cur = dict[current] as unknown as Record<string, string>;
  const enDict = dict.en as unknown as Record<string, string>;
  let s: string = cur[key] ?? enDict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

export type { Key as I18nKey };

/* ---------- Money / currency ---------- */

/* Money is integer minor units of TZS (1 TZS = 1 unit). Never floats. */
const TZS_FORMAT = new Intl.NumberFormat('en-TZ');
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function tzsMinor(n: number): number {
  return Math.round(n);
}

export function formatTZS(n: number): string {
  return `TZS ${TZS_FORMAT.format(Math.round(n))}`;
}

export function formatNumber(n: number): string {
  return NUMBER_FORMAT.format(Math.round(n));
}
