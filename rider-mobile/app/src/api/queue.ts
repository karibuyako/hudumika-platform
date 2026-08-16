import { useNetworkStore } from '@/store/network';
import { getTokenPair } from '@/api/tokenStore';

/**
 * Offline-first mutation queue.
 * Mutations made while offline are persisted and replayed in order when
 * connectivity returns. Each op carries its idempotency key so the server
 * dedupes against anything that already landed.
 */

export interface QueuedOp {
  key: string;
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  at: number;
}

const KEY = 'mq.queue';
let flushing = false;
/** In-memory mirror — the queue must keep working where localStorage is
 * unavailable (node tests, Hermes without the web polyfill). Storage, when
 * present, is the source of truth and overwrites the mirror on load. */
let mem: QueuedOp[] = [];

function load(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as QueuedOp[]) : [];
    mem = stored;
    return stored;
  } catch {
    return mem;
  }
}

function save(ops: QueuedOp[]) {
  const capped = ops.slice(0, 200);
  mem = capped;
  try {
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    /* storage unavailable — in-memory only */
  }
  useNetworkStore.getState().setQueuedCount(capped.length);
}

export function queuedOps(): QueuedOp[] {
  return load();
}

export function enqueue(op: Omit<QueuedOp, 'key' | 'at'>): QueuedOp {
  const stored: QueuedOp = { ...op, key: `${op.method}:${op.path}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, at: Date.now() };
  save([...load(), stored]);
  return stored;
}

export function dequeue(key: string) {
  save(load().filter((o) => o.key !== key));
}

export function clearQueue() {
  save([]);
}

/** Replay queued mutations in order. Returns false if connectivity dropped mid-flush. */
export async function flushQueue(): Promise<boolean> {
  if (flushing) return true;
  const ops = load();
  if (!ops.length) {
    useNetworkStore.getState().setSyncing(false);
    return true;
  }
  flushing = true;
  useNetworkStore.getState().setSyncing(true);
  try {
    for (const op of ops) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': op.key };
      const pair = await getTokenPair();
      if (pair?.accessToken) headers.authorization = `Bearer ${pair.accessToken}`;
      const res = await fetch(`/api${op.path}`, {
        method: op.method,
        headers,
        body: JSON.stringify(op.body),
      });
      if (res.status === 409 || res.status === 404 || res.status === 410 || res.status === 403) {
        // Server state superseded the op (e.g. order auto-cancelled) — drop it.
        dequeue(op.key);
        continue;
      }
      if (res.status >= 500) return false; // retry later
      dequeue(op.key);
    }
    useNetworkStore.getState().setLastSync(Date.now());
    return true;
  } finally {
    flushing = false;
    useNetworkStore.getState().setSyncing(load().length > 0);
  }
}
