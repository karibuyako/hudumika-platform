import type { ServerEvent } from '@/api/types';

/* Server-side event bus.
 * The log is persisted to localStorage so:
 *   - other tabs (simulated devices) see the same stream, and
 *   - clients that reconnect can catch up via ?after=<id>.
 * In-memory copy keeps the hot path fast; reads merge both sources.
 */

type Listener = (event: ServerEvent) => void;

const LOG_KEY = 'mockdb.events.log';
const SEQ_KEY = 'mockdb.events.seq';
const MAX_LOG = 300;

let seq = 0;
const localLog: { id: number; event: ServerEvent }[] = [];
const listeners = new Set<Listener>();

function readStored(): { id: number; event: ServerEvent }[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as { id: number; event: ServerEvent }[];
  } catch {
    return [];
  }
}

function readStoredSeq(): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    return Number(localStorage.getItem(SEQ_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function emit(event: ServerEvent) {
  seq += 1;
  const entry = { id: seq, event };
  localLog.push(entry);
  if (localLog.length > MAX_LOG) localLog.splice(0, localLog.length - MAX_LOG);
  listeners.forEach((l) => l(entry.event));
  if (typeof localStorage !== 'undefined') {
    try {
      const tail = [...readStored(), entry].slice(-MAX_LOG);
      localStorage.setItem(LOG_KEY, JSON.stringify(tail));
      localStorage.setItem(SEQ_KEY, String(seq));
    } catch {
      /* quota / privacy mode */
    }
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Events with id > afterId, merging the in-memory and shared (cross-tab) logs. */
export function eventsAfter(afterId: number): { id: number; event: ServerEvent }[] {
  const merged = new Map<number, ServerEvent>();
  for (const e of localLog) merged.set(e.id, e.event);
  for (const e of readStored()) merged.set(e.id, e.event);
  const seqHigh = Math.max(seq, readStoredSeq());
  return [...merged.entries()]
    .filter(([id]) => id > afterId && id <= seqHigh)
    .sort((a, b) => a[0] - b[0])
    .map(([id, event]) => ({ id, event }));
}

export function latestSeq(): number {
  return Math.max(localLog.length ? localLog[localLog.length - 1].id : 0, readStoredSeq());
}

/** Adopt the shared log when this tab boots after others. */
export function replayFromStorage() {
  if (typeof localStorage === 'undefined') return;
  try {
    const storedSeq = readStoredSeq();
    if (storedSeq > seq) seq = storedSeq;
    const stored = readStored();
    for (const e of stored) {
      if (!localLog.some((l) => l.id === e.id)) localLog.push(e);
    }
    localLog.sort((a, b) => a.id - b.id);
    if (localLog.length > MAX_LOG) localLog.splice(0, localLog.length - MAX_LOG);
  } catch {
    /* ignore */
  }
}
