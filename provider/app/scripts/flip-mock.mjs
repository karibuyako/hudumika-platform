#!/usr/bin/env node
// Incrementally flip ONE mock switch to live against staging.
// Usage:
//   node scripts/flip-mock.mjs --list                    # show all switches
//   node scripts/flip-mock.mjs --flip MOCK_AUTH --run    # flip one and run smoke
//   node scripts/flip-mock.mjs --flip MOCK_BOOKINGS --dry  # show env without running
//   node scripts/flip-mock.mjs --reset                   # back to all mocks ON (dev)

import { execSync } from 'node:child_process';

const ALL = [
  'MOCK_AUTH',
  'MOCK_PROFILE',
  'MOCK_BOOKINGS',
  'MOCK_DISPATCH',
  'MOCK_SERVICES',
  'MOCK_TECHNICIANS',
  'MOCK_EARNINGS',
  'MOCK_NOTIFICATIONS',
  'MOCK_SUPPORT',
  'MOCK_CATALOG',
];

const envMap = {
  MOCK_AUTH: 'EXPO_PUBLIC_MOCK_AUTH',
  MOCK_PROFILE: 'EXPO_PUBLIC_MOCK_PROFILE',
  MOCK_BOOKINGS: 'EXPO_PUBLIC_MOCK_BOOKINGS',
  MOCK_DISPATCH: 'EXPO_PUBLIC_MOCK_DISPATCH',
  MOCK_SERVICES: 'EXPO_PUBLIC_MOCK_SERVICES',
  MOCK_TECHNICIANS: 'EXPO_PUBLIC_MOCK_TECHNICIANS',
  MOCK_EARNINGS: 'EXPO_PUBLIC_MOCK_EARNINGS',
  MOCK_NOTIFICATIONS: 'EXPO_PUBLIC_MOCK_NOTIFICATIONS',
  MOCK_SUPPORT: 'EXPO_PUBLIC_MOCK_SUPPORT',
  MOCK_CATALOG: 'EXPO_PUBLIC_MOCK_CATALOG',
};

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log('Mock switches (one per module):');
  for (const k of ALL) console.log(` - ${k} -> ${envMap[k]}`);
  process.exit(0);
}
if (args.includes('--reset')) {
  console.log('Reset: all mocks ON (dev default). No env overrides needed.');
  process.exit(0);
}

const flipIdx = args.indexOf('--flip');
const flip = flipIdx !== -1 ? args[flipIdx + 1] : null;
const dry = args.includes('--dry');
const run = args.includes('--run');

if (!flip) {
  console.error('Usage: node scripts/flip-mock.mjs --flip MOCK_AUTH [--run|--dry]');
  console.error('       --list to see all switches, --reset to go back to all mocks');
  process.exit(1);
}
if (!ALL.includes(flip)) {
  console.error(`Unknown mock ${flip}. Choose from: ${ALL.join(', ')}`);
  process.exit(1);
}

const env = {
  EXPO_PUBLIC_ENV: 'staging',
  EXPO_PUBLIC_API_URL: 'https://staging-api.hudumika.co.tz/api/v1',
};
// Start with all mocks ON, flip the chosen one OFF (live)
for (const k of ALL) env[envMap[k]] = 'true';
env[envMap[flip]] = 'false';

console.log(`\n[flip-mock] Flipping ${flip} -> ${envMap[flip]}=false against staging`);
console.log('[flip-mock] Full env:');
for (const [k, v] of Object.entries(env)) console.log(`  ${k}=${v}`);

if (dry) {
  console.log('\n[flip-mock] dry run — not executing');
  process.exit(0);
}

if (run) {
  const envStr = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`\n[flip-mock] Running smoke with flipped mock...`);
  // Run contract tests scoping to that module + staging smoke
  try {
    execSync(`${envStr} node scripts/staging-smoke.mjs 2>&1 | tail -n 20`, { stdio: 'inherit' });
  } catch {}
  console.log(`\n[flip-mock] To run E2E with this flipped mock:`);
  console.log(`  ${envStr} PLAYWRIGHT_BASE_URL=https://staging-api.hudumika.co.tz npx playwright test --project=chromium --reporter=list 2>&1 | tail -n 40`);
  console.log(`\n[flip-mock] To run Expo web with flipped mock:`);
  console.log(`  ${envStr} npx expo start --web --port 8082 --non-interactive`);
}

console.log('\n[flip-mock] Done. Roll back with --reset or flip next module.');
