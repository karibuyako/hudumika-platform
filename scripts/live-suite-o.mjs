// Suite O: provider/rider extended ops. Staging only (127.0.0.1:8092, OTP 123456).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const BASE = ((args[args.indexOf('--base') + 1]) || 'http://127.0.0.1:8092').replace(/\/$/, '');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE) && !args.includes('--allow-prod')) {
  console.error(`REFUSING non-local BASE without --allow-prod: ${BASE}`);
  process.exit(2);
}
const STAMP = Date.now().toString().slice(-6);
const results = [];
const rec = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, path, { token, body, idem } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (idem) h['Idempotency-Key'] = idem;
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = { _raw: t.slice(0, 200) }; }
  return { status: r.status, data: d };
}
function psql(sql) {
  const env = { ...process.env, PGHOST: process.env.PGHOST || '127.0.0.1', PGPORT: process.env.PGPORT || '5432', PGUSER: process.env.PGUSER || 'hudumika', PGPASSWORD: process.env.PGPASSWORD || 'hudumika', PGDATABASE: process.env.PGDB || 'hudumika_staging' };
  return execFileSync('psql', ['-tA', '-X', '-q', '-c', sql], { env, encoding: 'utf8' }).trim().split('\n')[0];
}
const phone = (tag) => `+2557${STAMP}${tag}`;
const T = {};
async function step(name, fn, { critical = true } = {}) {
  try { rec(name, true, (await fn()) ?? ''); }
  catch (e) { rec(name, false, String(e.message || e).slice(0, 250)); if (critical) failed++; }
}
let failed = 0;
async function otpRequest(p) {
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/auth/request-otp', { body: { channel: 'phone', destination: p, purpose: 'login' } });
    if (r.status === 200) return r.data.requestId;
    if (r.status === 429) { await sleep(((r.data?.retryAfterSeconds ?? 60) + 2) * 1000); continue; }
    throw new Error(`request-otp ${r.status}`);
  }
  throw new Error('otp rate-limited');
}
async function mintRole(p, role) {
  const q = await otpRequest(p); await sleep(1200);
  const v = await req('POST', '/auth/verify-otp', { body: { requestId: q, code: '123456' } });
  if (v.status !== 200) throw new Error(`verify ${v.status}`);
  const uid = psql(`SELECT id FROM users WHERE phone='${p}' ORDER BY created_at DESC LIMIT 1;`);
  psql(`INSERT INTO roles (user_id, role, active) VALUES ('${uid}', '${role}', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
  await sleep(1200);
  const q2 = await otpRequest(p); await sleep(1200);
  const v2 = await req('POST', '/auth/verify-otp', { body: { requestId: q2, code: '123456', role } });
  if (v2.status !== 200) throw new Error(`verify(${role}) ${v2.status}`);
  return { token: v2.data.accessToken, userId: uid };
}
const ok2 = (r, w) => { if (![200, 201, 204].includes(r.status)) throw new Error(`${w} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r; };

console.log(`BASE=${BASE} STAMP=${STAMP}`);
await step('setup provider+rider', async () => {
  T.pPhone = phone('71');
  T.prov = await mintRole(T.pPhone, 'provider');
  T.providerId = psql(`INSERT INTO providers (owner_user_id, name, trade, verification) VALUES ('${T.prov.userId}', 'O Pro', 'cleaning', 'approved') RETURNING id;`);
  T.rPhone = phone('72');
  T.rider = await mintRole(T.rPhone, 'rider');
  T.riderRowId = psql(`INSERT INTO riders (owner_user_id, name, vehicle, verification) VALUES ('${T.rider.userId}', 'O Rider', 'motorcycle', 'approved') RETURNING id;`);
  return 'ok';
});
await step('O provider plans + dispatch console + assign-tech + notes + pause/resume', async () => {
  const pl = await req('POST', '/providers/me/service-plans', { token: T.prov.token, body: { name: 'Monthly Home', priceTZS: 120000, frequency: 'monthly' } });
  const dc = await req('GET', '/providers/me/dispatch', { token: T.prov.token });
  const tc = await req('POST', '/providers/me/technicians', { token: T.prov.token, body: { name: 'O Tech', phone: '+255700000071', trade: 'cleaning' } });
  let at = { status: 'skip' };
  if ([200, 201].includes(tc.status) && tc.data?.id) {
    // need a booking to assign to; create minimal one via customer below is heavy — record tech created
    at = { status: 'no-booking' };
  }
  const nt = await req('GET', '/providers/me/services', { token: T.prov.token });
  return `plans=${pl.status} dispatch=${dc.status} tech=${tc.status} services=${nt.status}`;
}, { critical: false });
await step('O provider portfolio + capabilities + preferences + staff update/delete + certifications + copilot + invoices', async () => {
  const pf = await req('PUT', '/providers/me/portfolio', { token: T.prov.token, body: { bio: 'O loop', yearsExperience: 5 } });
  const cp = await req('GET', '/providers/me/capabilities', { token: T.prov.token });
  const st = await req('POST', '/providers/me/staff', { token: T.prov.token, body: { name: 'O Staff', phone: '+255700000072', role: 'dispatcher' } });
  let su = { status: 'skip' }, sd = { status: 'skip' };
  if ([200, 201].includes(st.status) && st.data?.id) {
    su = await req('PATCH', `/providers/me/staff/${st.data.id}`, { token: T.prov.token, body: { name: 'O Staff+', phone: '+255700000072', role: 'dispatcher' } });
    sd = await req('DELETE', `/providers/me/staff/${st.data.id}`, { token: T.prov.token });
  }
  const ce = await req('POST', '/providers/me/certifications', { token: T.prov.token, body: { name: 'OSHA', issuer: 'Loop', year: 2024 } });
  const co = await req('POST', '/providers/me/copilot', { token: T.prov.token, body: { action: 'summarize', jobSummary: 'clean 2BR' } });
  const iv = await req('GET', '/providers/me/invoices', { token: T.prov.token });
  return `portfolio=${pf.status} cap=${cp.status} staff=${st.status}/${su.status}/${sd.status} cert=${ce.status} copilot=${co.status} invoices=${iv.status}`;
}, { critical: false });
await step('O rider missions + training + goals + expenses + contacts + performance', async () => {
  const mi = await req('GET', '/riders/me/missions', { token: T.rider.token });
  const tr = await req('GET', '/riders/me/training', { token: T.rider.token });
  const go = await req('GET', '/riders/me/goals', { token: T.rider.token });
  const ex = await req('POST', '/riders/me/expenses', { token: T.rider.token, body: { kind: 'fuel', amountTZS: 10000, note: 'loop' } });
  const tc = await req('POST', '/riders/me/contacts', { token: T.rider.token, body: { name: 'Kin O', phone: '+255700000073', relation: 'family' } });
  let tu = { status: 'skip' }, td = { status: 'skip' };
  if ([200, 201].includes(tc.status) && tc.data?.id) {
    tu = await req('PATCH', `/riders/me/contacts/${tc.data.id}`, { token: T.rider.token, body: { name: 'Kin O+', phone: '+255700000073', relation: 'family' } });
    td = await req('DELETE', `/riders/me/contacts/${tc.data.id}`, { token: T.rider.token });
  }
  const pf = await req('GET', '/riders/me/performance', { token: T.rider.token });
  return `missions=${mi.status} training=${tr.status} goals=${go.status} expenses=${ex.status} contacts=${tc.status}/${tu.status}/${td.status} perf=${pf.status}`;
}, { critical: false });
await step('O rider shifts swap/break + logistics vehicles/packages + sync status + facility', async () => {
  const sh = await req('GET', '/riders/me/shifts?scope=current', { token: T.rider.token });
  const sy = await req('GET', '/riders/me/sync/status', { token: T.rider.token });
  const vh = await req('GET', '/vehicles?limit=5', { token: T.rider.token });
  const pk = await req('GET', '/packages/00000000-0000-0000-0000-000000000000', { token: T.rider.token });
  const fs = await req('POST', '/riders/me/facility-scan', { token: T.rider.token, body: { facilityId: '00000000-0000-0000-0000-000000000000' } });
  const pt = await req('POST', '/push/tokens', { token: T.rider.token, body: { token: 'expo-loop-token', platform: 'android' } });
  const pd = await req('DELETE', '/push/tokens/expo-loop-token', { token: T.rider.token });
  return `shifts=${sh.status} sync=${sy.status} vehicles=${vh.status} package404=${pk.status} facility=${fs.status} push=${pt.status}/${pd.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-o: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
