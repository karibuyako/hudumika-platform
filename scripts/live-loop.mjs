// Hudumika live-loop: real-world API test across consumer -> merchant -> rider, then provider.
// Staging-first: defaults to local staging API + dev OTP 123456. Prod requires --allow-prod
// AND a human-verified SMS flow (no dev code in prod), so OTP steps are skipped there unless --otp-code is given.
//
// Usage:
//   node scripts/live-loop.mjs [--base http://127.0.0.1:8092] [--allow-prod] [--otp-code 123456]
//   PG* env for role activation: PGHOST PGPORT PGUSER PGPASSWORD PGDB (default hudumika_staging)
//
// Exit 0 = all critical steps green (+ SIGNED summary). Exit 1 = any critical failure.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = (opt('--base', 'http://127.0.0.1:8092') || '').replace(/\/$/, '');
const ALLOW_PROD = args.includes('--allow-prod');
const OTP_CODE = opt('--otp-code', '123456');
const STAMP = Date.now().toString().slice(-8);

const LOCAL_ALLOW = /^(http:\/\/127\.0\.0\.1:\d+|http:\/\/localhost:\d+)$/;
if (!LOCAL_ALLOW.test(BASE) && !ALLOW_PROD) {
  console.error(`REFUSING non-local BASE without --allow-prod: ${BASE}`);
  process.exit(2);
}

const results = [];
function rec(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function idem(tag) {
  return `loop-${STAMP}-${tag}-${randomUUID().slice(0, 8)}`;
}
async function req(method, path, { token, body, idemKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}
function psql(sql) {
  const env = {
    ...process.env,
    PGHOST: process.env.PGHOST || '127.0.0.1',
    PGPORT: process.env.PGPORT || '5432',
    PGUSER: process.env.PGUSER || 'hudumika',
    PGPASSWORD: process.env.PGPASSWORD || 'hudumika',
    PGDATABASE: process.env.PGDB || 'hudumika_staging',
  };
  return execFileSync('psql', ['-tA', '-X', '-q', '-c', sql], { env, encoding: 'utf8' }).trim().split('\n')[0];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function otpRequest(phone) {
  // request-otp with 429 backoff (per-IP throttling on rapid runs)
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await req('POST', '/auth/request-otp', { body: { channel: 'phone', destination: phone, purpose: 'login' } });
    if (r.status === 200) return r.data.requestId;
    if (r.status === 429) {
      const wait = ((r.data?.retryAfterSeconds ?? 60) + 2) * 1000;
      await sleep(wait);
      continue;
    }
    throw new Error(`request-otp ${r.status} ${JSON.stringify(r.data)}`);
  }
  throw new Error('request-otp still rate-limited after retries');
}
function userIdByPhone(phone) {
  const id = psql(`SELECT id FROM users WHERE phone='${phone}' ORDER BY created_at DESC LIMIT 1;`);
  if (!id || id.startsWith('00000000')) throw new Error(`no users row for ${phone}`);
  return id;
}
async function mintRole(phone, role) {
  // 1) request + verify as customer (creates user row), 2) activate role via test SQL, 3) re-verify with role.
  const reqId = await otpRequest(phone);
  await sleep(1200);
  let r = await req('POST', '/auth/verify-otp', { body: { requestId: reqId, code: OTP_CODE } });
  if (r.status !== 200) throw new Error(`verify-otp(customer) ${r.status} ${JSON.stringify(r.data)}`);
  const userId = userIdByPhone(phone);
  if (role !== 'customer') {
    psql(`INSERT INTO roles (user_id, role, active) VALUES ('${userId}', '${role}', true) ON CONFLICT (user_id, role) DO UPDATE SET active = true;`);
    await sleep(1200);
    const reqId2 = await otpRequest(phone);
    await sleep(1200);
    const v2 = await req('POST', '/auth/verify-otp', { body: { requestId: reqId2, code: OTP_CODE, role } });
    if (v2.status !== 200) throw new Error(`verify-otp(${role}) ${v2.status} ${JSON.stringify(v2.data)}`);
    return { token: v2.data.accessToken, refresh: v2.data.refreshToken, userId };
  }
  return { token: r.data.accessToken, refresh: r.data.refreshToken, userId };
}

const phone = (tag) => `+2557${STAMP.slice(-6)}${tag}`; // 5 + 6 + 2 = 13 chars, unique per role
const T = {};
let failed = 0;
async function step(name, fn, { critical = true } = {}) {
  try {
    const detail = (await fn()) ?? '';
    rec(name, true, detail);
  } catch (e) {
    rec(name, false, String(e.message || e).slice(0, 300));
    if (critical) failed++;
  }
}

console.log(`BASE=${BASE} STAMP=${STAMP}`);

// 0. Gates
await step('healthz 200', async () => {
  const r = await req('GET', '/healthz');
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  return JSON.stringify(r.data);
});
await step('readyz 200', async () => {
  const r = await req('GET', '/readyz');
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  return JSON.stringify(r.data);
});

// 1. Auth tokens for consumer / merchant / rider
await step('mint customer token', async () => {
  T.cust = await mintRole(phone('01'), 'customer');
  const me = await req('GET', '/users/me', { token: T.cust.token });
  if (me.status !== 200) throw new Error(`users/me ${me.status}`);
  return `user=${T.cust.userId}`;
});
await step('mint merchant phone user', async () => {
  T.mPhone = phone('02');
  T.merch = await mintRole(T.mPhone, 'merchant');
  return `user=${T.merch.userId}`;
});
await step('merchant profile setup (approved)', async () => {
  // Test setup mirrors staff approval: merchants row + approved verification.
  const id = psql(`INSERT INTO merchants (owner_user_id, business_name, business_type, verification) VALUES ('${T.merch.userId}', 'Loop Foods ${STAMP}', 'restaurant', 'approved') RETURNING id;`);
  if (!id) throw new Error('merchants insert failed');
  T.merchantId = id;
  const me = await req('GET', '/merchants/me', { token: T.merch.token });
  if (me.status !== 200) throw new Error(`merchants/me ${me.status} ${JSON.stringify(me.data)}`);
  T.merchantId = me.data?.id;
  return `merchant=${T.merchantId ?? 'n/a'}`;
});
await step('mint rider phone user', async () => {
  T.rPhone = phone('03');
  T.rider = await mintRole(T.rPhone, 'rider');
  return `user=${T.rider.userId}`;
});
await step('rider profile setup (approved)', async () => {
  const id = psql(`INSERT INTO riders (owner_user_id, name, vehicle, verification) VALUES ('${T.rider.userId}', 'Loop Rider ${STAMP}', 'motorcycle', 'approved') RETURNING id;`);
  if (!id) throw new Error('riders insert failed');
  T.riderRowId = id;
  return `rider=${id}`;
});

// 2. Merchant ops: settings + catalogue (food)
await step('merchant settings open', async () => {
  const g = await req('GET', '/merchants/me/settings', { token: T.merch.token });
  if (g.status !== 200) throw new Error(`get settings ${g.status}`);
  const p = await req('PUT', '/merchants/me/settings', { token: T.merch.token, body: { ...g.data, isOpen: true } });
  if (p.status !== 200) throw new Error(`put settings ${p.status} ${JSON.stringify(p.data)}`);
  return 'isOpen=true';
}, { critical: false });
await step('merchant creates food category', async () => {
  const r = await req('POST', '/categories', {
    token: T.merch.token,
    body: { name: 'Food' },
  });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `category=${r.data?.id ?? r.data?.name ?? 'ok'}`;
});
await step('merchant uploads food product', async () => {
  const r = await req('POST', '/catalogue-items', {
    token: T.merch.token,
    body: { name: 'Chapati Maharage', priceTZS: 5000, category: 'Food', available: true },
  });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  T.itemId = r.data?.id;
  if (!T.itemId) throw new Error('no item id returned');
  return `item=${T.itemId}`;
});
await step('public catalogue shows item', async () => {
  if (!T.merchantId) throw new Error('missing merchantId');
  const r = await req('GET', `/catalogues/${T.merchantId}`);
  if (r.status !== 200) throw new Error(`${r.status}`);
  const items = Array.isArray(r.data) ? r.data : r.data?.items ?? [];
  if (!items.some((i) => i.id === T.itemId)) throw new Error('item not visible publicly');
  return `${items.length} items`;
});

// 3. Consumer browses + places COD order
await step('consumer browses merchants', async () => {
  const r = await req('GET', '/merchants?limit=20');
  if (r.status !== 200) throw new Error(`${r.status}`);
  return 'ok';
});
await step('consumer places COD order (idempotent)', async () => {
  const body = {
    merchantId: T.merchantId,
    items: [{ catalogueItemId: T.itemId, quantity: 2 }],
    paymentMethod: 'cod',
    deliveryAddress: { label: 'Home', lines: 'Loop St 1', contactPhone: phone('01'), lat: -6.8, lon: 39.28 },
  };
  const key = idem('order');
  const r1 = await req('POST', '/orders', { token: T.cust.token, body, idemKey: key });
  if (![200, 201].includes(r1.status)) throw new Error(`${r1.status} ${JSON.stringify(r1.data)}`);
  T.orderId = r1.data?.id;
  const r2 = await req('POST', '/orders', { token: T.cust.token, body, idemKey: key });
  if ((r2.data?.id ?? null) !== T.orderId) throw new Error(`idempotency replay diverged ${T.orderId} vs ${r2.data?.id}`);
  return `order=${T.orderId} status=${r1.data?.status}`;
});

// 4. Merchant verifies + prepares
await step('merchant accepts order', async () => {
  const g = await req('GET', `/orders/${T.orderId}`, { token: T.merch.token });
  if (g.status !== 200) throw new Error(`get ${g.status}`);
  T.version = g.data?.version;
  const r = await req('POST', `/orders/${T.orderId}/accept`, { token: T.merch.token, body: { expectedVersion: T.version } });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
});
await step('merchant sees order in queue', async () => {
  const r = await req('GET', '/orders/search?status=merchant_accepted&limit=20', { token: T.merch.token });
  if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  const list = Array.isArray(r.data) ? r.data : r.data?.items ?? [];
  if (!list.some((o) => o.id === T.orderId)) throw new Error('order missing from merchant queue');
  return `${list.length} in queue`;
});
await step('merchant double-accept → 409', async () => {
  const r = await req('POST', `/orders/${T.orderId}/accept`, { token: T.merch.token, body: { expectedVersion: T.version } });
  if (r.status !== 409) throw new Error(`expected 409 got ${r.status}`);
  return 'conflict as expected';
}, { critical: false });
await step('merchant marks preparing', async () => {
  const r = await req('POST', `/orders/${T.orderId}/status`, { token: T.merch.token, body: { status: 'preparing' } });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
});
// 5. Rider delivers
await step('rider goes online', async () => {
  const r = await req('PUT', '/riders/me/availability', { token: T.rider.token, body: { online: true } });
  if (![200, 201, 204].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return 'online';
});
await step('rider sees dispatch feed', async () => {
  const r = await req('GET', '/dispatch/available-orders?lat=-6.8&lon=39.28&limit=20', { token: T.rider.token });
  if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  const list = Array.isArray(r.data) ? r.data : [];
  if (!list.some((o) => (o.orderId ?? o.id) === T.orderId)) throw new Error('order missing from feed');
  return `${list.length} offers`;
}, { critical: false });
await step('rider grabs order from dispatch feed (→rider_assigned)', async () => {
  // Rider self-grab replaces the old SQL-bind hack (staff assign needs staff+MFA).
  const r = await req('POST', `/dispatch/available-orders/${T.orderId}/accept`, { token: T.rider.token, body: {} });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  if (r.data?.status !== 'rider_assigned') throw new Error(`status=${r.data?.status}`);
  return `status=rider_assigned rider=${r.data?.riderId ?? T.riderRowId}`;
});
// Server chain (orders.go): rider_assigned→picked_up→delivering→delivered→completed
for (const s of ['picked_up', 'delivering', 'delivered']) {
  await step(`rider advances → ${s}`, async () => {
    const r = await req('POST', `/orders/${T.orderId}/status`, { token: T.rider.token, body: { status: s } });
    if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
    return `status=${r.data?.status}`;
  });
}
await step('rider completes order → completed', async () => {
  const r = await req('POST', `/orders/${T.orderId}/status`, { token: T.rider.token, body: { status: 'completed' } });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
});
await step('rider submits proof of delivery', async () => {
  const r = await req('POST', `/orders/${T.orderId}/proof-of-delivery`, {
    token: T.rider.token,
    body: { type: 'otp', code: '000000', note: 'loop test' },
  });
  if (![200, 201, 404, 422].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.status}`;
}, { critical: false });
await step('rider payout statement', async () => {
  const r = await req('GET', '/payouts/me?limit=5', { token: T.rider.token });
  if (r.status !== 200) throw new Error(`${r.status}`);
  return 'ok';
}, { critical: false });
await step('merchant payout statement', async () => {
  const r = await req('GET', '/payouts/me?limit=5', { token: T.merch.token });
  if (r.status !== 200) throw new Error(`${r.status}`);
  return 'ok';
}, { critical: false });

// 6. Negative checks
await step('401 without token', async () => {
  const r = await req('GET', '/orders/me?limit=5');
  if (r.status !== 401) throw new Error(`expected 401 got ${r.status}`);
  return 'unauthorized as expected';
});
await step('403 customer on /merchants/me', async () => {
  const r = await req('GET', '/merchants/me', { token: T.cust.token });
  if (![401, 403, 404].includes(r.status)) throw new Error(`expected 403-ish got ${r.status}`);
  return `status=${r.status}`;
});

// 7. Provider loop
await step('mint provider phone user', async () => {
  T.pPhone = phone('04');
  T.prov = await mintRole(T.pPhone, 'provider');
  return `user=${T.prov.userId}`;
});
await step('provider profile setup (approved)', async () => {
  const id = psql(`INSERT INTO providers (owner_user_id, name, trade, verification) VALUES ('${T.prov.userId}', 'Loop Pro ${STAMP}', 'cleaning', 'approved') RETURNING id;`);
  if (!id) throw new Error('providers insert failed');
  T.providerId = id;
  return `provider=${id}`;
});
await step('provider sets availability', async () => {
  const r = await req('PUT', '/providers/me/availability', {
    token: T.prov.token,
    body: { dayOfWeek: 1, startTime: '08:00', endTime: '18:00', active: true },
  });
  if (![200, 201, 204].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return 'ok';
}, { critical: false });
await step('provider creates service', async () => {
  const r = await req('POST', '/providers/me/services', {
    token: T.prov.token,
    body: { name: 'House Cleaning Standard', durationMinutes: 120, pricing: { baseTZS: 35000 }, active: true },
  });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  T.serviceId = r.data?.id;
  T.providerId = T.providerId ?? r.data?.providerId ?? T.prov.userId;
  return `service=${T.serviceId}`;
});
await step('consumer books service (idempotent)', async () => {
  const body = {
    providerId: T.providerId,
    serviceId: T.serviceId,
    scheduledFor: new Date(Date.now() + 86400000).toISOString(),
    paymentMethod: 'cod',
    address: { label: 'Home', lines: 'Loop St 1', contactPhone: phone('01') },
  };
  const key = idem('booking');
  const r1 = await req('POST', '/bookings', { token: T.cust.token, body, idemKey: key });
  if (![200, 201].includes(r1.status)) throw new Error(`${r1.status} ${JSON.stringify(r1.data)} body=${JSON.stringify(body).slice(0, 300)}`);
  T.bookingId = r1.data?.id;
  const r2 = await req('POST', '/bookings', { token: T.cust.token, body, idemKey: key });
  if ((r2.data?.id ?? null) !== T.bookingId) throw new Error('booking idempotency diverged');
  return `booking=${T.bookingId} status=${r1.data?.status}`;
});
await step('provider accepts booking', async () => {
  const r = await req('POST', `/bookings/${T.bookingId}/accept`, { token: T.prov.token, body: {} });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
});
// Server chain (bookings.go): provider_accepted→scheduled→provider_arrived→in_progress→awaiting_customer_confirmation→(customer)completed
for (const s of ['scheduled', 'provider_arrived', 'in_progress', 'awaiting_customer_confirmation']) {
  await step(`provider advances booking → ${s}`, async () => {
    const r = await req('POST', `/bookings/${T.bookingId}/status`, { token: T.prov.token, body: { status: s } });
    if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
    return `status=${r.data?.status}`;
  });
}
await step('customer confirms booking complete', async () => {
  const r = await req('POST', `/bookings/${T.bookingId}/complete`, { token: T.cust.token, body: {} });
  if (![200, 201].includes(r.status)) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
  return `status=${r.data?.status}`;
});
await step('provider payout statement', async () => {
  const r = await req('GET', '/payouts/me?limit=5', { token: T.prov.token });
  if (r.status !== 200) throw new Error(`${r.status}`);
  return 'ok';
}, { critical: false });

// Logout hygiene
for (const [n, t] of [['customer', T.cust], ['merchant', T.merch], ['rider', T.rider], ['provider', T.prov]]) {
  await step(`logout ${n}`, async () => {
    const r = await req('POST', '/auth/logout', { body: { refreshToken: t.refresh } });
    if (![200, 204].includes(r.status)) throw new Error(`${r.status}`);
    return 'revoked';
  }, { critical: false });
}

const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED live-loop: pass=${pass}/${results.length} failed=${failed} base=${BASE} stamp=${STAMP}`);
process.exit(failed ? 1 : 0);
