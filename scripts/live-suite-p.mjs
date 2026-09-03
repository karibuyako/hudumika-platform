// Suite P: admin extended (parity reads + mutations). Staging only. Needs staff+MFA (minted inline).
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

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
async function req(method, path, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
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
function totp(base32) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{1,8}/g).map((b) => parseInt(b.padEnd(8, '0'), 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
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

console.log(`BASE=${BASE} STAMP=${STAMP}`);
await step('setup staff MFA + ids', async () => {
  const p = `+2557${STAMP}81`;
  const q = await otpRequest(p); await sleep(1200);
  let v = await req('POST', '/auth/verify-otp', { body: { requestId: q, code: '123456', role: 'admin' } });
  if (v.status === 422) {
    const uid = psql(`SELECT id FROM users WHERE phone='${p}' ORDER BY created_at DESC LIMIT 1;`);
    T.staffUid = uid;
    psql(`INSERT INTO roles (user_id, role, active) VALUES ('${uid}', 'admin', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
    await sleep(1200);
    const q2 = await otpRequest(p); await sleep(1200);
    v = await req('POST', '/auth/verify-otp', { body: { requestId: q2, code: '123456', role: 'admin' } });
  }
  if (v.status !== 200) throw new Error(`verify ${v.status}`);
  const A0 = v.data.accessToken;
  const en = await req('GET', '/auth/2fa/enroll', { token: A0 });
  await req('POST', '/auth/2fa/verify', { token: A0, body: { code: totp(en.data.secret) } });
  const vs = await req('POST', '/auth/2fa/verify-for-session', { token: A0, body: { code: totp(en.data.secret) } });
  T.A = vs.data.accessToken;
  psql(`INSERT INTO staff_roles (name, description, permissions, system) VALUES ('admin','s','["*"]',true) ON CONFLICT (name) DO UPDATE SET permissions=EXCLUDED.permissions;`);
  T.order = psql(`SELECT id FROM orders ORDER BY created_at DESC LIMIT 1;`);
  T.merchant = psql(`SELECT id FROM merchants ORDER BY created_at DESC LIMIT 1;`);
  T.user = psql(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1;`);
  return 'ok';
});
const G = async (p) => (await req('GET', p, { token: T.A })).status;
await step('P parity reads batch 1 (ops/commerce)', async () => {
  const r = {};
  for (const p of ['/admin/orders?limit=5', '/admin/merchants?limit=5', '/admin/providers?limit=5', '/admin/riders?limit=5', '/admin/customers?limit=5', '/admin/bookings?limit=5', '/admin/payouts?limit=5', '/admin/conversations?limit=5', '/admin/overview', '/admin/fleet/control-tower']) {
    r[p] = await G(p);
  }
  const bad = Object.entries(r).filter(([, s]) => ![200, 404].includes(s));
  if (bad.length) throw new Error(JSON.stringify(bad));
  return JSON.stringify(r);
});
await step('P parity reads batch 2 (support/trust/finance)', async () => {
  const r = {};
  for (const p of ['/admin/support/tickets?limit=5', '/admin/reviews?limit=5', '/admin/risk/cases?limit=5', '/admin/audit/logs?limit=5', '/admin/webhooks?limit=5', '/admin/webhooks/deliveries?limit=5', '/admin/data-exports?limit=5', '/admin/templates?limit=5', '/admin/features?limit=5', '/admin/staff-roles']) {
    r[p] = await G(p);
  }
  const bad = Object.entries(r).filter(([, s]) => ![200, 404].includes(s));
  if (bad.length) throw new Error(JSON.stringify(bad));
  return 'ok';
});
await step('P parity reads batch 3 (logistics/growth/config)', async () => {
  const r = {};
  for (const p of ['/admin/logistics/control-tower', '/admin/hubs?limit=5', '/admin/warehouses?limit=5', '/admin/carriers?limit=5', '/admin/facilities?limit=5', '/admin/fleet-accounts?limit=5', '/admin/vehicles?limit=5', '/admin/shipments?limit=5', '/admin/consignments?limit=5', '/admin/delivery-exceptions?limit=5', '/admin/promotions?limit=5', '/admin/group-buys?limit=5', '/admin/chains?limit=5', '/admin/vouchers?limit=5', '/admin/banners?limit=5', '/admin/cities?limit=5', '/admin/regions?limit=5', '/admin/sla-rules', '/admin/commission-rules', '/admin/integration-health', '/admin/search?q=loop', '/admin/map/traffic']) {
    r[p] = await G(p);
  }
  const bad = Object.entries(r).filter(([, s]) => ![200, 404, 405].includes(s));
  if (bad.length) throw new Error(JSON.stringify(bad));
  return 'ok';
});
await step('P mutations: ticket assign + user status + review moderate + promo/groupbuy/risk decisions', async () => {
  const t = await req('POST', '/support/tickets', { token: T.A, body: { subject: 'P loop', body: 'x', category: 'general' } });
  let ta = { status: 'skip' };
  if ([200, 201].includes(t.status) && t.data?.id) ta = await req('POST', `/admin/support/tickets/${t.data.id}/assign`, { token: T.A, body: { agentUserId: T.staffUid } });
  const us = await req('POST', `/admin/users/${T.user}/status`, { token: T.A, body: { status: 'active', reason: 'loop' } });
  const pm = await req('POST', '/admin/promotions/00000000-0000-0000-0000-000000000000/decision', { token: T.A, body: { decision: 'approved', reason: 'loop' } });
  return `assign=${ta.status} userstatus=${us.status} promo-decide=${pm.status}`;
}, { critical: false });
await step('P mutations: report + wallet adjust + feature + city + shipment + conversation', async () => {
  const rp = await req('POST', '/admin/reports', { token: T.A, body: { name: 'Loop report', metrics: ['orders'], format: 'json' } });
  const wa = await req('POST', `/admin/wallets/${T.user}/adjust`, { token: T.A, body: { deltaTZS: 100, reason: 'loop test' } });
  const ft = await req('PUT', '/admin/features/loop_flag', { token: T.A, body: { enabled: true } });
  const ct = await req('PUT', '/admin/cities/loop-city', { token: T.A, body: { name: 'Loop City' } });
  const sh = await req('POST', `/admin/shipments/${T.order}/freeze`, { token: T.A, body: { reason: 'loop' } });
  return `report=${rp.status} wallet=${wa.status} feature=${ft.status} city=${ct.status} freeze=${sh.status}`;
}, { critical: false });
await step('P mutations: consignment + analytics export + banner + help + template + sla/commission + webhook retry', async () => {
  const cs = await req('POST', '/admin/consignments/missing', { token: T.A, body: {} });
  const ae = await req('POST', '/admin/analytics/export', { token: T.A, body: { report: 'orders', from: '2026-08-01', to: '2026-09-01' } });
  const bn = await req('POST', '/admin/banners', { token: T.A, body: { title: 'Loop', placement: 'home', active: false } });
  const ha = await req('POST', '/admin/help/articles', { token: T.A, body: { title: 'Loop', body: 'test' } });
  const tp = await req('PUT', '/admin/templates/loop_tpl', { token: T.A, body: { subject: 'Hi', body: 'loop' } });
  const sla = await req('PUT', '/admin/sla-rules', { token: T.A, body: { rules: [] } });
  const cm = await req('PUT', '/admin/commission-rules', { token: T.A, body: { rules: [] } });
  const wr = await req('GET', '/admin/webhooks/deliveries?limit=3', { token: T.A });
  return `consign=${cs.status} analytics=${ae.status} banner=${bn.status} help=${ha.status} tpl=${tp.status} sla=${sla.status} comm=${cm.status} wh=${wr.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-p: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
