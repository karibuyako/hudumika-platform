import { useNetworkStore } from '@/store/network';
import { loadStoredToken } from '@/lib/tokenStore';

/**
 * Offline-first mutation queue.
 * Mutations made while offline are persisted and replayed in order when
 * connectivity returns. Each op carries its idempotency key so the server
 * dedupes against anything that already landed.
 */

export interface QueuedOp {
  key: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  at: number;
}

const KEY = 'provider.queue';
let flushing = false;

function load(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedOp[]) : [];
  } catch {
    return [];
  }
}

function save(ops: QueuedOp[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ops.slice(0, 200)));
  } catch {
    /* storage unavailable — best effort */
  }
  useNetworkStore.getState().setQueuedCount(ops.length);
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
      const token = loadStoredToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const base = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');
      const res = await fetch(`${base}/api${op.path}`, {
        method: op.method,
        headers,
        body: JSON.stringify(op.body),
      });
      if (res.status === 409 || res.status === 404 || res.status === 410 || res.status === 403) {
        // Server state superseded the op (e.g. job auto-cancelled) — drop it.
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
