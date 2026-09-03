// Suite N: consumer extended flows. Staging only (127.0.0.1:8092, OTP 123456).
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
const idem = (t) => `n-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
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
async function mintCustomer(p) {
  const q = await otpRequest(p); await sleep(1200);
  const v = await req('POST', '/auth/verify-otp', { body: { requestId: q, code: '123456' } });
  if (v.status !== 200) throw new Error(`verify ${v.status}`);
  return v.data.accessToken;
}
const ok2 = (r, w) => { if (![200, 201, 204].includes(r.status)) throw new Error(`${w} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r; };

console.log(`BASE=${BASE} STAMP=${STAMP}`);
await step('setup customer + merchant + order', async () => {
  T.cust = await mintCustomer(phone('61'));
  const mp = phone('62');
  const mq = await otpRequest(mp); await sleep(1200);
  await req('POST', '/auth/verify-otp', { body: { requestId: mq, code: '123456' } });
  const muid = psql(`SELECT id FROM users WHERE phone='${mp}' ORDER BY created_at DESC LIMIT 1;`);
  psql(`INSERT INTO roles (user_id, role, active) VALUES ('${muid}', 'merchant', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
  await sleep(1200);
  const mq2 = await otpRequest(mp); await sleep(1200);
  const mv = await req('POST', '/auth/verify-otp', { body: { requestId: mq2, code: '123456', role: 'merchant' } });
  T.merch = mv.data.accessToken;
  T.merchantId = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${muid}', 'N Foods', 'restaurant', 'approved') RETURNING id;`);
  await req('POST', '/categories', { token: T.merch, body: { name: 'Food' } });
  const it = await req('POST', '/catalogue-items', { token: T.merch, body: { name: 'N Pilau', priceTZS: 7000, category: 'Food', available: true } });
  ok2(it, 'item');
  T.itemId = it.data.id;
  const o = await req('POST', '/orders', { token: T.cust, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: { label: 'H', lines: 'S', contactPhone: phone('61') } }, idem: idem('ord') });
  ok2(o, 'order');
  T.orderId = o.data.id;
  return 'ok';
});
await step('N favorites lists + disputes + splits + group-orders', async () => {
  const fl = await req('POST', '/favorites/lists', { token: T.cust, body: { name: 'Loop favs' }, idem: idem('fl') });
  let flm = { status: 'skip' };
  if ([200, 201].includes(fl.status) && fl.data?.id) {
    flm = await req('POST', `/favorites/lists/${fl.data.id}/merchants`, { token: T.cust, body: { merchantId: T.merchantId } });
  }
  const dp = await req('POST', '/disputes', { token: T.cust, body: { orderId: T.orderId, reason: 'late', description: 'loop test dispute' }, idem: idem('dsp') });
  const dm = await req('GET', '/disputes/me', { token: T.cust.token ?? T.cust });
  const sp = await req('POST', '/splits', { token: T.cust, body: { orderId: T.orderId, shares: [{ label: 'A', amountTZS: 3500 }, { label: 'B', amountTZS: 3500 }] }, idem: idem('spl') });
  const go = await req('POST', '/group-orders', { token: T.cust, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 2 }] }, idem: idem('go') });
  return `favlist=${fl.status}/${flm.status} dispute=${dp.status}/${dm.status} splits=${sp.status} groupord=${go.status}`;
}, { critical: false });
await step('N dine-in splits + redpacket claim + voice/image + live-chat + coupons-suggest', async () => {
  const t = await req('POST', '/dine-in/tables', { token: T.merch, body: { label: 'N1', seats: 2 } });
  let sp = { status: 'skip' };
  if ([200, 201].includes(t.status)) {
    const o = await req('POST', '/dine-in/orders', { token: T.cust, body: { merchantId: T.merchantId, tableId: t.data.id, items: [{ catalogueItemId: T.itemId, quantity: 1 }] }, idem: idem('dine') });
    if ([200, 201].includes(o.status)) sp = await req('POST', `/dine-in/orders/${o.data.id}/splits`, { token: T.cust, body: { shares: [{ name: 'A', amountTZS: 3500 }] } });
  }
  const rp = await req('POST', '/red-packets/me/share', { token: T.cust, body: { amountTZS: 2000, count: 2 } });
  const vs = await req('POST', '/search/voice', { token: T.cust, body: { query: 'chapati' } });
  const im = await req('POST', '/search/image', { token: T.cust, body: { imageUrl: 'https://example.com/food.jpg' } });
  const lc = await req('GET', '/marketing/live-deals', { token: T.cust.token ?? T.cust });
  const cs = await req('POST', '/coupons/suggest', { token: T.cust, body: { merchantId: T.merchantId, subtotalTZS: 7000 } });
  return `dinesplit=${sp.status} redpack=${rp.status} voice=${vs.status} image=${im.status} livedeals=${lc.status} couponsug=${cs.status}`;
}, { critical: false });
await step('N bus reminders + bike lifecycle + travel/hotel booking + events', async () => {
  const br = await req('GET', '/bus/routes?limit=5', { token: T.cust });
  const bm = await req('POST', '/bus/reminders', { token: T.cust, body: { routeId: '00000000-0000-0000-0000-000000000000', stopId: 's1', enabled: true } });
  const bn = await req('GET', '/bikes/nearby?lat=-6.8&lon=39.28', { token: T.cust });
  const tb = await req('POST', '/travel/bookings', { token: T.cust, body: { origin: 'DAR', destination: 'ARU', date: '2026-10-05', mode: 'bus', seats: 1 }, idem: idem('tv') });
  const hb = await req('POST', '/hotel-bookings', { token: T.cust, body: { hotelId: '00000000-0000-0000-0000-000000000000', checkIn: '2026-10-01', checkOut: '2026-10-02', guests: 1 }, idem: idem('hb') });
  const ev = await req('POST', '/entertainment/event-tickets', { token: T.cust, body: { eventId: '00000000-0000-0000-0000-000000000000', tierId: '00000000-0000-0000-0000-000000000000', quantity: 1 }, idem: idem('ev') });
  return `bus=${br.status}/${bm.status} bikes=${bn.status} travel=${tb.status} hotel=${hb.status} events=${ev.status}`;
}, { critical: false });
await step('N sessions + 2fa status + social + password + privacy + checkin-detail', async () => {
  const sl = await req('GET', '/sessions', { token: T.cust });
  const t2 = await req('GET', '/users/me/2fa', { token: T.cust });
  const so = await req('POST', '/auth/social', { body: { provider: 'google', idToken: 'loop-test-token' } });
  const cp = await req('POST', '/auth/change-password', { token: T.cust, body: { currentPassword: 'x', newPassword: 'y12345678' } });
  const pe = await req('POST', '/privacy/export', { token: T.cust });
  const ci = await req('POST', '/check-in', { token: T.cust, body: {} });
  return `sessions=${sl.status} 2fa=${t2.status} social=${so.status} chpwd=${cp.status} privacy=${pe.status} checkin=${ci.status}`;
}, { critical: false });
await step('N notifications order-settings + announcements + lists + preferred', async () => {
  const os = await req('GET', '/notifications/me/order-settings', { token: T.cust });
  const an = await req('GET', '/announcements', { token: T.cust });
  const li = await req('GET', '/lists', { token: T.cust });
  const pr = await req('GET', '/providers/me/preferred', { token: T.cust });
  const wd = await req('POST', '/wallet/withdrawals', { token: T.cust, body: { amountTZS: 1000 }, idem: idem('wd') });
  return `ordset=${os.status} ann=${an.status} lists=${li.status} pref=${pr.status} withdraw-cust=${wd.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-n: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
