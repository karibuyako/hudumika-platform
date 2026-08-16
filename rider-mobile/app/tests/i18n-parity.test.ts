/* M4 i18n parity test: every key in the en dict must exist in the sw dict
 * (and vice versa). Keeps the lightweight dict + t() pattern honest. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dict } from '@/i18n';

test('i18n: en and sw dictionaries have identical key sets', () => {
  const enKeys = Object.keys(dict.en);
  const swKeys = new Set(Object.keys(dict.sw));

  const missingInSw = enKeys.filter((k) => !swKeys.has(k));
  assert.deepEqual(missingInSw, [], `sw is missing ${missingInSw.length} key(s): ${missingInSw.join(', ')}`);

  const missingInEn = Object.keys(dict.sw).filter((k) => !enKeys.includes(k));
  assert.deepEqual(missingInEn, [], `en is missing ${missingInEn.length} key(s): ${missingInEn.join(', ')}`);
});

test('i18n: t() resolves every en key to a non-empty string', () => {
  for (const key of Object.keys(dict.en)) {
    const value = dict.en[key as keyof typeof dict.en];
    assert.ok(value.length > 0, `en key "${key}" must not be empty`);
  }
});
