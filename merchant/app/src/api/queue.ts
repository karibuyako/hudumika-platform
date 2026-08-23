import { getToken, resolveApiUrl } from '@/api/client';
import { useNetworkStore } from '@/store/network';

/**
 * Offline-first mutation queue.
 * Mutations made while offline are persisted and replayed in order when
 * connectivity returns. Each op carries its idempotency key so the server
 * dedupes against anything that already landed.
 *
 * Persistence: localStorage on web (queue survives reloads); an in-memory
 * fallback on native, where localStorage does not exist. Replay routes
 * through resolveApiUrl() (client.ts) so queued ops hit the same base path
 * convention as live requests — never a hardcoded /api prefix.
 */

export interface QueuedOp {
  key: string;
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  at: number;
}

/* Sensitive actions (MASTER-BLUEPRINT §26): payment, cancellation, wallet
 * withdrawal/payout and privacy ops always require fresh server confirmation —
 * they are never queued offline. Failing fast keeps the user's money and
 * account state safe; everything else queues and replays when connectivity
 * returns. Mirrors consumer-mobile/src/api/client.ts:44 */
const SENSITIVE_PATHS: RegExp[] = [
  /^\/payments\/intent(?:s)?(?:\/|$)/,
  /^\/payments\/[^/]+\/confirm/,
  /^\/payments\/[^/]+\/reverse/,
  /^\/payments\/qr(?:\/|$)/,
  /^\/orders\/[^/]+\/cancel/,
  /^\/bookings\/[^/]+\/(cancel|complete|quote)/,
  /^\/reservations\/[^/]+\/cancel/,
  /^\/group-buys\/[^/]+\/purchase/,
  /^\/wallet\/me\/top-up/,
  /^\/wallet\/withdrawals/,
  /^\/payouts\//,
  /^\/finance\/settlements\//,
  /^\/privacy\/(delete|export)/,
  /^\/auth\/change-password/,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path));
}

const KEY = 'mq.queue';
const MAX_OPS = 200;
let flushing = false;
// In-memory fallback for native (no localStorage). Mirrors the persisted
// queue 1:1 so flush/enqueue/dequeue behave identically on both platforms.
let memQueue: QueuedOp[] | null = null;

function load(): QueuedOp[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as QueuedOp[]) : [];
    }
  } catch {
    /* storage unavailable — fall through to memory */
  }
  return memQueue ?? [];
}

function save(ops: QueuedOp[]) {
  const trimmed = ops.slice(0, MAX_OPS);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, JSON.stringify(trimmed));
    }
  } catch {
    /* storage unavailable — memory fallback still serves this session */
  }
  memQueue = trimmed;
  useNetworkStore.getState().setQueuedCount(trimmed.length);
}

export function queuedOps(): QueuedOp[] {
  return load();
}

export function enqueue(op: Omit<QueuedOp, 'key' | 'at'>): QueuedOp {
  if (isSensitivePath(op.path)) {
    throw new Error(`[queue] refused sensitive path: ${op.path} — must fail fast, never queue (blueprint §26)`);
  }
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
      // Native has no navigator.onLine — always online; web keeps the check.
      const offline =
        process.env.EXPO_OS !== 'ios' && process.env.EXPO_OS !== 'android' && typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) return false;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': op.key };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(resolveApiUrl(op.path), {
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
