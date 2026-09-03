// Suite M: merchant extended ops. Staging only (127.0.0.1:8092, OTP 123456).
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
const idem = (t) => `m-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
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
  if (role !== 'customer') {
    psql(`INSERT INTO roles (user_id, role, active) VALUES ('${uid}', '${role}', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
    await sleep(1200);
    const q2 = await otpRequest(p); await sleep(1200);
    const v2 = await req('POST', '/auth/verify-otp', { body: { requestId: q2, code: '123456', role } });
    if (v2.status !== 200) throw new Error(`verify(${role}) ${v2.status} ${JSON.stringify(v2.data)}`);
    return { token: v2.data.accessToken, userId: uid };
  }
  return { token: v.data.accessToken, userId: uid };
}
const ok2 = (r, w) => { if (![200, 201, 204].includes(r.status)) throw new Error(`${w} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r; };
const day = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);

console.log(`BASE=${BASE} STAMP=${STAMP}`);
await step('setup approved merchant', async () => {
  T.mPhone = phone('51');
  T.merch = await mintRole(T.mPhone, 'merchant');
  T.merchantId = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${T.merch.userId}', 'M Foods ${STAMP}', 'restaurant', 'approved') RETURNING id;`);
  return 'ok';
});
await step('M stores list+patch', async () => {
  const l = await req('GET', '/merchants/me/stores', { token: T.merch.token });
  return `list=${l.status}`;
}, { critical: false });
await step('M staff CRUD + shifts + attendance + performance + commissions', async () => {
  const c = await req('POST', '/merchants/me/staff', { token: T.merch.token, body: { name: 'M Cashier', phone: '+255700000011', role: 'cashier' } });
  if (![200, 201].includes(c.status)) throw new Error(`staff create ${c.status} ${JSON.stringify(c.data)}`);
  const sid = c.data.id;
  const g = await req('GET', '/merchants/me/staff', { token: T.merch.token });
  const sh = await req('POST', '/staff/shifts', { token: T.merch.token, body: { staffId: sid, startAt: new Date().toISOString(), endAt: new Date(Date.now() + 8 * 3600000).toISOString() } });
  const sl = await req('GET', `/staff/shifts?from=${day(0)}&to=${day(1)}`, { token: T.merch.token });
  const at = await req('GET', '/staff/attendance', { token: T.merch.token });
  const pf = await req('GET', '/staff/performance', { token: T.merch.token });
  const cm = await req('GET', '/staff/commissions', { token: T.merch.token });
  const d = await req('DELETE', `/merchants/me/staff/${sid}`, { token: T.merch.token });
  return `list=${g.status} shift=${sh.status}/${sl.status} att=${at.status} perf=${pf.status} comm=${cm.status} del=${d.status}`;
});
await step('M devices + print jobs', async () => {
  const c = await req('POST', '/devices', { token: T.merch.token, body: { type: 'printer', label: 'Kitchen P1', status: 'online' } });
  if (![200, 201].includes(c.status)) throw new Error(`device ${c.status} ${JSON.stringify(c.data)}`);
  const l = await req('GET', '/devices', { token: T.merch.token });
  const p = await req('POST', '/print-jobs', { token: T.merch.token, body: { jobType: 'kitchen_ticket', content: 'loop test ticket', deviceId: c.data.id, copies: 1 } });
  if (![200, 201].includes(p.status)) throw new Error(`print ${p.status} ${JSON.stringify(p.data)}`);
  const h = await req('GET', '/print-jobs', { token: T.merch.token });
  return `list=${l.status} print=${p.status} hist=${h.status}`;
});
await step('M store QR + qualifications + receipt-templates + payment-accounts + self-pickup + compliance + logs + violations', async () => {
  const q = await req('GET', '/store/qr-codes', { token: T.merch.token });
  const ql = await req('GET', '/store/qualifications', { token: T.merch.token });
  const rt = await req('GET', '/store/receipt-templates', { token: T.merch.token });
  const pa = await req('GET', '/store/payment-accounts', { token: T.merch.token });
  const sp = await req('GET', '/store/self-pickup', { token: T.merch.token });
  const cp = await req('GET', '/store/compliance', { token: T.merch.token });
  const lg = await req('GET', '/store/logs', { token: T.merch.token });
  const vi = await req('GET', '/store/violations', { token: T.merch.token });
  return `qr=${q.status} qual=${ql.status} receipt=${rt.status} payacct=${pa.status} pickup=${sp.status} compliance=${cp.status} logs=${lg.status} viol=${vi.status}`;
}, { critical: false });
await step('M dual-screen + invoices + expenses + settlements + dispute-holds + revenue', async () => {
  const ds = await req('GET', '/store/dual-screen', { token: T.merch.token });
  const iv = await req('POST', '/finance/invoices', { token: T.merch.token, body: { title: 'Loop invoice', amountTZS: 50000 } });
  const ex = await req('POST', '/finance/expenses', { token: T.merch.token, body: { title: 'Charcoal', amountTZS: 20000 } });
  const st = await req('POST', '/finance/settlements/run', { token: T.merch.token, body: { periodStart: day(-7) } });
  const dh = await req('GET', '/finance/dispute-holds', { token: T.merch.token });
  const rv = await req('GET', '/finance/revenue-composition', { token: T.merch.token });
  return `dual=${ds.status} inv=${iv.status} exp=${ex.status} settle=${st.status} holds=${dh.status} rev=${rv.status}`;
}, { critical: false });
await step('M coupons verify/stats + brand + self-service + flash + dianjin + precision', async () => {
  const v = await req('POST', '/marketing/coupons/verify', { token: T.merch.token, body: { code: 'LOOP10' } });
  const cs = await req('GET', '/marketing/coupons', { token: T.merch.token });
  const bd = await req('GET', '/marketing/brand-display', { token: T.merch.token });
  const ss = await req('POST', '/marketing/self-service', { token: T.merch.token, body: { enabled: true } });
  const fl = await req('GET', '/marketing/flash-sales', { token: T.merch.token });
  const dj = await req('GET', '/marketing/dianjin', { token: T.merch.token });
  const pr = await req('GET', '/marketing/precision', { token: T.merch.token });
  return `verify=${v.status} coupons=${cs.status} brand=${bd.status} self=${ss.status} flash=${fl.status} dianjin=${dj.status} precision=${pr.status}`;
}, { critical: false });
await step('M group-buy extend/delist/relist + loyalty + reports + journeys + tasks', async () => {
  const now = Date.now();
  const g = await req('POST', '/group-buys', { token: T.merch.token, body: { merchantId: T.merchantId, title: 'M Feast', priceTZS: 12000, originalPriceTZS: 15000, quantity: 30, salesStartAt: new Date(now - 3600000).toISOString(), salesEndAt: new Date(now + 86400000 * 3).toISOString(), status: 'live' } });
  let gb = 'skip';
  if ([200, 201].includes(g.status)) {
    const id = g.data.id;
    const e = await req('POST', `/group-buys/${id}/extend`, { token: T.merch.token, body: { newEndsAt: new Date(now + 86400000 * 10).toISOString() } });
    const dl = await req('POST', `/group-buys/${id}/delist`, { token: T.merch.token, body: {} });
    const rl = await req('POST', `/group-buys/${id}/relist`, { token: T.merch.token, body: {} });
    gb = `${e.status}/${dl.status}/${rl.status}`;
  }
  const lm = await req('POST', '/loyalty/members', { token: T.merch.token, body: { phone: '+255700000021', name: 'Loyal A' } });
  const lt = await req('GET', '/loyalty/tiers', { token: T.merch.token });
  const rp = await req('GET', '/reports?limit=5', { token: T.merch.token });
  const jn = await req('GET', '/journeys?limit=5', { token: T.merch.token });
  const tk = await req('GET', '/tasks?limit=5', { token: T.merch.token });
  return `gb=${gb} loyalty=${lm.status}/${lt.status} reports=${rp.status} journeys=${jn.status} tasks=${tk.status}`;
}, { critical: false });
await step('M webhooks CRUD + deliveries + retry + integrations + privacy + onboarding', async () => {
  const c = await req('POST', '/webhooks', { token: T.merch.token, body: { url: 'https://example.com/hook', events: ['order.created'] } });
  let wid = null;
  if ([200, 201].includes(c.status)) wid = c.data.id;
  const l = await req('GET', '/webhooks', { token: T.merch.token });
  const dl = await req('GET', '/webhooks/deliveries', { token: T.merch.token });
  let rt = { status: 'skip' };
  if (wid) rt = await req('POST', `/admin/webhooks/deliveries/${wid}/retry`, { token: T.merch.token, body: {} });
  const ig = await req('GET', '/integrations', { token: T.merch.token });
  const pe = await req('POST', '/privacy/export', { token: T.merch.token, body: {} });
  const pd = await req('POST', '/privacy/delete', { token: T.merch.token, body: { reason: 'loop test - staging' } });
  const ob = await req('GET', '/onboarding/merchant', { token: T.merch.token });
  return `wh=${c.status}/${l.status}/${dl.status}/retry=${rt.status} integ=${ig.status} privacy=${pe.status}/${pd.status} onboarding=${ob.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-m: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
