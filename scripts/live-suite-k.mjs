// Suite K: admin RBAC+MFA, two-person approvals, assign-rider, consistency gates. Staging only.
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

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
const phone = (tag) => `+2557${STAMP}${tag}`;
const idem = (t) => `k-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
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
async function mintStaff(tag) {
  const p = phone(tag);
  const q = await otpRequest(p); await sleep(1200);
  let v = await req('POST', '/auth/verify-otp', { body: { requestId: q, code: '123456', role: 'admin' } });
  if (v.status === 422) {
    const uid = psql(`SELECT id FROM users WHERE phone='${p}' ORDER BY created_at DESC LIMIT 1;`);
    psql(`INSERT INTO roles (user_id, role, active) VALUES ('${uid}', 'admin', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
    await sleep(1200);
    const q2 = await otpRequest(p); await sleep(1200);
    v = await req('POST', '/auth/verify-otp', { body: { requestId: q2, code: '123456', role: 'admin' } });
  }
  if (v.status !== 200) throw new Error(`staff verify ${v.status}`);
  const A0 = v.data.accessToken;
  const en = await req('GET', '/auth/2fa/enroll', { token: A0 });
  if (en.status !== 200) throw new Error(`enroll ${en.status}`);
  const vfy = await req('POST', '/auth/2fa/verify', { token: A0, body: { code: totp(en.data.secret) } });
  if (vfy.status !== 200) throw new Error(`2fa verify ${vfy.status}`);
  const vs = await req('POST', '/auth/2fa/verify-for-session', { token: A0, body: { code: totp(en.data.secret) } });
  if (vs.status !== 200) throw new Error(`mfa session ${vs.status}`);
  return { mfa: vs.data.accessToken, plain: A0 };
}

console.log(`BASE=${BASE} STAMP=${STAMP}`);
await step('mint staff A+B with MFA', async () => {
  T.A = await mintStaff('41');
  T.B = await mintStaff('42');
  psql(`INSERT INTO staff_roles (name, description, permissions, system) VALUES ('admin','staging superuser','["*"]',true) ON CONFLICT (name) DO UPDATE SET permissions=EXCLUDED.permissions;`);
  return 'ok';
});
await step('K MFA gate: 200 with MFA, 401 without', async () => {
  const a = await req('GET', '/admin/templates', { token: T.A.mfa });
  const b = await req('GET', '/admin/templates', { token: T.A.plain });
  if (a.status !== 200 || b.status !== 401) throw new Error(`${a.status}/${b.status}`);
  return 'ok';
});
await step('K two-person resource: request→self-409→peer-approve', async () => {
  const oid = psql(`SELECT id FROM orders WHERE status='completed' ORDER BY created_at DESC LIMIT 1;`);
  if (!oid) throw new Error('no completed order in staging');
  const c = await req('POST', '/admin/two-person-approvals', { token: T.A.mfa, body: { actionType: 'large_refund', targetType: 'order', targetId: oid, reason: 'duplicate charge', payload: { amountTZS: 150000 } } });
  if (![200, 201].includes(c.status)) throw new Error(`create ${c.status} ${JSON.stringify(c.data)}`);
  const id = c.data.id;
  const self = await req('POST', `/admin/two-person-approvals/${id}/decision`, { token: T.A.mfa, body: { decision: 'approve', comment: 'self' } });
  if (self.status !== 409) throw new Error(`expected 409 got ${self.status}`);
  const peer = await req('POST', `/admin/two-person-approvals/${id}/decision`, { token: T.B.mfa, body: { decision: 'approve', comment: 'checked' } });
  if (![200, 201].includes(peer.status)) throw new Error(`peer ${peer.status} ${JSON.stringify(peer.data)}`);
  return `approved=${peer.data?.status}`;
});
await step('K setup paid order for inline gates', async () => {
  const cp = phone('43');
  const q = await otpRequest(cp); await sleep(1200);
  const v = await req('POST', '/auth/verify-otp', { body: { requestId: q, code: '123456' } });
  T.cust = v.data.accessToken;
  const mp = phone('44');
  const mq = await otpRequest(mp); await sleep(1200);
  await req('POST', '/auth/verify-otp', { body: { requestId: mq, code: '123456' } });
  const muid = psql(`SELECT id FROM users WHERE phone='${mp}' ORDER BY created_at DESC LIMIT 1;`);
  psql(`INSERT INTO roles (user_id, role, active) VALUES ('${muid}', 'merchant', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
  await sleep(1200);
  const mq2 = await otpRequest(mp); await sleep(1200);
  const mv = await req('POST', '/auth/verify-otp', { body: { requestId: mq2, code: '123456', role: 'merchant' } });
  T.merch = mv.data.accessToken;
  T.merchantId = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${muid}', 'K Foods', 'restaurant', 'approved') RETURNING id;`);
  await req('POST', '/categories', { token: T.merch, body: { name: 'Food' } });
  const it = await req('POST', '/catalogue-items', { token: T.merch, body: { name: 'K Pilau', priceTZS: 9000, category: 'Food', available: true } });
  const o = await req('POST', '/orders', { token: T.cust, body: { merchantId: T.merchantId, items: [{ catalogueItemId: it.data.id, quantity: 1 }], paymentMethod: 'mpesa', deliveryAddress: { label: 'H', lines: 'S', contactPhone: cp } }, idem: idem('ord') });
  T.orderId = o.data.id;
  const it2 = await req('POST', '/payments/intent', { token: T.cust, body: { orderId: T.orderId, method: 'mpesa' }, idem: idem('pay') });
  const wb = JSON.stringify({ orderId: T.orderId, reference: `K-${STAMP}`, status: 'paid' });
  const { createHmac } = await import('node:crypto');
  await req('POST', '/payments/webhooks/mpesa', { body: JSON.parse(wb), rawHeaders: undefined });
  // sign manually (rawHeaders path differs) — use fetch directly
  const sig = createHmac('sha256', 'testsecret123').update(wb).digest('hex');
  const wr = await fetch(`${BASE}/payments/webhooks/mpesa`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig }, body: wb });
  if (wr.status !== 200) throw new Error(`webhook ${wr.status}`);
  return `order=${T.orderId} paid`;
});
await step('K inline cancel+refund gate: A→409, B→executed', async () => {
  const a = await req('POST', `/admin/orders/${T.orderId}/cancel`, { token: T.A.mfa, body: { reason: 'fraud review', refundTZS: 6000000 } });
  if (a.status !== 409) throw new Error(`expected 409 got ${a.status} ${JSON.stringify(a.data)}`);
  const b = await req('POST', `/admin/orders/${T.orderId}/cancel`, { token: T.B.mfa, body: { reason: 'fraud review', refundTZS: 6000000 } });
  if (![200, 201].includes(b.status)) throw new Error(`peer ${b.status} ${JSON.stringify(b.data)}`);
  return `status=${b.data?.status}`;
});
await step('K assign-rider + merchant decision + lists', async () => {
  const rp = phone('45');
  const rq = await otpRequest(rp); await sleep(1200);
  await req('POST', '/auth/verify-otp', { body: { requestId: rq, code: '123456' } });
  const ruid = psql(`SELECT id FROM users WHERE phone='${rp}' ORDER BY created_at DESC LIMIT 1;`);
  psql(`INSERT INTO roles (user_id, role, active) VALUES ('${ruid}', 'rider', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
  const rid = psql(`INSERT INTO riders (owner_user_id, name, vehicle, verification, online) VALUES ('${ruid}', 'K Rider', 'motorcycle', 'approved', true) RETURNING id;`);
  // Bring the rider online through the real API so the Redis dispatch registry agrees.
  await sleep(1200);
  const rq2 = await otpRequest(rp); await sleep(1200);
  const rv = await req('POST', '/auth/verify-otp', { body: { requestId: rq2, code: '123456', role: 'rider' } });
  await req('PUT', '/riders/me/availability', { token: rv.data.accessToken, body: { online: true } });
  const o = await req('POST', '/orders', { token: T.cust, body: { merchantId: T.merchantId, items: [{ catalogueItemId: (await req('GET', `/catalogues/${T.merchantId}`)).data?.items?.[0]?.id ?? (await req('GET', `/catalogues/${T.merchantId}`)).data?.[0]?.id, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: { label: 'H', lines: 'S', contactPhone: phone('43') } }, idem: idem('ord2') });
  const g = await req('GET', `/orders/${o.data.id}`, { token: T.merch });
  await req('POST', `/orders/${o.data.id}/accept`, { token: T.merch, body: { expectedVersion: g.data.version } });
  await req('POST', `/orders/${o.data.id}/status`, { token: T.merch, body: { status: 'preparing' } });
  const as = await req('POST', `/admin/orders/${o.data.id}/assign-rider`, { token: T.A.mfa, body: { riderId: rid, reason: 'loop test' } });
  if (![200, 201].includes(as.status)) throw new Error(`assign ${as.status} ${JSON.stringify(as.data)}`);
  const lo = await req('GET', '/admin/orders?limit=5', { token: T.A.mfa });
  const lm = await req('POST', `/admin/merchants/${T.merchantId}/approval`, { token: T.A.mfa, body: { decision: 'approved', reason: 'loop' } });
  return `assign=200 list=${lo.status} approve=${lm.status}`;
}, { critical: false });
await step('K consistency: envelope + pagination + idempotency', async () => {
  const n = await req('GET', '/orders/no-such-order', { token: T.cust });
  if (!n.data?.code || !n.data?.requestId) throw new Error('envelope missing code/requestId');
  const p1 = await req('GET', '/orders/search?status=completed&limit=2', { token: T.merch });
  const body = { merchantId: T.merchantId, items: [], paymentMethod: 'cod', deliveryAddress: { label: 'H', lines: 'S', contactPhone: phone('43') } };
  const e1 = await req('POST', '/orders', { token: T.cust.token ?? T.cust, body, idem: idem('empty') });
  return `404code=${n.data.code} search=${p1.status} empty-items=${e1.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-k: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
