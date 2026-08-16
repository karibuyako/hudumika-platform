/* Test runner: bundles TypeScript tests with esbuild, then runs node --test. */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'tests', '.build');
mkdirSync(outDir, { recursive: true });

const alias = path.join(root, 'src');
/* Default suite: contract + store + queue + group-buy. store.test.ts is owned by a
 * parallel agent — if it is not on disk yet, drop it so `npm test` still runs
 * the tests that exist (both files stay listed so the suite turns on
 * automatically once the other agent lands their file). */
const DEFAULT_TESTS = ['contract.test.ts', 'store.test.ts', 'queue.test.ts', 'client-infra.test.ts', 'group-buy.test.ts', 'loyalty.test.ts', 'dine-in.test.ts', 'dine-in-qr.test.ts', 'p6d-gaps.test.ts', 'p6e-analytics.test.ts', 'analytics-flow.test.ts', 'w0a.test.ts', 'promotions.test.ts', 'orders-gaps.test.ts', 'order-flow.test.ts', 'catalogue-ext.test.ts', 'catalogue-flow.test.ts', 'supply-chain.test.ts', 'supply-flow.test.ts', 'webhooks-tasks.test.ts', 'staff-ops.test.ts', 'engagement.test.ts', 'reports-crm.test.ts', 'finance-ext.test.ts', 'store-settings.test.ts', 'catalogues-merchants.test.ts', 'onboarding-flow.test.ts', 'contract-aliases.test.ts', 'drift-catalogues.test.ts', 'drift-orders.test.ts', 'drift-store.test.ts', 'drift-marketing.test.ts', 'i18n.test.ts', 'rbac.test.ts', 'messaging-flow.test.ts', 'earnings-flow.test.ts', 'promotions-flow.test.ts'];
const requested = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TESTS.filter((t) => existsSync(path.join(root, 'tests', t)));
const tests = requested;

for (const t of tests) {
  const src = path.join(root, 'tests', t);
  const out = path.join(outDir, t.replace(/\.ts$/, '.mjs'));
  execSync(
    `npx esbuild "${src}" --bundle --platform=node --format=esm --alias:@="${alias}" --outfile="${out}" --log-level=warning`,
    { stdio: 'inherit', cwd: root },
  );
  console.log(`bundled ${t} -> ${out}`);
}

execSync(`node --test --test-reporter=spec ${tests.map((t) => JSON.stringify(path.join(outDir, t.replace(/\.ts$/, '.mjs')))).join(' ')}`, {
  stdio: 'inherit',
  cwd: root,
});
