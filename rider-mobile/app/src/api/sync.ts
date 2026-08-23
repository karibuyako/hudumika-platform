/* Rider offline sync engine — POST /riders/me/sync/batch + GET /riders/me/sync/status
 * (ARCHITECTURE.md Phase 3). The backend batch endpoint is sequence-numbered and
 * idempotent; this module maps the local queue (QueuedOp) into sync events when
 * flushing, and exposes sync status for the pending-count badge.
 */
import { api, API_BASE } from '@/api/client';

export interface RiderSyncEvent {
  seq: number;
  type: 'order_status' | 'pod' | 'location' | 'safety_event' | 'cod_cash' | 'chat_send';
  payload: unknown;
  capturedAt: string;
}

export interface SyncBatchRequest {
  events: RiderSyncEvent[];
  idempotencyKey: string;
}

export interface SyncBatchResponse {
  accepted: number;
  rejected: { seq: number; code: string; message?: string }[];
  highWaterMark: number;
}

export interface SyncStatus {
  highWaterMark: number;
  pendingCount: number;
  lastSyncedAt?: string | null;
  gaps?: number[];
}

let syncSeq = 0;

export function nextSeq(): number {
  syncSeq += 1;
  return syncSeq;
}

export function resetSyncSeq(to = 0) {
  syncSeq = to;
}

/* Adapters — map repo payloads to sync event types when needed.
 * For now the generic queue drives most mutations; these helpers let callers
 * build a typed batch directly when the sync path is used.
 */
export function buildOrderStatusEvent(seq: number, payload: unknown): RiderSyncEvent {
  return { seq, type: 'order_status', payload, capturedAt: new Date().toISOString() };
}

export function buildPodEvent(seq: number, payload: unknown): RiderSyncEvent {
  return { seq, type: 'pod', payload, capturedAt: new Date().toISOString() };
}

export async function syncRiderBatch(req: SyncBatchRequest): Promise<SyncBatchResponse> {
  // Allow mocks in dev to short-circuit — API_BASE empty means MSW will intercept
  // but the contract path is /riders/me/sync/batch (relative via api client).
  return api.post<SyncBatchResponse>('/riders/me/sync/batch', req);
}

export async function getRiderSyncStatus(): Promise<SyncStatus> {
  return api.get<SyncStatus>('/riders/me/sync/status');
}

/* Batch flush helper: attempts sync/batch for up to 500 queued ops, then
 * falls back to per-op replay if the server doesn't support it (404/422).
 * Returns true if all ops were accepted (or queue empty), false to retry later.
 */
export async function flushViaSyncBatch(
  ops: { key: string; method: string; path: string; body: unknown; at: number }[],
): Promise<{ ok: boolean; highWaterMark?: number; rejected?: SyncBatchResponse['rejected'] }> {
  if (!ops.length) return { ok: true };
  if (!API_BASE && process.env.EXPO_PUBLIC_ENV !== 'production') {
    // In dev with empty base the contract mock (if mounted) can handle sync/batch,
    // but many local runs have no server — caller should fall back to direct queue.
    return { ok: false };
  }
  const events: RiderSyncEvent[] = ops.slice(0, 500).map((op, idx) => ({
    seq: idx + 1,
    type: mapPathToSyncType(op.path),
    payload: { method: op.method, path: op.path, body: op.body },
    capturedAt: new Date(op.at).toISOString(),
  }));
  const idempotencyKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const res = await syncRiderBatch({ events, idempotencyKey });
    return { ok: res.rejected.length === 0, highWaterMark: res.highWaterMark, rejected: res.rejected };
  } catch {
    return { ok: false };
  }
}

function mapPathToSyncType(path: string): RiderSyncEvent['type'] {
  if (path.includes('/orders/') && path.includes('/status')) return 'order_status';
  if (path.includes('/proof-of-delivery')) return 'pod';
  if (path.includes('/location')) return 'location';
  if (path.includes('/safety-events') || path.includes('/sos')) return 'safety_event';
  if (path.includes('/location') || path.includes('/trips')) return 'location';
  return 'order_status';
}
