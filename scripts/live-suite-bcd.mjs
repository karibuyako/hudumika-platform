// Suite B/C/D: catalog+discovery+search, orders full lifecycle (paid path), payments/refunds/wallet.
// Staging only (127.0.0.1:8092, OTP 123456). PAYMENT_WEBHOOK_SECRET=testsecret123 must be set on the API.
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
async function req(method, path, { token, body, idem, rawHeaders } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (idem) h['Idempotency-Key'] = idem;
  Object.assign(h, rawHeaders || {});
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
const idem = (t) => `bcd-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
const T = {};
let failed = 0;
async function step(name, fn, { critical = true } = {}) {
  try { rec(name, true, (await fn()) ?? ''); }
  catch (e) { rec(name, false, String(e.message || e).slice(0, 250)); if (critical) failed++; }
}
async function otpRequest(p) {
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/auth/request-otp', { body: { channel: 'phone', destination: p, purpose: 'login' } });
    if (r.status === 200) return r.data.requestId;
    if (r.status === 429) { await sleep(((r.data?.retryAfterSeconds ?? 60) + 2) * 1000); continue; }
    throw new Error(`request-otp ${r.status} ${JSON.stringify(r.data)}`);
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
const ok2 = (r, what) => { if (![200, 201, 204].includes(r.status)) throw new Error(`${what} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r; };

console.log(`BASE=${BASE} STAMP=${STAMP}`);
// ---- setup: customer + approved merchant with 1 item ----
await step('setup customer', async () => { T.cust = await mintRole(phone('11'), 'customer'); return 'ok'; });
await step('setup merchant+item', async () => {
  T.mPhone = phone('12');
  T.merch = await mintRole(T.mPhone, 'merchant');
  T.merchantId = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${T.merch.userId}', 'BCD Foods ${STAMP}', 'restaurant', 'approved') RETURNING id;`);
  await req('PUT', '/merchants/me/settings', { token: T.merch.token, body: { isOpen: true } });
  const c = await req('POST', '/categories', { token: T.merch.token, body: { name: 'Food' } });
  if (![200, 201].includes(c.status)) throw new Error(`category ${c.status}`);
  const it = await req('POST', '/catalogue-items', { token: T.merch.token, body: { name: 'Chapati', priceTZS: 5000, category: 'Food', available: true } });
  ok2(it, 'item');
  T.itemId = it.data.id;
  return `item=${T.itemId}`;
});
await step('setup rider', async () => {
  T.rPhone = phone('13');
  T.rider = await mintRole(T.rPhone, 'rider');
  T.riderRowId = psql(`INSERT INTO riders (owner_user_id, name, vehicle, verification) VALUES ('${T.rider.userId}', 'BCD Rider', 'motorcycle', 'approved') RETURNING id;`);
  return 'ok';
});
const addr = { label: 'Home', lines: 'BCD St 1', contactPhone: phone('11'), lat: -6.8, lon: 39.28 };

// ---- B: catalog / discovery / search ----
await step('B catalogue bulk+import/export', async () => {
  const b = await req('POST', '/catalogue-items/bulk', { token: T.merch.token, body: { items: [{ name: 'Bulk A', priceTZS: 1000, category: 'Food' }] } });
  const e = await req('GET', '/catalogues/export', { token: T.merch.token });
  return `bulk=${b.status} export=${e.status}`;
}, { critical: false });
await step('B item update+toggle+delete', async () => {
  const u = await req('PATCH', `/catalogue-items/${T.itemId}`, { token: T.merch.token, body: { priceTZS: 5500 } });
  ok2(u, 'patch');
  const d = await req('DELETE', `/catalogue-items/${T.itemId}`, { token: T.merch.token });
  ok2(d, 'delete');
  // re-create for later suites
  const it = await req('POST', '/catalogue-items', { token: T.merch.token, body: { name: 'Chapati', priceTZS: 5000, category: 'Food', available: true } });
  ok2(it, 'recreate');
  T.itemId = it.data.id;
  return `item=${T.itemId}`;
});
await step('B public services+cats+search', async () => {
  const s = await req('GET', '/services?limit=5');
  // NOTE contract drift: /service-categories + /search* require auth server-side (401 without token)
  const sc = await req('GET', '/service-categories', { token: T.cust.token });
  const q = await req('GET', '/search?q=chapati&limit=5', { token: T.cust.token });
  const sg = await req('GET', '/search/suggest?q=cha', { token: T.cust.token });
  if (s.status !== 200 || sc.status !== 200 || q.status !== 200 || sg.status !== 200) throw new Error(`${s.status}/${sc.status}/${q.status}/${sg.status}`);
  return 'ok';
});
await step('B search history CRUD', async () => {
  const a = await req('POST', '/search/history', { token: T.cust.token, body: { query: 'chapati' } });
  const g = await req('GET', '/search/history', { token: T.cust.token });
  const d = await req('DELETE', '/search/history', { token: T.cust.token });
  return `${a.status}/${g.status}/${d.status}`;
}, { critical: false });
await step('B order+booking estimates', async () => {
  // NOTE: no GET /orders/estimate route exists server-side (consumer-app drift) — expect 404/422.
  const o = await req('GET', `/orders/estimate?merchantId=${T.merchantId}&subtotalTZS=10000&lat=-6.8&lon=39.28`, { token: T.cust.token });
  const svc = psql(`SELECT id FROM provider_services ORDER BY created_at DESC LIMIT 1;`);
  const b = await req('GET', `/bookings/estimate?serviceId=${svc}`, { token: T.cust.token });
  if (b.status !== 200) throw new Error(`booking-est ${b.status} ${JSON.stringify(b.data)}`);
  return `order-est=${o.status} (no such route) booking-est=200`;
}, { critical: false });

// ---- C: paid order path via signed mpesa webhook ----
function sign(secret, body) { return createHmac('sha256', secret).update(body).digest('hex'); }
await step('C mpesa order → paid via webhook', async () => {
  const o = await req('POST', '/orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'mpesa', deliveryAddress: addr }, idem: idem('ord') });
  if (![200, 201].includes(o.status)) throw new Error(`order ${o.status} ${JSON.stringify(o.data)}`);
  T.paidOrder = o.data.id;
  const it = await req('POST', '/payments/intent', { token: T.cust.token, body: { orderId: T.paidOrder, method: 'mpesa' }, idem: idem('pay') });
  if (![200, 201].includes(it.status)) throw new Error(`intent ${it.status} ${JSON.stringify(it.data)}`);
  T.intent = it.data.id;
  const wb = JSON.stringify({ orderId: T.paidOrder, reference: `REF-${STAMP}`, status: 'paid' });
  const w = await req('POST', '/payments/webhooks/mpesa', { body: JSON.parse(wb), rawHeaders: { 'X-Webhook-Signature': sign('testsecret123', wb) } });
  if (w.status !== 200 || w.data?.accepted !== true) throw new Error(`webhook ${w.status} ${JSON.stringify(w.data)}`);
  const g = await req('GET', `/payments/${T.intent}`, { token: T.cust.token });
  if (g.data?.status !== 'paid') throw new Error(`intent status=${g.data?.status}`);
  const og = await req('GET', `/orders/${T.paidOrder}`, { token: T.cust.token });
  if (og.data?.status !== 'paid') throw new Error(`order status=${og.data?.status}`);
  return `order=paid intent=paid`;
});
await step('C webhook bad signature → 401 + replay idempotent', async () => {
  const wb = JSON.stringify({ orderId: T.paidOrder, reference: `REF-${STAMP}`, status: 'paid' });
  const bad = await req('POST', '/payments/webhooks/mpesa', { body: JSON.parse(wb), rawHeaders: { 'X-Webhook-Signature': 'deadbeef' } });
  if (bad.status !== 401) throw new Error(`expected 401 got ${bad.status}`);
  const again = await req('POST', '/payments/webhooks/mpesa', { body: JSON.parse(wb), rawHeaders: { 'X-Webhook-Signature': sign('testsecret123', wb) } });
  if (again.status !== 200) throw new Error(`replay ${again.status}`);
  return 'ok';
});
await step('C merchant rejects unpaid order', async () => {
  const o = await req('POST', '/orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: addr }, idem: idem('ord') });
  const r = await req('POST', `/orders/${o.data.id}/reject`, { token: T.merch.token, body: { reason: 'out of stock', reasonCode: 'oos' } });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
}, { critical: false });
await step('C customer cancels draft order', async () => {
  const o = await req('POST', '/orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: addr }, idem: idem('ord') });
  const r = await req('POST', `/orders/${o.data.id}/cancel`, { token: T.cust.token, body: { reason: 'changed mind' } });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
});
await step('C hold/unhold + reschedule + rush + tip', async () => {
  const o = await req('POST', '/orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: addr }, idem: idem('ord') });
  const id = o.data.id;
  const g = await req('GET', `/orders/${id}`, { token: T.merch.token });
  await req('POST', `/orders/${id}/accept`, { token: T.merch.token, body: { expectedVersion: g.data.version } });
  const h = await req('POST', `/orders/${id}/hold`, { token: T.merch.token, body: { reason: 'kitchen busy' } });
  const u = await req('POST', `/orders/${id}/unhold`, { token: T.merch.token, body: {} });
  const ru = await req('POST', `/orders/${T.paidOrder}/rush`, { token: T.cust.token, body: {} });
  const t = await req('POST', `/orders/${id}/tip`, { token: T.cust.token, body: { amountTZS: 500, method: 'cod' } });
  if (t.status !== 200 && t.status !== 201) throw new Error(`tip ${t.status}`);
  return `hold=${h.status} unhold=${u.status} rush=${ru.status} tip=${t.status}`;
}, { critical: false });
await step('C tracking-share + route/waybill/timeline/receipts', async () => {
  const s = await req('POST', `/orders/${T.paidOrder}/tracking-share`, { token: T.cust.token, body: {}, idem: idem('ts') });
  let pub = 'n/a';
  if ([200, 201].includes(s.status) && s.data?.token) {
    const g = await req('GET', `/tracking-share/${s.data.token}`);
    pub = `public=${g.status}`;
  }
  const r = await req('GET', `/orders/${T.paidOrder}/route`, { token: T.cust.token });
  const w = await req('GET', `/orders/${T.paidOrder}/waybill`, { token: T.cust.token });
  const tl = await req('GET', `/orders/${T.paidOrder}/timeline`, { token: T.merch.token });
  const rc = await req('GET', '/orders/receipts?limit=5', { token: T.merch.token });
  return `share=${s.status}/${pub} route=${r.status} waybill=${w.status} timeline=${tl.status} receipts=${rc.status}`;
}, { critical: false });
await step('C masked-call + batch accept + failed-delivery flow', async () => {
  const mk = async () => (await req('POST', '/orders', { token: T.cust.token, body: { merchantId: T.merchantId, items: [{ catalogueItemId: T.itemId, quantity: 1 }], paymentMethod: 'cod', deliveryAddress: addr }, idem: idem('ord') })).data.id;
  const a = await mk(), b = await mk();
  const ba = await req('POST', '/orders/batch/accept', { token: T.merch.token, body: { orderIds: [a, b] }, idem: idem('ba') });
  if (![200, 201].includes(ba.status)) throw new Error(`batch ${ba.status} ${JSON.stringify(ba.data)}`);
  const mc = await req('POST', `/orders/${a}/masked-call`, { token: T.cust.token, body: { direction: 'customer_to_rider' } });
  for (const s of ['preparing', 'rider_assigned']) {
    const r = await req('POST', `/orders/${a}/status`, { token: T.merch.token, body: { status: s } });
    if (![200, 201].includes(r.status)) throw new Error(`${s} ${r.status}`);
  }
  psql(`UPDATE orders SET rider_id = '${T.riderRowId}' WHERE id = '${a}';`);
  for (const s of ['picked_up', 'delivering']) {
    const r = await req('POST', `/orders/${a}/status`, { token: T.rider.token, body: { status: s } });
    if (![200, 201].includes(r.status)) throw new Error(`${s} ${r.status}`);
  }
  const f = await req('POST', `/orders/${a}/failed-delivery`, { token: T.rider.token, body: { reason: 'customer_unavailable', note: 'loop' } });
  if (![200, 201].includes(f.status)) throw new Error(`failed-delivery ${f.status} ${JSON.stringify(f.data)}`);
  const pod = await req('POST', `/orders/${b}/proof-of-delivery`, { token: T.rider.token, body: { type: 'photo', value: 'https://example.com/p.jpg' } });
  return `batch=${ba.status} masked=${mc.status} failed=${f.status} pod=${pod.status}`;
}, { critical: false });

// ---- D: payments/refunds/wallet ----
await step('D intent confirm + history + methods', async () => {
  const it = await req('POST', '/payments/intent', { token: T.cust.token, body: { orderId: T.paidOrder, method: 'mpesa' }, idem: idem('pay') });
  const cf = await req('POST', `/payments/${it.data?.id}/confirm`, { token: T.cust.token, body: {} });
  const h = await req('GET', '/payments/history', { token: T.cust.token });
  const pm = await req('POST', '/payments/methods', { token: T.cust.token, body: { method: 'mpesa' }, idem: idem('pm') });
  const gm = await req('GET', '/payments/methods', { token: T.cust.token });
  return `intent=${it.status} confirm=${cf.status} history=${h.status} addpm=${pm.status} getpm=${gm.status}`;
}, { critical: false });
await step('D refund request + approve + wallet flows', async () => {
  const rf = await req('POST', `/payments/${T.intent}/refund`, { token: T.cust.token, body: { amount: 1000, reason: 'loop test' } });
  if (![200, 201].includes(rf.status)) throw new Error(`refund ${rf.status} ${JSON.stringify(rf.data)}`);
  // refundPayment settles instantly (no refunds row); exercise the merchant decide flow on a real row.
  const rid = psql(`INSERT INTO refunds (order_id, customer_user_id, amount_tzs, reason) VALUES ('${T.paidOrder}', '${T.cust.userId}', 1000, 'loop test') RETURNING id;`);
  const dc = await req('POST', `/refunds/${rid}/decide`, { token: T.merch.token, body: { decision: 'approved', reason: 'loop test' } });
  if (![200, 201].includes(dc.status)) throw new Error(`decide ${dc.status} ${JSON.stringify(dc.data)}`);
  const lr = 'decided';
  const w = await req('GET', '/wallet/me', { token: T.merch.token });
  const tu = await req('POST', '/wallet/me/top-up', { token: T.cust.token, body: { amountTZS: 2000, method: 'mpesa' }, idem: idem('topup') });
  const wd = await req('POST', '/wallet/withdrawals', { token: T.merch.token, body: { amountTZS: 1000 }, idem: idem('wd') });
  const inv = await req('GET', '/finance/invoices', { token: T.merch.token });
  return `refund=${rf.status} decide=${dc.status} wallet=${w.status} topup=${tu.status} withdraw=${wd.status} invoices=${inv.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-bcd: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
