/* Offline mutation queue verification (M6).
 *
 * The queue (src/api/queue.ts) persists mutations made offline and replays
 * them with their idempotency keys on reconnect. Browser globals are polyfilled
 * because node:test has none.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api } from '@/api/client';
import { clearQueue, flushQueue, queuedOps } from '@/api/queue';

const store = new Map<string, string>();

const webStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const nav = { onLine: true };

beforeEach(() => {
  store.clear();
  clearQueue();
  nav.onLine = true;
  globalThis.localStorage = webStorage;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
});

function fakeFetch(status: number) {
  globalThis.fetch = (async () => ({ ok: status >= 200 && status < 300, status })) as typeof fetch;
}

test('a mutation while offline throws OFFLINE_QUEUED and is persisted', async () => {
  nav.onLine = false;
  let caught: unknown;
  try {
    await api.post<void>('/bookings/b1/accept', {}, { idempotencyKey: 'op-1' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal(caught.status, 0);
  assert.equal(caught.code, 'OFFLINE_QUEUED');
  const ops = queuedOps();
  assert.equal(ops.length, 1);
  // The queue assigns its own stable key (used as the replay idempotency-key).
  assert.ok(ops[0].key.startsWith('POST:/bookings/b1/accept:'));
  assert.equal(ops[0].path, '/bookings/b1/accept');
});

test('flushQueue replays queued ops in order and clears the queue on success', async () => {
  nav.onLine = false;
  await api.post<void>('/bookings/b1/accept', { decision: 'ok' }, { idempotencyKey: 'op-1' }).catch(() => undefined);
  await api.post<void>('/bookings/b2/quote', { laborTZS: 1000 }, { idempotencyKey: 'op-2' }).catch(() => undefined);
  assert.equal(queuedOps().length, 2);

  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const before = queuedOps();
  nav.onLine = true; // back online — the queue can now flush
  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.equal(queuedOps().length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['idempotency-key'], before[0].key);
  assert.equal(calls[1].headers['idempotency-key'], before[1].key);
  assert.ok(calls[0].body.includes('decision'));
});

test('a 409 server conflict drops the stale op instead of replaying it', async () => {
  nav.onLine = false;
  await api.post<void>('/bookings/b1/accept', {}, { idempotencyKey: 'op-stale' }).catch(() => undefined);
  assert.equal(queuedOps().length, 1);

  fakeFetch(409);
  nav.onLine = true;
  const ok = await flushQueue();
  assert.equal(ok, true);
  assert.equal(queuedOps().length, 0, '409 means the server superseded the op — drop it');
});

test('a 5xx aborts the flush and keeps the op for a later retry', async () => {
  nav.onLine = false;
  await api.post<void>('/bookings/b1/accept', {}, { idempotencyKey: 'op-retry' }).catch(() => undefined);

  fakeFetch(503);
  nav.onLine = true;
  const ok = await flushQueue();
  assert.equal(ok, false);
  assert.equal(queuedOps().length, 1);
});
