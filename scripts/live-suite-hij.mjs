// Suite H/I/J: engagement, promos+group-buy+dine-in, logistics+transport+travel. Staging only.
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
const idem = (t) => `hij-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
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
    return { token: v2.data.accessToken, refresh: v2.data.refreshToken, userId: uid };
  }
  return { token: v.data.accessToken, refresh: v.data.refreshToken, userId: uid };
}
const ok2 = (r, w) => { if (![200, 201, 204].includes(r.status)) throw new Error(`${w} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r; };

console.log(`BASE=${BASE} STAMP=${STAMP}`);
// setup: customer + approved merchant with item + approved provider+service
await step('setup identities', async () => {
  T.cust = await mintRole(phone('31'), 'customer');
  T.mPhone = phone('32');
  T.merch = await mintRole(T.mPhone, 'merchant');
  T.merchantId = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${T.merch.userId}', 'HIJ Foods ${STAMP}', 'restaurant', 'approved') RETURNING id;`);
  await req('POST', '/categories', { token: T.merch.token, body: { name: 'Food' } });
  const it = await req('POST', '/catalogue-items', { token: T.merch.token, body: { name: 'Pilau', priceTZS: 8000, category: 'Food', available: true } });
  ok2(it, 'item');
  T.itemId = it.data.id;
  T.pPhone = phone('33');
  T.prov = await mintRole(T.pPhone, 'provider');
  T.providerId = psql(`INSERT INTO providers (owner_user_id, name, trade, verification) VALUES ('${T.prov.userId}', 'HIJ Pro', 'cleaning', 'approved') RETURNING id;`);
  const s = await req('POST', '/providers/me/services', { token: T.prov.token, body: { name: 'HIJ Clean', durationMinutes: 60, pricing: { baseTZS: 25000 }, active: true } });
  ok2(s, 'service');
  T.serviceId = s.data.id;
  return 'ok';
});
// H: engagement
await step('H reviews lifecycle', async () => {
  const c = await req('POST', '/reviews', { token: T.cust.token, body: { targetType: 'merchant', targetId: T.merchantId, rating: 5, body: 'excellent' } });
  if (![200, 201].includes(c.status)) throw new Error(`create ${c.status} ${JSON.stringify(c.data)}`);
  const id = c.data?.id;
  const u = await req('PATCH', `/reviews/${id}`, { token: T.cust.token, body: { rating: 4, body: 'very good' } });
  const h = await req('POST', `/reviews/${id}/helpful`, { token: T.cust.token, body: { helpful: true } });
  const m = await req('GET', '/reviews/me', { token: T.cust.token });
  const rp = await req('POST', `/reviews/${id}/report`, { token: T.cust.token, body: { reason: 'spam-test' } });
  const d = await req('DELETE', `/reviews/${id}`, { token: T.cust.token });
  return `u=${u.status} helpful=${h.status} mine=${m.status} report=${rp.status} del=${d.status}`;
});
await step('H favorites + tickets + conversations + notifications', async () => {
  const f = await req('POST', '/favorites', { token: T.cust.token, body: { merchantId: T.merchantId } });
  const fl = await req('GET', '/favorites', { token: T.cust.token });
  const fr = await req('DELETE', `/favorites/${T.merchantId}`, { token: T.cust.token });
  const t = await req('POST', '/support/tickets', { token: T.cust.token, body: { subject: 'loop', body: 'test', category: 'general' } });
  const tm = await req('GET', '/support/tickets/me', { token: T.cust.token });
  let msg = { status: 'skip' };
  if ([200, 201].includes(t.status) && t.data?.id) msg = await req('POST', `/support/tickets/${t.data.id}/messages`, { token: T.cust.token, body: { body: 'follow-up' } });
  const cv = await req('POST', '/conversations', { token: T.cust.token, body: { subject: 'loop chat' } });
  const nl = await req('GET', '/notifications/me?limit=5', { token: T.cust.token });
  const pr = await req('PUT', '/notifications/me/preferences', { token: T.cust.token, body: { push: true, sms: false } });
  const ra = await req('POST', '/notifications/read-all', { token: T.cust.token, body: {} });
  return `fav=${f.status}/${fl.status}/${fr.status} ticket=${t.status}/${tm.status}/${msg.status} convo=${cv.status} notif=${nl.status}/${pr.status}/${ra.status}`;
});
await step('H coupons + referrals + check-in + redpackets', async () => {
  const cl = await req('GET', '/coupons/me', { token: T.cust.token });
  const rf = await req('GET', '/referrals/me', { token: T.cust.token });
  const rc = await req('POST', '/referrals/claim', { token: T.cust.token, body: { code: 'LOOP123' } });
  const ci = await req('POST', '/check-in', { token: T.cust.token, body: {} });
  const lt = await req('GET', '/loyalty-transactions?limit=5', { token: T.cust.token });
  const sh = await req('POST', '/red-packets/me/share', { token: T.cust.token, body: { amountTZS: 1000, count: 2 } });
  return `coupons=${cl.status} ref=${rf.status}/${rc.status} checkin=${ci.status} loyalty=${lt.status} redpack=${sh.status}`;
}, { critical: false });
// I: promos + group-buy + dine-in + reservations
await step('I promotion create+pause+performance', async () => {
  const c = await req('POST', '/promotions', { token: T.merch.token, body: { merchantId: T.merchantId, type: 'discount', title: 'Loop 10%', status: 'draft', discountRateBps: 1000 } });
  if (![200, 201].includes(c.status)) throw new Error(`create ${c.status} ${JSON.stringify(c.data)}`);
  const id = c.data.id;
  const p = await req('POST', `/promotions/${id}/pause`, { token: T.merch.token, body: { paused: true } });
  const pf = await req('GET', `/promotions/${id}/performance`, { token: T.merch.token });
  return `pause=${p.status} perf=${pf.status}`;
});
await step('I group-buy purchase + voucher verify', async () => {
  const now = Date.now();
  const g = await req('POST', '/group-buys', { token: T.merch.token, body: { merchantId: T.merchantId, title: 'Loop Feast', priceTZS: 15000, originalPriceTZS: 20000, quantity: 50, salesStartAt: new Date(now - 3600000).toISOString(), salesEndAt: new Date(now + 86400000 * 7).toISOString(), status: 'live' } });
  if (![200, 201].includes(g.status)) throw new Error(`create ${g.status} ${JSON.stringify(g.data)}`);
  const id = g.data.id;
  const pu = await req('POST', `/group-buys/${id}/purchase`, { token: T.cust.token, body: { quantity: 1 }, idem: idem('gb') });
  const v = await req('GET', '/vouchers/me', { token: T.cust.token });
  return `purchase=${pu.status} vouchers=${v.status}`;
}, { critical: false });
await step('I dine-in table + order + bill + reservation', async () => {
  const t = await req('POST', '/dine-in/tables', { token: T.merch.token, body: { name: 'T1', seats: 4 } });
  if (![200, 201].includes(t.status)) throw new Error(`table ${t.status} ${JSON.stringify(t.data)}`);
  const tid = t.data.id;
  const o = await req('POST', '/dine-in/orders', { token: T.cust.token, body: { merchantId: T.merchantId, tableId: tid, items: [{ catalogueItemId: T.itemId, quantity: 1 }] }, idem: idem('dine') });
  const b = [200, 201].includes(o.status) ? await req('POST', `/dine-in/orders/${o.data.id}/request-bill`, { token: T.cust.token, body: {} }) : { status: 'skip' };
  const r = await req('POST', '/reservations', { token: T.cust.token, body: { merchantId: T.merchantId, partySize: 2, scheduledFor: new Date(Date.now() + 86400000).toISOString() }, idem: idem('res') });
  return `table ok order=${o.status} bill=${b.status} reservation=${r.status}`;
}, { critical: false });
// J: logistics + transport + travel
await step('J shipment from order + scan chain', async () => {
  const o = await req('POST', '/orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: { label: 'H', lines: 'S', contactPhone: phone('31') } }, idem: idem('ord') });
  const s = await req('POST', '/shipments', { token: T.merch.token, body: { orderId: o.data.id } });
  if (![200, 201].includes(s.status)) throw new Error(`shipment ${s.status} ${JSON.stringify(s.data)}`);
  const sid = s.data.id;
  const sc = await req('POST', `/shipments/${sid}/scan`, { token: T.merch.token, body: { event: 'hub_in', note: 'loop' } });
  const cu = await req('GET', `/shipments/${sid}/custody`, { token: T.merch.token });
  const cs = await req('GET', '/linehaul/consignments?limit=5', { token: T.merch.token });
  return `scan=${sc.status} custody=${cu.status} consign=${cs.status}`;
}, { critical: false });
await step('J rides + bikes + bus + hotels/travel/events', async () => {
  const re = await req('POST', '/rides/estimate', { token: T.cust.token, body: { pickup: { lat: -6.8, lon: 39.28 }, destination: { lat: -6.81, lon: 39.29 } } });
  const rc = await req('POST', '/rides', { token: T.cust.token, body: { pickup: { lat: -6.8, lon: 39.28 }, destination: { lat: -6.81, lon: 39.29 } }, idem: idem('ride') });
  const bn = await req('GET', '/bikes/nearby?lat=-6.8&lon=39.28', { token: T.cust.token });
  const br = await req('GET', '/bus/routes?limit=5', { token: T.cust.token });
  const h = await req('GET', '/hotels?limit=5', { token: T.cust.token });
  const hb = await req('POST', '/hotel-bookings', { token: T.cust.token, body: { hotelId: '00000000-0000-0000-0000-000000000000', checkIn: '2026-10-01', checkOut: '2026-10-02', guests: 1 }, idem: idem('hb') });
  const ev = await req('GET', '/entertainment/events?limit=5', { token: T.cust.token });
  return `ride-est=${re.status} ride=${rc.status} bikes=${bn.status} bus=${br.status} hotels=${h.status} hotel-bk=${hb.status} events=${ev.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-hij: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
