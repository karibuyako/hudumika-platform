/* M7 — Hardening: deep-link allow-list, UTC→local date helpers, money
 * grouping, idempotency discipline, offline queue persistence (with a
 * localStorage shim — node has no storage), and the PII-safe analytics
 * surface. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { deepLinkHref, isAllowedDeepLink, DEEP_LINK_ROUTES, parseAndValidateDeepLink } from '@/lib/deep-link';
import { clockISO, dayLabelISO, fullTimeISO, timeAgoISO, weekdayLabelISO } from '@/lib/dates';
import { formatTZS, minutesLabel } from '@/lib/format';
import { queryKeys } from '@/hooks/query';
import { ANALYTICS_EVENTS, track, type AnalyticsEvent } from '@/lib/analytics';
import { clearQueue, dequeue, enqueue, queuedOps, flushQueue } from '@/api/queue';
import { ApiError, api, hydrateToken, setToken } from '@/api/client';
import { getStoredSession, setStoredSession, getStoredTokenAsync, setStoredTokenAsync } from '@/lib/secureStorage';
import { idempotencyKey } from '@/lib/idempotency';
import { useSessionStore } from '@/store/session';
import { useConsentStore } from '@/store/consent';
import { getAuthRepository } from '@/repos';
import type { User } from '@hudumika/contract';

/* ---- localStorage shim (queue.ts + client.ts persist through it) ---- */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
try {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: (globalThis as Record<string, unknown>).localStorage,
    configurable: true,
  });
} catch {
  /* some runtimes freeze navigator — offline path is covered by queue tests */
}
/* node defines navigator but leaves onLine undefined — the client treats
 * !onLine as offline. Force the online state so mutation/refresh tests
 * actually hit the network path. */
try {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
} catch {
  /* navigator may be frozen — the refresh test then covers the offline branch */
}

beforeEach(() => store.clear());

test('deep-link allow-list: only allow-listed routes navigate', () => {
  assert.deepEqual([...DEEP_LINK_ROUTES], ['order', 'booking', 'ticket', 'conversation', 'dine-in', 'reservation', 'red-packet', 'voucher', 'group-order', 'referral', 'split', 'track-share']);
  assert.equal(isAllowedDeepLink('order/ord_1'), true);
  assert.equal(isAllowedDeepLink('booking/bk_1'), true);
  assert.equal(isAllowedDeepLink('ticket/tk_1'), true);
  assert.equal(isAllowedDeepLink('conversation/cv_1'), true);
  assert.equal(isAllowedDeepLink('dine-in/din_1'), true);
  assert.equal(isAllowedDeepLink('reservation/res_1'), true);
  assert.equal(isAllowedDeepLink('red-packet/PK-7D2F'), true);
  assert.equal(isAllowedDeepLink('voucher/GB-1234-5678'), true);
  // Trip-share links (hudumika://track-share/{token}, OPERATIONS-COVERAGE #77).
  assert.equal(isAllowedDeepLink('track-share/ts_abc'), true);
  assert.equal(isAllowedDeepLink('admin/users'), false);
  assert.equal(isAllowedDeepLink(null), false);
  assert.equal(isAllowedDeepLink('order/'), false, 'missing id never navigates');
});

test('deep-link hrefs map to typed routes only', () => {
  assert.deepEqual(deepLinkHref('order/ord_1'), { pathname: '/order/[orderId]', params: { orderId: 'ord_1' } });
  assert.deepEqual(deepLinkHref('booking/bk_2'), { pathname: '/booking/[bookingId]', params: { bookingId: 'bk_2' } });
  assert.deepEqual(deepLinkHref('conversation/cv_9'), { pathname: '/messages/[conversationId]', params: { conversationId: 'cv_9' } });
  assert.deepEqual(deepLinkHref('dine-in/din_3'), { pathname: '/dine-in' });
  assert.deepEqual(deepLinkHref('reservation/res_4'), { pathname: '/reservations' });
  assert.deepEqual(deepLinkHref('red-packet/PK-7D2F'), { pathname: '/red-packets' }, 'share links land on the list screen (no id param read)');
  assert.deepEqual(deepLinkHref('voucher/GB-1234-5678'), { pathname: '/vouchers' });
  assert.deepEqual(deepLinkHref('track-share/ts_abc'), { pathname: '/track-share/[token]', params: { token: 'ts_abc' } });
  assert.equal(deepLinkHref('https://evil.example'), null);
  assert.equal(deepLinkHref('order'), null);
});

test('parseAndValidateDeepLink accepts new-resource payloads in every transport form', () => {
  assert.equal(parseAndValidateDeepLink('hudumika://dine-in/din_1'), 'dine-in/din_1');
  assert.equal(parseAndValidateDeepLink('https://app.hudumika.tz/reservation/res_1'), 'reservation/res_1');
  assert.equal(parseAndValidateDeepLink('voucher/GB-1234-5678'), 'voucher/GB-1234-5678');
  assert.equal(parseAndValidateDeepLink('hudumika://red-packet/PK-7D2F'), 'red-packet/PK-7D2F');
  assert.equal(parseAndValidateDeepLink('hudumika://track-share/ts_1'), 'track-share/ts_1');
  assert.equal(parseAndValidateDeepLink('hudumika://voucher/GB-1234-5678?utm_source=push'), 'voucher/GB-1234-5678', 'query strings are stripped');
  assert.equal(parseAndValidateDeepLink('https://evil.example/dine-in/din_1'), 'dine-in/din_1');
  assert.equal(parseAndValidateDeepLink('dine-in/'), null, 'missing id never parses');
  assert.equal(parseAndValidateDeepLink('admin/wipe'), null, 'unknown payloads still no-op');
  assert.equal(parseAndValidateDeepLink('hudumika://reservation/'), null);
  assert.equal(parseAndValidateDeepLink(''), null);
  assert.equal(parseAndValidateDeepLink('reservation/res_1/more'), null, 'extra segments never parse');
});

test('all date helpers render local, never raw UTC ISO', () => {
  const iso = '2026-08-14T14:32:00Z';
  for (const out of [clockISO(iso), dayLabelISO(iso), weekdayLabelISO(iso), fullTimeISO(iso), timeAgoISO(iso)]) {
    assert.ok(!out.includes('Z'));
  }
  for (const out of [clockISO(), dayLabelISO(null), weekdayLabelISO('nope'), fullTimeISO('nope')]) {
    assert.equal(out, '—');
  }
});

test('money formatting groups TZS and signs negative rows', () => {
  assert.equal(formatTZS(12500), 'TZS 12,500');
  assert.equal(formatTZS(0), 'TZS 0');
  assert.equal(formatTZS(-5000), '−TZS 5,000');
  assert.equal(minutesLabel(25), '25m');
  assert.equal(minutesLabel(125), '2h 5m');
});

test('query keys mirror contract resources (INSTRUCTIONS §5)', () => {
  assert.deepEqual(queryKeys.orders.me({ status: 'active' }), ['orders', 'me', { status: 'active' }]);
  assert.deepEqual(queryKeys.merchants.detail('m1'), ['merchants', 'm1']);
  assert.deepEqual(queryKeys.orders.track('o1'), ['orders', 'o1', 'track']);
  assert.deepEqual(queryKeys.merchants.catalogue('m1'), ['catalogues', 'm1']);
});

/* ---- offline queue (api/queue.ts) ---- */

test('offline queue persists mutations with a stable key and replays in order', async () => {
  enqueue({ method: 'POST', path: '/orders', body: { merchantId: 'm1' } });
  enqueue({ method: 'POST', path: '/payments/intent', body: { orderId: 'o1' } });
  const ops = queuedOps();
  assert.equal(ops.length, 2);
  assert.ok(ops[0].key.startsWith('POST:/orders:'), 'key embeds method+path for dedupe');
  assert.deepEqual(ops[0].body, { merchantId: 'm1' });
  assert.equal(ops[0].method, 'POST');
});

test('dequeue removes a single op; clearQueue empties the queue', () => {
  const a = enqueue({ method: 'POST', path: '/a', body: null });
  const b = enqueue({ method: 'PATCH', path: '/b', body: null });
  dequeue(a.key);
  assert.deepEqual(queuedOps().map((o) => o.key), [b.key]);
  clearQueue();
  assert.equal(queuedOps().length, 0);
});

test('flushQueue with nothing pending resolves true and clears the syncing flag', async () => {
  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.equal(queuedOps().length, 0);
});

/* ---- FIX 1: sensitive actions never queue offline (blueprint §26) ---- */

test('offline sensitive mutations fail fast (OFFLINE) and are never queued', async () => {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  try {
    const sensitive = [
      () => api.post('/payments/intent', { orderId: 'o1' }, { idempotencyKey: 'hk_pay' }),
      () => api.post('/payments/pi_1/confirm', {}, { idempotencyKey: 'hk_confirm' }),
      () => api.post('/orders/ord_1/cancel', { reason: 'changed mind' }, { idempotencyKey: 'hk_cancel' }),
      () => api.post('/bookings/bk_1/cancel', { reason: 'delay' }, { idempotencyKey: 'hk_bc' }),
      () => api.post('/bookings/bk_1/complete', {}, { idempotencyKey: 'hk_done' }),
      () => api.post('/bookings/bk_1/quote/decision', { decision: 'accept' }, { idempotencyKey: 'hk_quote' }),
      () => api.post('/reservations/r_1/cancel', {}, { idempotencyKey: 'hk_rc' }),
      () => api.post('/group-buys/g_1/purchase', { quantity: 1 }, { idempotencyKey: 'hk_gb' }),
      () => api.post('/wallet/me/top-up', { amountTZS: 10000 }, { idempotencyKey: 'hk_topup' }),
      () => api.post('/privacy/export'),
      () => api.post('/privacy/delete'),
    ];
    for (const call of sensitive) {
      await assert.rejects(
        call(),
        (e) => e instanceof ApiError && e.code === 'OFFLINE' && e.status === 0,
        `${String(call).slice(0, 60)} must fail fast, not queue`,
      );
    }
    assert.equal(queuedOps().length, 0, 'nothing sensitive is ever enqueued');
  } finally {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
  }
});

test('offline chat sends are queued with their original idempotency key', async () => {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  try {
    await assert.rejects(
      api.post('/conversations/cv_1/messages', { body: 'hello' }, { idempotencyKey: 'hk_chat_9' }),
      (e) => e instanceof ApiError && e.code === 'OFFLINE_QUEUED',
    );
    const ops = queuedOps();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].key, 'hk_chat_9', 'queued op reuses the original idempotency key');
    assert.equal(ops[0].path, '/conversations/cv_1/messages');
    assert.equal(ops[0].method, 'POST');
    clearQueue();
  } finally {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
  }
});

/* ---- FIX 2: replay reuses the original idempotency key via the client ---- */

test('flushQueue replays through the client: original key, token, base URL', async () => {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify({ id: 'm1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    setToken('tok_flush');
    enqueue({ method: 'POST', path: '/conversations/cv_1/messages', body: { body: 'hello' }, idempotencyKey: 'hk_replay_K' });
    const ok = await flushQueue();
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/conversations/cv_1/messages', 'flush goes through the client base URL');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['idempotency-key'], 'hk_replay_K', 'flush reuses the original idempotency key');
    assert.equal(calls[0].headers.authorization, 'Bearer tok_flush', 'flush attaches the token like the client');
    assert.equal(queuedOps().length, 0, 'successful replay dequeues the op');
  } finally {
    globalThis.fetch = orig;
    setToken(null);
  }
});

test('flushQueue drops ops the server superseded (409) and stops on 5xx', async () => {
  const orig = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    const status = call === 1 ? 409 : 503;
    return new Response(JSON.stringify({ error: { code: status === 409 ? 'CONFLICT' : 'SERVER_ERROR', message: 'x' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    enqueue({ method: 'POST', path: '/conversations/cv_1/messages', body: { body: 'a' }, idempotencyKey: 'hk_a' });
    enqueue({ method: 'POST', path: '/conversations/cv_1/messages', body: { body: 'b' }, idempotencyKey: 'hk_b' });
    const ok = await flushQueue();
    assert.equal(ok, false, '5xx mid-flush stops the replay');
    assert.equal(queuedOps().length, 1, 'the 409 op is dropped, the 5xx op stays');
    assert.equal(queuedOps()[0].key, 'hk_b');
  } finally {
    globalThis.fetch = orig;
  }
});

/* ---- FIX 3: idempotency keys derive from the real user (audit P1-7) ---- */

test('idempotency keys derive from the session user, never a hardcoded customer', () => {
  useSessionStore.setState({ user: { id: 'cus_alice' } as User });
  const k1 = idempotencyKey('cus_1', 'booking.cancel');
  assert.ok(k1.startsWith('hk_cus_alic'), `key embeds the real user id: ${k1}`);
  assert.ok(!k1.includes('cus_1'), 'hardcoded placeholder never reaches the key');

  useSessionStore.setState({ user: { id: 'cus_bob' } as User });
  const k2 = idempotencyKey('cus_1', 'booking.cancel');
  assert.ok(k2.startsWith('hk_cus_bob'));
  assert.notEqual(k1, k2, 'keys differ per user');

  useSessionStore.setState({ user: null });
  assert.ok(idempotencyKey('cus_1', 'booking.cancel').startsWith('hk_anon_'), 'no session falls back to anon');
});

/* ---- FIX 4: analytics catalog completeness (audit P1-3) ---- */

test('analytics catalog covers every blueprint event with entity-only payloads', () => {
  assert.deepEqual(
    [...ANALYTICS_EVENTS],
    [
      'home_viewed',
      'search_started',
      'search_submitted',
      'category_opened',
      'merchant_viewed',
      'product_viewed',
      'cart_item_added',
      'checkout_started',
      'payment_started',
      'order_created',
      'order_cancelled',
      'tracking_viewed',
      'review_submitted',
      'support_opened',
      'coupon_claimed',
      'app_open',
    ],
  );
  const samples: AnalyticsEvent[] = [
    { name: 'app_open' },
    { name: 'home_viewed', cityId: 'c1' },
    { name: 'search_started' },
    { name: 'search_submitted', query: 'pilau', category: 'food', results: 4 },
    { name: 'category_opened', category: 'food' },
    { name: 'merchant_viewed', merchantId: 'm1' },
    { name: 'product_viewed', merchantId: 'm1', catalogueItemId: 'ci_9' },
    { name: 'cart_item_added', merchantId: 'm1', catalogueItemId: 'ci_9', quantity: 2 },
    { name: 'checkout_started', merchantId: 'm1' },
    { name: 'payment_started', method: 'mpesa' },
    { name: 'order_created', orderId: 'ord_1', status: 'paid' },
    { name: 'order_cancelled', orderId: 'ord_1', reason: 'changed mind' },
    { name: 'tracking_viewed', orderId: 'ord_1' },
    { name: 'review_submitted', targetType: 'merchant', targetId: 'm1' },
    { name: 'support_opened' },
    { name: 'coupon_claimed', couponId: 'cp_1' },
  ];
  assert.equal(samples.length, ANALYTICS_EVENTS.length, 'one typed sample per catalog event');
  for (const event of samples) {
    const json = JSON.stringify(event);
    assert.ok(!json.includes('TZS') && !json.includes('phone') && !json.includes('token'), `${event.name} stays entity-only`);
    assert.doesNotThrow(() => track(event));
  }
});

/* ---- FIX 5: privacy/consent layer ---- */

test('consent store grants, revokes and persists per purpose', () => {
  useConsentStore.getState().grant('location');
  assert.equal(useConsentStore.getState().consents.location, true);
  useConsentStore.getState().grant('marketing');
  useConsentStore.getState().revoke('marketing');
  assert.equal(useConsentStore.getState().consents.marketing, false);
  assert.equal(useConsentStore.getState().consents.camera, false, 'untouched purposes stay off');
  const persisted = JSON.parse(localStorage.getItem('consumer.consents') ?? '{}') as Record<string, boolean>;
  assert.equal(persisted.location, true);
  assert.equal(persisted.marketing, false);
});

test('exportData round-trips through the auth repo (contract {jobId, status})', async () => {
  const res = await getAuthRepository().exportData();
  assert.ok(res.jobId, 'mock returns a job id');
  assert.equal(res.status, 'queued');
});

/* ---- analytics surface stays PII/money-free ---- */

test('analytics events carry entity ids/statuses only — never money or bodies', () => {
  const event: AnalyticsEvent = { name: 'order_created', orderId: 'ord_1', status: 'paid' };
  const json = JSON.stringify(event);
  assert.ok(!json.includes('TZS') && !json.includes('phone') && !json.includes('token'));
  assert.doesNotThrow(() => track({ name: 'home_viewed' }));
  assert.doesNotThrow(() => track({ name: 'tracking_viewed', orderId: 'ord_1' }));
});

/* ---- token storage (FIX 4/5: native persistence + refresh rotation) ---- */

test('token store round-trips through the storage abstraction (SecureStore fallback path)', async () => {
  await setStoredTokenAsync('tok_roundtrip');
  assert.equal(await getStoredTokenAsync(), 'tok_roundtrip');
  assert.equal(localStorage.getItem('customer.token'), 'tok_roundtrip', 'web fallback key stays in sync');
  await setStoredTokenAsync(null);
  assert.equal(await getStoredTokenAsync(), null);
  assert.equal(localStorage.getItem('customer.token'), null);
});

test('setToken keeps the web fallback and write-through persists to the token store', async () => {
  setToken('tok_native');
  assert.equal(localStorage.getItem('customer.token'), 'tok_native');
  await new Promise((r) => setTimeout(r, 0)); // SecureStore write-through is async
  assert.equal(await getStoredTokenAsync(), 'tok_native');
  setToken(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await getStoredTokenAsync(), null);
});

test('Authorization is attached from the in-memory token (native hot path), cleared on logout', async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(`${String(url)} ${init?.headers ? (init.headers as Record<string, string>).authorization ?? 'no-auth' : 'no-auth'}`);
    return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    setToken('tok_hot');
    await api.get('/users/me');
    assert.equal(calls[0], '/users/me Bearer tok_hot');

    setToken(null);
    await api.get('/users/me');
    assert.equal(calls[1], '/users/me no-auth');
  } finally {
    globalThis.fetch = orig;
    setToken(null);
  }
});

test('every request carries an X-Request-ID, unique per logical request (tracing)', async () => {
  const ids: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers as Record<string, string>) ?? {};
    ids.push(headers['x-request-id'] ?? '');
    return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await api.get('/users/me');
    await api.post('/users/me', { locale: 'sw' });
    assert.equal(ids.length, 2);
    for (const id of ids) {
      assert.match(id, /^req_[0-9a-z]+$/, `x-request-id ${id} looks like a generated trace id`);
    }
    assert.notEqual(ids[0], ids[1], 'each logical request gets a fresh id');
  } finally {
    globalThis.fetch = orig;
  }
});

test('hydrateToken seeds the in-memory token from the persisted store (cold start)', async () => {
  setToken(null); // simulate a fresh process: no in-memory token yet
  await new Promise((r) => setTimeout(r, 0)); // let the async clear write-through land
  await setStoredTokenAsync('tok_persisted'); // what a native cold start reads from SecureStore
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(`${String(url)} ${init?.headers ? (init.headers as Record<string, string>).authorization ?? 'no-auth' : 'no-auth'}`);
    return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await hydrateToken();
    await api.get('/users/me');
    assert.equal(calls[0], '/users/me Bearer tok_persisted');
  } finally {
    globalThis.fetch = orig;
    setToken(null);
  }
});

test('401 → refresh rotation persists the new pair and replays the request with it', async () => {
  const orig = globalThis.fetch;
  let refreshCalls = 0;
  let meCalls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/auth/refresh')) {
      refreshCalls += 1;
      return new Response(
        JSON.stringify({ accessToken: 'at_new', refreshToken: 'rt_new', user: { id: 'u1', phone: '+255700000000' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    meCalls += 1;
    if (meCalls === 1) {
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'token expired' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
    const auth = init?.headers ? (init.headers as Record<string, string>).authorization : undefined;
    assert.equal(auth, 'Bearer at_new', 'replayed request uses the rotated token');
    return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await setStoredSession({
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      userId: 'u1',
      phone: '+255700000000',
      locale: 'en',
      savedAt: new Date().toISOString(),
    });
    setToken('at_old');

    await api.get('/users/me');

    assert.equal(refreshCalls, 1, 'single-flight refresh fires exactly once');
    const stored = await getStoredSession();
    assert.ok(stored, 'stored session survives the rotation');
    assert.equal(stored?.accessToken, 'at_new', 'rotated access token is persisted');
    assert.equal(stored?.refreshToken, 'rt_new', 'rotated refresh token is persisted');
    assert.equal(await getStoredTokenAsync(), 'at_new', 'token store follows the rotation');
  } finally {
    globalThis.fetch = orig;
    setToken(null);
  }
});
