/* GET /events long-poll client for rider.
 * Mirrors consumer-mobile/app/src/api/events.ts but piggybacks on RiderEventType.
 * Under mocks (any MOCK_* true) there is no server to poll — the stream stays off
 * and screens refresh via pull-to-refresh / jobsStore.refresh().
 */
import { api } from '@/api/client';
import { eventBus, type RiderEventType } from '@/store/events';
import type { GetServerEvents200EventsItem } from '@hudumika/contract';

const MOCK_ON = (v: string | undefined) => v === undefined || v !== 'false';

function isEventsEnabled(): boolean {
  // If every mock switch is still ON (dev with empty API_URL) there's no backend.
  // Enable polling only when at least one live path is active and API_BASE is set.
  const hasLive = !MOCK_ON(process.env.EXPO_PUBLIC_MOCK_JOBS) || !MOCK_ON(process.env.EXPO_PUBLIC_MOCK_AUTH);
  const hasApiBase = !!process.env.EXPO_PUBLIC_API_URL;
  if (!hasLive || !hasApiBase) return false;
  return true;
}

const POLL_TIMEOUT_MS = 25000;
const RETRY_MS = 3000;

let stopped = true;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSeq: number | null = null;

export function stopEventStream() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function startEventStream() {
  if (!isEventsEnabled()) return;
  if (!stopped) return;
  stopped = false;
  void poll();
}

export function getLastSeq(): number | null {
  return lastSeq;
}

export function resetEventStreamSeq() {
  lastSeq = null;
}

async function poll() {
  if (stopped) return;
  try {
    const qs = lastSeq !== null ? `?after=${lastSeq}` : `?after=0`;
    const res = await api.get<{ events: GetServerEvents200EventsItem[]; latestSeq?: number } | GetServerEvents200EventsItem[]>(
      `/events${qs}`,
      { timeoutMs: POLL_TIMEOUT_MS },
    );
    const events: GetServerEvents200EventsItem[] = Array.isArray(res)
      ? res
      : ((res as { events: GetServerEvents200EventsItem[] }).events ?? []);
    const latest = (res as { latestSeq?: number })?.latestSeq;
    for (const ev of events) {
      lastSeq = ev.id;
      eventBus.publish(ev.type as RiderEventType, ev.payload as Record<string, unknown> | undefined);
    }
    if (latest != null && events.length === 0) lastSeq = latest;
  } catch {
    /* transient — back off and retry */
  } finally {
    if (!stopped) timer = setTimeout(() => void poll(), RETRY_MS);
  }
}
