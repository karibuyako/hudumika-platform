/* M6 hardening tests: lib format/countdown math, i18n, zustand stores
 * (network/jobs/session), API client 401-refresh single-flight, offline queue
 * and token storage. Everything runs in-process — the repo factories default
 * to mocks, tokenStore falls back to its in-memory cache, and the queue keeps
 * an in-memory mirror where localStorage is unavailable.
 *
 * The countdown formula under test mirrors src/app/(tabs)/home/index.tsx
 * (OFFER_DISPLAY_SECONDS = 120); the pure helper lives in src/lib/format.ts.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mmss, clock, clockISO, dateISO, minutesLabel, countdownRemaining } from '@/lib/format';
import { formatTZS, t, setLocale, getLocale } from '@/i18n';
import { useNetworkStore } from '@/store/network';
import { useJobsStore } from '@/store/jobs';
import { useSessionStore } from '@/store/session';
import { api, ApiError } from '@/api/client';
import { enqueue, dequeue, clearQueue, queuedOps, flushQueue } from '@/api/queue';
import { setTokenPair, getTokenPair, getCachedTokenPair, clearTokens } from '@/api/tokenStore';
import { ApiDeliveryRepository } from '@/repos/api/delivery';
import { ApiPaymentRepository } from '@/repos/api/payments';
import { resetMockState } from '@/repos/mock/mockState';

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await clearTokens();
  resetMockState();
  clearQueue();
  useNetworkStore.setState({ online: true, syncing: false, queuedCount: 0, lastSync: null });
  useJobsStore.setState({ available: [], offers: {}, heatmap: [], loading: false, error: null, activeOrder: null });
  useSessionStore.setState({ status: 'boot', token: null, rider: null });
  setLocale('en');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ---------------- lib/format.ts ---------------- */

test('format: mmss pads, floors and clamps negatives to zero', () => {
  assert.equal(mmss(0), '00:00');
  assert.equal(mmss(59), '00:59');
  assert.equal(mmss(61), '01:01');
  assert.equal(mmss(3599), '59:59');
  assert.equal(mmss(3600), '60:00');
  assert.equal(mmss(61.9), '01:01');
  assert.equal(mmss(-5), '00:00');
});

test('format: clockISO/dateISO return em dash for invalid input', () => {
  assert.equal(clockISO(null), '—');
  assert.equal(clockISO(undefined), '—');
  assert.equal(clockISO(''), '—');
  assert.equal(clockISO('not-a-date'), '—');
  assert.equal(dateISO(null), '—');
  assert.equal(dateISO(undefined), '—');
  assert.equal(dateISO('garbage'), '—');
  const iso = '2026-08-13T09:05:00Z';
  assert.equal(clockISO(iso), clock(new Date(iso).getTime()));
  assert.match(dateISO(iso), /\d{1,2} Aug · \d{2}:\d{2}/);
});

test('format: minutesLabel renders hours and minutes', () => {
  assert.equal(minutesLabel(0), '0m');
  assert.equal(minutesLabel(59), '59m');
  assert.equal(minutesLabel(60), '1h 0m');
  assert.equal(minutesLabel(90), '1h 30m');
  assert.equal(minutesLabel(1500), '25h 0m');
  assert.equal(minutesLabel(-10), '0m');
});

test('format: countdownRemaining clamps to [0, cap] — mirrors home/index.tsx countdown', () => {
  const now = 1_700_000_000_000;
  assert.equal(countdownRemaining(now + 5_000, now), 5);
  assert.equal(countdownRemaining(now + 200_000, now), 120);
  assert.equal(countdownRemaining(now + 999_999, now), 120);
  assert.equal(countdownRemaining(now - 1_000, now), 0);
  assert.equal(countdownRemaining(now + 1_500, now), 1);
  assert.equal(countdownRemaining(now + 60_000, now, 30), 30);
  assert.equal(countdownRemaining(now + 1_500, now, 10), 1);
  assert.equal(countdownRemaining(now - 1, now, 30), 0);
});

/* ---------------- i18n ---------------- */

test('i18n: formatTZS formats integer money with en-US grouping', () => {
  assert.equal(formatTZS(1250), 'TZS 1,250');
  assert.equal(formatTZS(0), 'TZS 0');
  assert.equal(formatTZS(-1250), 'TZS -1,250');
  assert.equal(formatTZS(1_000_000), 'TZS 1,000,000');
  assert.equal(formatTZS(1250.6), 'TZS 1,251');
});

test('i18n: t substitutes {n} params', () => {
  assert.equal(t('earnings.payoutIssueSubject', { payoutId: 'po_123' }), 'Payout issue — po_123');
  assert.equal(t('earnings.payoutIssueSubject', { payoutId: 42 }), 'Payout issue — 42');
});

test('i18n: setLocale switches strings and restore() brings en back', () => {
  assert.equal(getLocale(), 'en');
  setLocale('sw');
  assert.equal(getLocale(), 'sw');
  assert.equal(t('tab.home'), 'Nyumbani');
  assert.equal(t('login.title'), 'Mwendesha Hudumika');
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('tab.home'), 'Home');
});

test('i18n: unknown key falls back through en then the key itself', () => {
  const tLoose = t as unknown as (key: string, params?: Record<string, string | number>) => string;
  assert.equal(tLoose('i18n.never.defined'), 'i18n.never.defined');
  setLocale('sw');
  assert.equal(tLoose('i18n.never.defined'), 'i18n.never.defined');
  setLocale('en');
});

/* ---------------- store/network.ts ---------------- */

test('network: initial state', () => {
  const s = useNetworkStore.getState();
  assert.equal(typeof s.online, 'boolean');
  assert.equal(s.syncing, false);
  assert.equal(s.queuedCount, 0);
  assert.equal(s.lastSync, null);
});

test('network: setters update queuedCount/syncing/lastSync', () => {
  const s = useNetworkStore.getState();
  s.setQueuedCount(3);
  assert.equal(useNetworkStore.getState().queuedCount, 3);
  s.setSyncing(true);
  assert.equal(useNetworkStore.getState().syncing, true);
  s.setLastSync(1234567890);
  assert.equal(useNetworkStore.getState().lastSync, 1234567890);
  s.setLastSync(0);
  assert.equal(useNetworkStore.getState().lastSync, 0);
});

test('network: offline banner state transitions', () => {
  const s = useNetworkStore.getState();
  assert.equal(useNetworkStore.getState().online, true);
  s.setOnline(false);
  assert.equal(useNetworkStore.getState().online, false);
  s.setQueuedCount(2);
  assert.equal(useNetworkStore.getState().online, false);
  assert.equal(useNetworkStore.getState().queuedCount, 2);
  s.setOnline(true);
  s.setQueuedCount(0);
  assert.equal(useNetworkStore.getState().online, true);
  assert.equal(useNetworkStore.getState().queuedCount, 0);
});

/* ---------------- store/jobs.ts ---------------- */

test('jobs: refresh populates available feed and heatmap from mock', async () => {
  await useJobsStore.getState().refresh();
  const s = useJobsStore.getState();
  assert.equal(s.loading, false);
  assert.equal(s.error, null);
  assert.equal(s.available.length, 5);
  assert.equal(s.heatmap.length, 5);
  assert.ok(s.available[0].orderId.length > 0);
  assert.ok(s.offers[s.available[0].orderId], 'offer snapshot retained per orderId');
});

test('jobs: acceptOffer removes the item and sets activeOrder', async () => {
  await useJobsStore.getState().refresh();
  const first = useJobsStore.getState().available[0];
  const order = await useJobsStore.getState().acceptOffer(first.orderId);
  assert.ok(order, 'accepted order returned');
  assert.equal(order.status, 'rider_assigned');
  const s = useJobsStore.getState();
  assert.equal(s.available.length, 4);
  assert.equal(s.available.some((i) => i.orderId === first.orderId), false);
  assert.equal(s.activeOrder?.id, first.orderId);
});

test('jobs: rejectOffer removes the item', async () => {
  await useJobsStore.getState().refresh();
  const first = useJobsStore.getState().available[0];
  await useJobsStore.getState().rejectOffer(first.orderId, 'Traffic');
  const s = useJobsStore.getState();
  assert.equal(s.available.length, 4);
  assert.equal(s.available.some((i) => i.orderId === first.orderId), false);
  assert.equal(s.activeOrder, null);
});

test('jobs: refresh resets error at start of a load', async () => {
  useJobsStore.setState({ error: 'boom' });
  await useJobsStore.getState().refresh();
  assert.equal(useJobsStore.getState().error, null);
  assert.equal(useJobsStore.getState().available.length, 5);
});

/* ---------------- store/session.ts ---------------- */

test('session: restore with no stored token -> anon', async () => {
  await useSessionStore.getState().restore();
  const s = useSessionStore.getState();
  assert.equal(s.status, 'anon');
  assert.equal(s.token, null);
  assert.equal(s.rider, null);
});

test('session: restore with stored tokens -> authed via me()', async () => {
  await setTokenPair({ accessToken: 'at_1', refreshToken: 'rt_1' });
  await useSessionStore.getState().restore();
  const s = useSessionStore.getState();
  assert.equal(s.status, 'authed');
  assert.equal(s.token, 'at_1');
  assert.ok(s.rider, 'rider profile loaded from mock me()');
  assert.equal(s.rider.verification, 'approved');
});

test('session: requestOtp + verifyOtp -> authed with persisted tokens', async () => {
  const store = useSessionStore.getState();
  const res = await store.requestOtp('+255700000000');
  assert.ok(res.debugCode, 'mock returns a debug code');
  await store.verifyOtp(res.requestId, res.debugCode as string);
  const s = useSessionStore.getState();
  assert.equal(s.status, 'authed');
  assert.ok(s.token, 'access token held in state');
  const pair = await getTokenPair();
  assert.ok(pair, 'token pair persisted');
  assert.equal(pair.accessToken, s.token);
  assert.ok(pair.refreshToken.length > 0);
});

test('session: logout -> anon and tokens cleared', async () => {
  const store = useSessionStore.getState();
  const res = await store.requestOtp('+255700000000');
  await store.verifyOtp(res.requestId, res.debugCode as string);
  assert.equal(useSessionStore.getState().status, 'authed');
  await store.logout();
  const s = useSessionStore.getState();
  assert.equal(s.status, 'anon');
  assert.equal(s.token, null);
  assert.equal(s.rider, null);
  assert.equal(await getTokenPair(), null);
});

/* ---------------- api/tokenStore.ts ---------------- */

test('tokenStore: set/get round-trip, cached hot path, clearTokens wipes', async () => {
  assert.equal(await getTokenPair(), null);
  assert.equal(getCachedTokenPair(), null);
  await setTokenPair({ accessToken: 'at', refreshToken: 'rt' });
  assert.deepEqual(await getTokenPair(), { accessToken: 'at', refreshToken: 'rt' });
  assert.deepEqual(getCachedTokenPair(), { accessToken: 'at', refreshToken: 'rt' });
  await clearTokens();
  assert.equal(await getTokenPair(), null);
  assert.equal(getCachedTokenPair(), null);
});

test('tokenStore: setTokenPair(null) wipes every store', async () => {
  await setTokenPair({ accessToken: 'a', refreshToken: 'r' });
  await setTokenPair(null);
  assert.equal(await getTokenPair(), null);
  assert.equal(getCachedTokenPair(), null);
});

/* ---------------- api/client.ts (401 refresh) ---------------- */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

test('client: 401 rotates the token via refresh then retries once', async () => {
  await setTokenPair({ accessToken: 'old_at', refreshToken: 'old_rt' });
  let usersMeHits = 0;
  let refreshHits = 0;
  stubFetch(async (url, init) => {
    if (url.endsWith('/api/auth/refresh')) {
      refreshHits += 1;
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(init?.body as string), { refreshToken: 'old_rt' });
      return jsonResponse(200, { accessToken: 'new_at', refreshToken: 'new_rt' });
    }
    if (url.endsWith('/api/users/me')) {
      usersMeHits += 1;
      if (usersMeHits === 1) return jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
      return jsonResponse(200, { id: 'u1' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const user = await api.get<{ id: string }>('/users/me');
  assert.equal(user.id, 'u1');
  assert.equal(refreshHits, 1);
  assert.equal(usersMeHits, 2);
  const pair = await getTokenPair();
  assert.equal(pair?.accessToken, 'new_at');
  assert.equal(pair?.refreshToken, 'new_rt');
});

test('client: concurrent 401s share a single refresh call', async () => {
  await setTokenPair({ accessToken: 'old_at', refreshToken: 'old_rt' });
  let usersMeHits = 0;
  let refreshHits = 0;
  stubFetch(async (url) => {
    if (url.endsWith('/api/auth/refresh')) {
      refreshHits += 1;
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse(200, { accessToken: 'new_at', refreshToken: 'new_rt' });
    }
    if (url.endsWith('/api/users/me')) {
      usersMeHits += 1;
      if (usersMeHits <= 2) return jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
      return jsonResponse(200, { id: 'u1' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const [a, b] = await Promise.all([api.get<{ id: string }>('/users/me'), api.get<{ id: string }>('/users/me')]);
  assert.equal(a.id, 'u1');
  assert.equal(b.id, 'u1');
  assert.equal(refreshHits, 1);
});

test('client: 401 with failing refresh wipes tokens and throws ApiError 401', async () => {
  await setTokenPair({ accessToken: 'old_at', refreshToken: 'old_rt' });
  stubFetch(async (url) => {
    if (url.endsWith('/api/auth/refresh')) return jsonResponse(500, {});
    if (url.endsWith('/api/users/me')) return jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
    throw new Error(`unexpected fetch: ${url}`);
  });

  let caught: unknown;
  try {
    await api.get('/users/me');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal((caught as ApiError).status, 401);
  assert.equal(await getTokenPair(), null);
});

/* ---------------- api/queue.ts ---------------- */

test('queue: enqueue caps at 200 ops and reports the queued count', () => {
  for (let i = 0; i < 220; i += 1) {
    enqueue({ method: 'POST', path: `/orders/o${i}/accept`, body: { i } });
  }
  const ops = queuedOps();
  assert.equal(ops.length, 200);
  assert.equal(useNetworkStore.getState().queuedCount, 200);
  assert.equal(ops[0].method, 'POST');
  assert.ok(ops[0].key.length > 0);
  assert.ok(ops[0].at > 0);
  assert.deepEqual(ops[0].body, { i: 0 });
});

test('queue: dequeue removes exactly one op', () => {
  const a = enqueue({ method: 'PATCH', path: '/orders/1', body: {} });
  const b = enqueue({ method: 'PATCH', path: '/orders/2', body: {} });
  dequeue(a.key);
  const ops = queuedOps();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].key, b.key);
});

test('queue: clearQueue empties and resets the count', () => {
  enqueue({ method: 'POST', path: '/x', body: {} });
  enqueue({ method: 'POST', path: '/y', body: {} });
  clearQueue();
  assert.deepEqual(queuedOps(), []);
  assert.equal(useNetworkStore.getState().queuedCount, 0);
});

test('queue: flushQueue with no ops returns true and syncing stays false', async () => {
  assert.deepEqual(queuedOps(), []);
  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.equal(useNetworkStore.getState().syncing, false);
});

/* ---------------- api repos (delivery advance, payment QR) ---------------- */

/* Node 22 ships a global `navigator` with no onLine → the client's offline
 * gate (typeof navigator !== 'undefined' && !navigator.onLine) would queue
 * these POSTs instead of fetching. Define it once per test. */
function stubOnline() {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
}

test('api delivery advance: posts {status, note} and never a pickupCode', async () => {
  stubOnline();
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  stubFetch(async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return jsonResponse(200, { id: 'o1', version: 3, status: 'picked_up' });
  });
  const repo = new ApiDeliveryRepository();
  const updated = await repo.advance('o1', 'picked_up', { note: 'Manual confirm', pickupCode: '1234' });
  assert.equal(updated.status, 'picked_up');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'expected a POST');
  assert.equal(post.url, '/api/orders/o1/status');
  assert.deepEqual(post.body, { status: 'picked_up', note: 'Manual confirm' });
  assert.ok(!('pickupCode' in (post.body as Record<string, unknown>)));
});

test('api delivery advance: no note is sent when not provided', async () => {
  stubOnline();
  let posted: unknown;
  stubFetch(async (url, init) => {
    posted = JSON.parse(init?.body as string);
    return jsonResponse(200, { id: 'o1', version: 5, status: 'rider_arrived_dropoff' });
  });
  const repo = new ApiDeliveryRepository();
  await repo.advance('o1', 'rider_arrived_dropoff');
  assert.deepEqual(posted, { status: 'rider_arrived_dropoff' });
});

test('api payments createCollectionQr: posts {provider, amountTZS, orderId} to /payments/qr', async () => {
  stubOnline();
  let posted: unknown;
  stubFetch(async (url, init) => {
    assert.equal(url, '/api/payments/qr');
    assert.equal(init?.method, 'POST');
    posted = JSON.parse(init?.body as string);
    return jsonResponse(200, {
      qrPayload: 'payload-1',
      provider: 'mpesa',
      amountTZS: 5000,
      merchantRef: 'MER-1',
      expiresAt: '2026-08-14T10:00:00Z',
    });
  });
  const repo = new ApiPaymentRepository();
  const qr = await repo.createCollectionQr('o1', { amountTZS: 5000 });
  assert.deepEqual(posted, { provider: 'mpesa', amountTZS: 5000, orderId: 'o1' });
  assert.equal(qr.qrPayload, 'payload-1');
  assert.equal(qr.amountTZS, 5000);
  assert.equal(qr.merchantRef, 'MER-1');
});

test('api payments createCollectionQr: defaults amountTZS to null (variable amount)', async () => {
  stubOnline();
  let posted: unknown;
  stubFetch(async (url, init) => {
    posted = JSON.parse(init?.body as string);
    return jsonResponse(200, { qrPayload: 'p', provider: 'mpesa', amountTZS: null, expiresAt: '2026-08-14T10:00:00Z' });
  });
  const repo = new ApiPaymentRepository();
  const qr = await repo.createCollectionQr('o1');
  assert.deepEqual(posted, { provider: 'mpesa', amountTZS: null, orderId: 'o1' });
  assert.equal(qr.amountTZS, null);
});
