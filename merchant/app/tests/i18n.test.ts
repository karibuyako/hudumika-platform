import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dict, setLocale, getLocale, t, type Locale } from '@/i18n';

const LOCALES: Locale[] = ['en', 'sw', 'ar'];

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('all locale bundles expose the same key set', () => {
  const keySets = Object.fromEntries(LOCALES.map((l) => [l, Object.keys(dict[l]).sort()])) as Record<Locale, string[]>;
  for (const l of LOCALES.slice(1)) {
    assert.deepEqual(keySets[l], keySets.en, `key set of "${l}" differs from "en"`);
  }
});

test('placeholder params are identical across locales for every key', () => {
  /* Pre-existing sw translation quirk: these two keys embed the noun inside
   * the sentence and skip the {noun} placeholder. en/ar must match exactly. */
  const KNOWN_SW_DEVIATIONS = new Set(['offline.banner', 'offline.syncing']);
  for (const k of Object.keys(dict.en)) {
    const en = placeholders(dict.en[k]);
    assert.deepEqual(placeholders(dict.ar[k]), en, `placeholder mismatch for "${k}" in ar`);
    if (!KNOWN_SW_DEVIATIONS.has(k)) {
      assert.deepEqual(placeholders(dict.sw[k]), en, `placeholder mismatch for "${k}" in sw`);
    }
  }
});

test('t() interpolates ar params and falls back to en for missing keys', () => {
  assert.equal(t('common.retry'), 'Retry');
  setLocale('ar');
  assert.equal(t('common.retry'), 'إعادة المحاولة');
  assert.equal(t('offline.banner', { count: 3, noun: 'طلبات' }), 'غير متصل — 3 طلبات في قائمة الانتظار، ستتم إعادة المحاولة تلقائيًا عند إعادة الاتصال');
  assert.equal(getLocale(), 'ar');
  setLocale('en');
  assert.equal(getLocale(), 'en');
});
