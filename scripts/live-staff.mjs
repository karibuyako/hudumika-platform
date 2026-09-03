// Mint 2 staging staff+MFA sessions. Output: /tmp/opencode/live-tokens.json {A_MFA, B_MFA, A0}
// Requires: ENV=staging API (dev OTP 123456), migration 00132 applied.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8092').replace(/\/$/, '');
const STAMP = Date.now().toString().slice(-6);
const results = [];
const rec = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, path, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = { _raw: t.slice(0, 200) }; }
  return { status: r.status, data: d };
}
function psql(sql) {
  const env = { ...process.env, PGHOST: process.env.PGHOST || '127.0.0.1', PGPORT: process.env.PGPORT || '5432', PGUSER: process.env.PGUSER || 'hudumika', PGPASSWORD: process.env.PGPASSWORD || 'hudumika', PGDATABASE: process.env.PGDB || 'hudumika_staging' };
  return execFileSync('psql', ['-tA', '-X', '-q', '-c', sql], { env, encoding: 'utf8' }).trim().split('\n')[0];
}
function totp(base32, skew = 0) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{1,8}/g).map((b) => parseInt(b.padEnd(8, '0'), 2)));
  const counter = Math.floor(Date.now() / 30000) + skew;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
async function otpRequest(phone) {
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/auth/request-otp', { body: { channel: 'phone', destination: phone, purpose: 'login' } });
    if (r.status === 200) return r.data.requestId;
    if (r.status === 429) { await sleep(((r.data?.retryAfterSeconds ?? 60) + 2) * 1000); continue; }
    throw new Error(`request-otp ${r.status} ${JSON.stringify(r.data)}`);
  }
  throw new Error('request-otp rate-limited');
}

const out = {};
for (const [tag, key] of [['A', 'A_MFA'], ['B', 'B_MFA']]) {
  const phone = `+2557${STAMP}${tag === 'A' ? '11' : '22'}`;
  const reqId = await otpRequest(phone);
  await sleep(1200);
  let v = await req('POST', '/auth/verify-otp', { body: { requestId: reqId, code: '123456', role: 'admin' } });
  if (v.status === 422 && JSON.stringify(v.data).includes('ROLE_NOT_ACTIVE')) {
    const uid = psql(`SELECT id FROM users WHERE phone='${phone}' ORDER BY created_at DESC LIMIT 1;`);
    psql(`INSERT INTO roles (user_id, role, active) VALUES ('${uid}', 'admin', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
    await sleep(1200);
    const reqId2 = await otpRequest(phone);
    await sleep(1200);
    v = await req('POST', '/auth/verify-otp', { body: { requestId: reqId2, code: '123456', role: 'admin' } });
  }
  if (v.status !== 200) throw new Error(`staff ${tag} verify ${v.status} ${JSON.stringify(v.data)}`);
  rec(`staff ${tag} verify-otp admin`, true);
  const A0 = v.data.accessToken;
  out[tag === 'A' ? 'A0' : 'B0'] = A0;
  const en = await req('GET', '/auth/2fa/enroll', { token: A0 });
  let secret;
  if (en.status === 200) {
    secret = en.data.secret;
    rec(`staff ${tag} 2fa enroll`, true);
    const code = totp(secret);
    const vf = await req('POST', '/auth/2fa/verify', { token: A0, body: { code } });
    if (vf.status !== 200) throw new Error(`2fa verify ${vf.status} ${JSON.stringify(vf.data)}`);
    rec(`staff ${tag} 2fa verify (enable)`, true);
  } else if (en.status === 409) {
    // Secret exists in DB from a prior run; cannot recover it — re-enroll is blocked.
    // Fall through: try verify-for-session only if we have a secret (we don't) -> fail loudly.
    throw new Error(`staff ${tag} 2fa already enabled from prior run; use fresh phones (new stamp)`);
  } else {
    throw new Error(`enroll ${en.status} ${JSON.stringify(en.data)}`);
  }
  const code2 = totp(secret);
  const vs = await req('POST', '/auth/2fa/verify-for-session', { token: A0, body: { code: code2 } });
  if (vs.status !== 200) throw new Error(`verify-for-session ${vs.status} ${JSON.stringify(vs.data)}`);
  out[key] = vs.data.accessToken;
  rec(`staff ${tag} mfa session`, true);
}
psql(`INSERT INTO staff_roles (name, description, permissions, system) VALUES ('admin','staging superuser','["*"]',true) ON CONFLICT (name) DO UPDATE SET permissions=EXCLUDED.permissions;`);
const p1 = await req('GET', '/admin/templates', { token: out.A_MFA });
rec('admin/templates with MFA → 200', p1.status === 200, `status=${p1.status}`);
const p2 = await req('GET', '/admin/templates', { token: out.A0 });
rec('admin/templates without MFA → 401', p2.status === 401, `status=${p2.status}`);
writeFileSync('/tmp/opencode/live-tokens.json', JSON.stringify(out));
console.log('SAVED /tmp/opencode/live-tokens.json');
const failed = results.filter((r) => !r.ok).length;
console.log(`SIGNED live-staff: pass=${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
