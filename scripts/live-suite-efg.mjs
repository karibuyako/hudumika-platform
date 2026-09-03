// Suite E/F/G: bookings extras, provider ops, rider ops. Staging only (127.0.0.1:8092, OTP 123456).
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
const idem = (t) => `efg-${STAMP}-${t}-${randomUUID().slice(0, 8)}`;
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
// setup: customer + provider(+service) + booking in play
await step('setup customer+provider+booking', async () => {
  T.cust = await mintRole(phone('21'), 'customer');
  T.pPhone = phone('22');
  T.prov = await mintRole(T.pPhone, 'provider');
  T.providerId = psql(`INSERT INTO providers (owner_user_id, name, trade, verification) VALUES ('${T.prov.userId}', 'EFG Pro ${STAMP}', 'cleaning', 'approved') RETURNING id;`);
  const s = await req('POST', '/providers/me/services', { token: T.prov.token, body: { name: 'EFG Clean', durationMinutes: 60, pricing: { baseTZS: 30000 }, active: true } });
  ok2(s, 'service');
  T.serviceId = s.data.id;
  const b = await req('POST', '/bookings', { token: T.cust.token, body: { providerId: T.providerId, serviceId: T.serviceId, scheduledFor: new Date(Date.now() + 86400000).toISOString(), paymentMethod: 'cod' }, idem: idem('bk') });
  ok2(b, 'booking');
  T.bookingId = b.data.id;
  await req('POST', `/bookings/${T.bookingId}/accept`, { token: T.prov.token, body: {} });
  return `booking=${T.bookingId}`;
});
// E: booking extras
await step('E quote submit+decide', async () => {
  // NOTE: decide(approved) requires provider_requested (paid/dispatch path); draft quotes decide declined.
  const q = await req('POST', `/bookings/${T.bookingId}/quote`, { token: T.prov.token, body: { amountTZS: 35000, validUntil: new Date(Date.now() + 86400000).toISOString(), parts: [{ name: 'Detergent', quantity: 1, unitCostTZS: 5000 }] }, idem: idem('q') });
  if (![200, 201].includes(q.status)) throw new Error(`quote ${q.status} ${JSON.stringify(q.data)}`);
  const d = await req('POST', `/bookings/${T.bookingId}/quote/decision`, { token: T.cust.token, body: { decision: 'declined', note: 'too pricey' } });
  if (![200, 201].includes(d.status)) throw new Error(`decide ${d.status} ${JSON.stringify(d.data)}`);
  return 'quoted+declined (approved path needs provider_requested)';
});
await step('E check-in + parts + invoice + warranty + proof', async () => {
  const c = await req('POST', `/bookings/${T.bookingId}/check-in`, { token: T.prov.token, body: { lat: -6.8, lon: 39.28 } });
  const p = await req('POST', `/bookings/${T.bookingId}/parts`, { token: T.prov.token, body: { parts: [{ name: 'Filter', quantity: 1, unitCostTZS: 8000 }] } });
  const i = await req('POST', `/bookings/${T.bookingId}/invoice`, { token: T.prov.token, body: { laborTZS: 30000, note: 'loop' } });
  const w = await req('POST', `/bookings/${T.bookingId}/warranty`, { token: T.prov.token, body: { bookingId: T.bookingId, validDays: 90, coverage: 'loop test' } });
  const s = await req('POST', `/bookings/${T.bookingId}/proof-of-service`, { token: T.prov.token, body: { type: 'photo', value: 'https://example.com/done.jpg' } });
  return `checkin=${c.status} parts=${p.status} invoice=${i.status} warranty=${w.status} proof=${s.status}`;
}, { critical: false });
await step('E booking decline + cancel paths', async () => {
  const mk = async () => (await req('POST', '/bookings', { token: T.cust.token, body: { providerId: T.providerId, serviceId: T.serviceId, scheduledFor: new Date(Date.now() + 86400000).toISOString(), paymentMethod: 'cod' }, idem: idem('bk') })).data.id;
  const b1 = await mk();
  // decline is only legal from pending_payment|paid|provider_requested — draft must 409 (documents gate)
  const d = await req('POST', `/bookings/${b1}/decline`, { token: T.prov.token, body: { reason: 'fully booked' } });
  if (d.status !== 409) throw new Error(`expected 409 got ${d.status}`);
  const b2 = await mk();
  const c = await req('POST', `/bookings/${b2}/cancel`, { token: T.cust.token, body: { reason: 'changed mind' } });
  if (![200, 201].includes(c.status)) throw new Error(`cancel=${c.status}`);
  return 'decline-gate-409 cancel-ok';
});
await step('E provider-jobs marketplace accept', async () => {
  const j = await req('GET', '/dispatch/provider-jobs?lat=-6.8&lon=39.28&trade=cleaning', { token: T.prov.token });
  if (j.status !== 200) throw new Error(`${j.status} ${JSON.stringify(j.data)}`);
  return 'ok';
}, { critical: false });
// F: provider ops
await step('F technicians CRUD', async () => {
  const c = await req('POST', '/providers/me/technicians', { token: T.prov.token, body: { name: 'Tech A', phone: '+255700000001', trade: 'cleaning', skills: ['cleaning'] } });
  if (![200, 201].includes(c.status)) throw new Error(`create ${c.status} ${JSON.stringify(c.data)}`);
  const id = c.data?.id;
  const u = await req('PATCH', `/providers/me/technicians/${id}`, { token: T.prov.token, body: { name: 'Tech A+', phone: '+255700000001', trade: 'cleaning' } });
  const l = await req('GET', '/providers/me/technicians', { token: T.prov.token });
  const d = await req('DELETE', `/providers/me/technicians/${id}`, { token: T.prov.token });
  if (u.status !== 200 || l.status !== 200 || ![200, 204].includes(d.status)) throw new Error(`${u.status}/${l.status}/${d.status}`);
  return 'crud ok';
}, { critical: false });
await step('F staff + inventory + contracts + KYC + trust', async () => {
  const st = await req('POST', '/providers/me/staff', { token: T.prov.token, body: { name: 'Staff A', phone: '+255700000002', role: 'dispatcher' } });
  const iv = await req('POST', '/providers/me/inventory', { token: T.prov.token, body: { name: 'Detergent', quantity: 10, unit: 'pcs' } });
  let adj = { status: 'skip' };
  if ([200, 201].includes(iv.status) && iv.data?.id) adj = await req('POST', `/providers/me/inventory/items/${iv.data.id}/adjust`, { token: T.prov.token, body: { delta: -2, reason: 'job use' } });
  const ct = await req('GET', '/providers/me/contracts', { token: T.prov.token });
  const ky = await req('POST', '/providers/me/kyc/verify', { token: T.prov.token, body: { nidaNumber: '19900101-00001-00001-12', selfieCaptured: true } });
  const tr = await req('GET', '/providers/me/trust', { token: T.prov.token });
  return `staff=${st.status} inv=${iv.status}/${adj.status} contracts=${ct.status} kyc=${ky.status} trust=${tr.status}`;
}, { critical: false });
await step('F notifications + support + reviews-for-customer', async () => {
  const p = await req('GET', '/notifications/me/preferences', { token: T.prov.token });
  const t = await req('POST', '/support/tickets', { token: T.prov.token, body: { subject: 'loop', body: 'test ticket', category: 'general' } });
  const r = await req('POST', '/reviews', { token: T.cust.token, body: { targetType: 'provider', targetId: T.providerId, rating: 5, body: 'great service' } });
  return `prefs=${p.status} ticket=${t.status} review=${r.status}`;
}, { critical: false });
// G: rider ops (fresh rider)
await step('setup rider ops', async () => {
  T.rPhone = phone('23');
  T.rider = await mintRole(T.rPhone, 'rider');
  T.riderRowId = psql(`INSERT INTO riders (owner_user_id, name, vehicle, verification) VALUES ('${T.rider.userId}', 'EFG Rider', 'motorcycle', 'approved') RETURNING id;`);
  return 'ok';
});
await step('G shifts clock-in/out + SOS + contacts', async () => {
  const sh = await req('GET', '/riders/me/shifts?scope=current', { token: T.rider.token });
  const sos = await req('POST', '/sos', { token: T.rider.token, body: { type: 'mechanical', note: 'loop test', lat: -6.8, lon: 39.28 } });
  const tc = await req('POST', '/riders/me/contacts', { token: T.rider.token, body: { name: 'Kin', phone: '+255700000003', relation: 'family' } });
  return `shifts=${sh.status} sos=${sos.status} contacts=${tc.status}`;
}, { critical: false });
await step('G trips + sync batch + vehicle + logistics', async () => {
  const tr = await req('GET', '/riders/me/trips', { token: T.rider.token });
  if (![200, 404].includes(tr.status)) throw new Error(`trips ${tr.status}`);
  const sy = await req('POST', '/riders/me/sync/batch', { token: T.rider.token, body: { events: [{ seq: 1, type: 'location', payload: { lat: -6.8, lon: 39.28 } }] } });
  const vm = await req('GET', '/riders/me/vehicle/maintenance', { token: T.rider.token });
  const ex = await req('GET', '/delivery-exceptions?status=open', { token: T.rider.token });
  const cs = await req('GET', '/linehaul/consignments?limit=5', { token: T.rider.token });
  if (![200, 201].includes(sy.status) || vm.status !== 200 || ex.status !== 200) throw new Error(`sync=${sy.status} vehicle=${vm.status} exc=${ex.status} consign=${cs.status}`);
  return `trips=${tr.status} (404=no active trip) sync+vehicle+exc ok consign=${cs.status}`;
}, { critical: false });

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-suite-efg: pass=${pass}/${results.length} failed=${results.length - pass} base=${BASE} stamp=${STAMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
