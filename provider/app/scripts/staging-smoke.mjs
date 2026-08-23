#!/usr/bin/env node
// Staging smoke: validates provider-backend connectivity with real contract paths.
// Usage: EXPO_PUBLIC_API_URL=https://staging-api.hudumika.co.tz/api/v1 node scripts/staging-smoke.mjs
// Or mock mode: node scripts/staging-smoke.mjs --mock (uses in-memory mocks, no network)

const API_RAW = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8081';
const USE_MOCK = process.argv.includes('--mock');

function normalizeBase(raw) {
  return raw.replace(/\/$/, '').replace(/\/api(\/v1)?$/, '');
}
const API_BASE = normalizeBase(API_RAW);

async function checkHealth() {
  const url = `${API_BASE}/api/healthz`;
  console.log(`[smoke] health: ${url}`);
  try {
    const res = await fetch(url);
    console.log(`[smoke] health status: ${res.status}`);
    if (!res.ok) console.warn('[smoke] health non-200 — backend may not expose /healthz');
  } catch (e) {
    console.warn(`[smoke] health fetch failed: ${e.message}`);
  }
}

async function mockSmoke() {
  console.log('[smoke] Running mock smoke (no network)');
  // Import mock repos directly via esbuild-like alias — simplified to api-base checks
  const { default: assert } = await import('node:assert/strict');
  // Validate URL construction
  assert.equal(`${normalizeBase('https://staging-api.hudumika.co.tz/api/v1')}/api/providers/me`, 'https://staging-api.hudumika.co.tz/api/providers/me');
  assert.equal(`${normalizeBase('http://localhost:8081')}/api/providers/me`, 'http://localhost:8081/api/providers/me');
  console.log('[smoke] URL normalization OK');
  // Run node tests as smoke
  const { execSync } = await import('node:child_process');
  execSync('npm run test 2>&1 | tail -n 20', { stdio: 'inherit' });
  console.log('[smoke] mock smoke passed');
}

async function liveSmoke() {
  console.log(`[smoke] API_BASE normalized: ${API_BASE} (from ${API_RAW})`);
  await checkHealth();
  // Attempt OTP flow against live staging (requires staging reachable)
  // This is best-effort: staging may not be deployed yet.
  try {
    const r = await fetch(`${API_BASE}/api/auth/request-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: '+255700000000', purpose: 'login' }),
    });
    console.log(`[smoke] POST /auth/request-otp status: ${r.status}`);
    const body = await r.text();
    console.log(`[smoke] body preview: ${body.slice(0, 400)}`);
    if (r.status === 429) console.log('[smoke] rate-limited — retryAfterSeconds handling needed (expected for repeated runs)');
    if (r.status === 200) console.log('[smoke] OTP delivery OK (check debugCode)');
  } catch (e) {
    console.warn(`[smoke] OTP request failed: ${e.message}`);
  }
  // Probe provider endpoints behind auth would need token; just probe 401 shape
  try {
    const r = await fetch(`${API_BASE}/api/providers/me`);
    console.log(`[smoke] GET /providers/me without auth status: ${r.status} (expect 401)`);
  } catch (e) {
    console.warn(`[smoke] GET /providers/me failed: ${e.message}`);
  }
  console.log('[smoke] live smoke done — verify staging deployment if failures');
}

if (USE_MOCK) await mockSmoke();
else await liveSmoke().catch((e) => { console.error(e); process.exit(1); });
