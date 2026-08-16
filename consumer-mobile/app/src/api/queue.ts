/* Offline-first mutation queue.
 * Non-sensitive mutations made while offline are persisted and replayed in
 * order when connectivity returns. Each op carries the ORIGINAL attempt's
 * idempotency key so the server dedupes against anything that already
 * landed (a replayed mutation must never double-submit). Sensitive actions
 * (payment, cancellation, quote approval, address change) are never enqueued
 * — client.ts fails them fast with code OFFLINE (MASTER-BLUEPRINT §26).
 *
 * Replay routes through the shared client wrapper (api/client.ts) so the
 * Authorization header, base-URL prefix, timeout and error handling apply
 * identically to a live request.
 */
import { ApiError, api, type RequestOptions } from '@/api/client';
import { useNetworkStore } from '@/store/network';

export interface QueuedOp {
  /** Idempotency key — the original attempt's key when it had one. */
  key: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body: unknown;
  at: number;
}

const KEY = 'consumer.queue';
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

export function enqueue(op: Omit<QueuedOp, 'key' | 'at'> & { idempotencyKey?: string }): QueuedOp {
  // Reuse the attempt's original idempotency key so a replay dedupes server-
  // side instead of double-submitting. Only ops without a key fall back to a
  // fabricated one (plain retries / pre-key call sites).
  const key = op.idempotencyKey ?? `${op.method}:${op.path}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  const stored: QueuedOp = { method: op.method, path: op.path, body: op.body, key, at: Date.now() };
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
      try {
        await replay(op);
        dequeue(op.key);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 404 || e.status === 410 || e.status === 403)) {
          // Server state superseded the op (e.g. order auto-cancelled) — drop it.
          dequeue(op.key);
          continue;
        }
        return false; // network/5xx — retry later
      }
    }
    useNetworkStore.getState().setLastSync(Date.now());
    return true;
  } finally {
    flushing = false;
    useNetworkStore.getState().setSyncing(load().length > 0);
  }
}

async function replay(op: QueuedOp): Promise<void> {
  const opts: RequestOptions = {
    idempotencyKey: op.key,
    retries: 1,
    timeoutMs: 30_000,
    skipOfflineQueue: true,
  };
  if (op.method === 'POST') await api.post(op.path, op.body, opts);
  else if (op.method === 'PATCH') await api.patch(op.path, op.body, opts);
  else await api.delete(op.path, opts);
}
