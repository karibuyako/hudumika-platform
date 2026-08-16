/* M14 — Env config consumption: EXPO_PUBLIC_APP_LINKS parsing is pure and
 * never throws. Valid JSON yields the object; malformed input, missing
 * fields and non-string values fall back to the empty-string defaults and
 * log a dev warning. */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { APP_LINKS_DEFAULTS, envConfig, parseAppLinks } from '@/lib/env';

const VALID_RAW = JSON.stringify({
  ios: 'https://apps.apple.com/app/id123',
  android: 'https://play.google.com/store/apps/details?id=com.hudumika',
  supportPhone: '+255700000000',
  supportEmail: 'support@hudumika.co.tz',
  privacyUrl: 'https://hudumika.co.tz/privacy',
  termsUrl: 'https://hudumika.co.tz/terms',
});

/* The parser warns via console.warn in non-production channels — silence
 * it so malformed-input tests run clean (and capture the warn count). */
const warnings: string[] = [];
const originalWarn = console.warn;
beforeEach(() => {
  warnings.length = 0;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  // keep the module reading the live env var between tests
  delete process.env.EXPO_PUBLIC_APP_LINKS;
  delete process.env.EXPO_PUBLIC_ENV;
});

after(() => {
  console.warn = originalWarn;
});

test('parseAppLinks: valid JSON yields the full object', () => {
  const links = parseAppLinks(VALID_RAW);
  assert.deepEqual(links, {
    ios: 'https://apps.apple.com/app/id123',
    android: 'https://play.google.com/store/apps/details?id=com.hudumika',
    supportPhone: '+255700000000',
    supportEmail: 'support@hudumika.co.tz',
    privacyUrl: 'https://hudumika.co.tz/privacy',
    termsUrl: 'https://hudumika.co.tz/terms',
  });
  assert.equal(warnings.length, 0, 'valid input never warns');
});

test('parseAppLinks: malformed JSON falls back to defaults and warns', () => {
  const links = parseAppLinks('{"ios": "unterminated');
  assert.deepEqual(links, APP_LINKS_DEFAULTS);
  assert.equal(links.ios, '');
  assert.equal(warnings.length, 1, 'malformed JSON logs exactly one dev warning');
  assert.match(warnings[0], /malformed JSON/);
});

test('parseAppLinks: missing field falls back to its default only', () => {
  const links = parseAppLinks('{"ios":"https://apps.apple.com/app/id123"}');
  assert.equal(links.ios, 'https://apps.apple.com/app/id123');
  assert.equal(links.android, '');
  assert.equal(links.supportPhone, '');
  assert.equal(links.supportEmail, '');
  assert.equal(links.privacyUrl, '');
  assert.equal(links.termsUrl, '');
  assert.equal(warnings.length, 0, 'partial objects do not warn — missing keys are valid');
});

test('parseAppLinks: non-string values are rejected per field', () => {
  const links = parseAppLinks(JSON.stringify({ ios: 42, supportEmail: ['x@y.tz'] }));
  assert.equal(links.ios, '');
  assert.equal(links.supportEmail, '');
});

test('parseAppLinks: undefined / null / empty input returns defaults and warns once', () => {
  for (const raw of [undefined, null, '']) {
    assert.deepEqual(parseAppLinks(raw), APP_LINKS_DEFAULTS);
  }
  assert.equal(warnings.length, 3, 'one warning per unset read');
});

test('parseAppLinks: non-object JSON falls back to defaults', () => {
  assert.deepEqual(parseAppLinks('"just a string"'), APP_LINKS_DEFAULTS);
  assert.deepEqual(parseAppLinks('[1,2,3]'), APP_LINKS_DEFAULTS);
  assert.deepEqual(parseAppLinks('42'), APP_LINKS_DEFAULTS);
});

test('parseAppLinks: returns a fresh copy, never the shared defaults object', () => {
  const a = parseAppLinks(VALID_RAW);
  const b = parseAppLinks(VALID_RAW);
  assert.notEqual(a, b, 'each read returns an independent object');
  assert.notEqual(a, APP_LINKS_DEFAULTS);
  a.ios = 'mutated';
  assert.equal(b.ios, 'https://apps.apple.com/app/id123', 'mutations never leak');
});

test('envConfig.appLinks reads process.env.EXPO_PUBLIC_APP_LINKS without throwing', () => {
  assert.deepEqual(envConfig.appLinks, APP_LINKS_DEFAULTS, 'unset env var → defaults');
  process.env.EXPO_PUBLIC_APP_LINKS = VALID_RAW;
  assert.equal(envConfig.appLinks.ios, 'https://apps.apple.com/app/id123');
  process.env.EXPO_PUBLIC_APP_LINKS = '{broken';
  assert.deepEqual(envConfig.appLinks, APP_LINKS_DEFAULTS, 'malformed env var → defaults, no crash');
});

test('envConfig.appLinks never throws on garbage input', () => {
  process.env.EXPO_PUBLIC_APP_LINKS = 'null';
  assert.deepEqual(envConfig.appLinks, APP_LINKS_DEFAULTS);
  process.env.EXPO_PUBLIC_APP_LINKS = '{}';
  assert.deepEqual(envConfig.appLinks, APP_LINKS_DEFAULTS);
});
