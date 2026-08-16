/* Test runner: bundles TypeScript tests with esbuild, then runs node --test. */
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'tests', '.build');
mkdirSync(outDir, { recursive: true });

const alias = path.join(root, 'src');
const tests = process.argv.slice(2).length ? process.argv.slice(2) : ['provider-contract.test.ts', 'queue.test.ts'];

for (const t of tests) {
  const src = path.join(root, 'tests', t);
  const out = path.join(outDir, t.replace(/\.ts$/, '.mjs'));
  execSync(
    `npx esbuild "${src}" --bundle --platform=node --format=esm --alias:@="${alias}" --outfile="${out}" --log-level=warning --external:react-native --external:expo-secure-store`,
    { stdio: 'inherit', cwd: root },
  );
  console.log(`bundled ${t} -> ${out}`);
}

execSync(`node --test --test-reporter=spec ${tests.map((t) => JSON.stringify(path.join(outDir, t.replace(/\.ts$/, '.mjs')))).join(' ')}`, {
  stdio: 'inherit',
  cwd: root,
});
