import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { performAccept } from '@/mock/handlers/orders';
import { ApiError, api } from '@/api/client';
import { enqueue, queuedOps, dequeue, clearQueue, flushQueue } from '@/api/queue';
import { useNetworkStore } from '@/store/network';

/* The queue lives on localStorage and its replay path reads navigator.onLine —
 * neither exists in plain Node 22. Provide a tiny in-memory localStorage and a
 * configurable onLine flag before importing the queue (same file-level stub
 * approach the contract suite uses for its environment gaps). */
const memory = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
};
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
function setOnline(v: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: v, configurable: true });
}

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

/* flushQueue() fetches same-origin relative paths (/api/...) — MSW in Node only
 * intercepts absolute URLs. Wrap fetch AFTER server.listen() so the wrapper sits
 * above MSW's fetch proxy and absolutizes before the proxy ever sees the URL;
 * all queue replay tests then run against the real mock backend end-to-end. */
function wrapFetch() {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)) as typeof fetch;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; internal?: boolean; idem?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  if (opts.internal) headers['x-internal-key'] = 'demo-customer-platform';
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

/** Poll until fn stops throwing (default ~1s, 10ms intervals). */
async function waitFor(fn: () => void, ms = 1000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < ms) {
    try {
      fn();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw lastErr;
}

const MIN_ORDER = 30;

function minCart(items: { productId: string; qty: number }[]): { productId: string; qty: number }[] {
  const subtotal = items.reduce((s, it) => s + (db.table('products').find(it.productId)?.price ?? 0) * it.qty, 0);
  if (subtotal >= MIN_ORDER) return items;
  return [...items, { productId: 'p4', qty: 1 }];
}

/** Poll GET /orders/:id until the provider capture fires (~1.8-4.3s). */
async function waitCaptured(id: string): Promise<void> {
  let detail: any = null;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    detail = await call('GET', `/orders/${id}`);
    if (detail.body?.order?.payment?.status === 'captured') return;
  }
  assert.fail(`order ${id} payment was never captured`);
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  wrapFetch();
  db.reset();
  seedDatabase();
  token = await loginAs('+255700000000');
  localStorage.setItem('merchant.token', token);
});

beforeEach(() => {
  clearQueue();
  setOnline(true);
});

after(() => {
  server.close();
});

/* ================= Offline mutation queue (unit) ================= */

test('enqueue persists an op to localStorage with key + timestamp and bumps queuedCount', () => {
  const op = enqueue({ method: 'POST', path: '/orders/o1/accept', body: { expectedVersion: 1 } });
  assert.ok(op.key, 'key generated');
  assert.match(op.key, /^POST:\/orders\/o1\/accept:/);
  assert.ok(op.at > 0, 'timestamp recorded');
  const raw = JSON.parse(localStorage.getItem('mq.queue')!) as { key: string; method: string; path: string }[];
  assert.equal(raw.length, 1);
  assert.equal(raw[0].key, op.key);
  assert.equal(raw[0].method, 'POST');
  assert.equal(raw[0].path, '/orders/o1/accept');
  assert.equal(useNetworkStore.getState().queuedCount, 1);
});

test('enqueue generates a unique key per call — replay safety depends on it', () => {
  const a = enqueue({ method: 'PATCH', path: '/products/p1', body: { price: 20 } });
  const b = enqueue({ method: 'PATCH', path: '/products/p1', body: { price: 20 } });
  assert.notEqual(a.key, b.key, 'each queued op carries its own idempotency key');
  assert.equal(queuedOps().length, 2);
});

test('queuedOps returns stored ops in order; empty when nothing stored', () => {
  assert.deepEqual(queuedOps(), []);
  enqueue({ method: 'POST', path: '/orders/o1/accept', body: {} });
  enqueue({ method: 'POST', path: '/orders/o2/accept', body: {} });
  const ops = queuedOps();
  assert.equal(ops.length, 2);
  assert.equal(ops[0].path, '/orders/o1/accept');
  assert.equal(ops[1].path, '/orders/o2/accept');
});

test('dequeue removes only the targeted op and updates queuedCount', () => {
  const a = enqueue({ method: 'POST', path: '/a', body: {} });
  const b = enqueue({ method: 'POST', path: '/b', body: {} });
  dequeue(a.key);
  const left = queuedOps();
  assert.equal(left.length, 1);
  assert.equal(left[0].key, b.key);
  assert.equal(useNetworkStore.getState().queuedCount, 1);
});

test('clearQueue empties the queue and resets queuedCount', () => {
  enqueue({ method: 'POST', path: '/a', body: {} });
  enqueue({ method: 'POST', path: '/b', body: {} });
  clearQueue();
  assert.deepEqual(queuedOps(), []);
  assert.equal(useNetworkStore.getState().queuedCount, 0);
});

test('save caps the persisted queue at 200 ops', () => {
  for (let i = 0; i < 205; i++) enqueue({ method: 'POST', path: `/orders/o${i}/accept`, body: {} });
  assert.equal(queuedOps().length, 200, 'queue truncated to 200');
  clearQueue();
});

test('flushQueue replays ops in order with idempotency-key + bearer headers and clears on success', async () => {
  const captured: { method: string; url: string; idem: string | null; auth: string | null; body: unknown }[] = [];
  server.use(
    rawHttp.post('http://localhost/api/orders/flush-1/accept', async ({ request }) => {
      captured.push({
        method: request.method,
        url: request.url,
        idem: request.headers.get('idempotency-key'),
        auth: request.headers.get('authorization'),
        body: await request.json(),
      });
      return Response.json({ accepted: true });
    }),
    rawHttp.patch('http://localhost/api/products/flush-1', async ({ request }) => {
      captured.push({
        method: request.method,
        url: request.url,
        idem: request.headers.get('idempotency-key'),
        auth: request.headers.get('authorization'),
        body: await request.json(),
      });
      return Response.json({ ok: true });
    }),
  );

  const a = enqueue({ method: 'POST', path: '/orders/flush-1/accept', body: { expectedVersion: 1 } });
  const b = enqueue({ method: 'PATCH', path: '/products/flush-1', body: { price: 25 } });
  const ok = await flushQueue();

  assert.equal(ok, true);
  assert.equal(captured.length, 2, 'both ops replayed');
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].url, 'http://localhost/api/orders/flush-1/accept');
  assert.equal(captured[0].idem, a.key, 'op key sent as idempotency-key');
  assert.equal(captured[0].auth, `Bearer ${token}`, 'session token attached');
  assert.deepEqual(captured[0].body, { expectedVersion: 1 });
  assert.equal(captured[1].method, 'PATCH');
  assert.equal(captured[1].idem, b.key);
  assert.equal(captured[1].auth, `Bearer ${token}`);
  assert.deepEqual(queuedOps(), [], 'successful replay clears the queue');
  assert.equal(useNetworkStore.getState().queuedCount, 0);
  assert.equal(useNetworkStore.getState().syncing, false);
  assert.ok(useNetworkStore.getState().lastSyncAt, 'lastSyncAt recorded after a full flush');
});

test('flushQueue drops ops the server superseded (409/404/410/403) and keeps replaying', async () => {
  let dropCount = 0;
  server.use(
    rawHttp.post('http://localhost/api/orders/drop-me/accept', () => {
      dropCount += 1;
      return Response.json({ error: { code: 'VERSION_CONFLICT', message: 'superseded' } }, { status: 409 });
    }),
    rawHttp.post('http://localhost/api/orders/keep-me/accept', () => Response.json({ accepted: true })),
  );

  enqueue({ method: 'POST', path: '/orders/drop-me/accept', body: { expectedVersion: 1 } });
  enqueue({ method: 'POST', path: '/orders/keep-me/accept', body: { expectedVersion: 1 } });
  const ok = await flushQueue();

  assert.equal(ok, true, 'a superseded op is dropped, not a failure');
  assert.equal(dropCount, 1);
  assert.deepEqual(queuedOps(), [], 'conflict op dropped, remaining op flushed');
  assert.equal(useNetworkStore.getState().queuedCount, 0);
});

test('flushQueue aborts on 5xx and keeps the op for a later retry', async () => {
  server.use(rawHttp.post('http://localhost/api/orders/boom/accept', () => new Response(null, { status: 503 })));
  const op = enqueue({ method: 'POST', path: '/orders/boom/accept', body: { expectedVersion: 1 } });

  const ok = await flushQueue();
  assert.equal(ok, false, 'flush reports failure on 5xx');
  const left = queuedOps();
  assert.equal(left.length, 1, 'op retained for retry');
  assert.equal(left[0].key, op.key);
  assert.equal(useNetworkStore.getState().syncing, true, 'syncing stays on while ops remain');
});

test('flushQueue stops mid-flush when connectivity drops and keeps the remainder', async () => {
  server.use(
    rawHttp.post('http://localhost/api/orders/first/accept', () => {
      setOnline(false);
      return Response.json({ accepted: true });
    }),
    rawHttp.post('http://localhost/api/orders/second/accept', () => Response.json({ accepted: true })),
  );
  const a = enqueue({ method: 'POST', path: '/orders/first/accept', body: {} });
  const b = enqueue({ method: 'POST', path: '/orders/second/accept', body: {} });

  const ok = await flushQueue();
  assert.equal(ok, false, 'flush aborts when connectivity drops');
  const left = queuedOps();
  assert.equal(left.length, 1, 'second op never sent');
  assert.equal(left[0].key, b.key, 'unreplayed op retained');
  assert.notEqual(left[0].key, a.key, 'completed op dequeued');

  setOnline(true);
  const retry = await flushQueue();
  assert.equal(retry, true, 'flush completes once back online');
  assert.deepEqual(queuedOps(), []);
});

test('flushQueue with an empty queue returns true and clears syncing', async () => {
  useNetworkStore.getState().setSyncing(true);
  assert.equal(await flushQueue(), true);
  assert.equal(useNetworkStore.getState().syncing, false);
});

test('flushQueue ignores a concurrent second call — no double replay', async () => {
  let resolveFirst: (r: Response) => void = () => {};
  const firstGate = new Promise<Response>((r) => (resolveFirst = r));
  const seen: string[] = [];
  server.use(
    rawHttp.post('http://localhost/api/orders/slow/accept', ({ request }) => {
      seen.push(request.headers.get('idempotency-key') ?? '');
      return firstGate;
    }),
  );
  enqueue({ method: 'POST', path: '/orders/slow/accept', body: {} });

  try {
    const first = flushQueue();
    const second = await flushQueue();
    assert.equal(second, true, 're-entrant flush short-circuits while a flush is running');
    await waitFor(() => assert.equal(seen.length, 1, 'first flush dispatched exactly one request'));
    resolveFirst(Response.json({ accepted: true }));
    assert.equal(await first, true, 'first flush completes after the gate opens');
    assert.deepEqual(queuedOps(), [], 'single replay cleared the queue');
  } finally {
    resolveFirst(Response.json({ accepted: true }));
  }
});

/* ================= client.ts integration ================= */

test('client: offline mutation is enqueued and throws ApiError OFFLINE_QUEUED', async () => {
  setOnline(false);
  const before = queuedOps().length;
  try {
    await api.post('/orders/o_client_1/accept', { expectedVersion: 1 });
    assert.fail('offline mutation must throw');
  } catch (e) {
    assert.ok(e instanceof ApiError, 'ApiError thrown');
    const err = e as ApiError;
    assert.equal(err.status, 0);
    assert.equal(err.code, 'OFFLINE_QUEUED');
    assert.equal(err.retriable, true);
  }
  const ops = queuedOps();
  assert.equal(ops.length, before + 1, 'mutation persisted to the queue');
  assert.equal(ops[ops.length - 1].method, 'POST');
  assert.equal(ops[ops.length - 1].path, '/orders/o_client_1/accept');
  assert.deepEqual(ops[ops.length - 1].body, { expectedVersion: 1 });
});

test('client: online mutation is NOT enqueued and carries the idempotency-key header', async () => {
  let idem: string | null = null;
  server.use(
    rawHttp.post('http://localhost/api/orders/o_client_2/accept', ({ request }) => {
      idem = request.headers.get('idempotency-key');
      return Response.json({ accepted: true, order: { id: 'o_client_2', status: 'preparing' } });
    }),
  );
  const res = await api.post<{ accepted: boolean }>('/orders/o_client_2/accept', { expectedVersion: 1 }, { idempotencyKey: 'client-key-1' });
  assert.equal(res.accepted, true);
  assert.equal(idem, 'client-key-1', 'opts.idempotencyKey mapped to the idempotency-key header');
  assert.deepEqual(queuedOps(), [], 'online mutation never queued');
});

test('client: GET is never queued, even offline', async () => {
  setOnline(false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new TypeError('network down');
  }) as typeof fetch;
  try {
    await assert.rejects(
      api.get('/orders', { retries: 0 }),
      (e) => e instanceof ApiError && e.code === 'NETWORK_ERROR',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(queuedOps(), [], 'reads are never queued');
});

/* ================= Mutation idempotency (mock backend) ================= */

test('idempotency: same accept key twice returns the cached result, no double transition', async () => {
  const before = db.table('products').find('p1')?.stock ?? 0;
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p1', qty: 1 }]) } });
  const id = created.body.order.id;

  const first = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'q-idem-same' });
  assert.equal(first.status, 200);
  assert.equal(first.body.order.status, 'preparing');

  const second = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'q-idem-same' });
  assert.equal(second.status, 200);
  assert.equal(second.body.order.version, first.body.order.version, 'replay returned the cached result, not a re-apply');
  assert.equal(second.body.order.id, id);
  assert.equal(db.table('products').find('p1')?.stock, before - 1, 'stock decremented exactly once');
});

test('idempotency: accept without an idempotency key is rejected 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p2', qty: 1 }]) } });
  const res = await call('POST', `/orders/${created.body.order.id}/accept`, { body: { expectedVersion: 1 } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(db.table('orders').find(created.body.order.id)?.status, 'new', 'rejected accept never transitions the order');
});

test('idempotency: accept replay with a DIFFERENT key is absorbed by the state machine', async () => {
  const before = db.table('products').find('p2')?.stock ?? 0;
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p2', qty: 1 }]) } });
  const id = created.body.order.id;

  const first = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'q-key-a' });
  assert.equal(first.status, 200);
  const second = await call('POST', `/orders/${id}/accept`, { body: { expectedVersion: 1 }, idem: 'q-key-b' });
  assert.equal(second.status, 200, 'already-accepted order replays as ok, not a crash');
  assert.equal(second.body.order.status, 'preparing');
  assert.equal(second.body.order.version, first.body.order.version, 'no version bump on replay');
  assert.equal(db.table('products').find('p2')?.stock, before - 1, 'stock decremented once across both keys');
});

test('idempotency: double reject creates a single refund record', async () => {
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p3', qty: 1 }]) } });
  const id = created.body.order.id;
  await waitCaptured(id);
  const detail = await call('GET', `/orders/${id}`);

  const first = await call('POST', `/orders/${id}/reject`, { body: { reason: 'x', expectedVersion: detail.body.order.version }, idem: 'q-rej-a' });
  assert.equal(first.status, 200);
  const second = await call('POST', `/orders/${id}/reject`, { body: { reason: 'x', expectedVersion: detail.body.order.version }, idem: 'q-rej-b' });
  assert.equal(second.status, 200, 'double reject replays as ok');
  assert.equal(db.table('refunds').where((r: any) => r.orderId === id).length, 1, 'exactly one refund record');
});

test('idempotency: key reuse across a DIFFERENT order returns the first cached response', async () => {
  // The mock dedupes by key alone (idemGet('accept', key)), not by order id —
  // queue-generated keys are unique per op, so this never fires in the queue
  // path; the assertion pins the mock's dedupe semantics.
  const a = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p1', qty: 1 }]) } });
  const b = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p1', qty: 1 }]) } });
  const first = await call('POST', `/orders/${a.body.order.id}/accept`, { body: { expectedVersion: 1 }, idem: 'q-cross-order' });
  assert.equal(first.status, 200);
  const second = await call('POST', `/orders/${b.body.order.id}/accept`, { body: { expectedVersion: 1 }, idem: 'q-cross-order' });
  assert.equal(second.status, 200);
  assert.equal(second.body.order.id, a.body.order.id, 'cached payload replayed verbatim for the same key');
});

/* ================= Queue replay end-to-end against the mock backend ================= */

test('flushQueue replays a queued accept against the mock backend — applied once, queue cleared', async () => {
  const before = db.table('products').find('p4')?.stock ?? 0;
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p4', qty: 1 }]) } });
  const id = created.body.order.id;
  enqueue({ method: 'POST', path: `/orders/${id}/accept`, body: { expectedVersion: 1 } });

  const ok = await flushQueue();
  assert.equal(ok, true);
  const detail = await call('GET', `/orders/${id}`);
  assert.equal(detail.body.order.status, 'preparing', 'queued accept applied by replay');
  assert.equal(db.table('products').find('p4')?.stock, before - 1, 'stock decremented exactly once');
  assert.deepEqual(queuedOps(), [], 'queue cleared after successful replay');
  assert.ok(useNetworkStore.getState().lastSyncAt, 'lastSyncAt set after end-to-end replay');
});

test('flushQueue drops a stale op the server superseded (409 VERSION_CONFLICT)', async () => {
  const before = db.table('products').find('p4')?.stock ?? 0;
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p4', qty: 1 }]) } });
  const id = created.body.order.id;
  // Server state moves ahead (auto-accept) while the client is offline…
  assert.ok(performAccept(id, 'system-auto', 'system'), 'order accepted server-side');
  assert.equal(db.table('products').find('p4')?.stock, before - 1, 'server-side accept decremented stock');
  // …then the stale queued op (expectedVersion 1) replays.
  enqueue({ method: 'POST', path: `/orders/${id}/accept`, body: { expectedVersion: 1 } });

  const ok = await flushQueue();
  assert.equal(ok, true, 'conflict is treated as superseded — dropped, not fatal');
  assert.deepEqual(queuedOps(), [], 'stale op dropped from the queue');
  const detail = await call('GET', `/orders/${id}`);
  assert.equal(detail.body.order.status, 'preparing', 'order state untouched by the stale replay');
  assert.equal(db.table('products').find('p4')?.stock, before - 1, 'stock never double-decremented');
});

test('flushQueue aborts on a 5xx and keeps the op queued until the next flush', async () => {
  const created = await call('POST', '/orders', { internal: true, body: { items: minCart([{ productId: 'p1', qty: 1 }]) } });
  const id = created.body.order.id;
  enqueue({ method: 'POST', path: `/orders/${id}/accept`, body: { expectedVersion: 1 } });

  server.use(rawHttp.post(`http://localhost/api/orders/${id}/accept`, () => new Response(null, { status: 503 })));
  try {
    const ok = await flushQueue();
    assert.equal(ok, false);
    assert.equal(queuedOps().length, 1, 'op retained after transient failure');
  } finally {
    server.resetHandlers();
  }

  const retry = await flushQueue();
  assert.equal(retry, true, 'second flush applies the op');
  assert.deepEqual(queuedOps(), []);
  const detail = await call('GET', `/orders/${id}`);
  assert.equal(detail.body.order.status, 'preparing', 'op applied on retry');
});
