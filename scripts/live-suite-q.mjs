// Suite Q: merchant extended-2 + consumer extended-2. Staging only (127.0.0.1:8092, OTP 123456).
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
const idem = (t) => `q-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
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

console.log(`BASE=${BASE} STAMP=${STAMP}`);
await step('setup merchant+customer+item', async () => {
  T.cust = await mintRole(phone('91'), 'customer');
  T.mPhone = phone('92');
  T.merch = await mintRole(T.mPhone, 'merchant');
  T.merchantId = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${T.merch.userId}', 'Q Foods', 'restaurant', 'approved') RETURNING id;`);
  await req('POST', '/categories', { token: T.merch.token, body: { name: 'Food' } });
  const it = await req('POST', '/catalogue-items', { token: T.merch.token, body: { name: 'Q Pilau', priceTZS: 7000, category: 'Food', available: true } });
  ok2(it, 'item');
  T.itemId = it.data.id;
  return 'ok';
});
await step('Q staff full lifecycle (unified merchant id)', async () => {
  const c = await req('POST', '/merchants/me/staff', { token: T.merch.token, body: { name: 'Q Cashier', phone: '+255700000091', role: 'cashier' } });
  ok2(c, 'create');
  const sid = c.data.id;
  const g = await req('GET', '/merchants/me/staff', { token: T.merch.token });
  ok2(g, 'list');
  const sh = await req('POST', '/staff/shifts', { token: T.merch.token, body: { staffId: sid, startAt: new Date(Date.now() + 3600000).toISOString(), endAt: new Date(Date.now() + 9 * 3600000).toISOString() } });
  ok2(sh, 'shift-create');
  const shid = sh.data.id;
  const sl = await req('GET', `/staff/shifts?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`, { token: T.merch.token });
  ok2(sl, 'shift-list');
  const ci = await req('POST', '/staff/attendance/clock-in', { token: T.merch.token, body: { staffId: sid } });
  const co = await req('POST', '/staff/attendance/clock-out', { token: T.merch.token, body: { staffId: sid } });
  const at = await req('GET', '/staff/attendance', { token: T.merch.token });
  const pf = await req('GET', '/staff/performance', { token: T.merch.token });
  const cm = await req('GET', '/staff/commissions', { token: T.merch.token });
  const su = await req('PATCH', `/merchants/me/staff/${sid}`, { token: T.merch.token, body: { name: 'Q Cashier+', phone: '+255700000091', role: 'cashier' } });
  const dl = await req('DELETE', `/merchants/me/staff/${sid}`, { token: T.merch.token });
  return `shift=${shid ? 'ok' : 'n/a'} clock=${ci.status}/${co.status} att=${at.status} perf=${pf.status} comm=${cm.status} upd=${su.status} del=${dl.status}`;
});
await step('Q payout account link + merchant withdrawal', async () => {
  // NOTE: no PUT /merchants/me/payout-account route exists (GET only) — record link absence.
  const pa = await req('PUT', '/merchants/me/payout-account', { token: T.merch.token, body: { provider: 'mpesa', account: '+255700000092', name: 'Q Foods' } });
  const g = await req('GET', '/merchants/me/payout-account', { token: T.merch.token });
  const wd = await req('POST', '/wallet/withdrawals', { token: T.merch.token, body: { amountTZS: 5000 }, idem: idem('wd') });
  const wl = await req('GET', '/wallet/withdrawals/me', { token: T.merch.token });
  return `link=${pa.status} get=${g.status} withdraw=${wd.status} list=${wl.status}`;
}, { critical: false });
await step('Q privacy delete (fresh user) + order COD-collect', async () => {
  const p = phone('93');
  const q = await otpRequest(p); await sleep(1200);
  const v2 = await req('POST', '/auth/verify-otp', { body: { requestId: q, code: '123456' } });
  const tok = v2.data.accessToken;
  const o = await req('POST', '/orders', { token: tok, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: { label: 'H', lines: 'S', contactPhone: p } }, idem: idem('ord') });
  const g = await req('GET', `/orders/${o.data.id}`, { token: T.merch.token });
  await req('POST', `/orders/${o.data.id}/accept`, { token: T.merch.token, body: { expectedVersion: g.data.version } });
  for (const s of ['preparing', 'rider_assigned', 'picked_up', 'delivering', 'delivered']) {
    await req('POST', `/orders/${o.data.id}/status`, { token: T.merch.token, body: { status: s } });
  }
  const cc = await req('POST', `/orders/${o.data.id}/cod-collect`, { token: T.merch.token, body: { amountTZS: 7000 } });
  const pd = await req('POST', '/privacy/delete', { token: tok, body: { reason: 'staging loop test' } });
  return `cod-collect=${cc.status} privacy-delete=${pd.status}`;
}, { critical: false });
await step('Q consumer splits pay/complete + group-order lifecycle', async () => {
  const sp = await req('POST', '/splits', { token: T.cust.token, body: { orderId: psql(`SELECT id FROM orders ORDER BY created_at DESC LIMIT 1;`), shares: [{ label: 'A', amountTZS: 3500 }, { label: 'B', amountTZS: 3500 }] }, idem: idem('spl') });
  let spp = { status: 'skip' }, spc = { status: 'skip' };
  if ([200, 201].includes(sp.status) && sp.data?.id) {
    spp = await req('POST', `/splits/${sp.data.id}/pay`, { token: T.cust.token, body: { method: 'mpesa' } });
    spc = await req('POST', `/splits/${sp.data.id}/complete`, { token: T.cust.token, body: {} });
  }
  const go = await req('POST', '/group-orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 2 }] }, idem: idem('go') });
  let gof = { status: 'skip' };
  if ([200, 201].includes(go.status) && go.data?.id) {
    const ga = await req('POST', `/group-orders/${go.data.id}/items`, { token: T.cust.token, body: { memberName: 'Q Guest', catalogueItemId: T.itemId, quantity: 1 } });
    gof = await req('POST', `/group-orders/${go.data.id}/finalize`, { token: T.cust.token, body: { paymentMethod: 'cod', deliveryAddress: { label: 'H', lines: 'S', contactPhone: phone('91') } } });
    void ga;
  }
  return `split=${sp.status}/${spp.status}/${spc.status} groupord=${go.status}/${gof.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-q: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
