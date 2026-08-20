/* Offline queue tests — enqueue / replay / conflict for rider.
 * Mirrors merchant's queue.test.ts but against the rider queue implementation
 * (src/api/queue.ts, src/store/network.ts, src/api/tokenStore.ts).
 * No MSW server — stubbed fetch suffices because rider's replay is a plain
 * fetch loop with idempotency-key + bearer headers.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { enqueue, queuedOps, dequeue, clearQueue, flushQueue } from '@/api/queue';
import { useNetworkStore } from '@/store/network';
import { setTokenPair, clearTokens } from '@/api/tokenStore';

const originalFetch = globalThis.fetch;

function setOnline(v: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: v, configurable: true });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const mem = new Map<string, string>();
if (typeof (globalThis as unknown as { localStorage?: unknown }).localStorage === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
}
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });

beforeEach(async () => {
  await clearTokens();
  clearQueue();
  mem.clear();
  try { localStorage.clear(); } catch {}
  useNetworkStore.setState({ online: true, syncing: false, queuedCount: 0, lastSync: null });
  setOnline(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOnline(true);
});

test('enqueue persists an op with key + timestamp and bumps queuedCount', () => {
  const op = enqueue({ method: 'POST', path: '/orders/o1/status', body: { status: 'picked_up' } });
  assert.ok(op.key.length > 0);
  assert.match(op.key, /^POST:\/orders\/o1\/status:/);
  assert.ok(op.at > 0);
  const ops = queuedOps();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].key, op.key);
  assert.equal(useNetworkStore.getState().queuedCount, 1);
});

test('enqueue generates a unique key per call — replay safety', () => {
  const a = enqueue({ method: 'POST', path: '/orders/o1/status', body: {} });
  const b = enqueue({ method: 'POST', path: '/orders/o1/status', body: {} });
  assert.notEqual(a.key, b.key);
  assert.equal(queuedOps().length, 2);
});

test('queuedOps returns ops in FIFO order', () => {
  assert.deepEqual(queuedOps(), []);
  enqueue({ method: 'POST', path: '/a', body: {} });
  enqueue({ method: 'POST', path: '/b', body: {} });
  const ops = queuedOps();
  assert.equal(ops[0].path, '/a');
  assert.equal(ops[1].path, '/b');
});

test('dequeue removes exactly one op', () => {
  const a = enqueue({ method: 'POST', path: '/a', body: {} });
  const b = enqueue({ method: 'POST', path: '/b', body: {} });
  dequeue(a.key);
  const ops = queuedOps();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].key, b.key);
});

test('clearQueue empties and resets queuedCount', () => {
  enqueue({ method: 'POST', path: '/a', body: {} });
  enqueue({ method: 'POST', path: '/b', body: {} });
  clearQueue();
  assert.deepEqual(queuedOps(), []);
  assert.equal(useNetworkStore.getState().queuedCount, 0);
});

test('enqueue caps at 200 ops', () => {
  for (let i = 0; i < 205; i += 1) enqueue({ method: 'POST', path: `/orders/o${i}/status`, body: {} });
  assert.equal(queuedOps().length, 200);
});

test('flushQueue replays ops in order with idempotency-key + bearer and clears on success', async () => {
  await setTokenPair({ accessToken: 'at_1', refreshToken: 'rt_1' });
  const seen: { url: string; method?: string; idem: string | null; auth: string | null; body: unknown }[] = [];
  stubFetch(async (url, init) => {
    const h = init?.headers as Record<string, string> | Headers | undefined;
    let idemHeader: string | null = null;
    let authHeader: string | null = null;
    if (h && typeof (h as Headers).get === 'function') {
      idemHeader = (h as Headers).get('idempotency-key');
      authHeader = (h as Headers).get('authorization');
    } else if (h) {
      idemHeader = (h as Record<string, string>)['idempotency-key'] ?? null;
      authHeader = (h as Record<string, string>).authorization ?? null;
    }
    seen.push({
      url,
      method: init?.method,
      idem: idemHeader,
      auth: authHeader,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return jsonResponse(200, { ok: true });
  });

  const a = enqueue({ method: 'POST', path: '/orders/o1/status', body: { status: 'picked_up' } });
  const b = enqueue({ method: 'POST', path: '/orders/o2/status', body: { status: 'delivering' } });

  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].idem, a.key);
  assert.equal(seen[0].auth, 'Bearer at_1');
  assert.deepEqual(seen[0].body, { status: 'picked_up' });
  assert.equal(seen[1].idem, b.key);
  assert.deepEqual(queuedOps(), []);
  assert.equal(useNetworkStore.getState().queuedCount, 0);
  assert.equal(useNetworkStore.getState().syncing, false);
  assert.ok(useNetworkStore.getState().lastSync);
});

test('flushQueue drops 409/404/410/403 and continues (conflict handling)', async () => {
  let dropCalls = 0;
  stubFetch(async (url) => {
    if (url.includes('/orders/conflict/status')) {
      dropCalls += 1;
      return jsonResponse(409, { error: { code: 'VERSION_CONFLICT' } });
    }
    if (url.includes('/orders/gone/status')) return jsonResponse(404, {});
    if (url.includes('/orders/keep/status')) return jsonResponse(200, {});
    return jsonResponse(200, {});
  });

  enqueue({ method: 'POST', path: '/orders/conflict/status', body: {} });
  enqueue({ method: 'POST', path: '/orders/gone/status', body: {} });
  enqueue({ method: 'POST', path: '/orders/keep/status', body: {} });

  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.equal(dropCalls, 1);
  assert.deepEqual(queuedOps(), [], 'all ops dropped/flushed even though some were conflicts');
});

test('flushQueue drops 403 (server superseded) and continues', async () => {
  stubFetch(async (url) => {
    if (url.includes('/orders/forbidden/status')) return jsonResponse(403, {});
    return jsonResponse(200, {});
  });
  enqueue({ method: 'POST', path: '/orders/forbidden/status', body: {} });
  enqueue({ method: 'POST', path: '/orders/ok/status', body: {} });
  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.deepEqual(queuedOps(), []);
});

test('flushQueue aborts on 5xx and retains the op for retry', async () => {
  stubFetch(async () => jsonResponse(503, {}));
  const op = enqueue({ method: 'POST', path: '/orders/boom/status', body: {} });
  const ok = await flushQueue();
  assert.equal(ok, false);
  assert.equal(queuedOps().length, 1);
  assert.equal(queuedOps()[0].key, op.key);
  assert.equal(useNetworkStore.getState().syncing, true);
});

test('flushQueue aborts on 500 and retains remainder', async () => {
  let call = 0;
  stubFetch(async () => {
    call += 1;
    if (call === 1) return jsonResponse(500, {});
    return jsonResponse(200, {});
  });
  enqueue({ method: 'POST', path: '/a', body: {} });
  enqueue({ method: 'POST', path: '/b', body: {} });
  const ok = await flushQueue();
  assert.equal(ok, false);
  assert.equal(queuedOps().length, 2);
});

test('flushQueue stops when connectivity drops mid-flush and keeps remainder', async () => {
  stubFetch(async (url) => {
    if (url.includes('/a')) {
      setOnline(false);
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {});
  });
  const a = enqueue({ method: 'POST', path: '/a', body: {} });
  const b = enqueue({ method: 'POST', path: '/b', body: {} });
  const ok = await flushQueue();
  assert.equal(ok, false);
  const left = queuedOps();
  assert.equal(left.length, 1);
  assert.equal(left[0].key, b.key);
  assert.notEqual(left[0].key, a.key);
  setOnline(true);
  stubFetch(async () => jsonResponse(200, {}));
  const retry = await flushQueue();
  assert.equal(retry, true);
  assert.deepEqual(queuedOps(), []);
});

test('flushQueue with empty queue returns true and clears syncing', async () => {
  useNetworkStore.getState().setSyncing(true);
  assert.equal(await flushQueue(), true);
  assert.equal(useNetworkStore.getState().syncing, false);
});

test('flushQueue ignores re-entrant call while flushing (no double replay)', async () => {
  let resolveGate: (r: Response) => void = () => {};
  const gate = new Promise<Response>((r) => (resolveGate = r));
  let hits = 0;
  stubFetch(async () => {
    hits += 1;
    return gate;
  });
  enqueue({ method: 'POST', path: '/slow', body: {} });
  const first = flushQueue();
  const second = await flushQueue();
  assert.equal(second, true, 'second flush short-circuits while first is running');
  assert.equal(hits, 1);
  resolveGate(jsonResponse(200, {}));
  assert.equal(await first, true);
  assert.deepEqual(queuedOps(), []);
});

test('flushQueue sends no auth header when no token stored', async () => {
  await clearTokens();
  let authSent: string | null | undefined;
  stubFetch(async (url, init) => {
    const h = init?.headers as Record<string, string> | Headers;
    if (h && typeof (h as Headers).get === 'function') authSent = (h as Headers).get('authorization');
    else authSent = (h as Record<string, string>)?.authorization;
    return jsonResponse(200, {});
  });
  enqueue({ method: 'POST', path: '/orders/o1/status', body: {} });
  await flushQueue();
  assert.equal(authSent, undefined, 'no bearer when no token');
});
