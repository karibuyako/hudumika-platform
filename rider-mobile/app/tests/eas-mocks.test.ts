/* Store-release guardrail (DEPLOYMENT.md): mock switches must never be on in
 * preview/production EAS profiles — a review build must behave against the
 * real staging/production backend, never the in-memory fixtures. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const eas = JSON.parse(readFileSync(path.join(root, 'eas.json'), 'utf8')) as {
  build?: Record<string, { env?: Record<string, string | undefined> }>;
};

const MOCK_SWITCHES = ['EXPO_PUBLIC_MOCK_AUTH', 'EXPO_PUBLIC_MOCK_JOBS', 'EXPO_PUBLIC_MOCK_EARNINGS', 'EXPO_PUBLIC_MOCK_SUPPORT', 'EXPO_PUBLIC_MOCK_SAFETY', 'EXPO_PUBLIC_MOCK_VEHICLE', 'EXPO_PUBLIC_MOCK_TRIPS', 'EXPO_PUBLIC_MOCK_LOGISTICS'];

test('preview and production EAS profiles explicitly disable every mock switch', () => {
  const profiles = eas.build ?? {};
  for (const name of ['preview', 'production']) {
    const env = profiles[name]?.env ?? {};
    for (const key of MOCK_SWITCHES) {
      assert.equal(env[key], 'false', `${name}: ${key} must be explicitly "false" (defaults to ON)`);
    }
  }
});

test('development profile may enable mocks but defaults stay off unless explicit', () => {
  const env = eas.build?.development?.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('EXPO_PUBLIC_MOCK_')) {
      assert.ok(value === 'true' || value === 'false', `${key} must be a boolean string`);
    }
  }
});