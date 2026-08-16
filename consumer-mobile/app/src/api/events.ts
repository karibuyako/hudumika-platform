/* GET /events long-poll client (INSTRUCTIONS §7 realtime). REST for initial
 * state, this stream for live changes. Under mocks (EXPO_PUBLIC_MOCK_ORDERS
 * on) there is no server to poll — the stream stays off and screens refresh
 * via pull-to-refresh/polling. */
import { api } from '@/api/client';
import { eventBus, type ServerEventType } from '@/store/events';
import type { GetServerEvents200EventsItem } from '@hudumika/contract';

const MOCK_VALUES = new Set(['true', '1', 'yes']);

export function isEventsEnabled(): boolean {
  const v = process.env.EXPO_PUBLIC_MOCK_ORDERS;
  if (v === undefined || MOCK_VALUES.has(v)) return false;
  // Live backend also needs a session; 401s are handled by the client.
  return true;
}

const POLL_TIMEOUT_MS = 25000;
const RETRY_MS = 3000;

let stopped = true;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastEventId: number | null = null;

export function stopEventStream() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function startEventStream() {
  if (!isEventsEnabled()) return;
  stopped = false;
  void poll();
}

async function poll() {
  if (stopped) return;
  try {
    const qs = lastEventId !== null ? `?lastEventId=${lastEventId}` : '';
    const events = await api.get<GetServerEvents200EventsItem[]>(`/events${qs}`, { timeoutMs: POLL_TIMEOUT_MS, skipAuthRefresh: false });
    for (const ev of events) {
      lastEventId = ev.id;
      eventBus.publish(ev.type as ServerEventType, ev.payload as Record<string, unknown> | undefined);
    }
  } catch {
    /* transient — back off and retry */
  } finally {
    if (!stopped) timer = setTimeout(() => void poll(), RETRY_MS);
  }
}