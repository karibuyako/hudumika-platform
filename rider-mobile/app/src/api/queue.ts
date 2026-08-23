import { useNetworkStore } from '@/store/network';
import { getCachedTokenPair } from '@/api/tokenStore';
import { API_BASE } from '@/api/client';

function safeStorage(): Storage | null {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : (globalThis as unknown as { localStorage?: Storage }).localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {}
  try {
    const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
    if (ss && typeof ss.getItem === 'function') return ss as unknown as Storage;
  } catch {}
  return null;
}

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
  const storage = safeStorage();
  if (!storage) return mem;
  try {
    const raw = storage.getItem(KEY);
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
  const storage = safeStorage();
  if (storage) {
    try {
      storage.setItem(KEY, JSON.stringify(capped));
    } catch {
      /* storage unavailable — in-memory only */
    }
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
    // Enterprise Phase 3: try sequence-numbered sync/batch (up to 500) when live backend is configured.
    // Falls back to per-op replay if sync is unavailable (404) or rejects gaps (SYNC_SEQUENCE_GAP).
    if (API_BASE) {
      try {
        const { flushViaSyncBatch } = await import('@/api/sync');
        const syncRes = await flushViaSyncBatch(ops);
        if (syncRes.ok) {
          const toDrop = syncRes.highWaterMark ?? ops.length;
          for (let i = 0; i < Math.min(toDrop, ops.length); i++) dequeue(ops[i].key);
          if (!syncRes.rejected?.length) {
            useNetworkStore.getState().setLastSync(Date.now());
            return true;
          }
          console.warn(`[queue] sync batch accepted ${toDrop} rejected ${syncRes.rejected?.length}`, syncRes.rejected);
        }
      } catch {
        /* sync not available in this env — fallback to per-op */
      }
    }
    for (const op of ops) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': op.key };
      const pair = getCachedTokenPair();
      if (pair?.accessToken) headers.authorization = `Bearer ${pair.accessToken}`;
      const url = API_BASE ? `${API_BASE}${op.path}` : `/api${op.path}`;
      const res = await fetch(url, {
        method: op.method,
        headers,
        body: JSON.stringify(op.body),
      });
      if (res.status === 409 || res.status === 404 || res.status === 410 || res.status === 403) {
        // Server state superseded the op (e.g. order auto-cancelled) — drop it.
        dequeue(op.key);
        continue;
      }
      if (res.status >= 500 || res.status === 429) return false; // retry later — rate-limited or server error
      if (!res.ok) {
        // 4xx client error (400, 422 etc.) — drop to avoid poison queue, but log for diagnostics.
        console.warn(`[queue] drop 4xx op ${op.key}: ${res.status}`);
        dequeue(op.key);
        continue;
      }
      dequeue(op.key);
    }
    useNetworkStore.getState().setLastSync(Date.now());
    return true;
  } finally {
    flushing = false;
    useNetworkStore.getState().setSyncing(load().length > 0);
  }
}
