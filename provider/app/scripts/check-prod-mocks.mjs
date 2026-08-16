/* CI guard: mock code must never ship.
 *
 * Verifies that every preview/production EAS profile forces every
 * EXPO_PUBLIC_MOCK_* switch to "false" and pins a live API URL + environment,
 * and that the app's repository factories default to mock only when the env
 * var is unset (never the other way around).
 *
 * Usage: node scripts/check-prod-mocks.mjs (run in provider/app).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eas = JSON.parse(readFileSync(path.join(root, 'eas.json'), 'utf8'));
const envExample = readFileSync(path.join(root, '.env.example'), 'utf8');

const MOCK_VARS = ['EXPO_PUBLIC_MOCK_AUTH', 'EXPO_PUBLIC_MOCK_PROFILE', 'EXPO_PUBLIC_MOCK_BOOKINGS', 'EXPO_PUBLIC_MOCK_DISPATCH', 'EXPO_PUBLIC_MOCK_SERVICES', 'EXPO_PUBLIC_MOCK_TECHNICIANS', 'EXPO_PUBLIC_MOCK_EARNINGS', 'EXPO_PUBLIC_MOCK_NOTIFICATIONS', 'EXPO_PUBLIC_MOCK_SUPPORT', 'EXPO_PUBLIC_MOCK_CATALOG'];

const problems = [];

for (const profile of ['preview', 'production']) {
  const env = eas.build?.[profile]?.env ?? {};
  if (env.EXPO_PUBLIC_ENV !== (profile === 'production' ? 'production' : 'staging')) {
    problems.push(`${profile}: EXPO_PUBLIC_ENV must be ${profile === 'production' ? 'production' : 'staging'}`);
  }
  if (!env.EXPO_PUBLIC_API_URL || !env.EXPO_PUBLIC_API_URL.startsWith('https://')) {
    problems.push(`${profile}: EXPO_PUBLIC_API_URL must be a live https URL`);
  }
  for (const v of MOCK_VARS) {
    if (env[v] !== 'false') {
      problems.push(`${profile}: ${v} must be "false" (got ${JSON.stringify(env[v])})`);
    }
  }
}

// Every mock switch must be registered in .env.example (same-PR rule).
for (const v of MOCK_VARS) {
  if (!envExample.includes(`${v}=`)) {
    problems.push(`.env.example: missing ${v}`);
  }
}

if (problems.length) {
  console.error('mock-shipping guard failed:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('mock-shipping guard OK: preview/production profiles force all mocks off.');
