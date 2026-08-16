/* Test runner: bundles TypeScript tests with esbuild, then runs node --test.
 *
 * Default: every tests/*.test.ts file (per-milestone suites + the endpoint
 * parity suite) — `npm test` runs them all. Pass explicit names to run a
 * subset, e.g. `node tests/run.mjs m1-auth.test.ts consumer-contract.test.ts`.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'tests', '.build');
mkdirSync(outDir, { recursive: true });

const alias = path.join(root, 'src');
const all = readdirSync(path.join(root, 'tests'))
  .filter((f) => f.endsWith('.test.ts'))
  .sort();
const tests = process.argv.slice(2).length ? process.argv.slice(2) : all;
if (!tests.length) {
  console.error('no test files found in tests/*.test.ts');
  process.exit(1);
}

for (const t of tests) {
  const src = path.join(root, 'tests', t);
  const out = path.join(outDir, t.replace(/\.ts$/, '.mjs'));
  execSync(
    // expo-secure-store + expo-notifications stay external: their package
    // graphs pull react-native (whose index.js carries Flow syntax esbuild
    // cannot parse). Every usage in app code is a guarded lazy import that
    // never executes under node (isNative() checks) — external keeps the
    // test bundle pure Node. react-native is external for the same reason:
    // src/lib/share.ts lazily imports Share inside shareContent(), which the
    // node guard short-circuits before the import is ever resolved.
    `npx esbuild "${src}" --bundle --platform=node --format=esm --alias:@="${alias}" --external:expo-secure-store --external:expo-notifications --external:react-native --outfile="${out}" --log-level=warning`,
    { stdio: 'inherit', cwd: root },
  );
  console.log(`bundled ${t} -> ${out}`);
}

execSync(`node --test --test-reporter=spec ${tests.map((t) => JSON.stringify(path.join(outDir, t.replace(/\.ts$/, '.mjs')))).join(' ')}`, {
  stdio: 'inherit',
  cwd: root,
});
