import type { ServerEvent } from '@/api/types';
import { api } from '@/api/client';

/**
 * Near real-time event delivery via long-polling.
 * The mock server holds the request for ~20s and returns any events
 * published after the last seen sequence. On network loss the poll
 * restarts with backoff (graceful degradation).
 */

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let lastSeq = 0;
let active = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500;

export function onServerEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function poll() {
  if (!active) return;
  try {
    const res = await api.get<{ seq: number; events: ServerEvent[] }>(`/events?after=${lastSeq}`, {
      timeoutMs: 25000,
      retries: 0,
    });
    backoff = 500;
    if (res.seq > lastSeq) lastSeq = res.seq;
    for (const e of res.events) {
      listeners.forEach((l) => {
        try {
          l(e);
        } catch {
          /* listener error must not kill the poll */
        }
      });
    }
    if (active) timer = setTimeout(poll, 100);
  } catch {
    if (!active) return;
    backoff = Math.min(15000, backoff * 2);
    if (active) timer = setTimeout(poll, backoff);
  }
}

export function startEventPolling() {
  if (active) return;
  active = true;
  poll();
}

export function stopEventPolling() {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
