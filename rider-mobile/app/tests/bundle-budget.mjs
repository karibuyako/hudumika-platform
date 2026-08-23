#!/usr/bin/env node
/* Bundle budget check for the rider web export.
 *
 * Usage: node tests/bundle-budget.mjs [path-to-web-export]
 *
 * Sums every .js file under the export directory (default: dist/) and fails
 * (exit 1) when the total exceeds BUNDLE_BUDGET_BYTES. Prints per-entry sizes
 * and the total. Node built-ins only — no dependencies.
 *
 * Run it after `npx expo export --platform web` (the CI step produces dist/).
 * If no export exists yet the script fails with a clear message so the budget
 * can never silently pass on an empty build.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 7.00 MB of JavaScript across all chunks. Rider now ships SlideConfirm,
 * realtime (WS + long-poll), sync/batch, heatmap, and full Meituan-parity
 * dispatch flows — baseline grew from 5.0 to 6.32 MB (2026-08-21 export).
 * 7 MB retains ~10% headroom; any further growth should be code-split
 * (e.g. lazy mock factories) rather than bumping again blindly.
 */
const BUNDLE_BUDGET_BYTES = 7.0 * 1024 * 1024;
const MB = 1024 * 1024;

const exportDir = process.argv[2] ?? 'dist';

function walkJs(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read export directory "${dir}" — run "npx expo export --platform web" first so the budget can be measured against a real build.`);
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walkJs(exportDir);
if (!files.length) {
  console.error(`Bundle budget: FAIL — no .js files under "${exportDir}".`);
  console.error('Run "npx expo export --platform web" first, then re-run this script.');
  process.exit(1);
}

const rows = files
  .map((f) => ({ name: relative(process.cwd(), f), size: statSync(f).size }))
  .sort((a, b) => b.size - a.size);

const total = rows.reduce((s, r) => s + r.size, 0);

console.log(`Bundle budget: ${(BUNDLE_BUDGET_BYTES / MB).toFixed(2)} MB max, measured against "${exportDir}"`);
for (const r of rows) {
  console.log(`  ${(r.size / MB).toFixed(3).padStart(8)} MB  ${r.name}`);
}
console.log(`  ${(total / MB).toFixed(3).padStart(8)} MB  TOTAL (${files.length} js files)`);

if (total > BUNDLE_BUDGET_BYTES) {
  console.error(
    `Bundle budget: FAIL — ${(total / MB).toFixed(2)} MB exceeds the ${(BUNDLE_BUDGET_BYTES / MB).toFixed(2)} MB budget by ${((total - BUNDLE_BUDGET_BYTES) / MB).toFixed(2)} MB.`,
  );
  process.exit(1);
}

console.log(`Bundle budget: OK — ${(total / MB).toFixed(2)} MB under the ${(BUNDLE_BUDGET_BYTES / MB).toFixed(2)} MB budget.`);
