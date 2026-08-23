/* Rider WebSocket client — WS /ws (backend/app/internal/api/websocket.go).
 * Falls back to long-poll /events if WS is unavailable (firewalled, background).
 * Auth via ?token= query param (bearer from tokenStore). The hub closes the
 * connection with 1008 when the token expires — the client then falls back to
 * polling until the next refresh.
 *
 * Usage: startRiderRealtime() when authed, stopRiderRealtime() on logout/anon.
 * Internally the WS publishes to the same eventBus as the poller so screens
 * have a single subscription point.
 */
import { API_BASE } from '@/api/client';
import { getTokenPair } from '@/api/tokenStore';
import { eventBus, type RiderEventType } from '@/store/events';
import { startEventStream, stopEventStream } from '@/api/events';

let ws: WebSocket | null = null;
let stopped = true;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

function wsUrl(token: string): string | null {
  if (!API_BASE) return null;
  // API_BASE like https://api.hudumika.co.tz/api/v1 or http://localhost:8080/api/v1
  // WS endpoint is /ws at the host root (router.go: r.Get("/ws", ...)).
  const base = API_BASE.replace(/\/api\/v1\/?$/, '');
  const httpBase = base || API_BASE;
  let wsBase: string;
  try {
    const u = new URL(httpBase);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = `?token=${encodeURIComponent(token)}`;
    wsBase = u.toString();
  } catch {
    // Fallback string replace for malformed base (tests with relative)
    wsBase = httpBase.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '') + `/ws?token=${encodeURIComponent(token)}`;
  }
  return wsBase;
}

export function isWebSocketSupported(): boolean {
  return typeof WebSocket !== 'undefined' && !!API_BASE;
}

export async function startRiderRealtime() {
  stopped = false;
  // Prefer WS when available; poll only while WS is not connected.
  if (isWebSocketSupported()) {
    await connectWs();
  } else {
    startEventStream();
  }
}

export function stopRiderRealtime() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  stopEventStream();
}

async function connectWs() {
  if (stopped) return;
  const pair = await getTokenPair();
  if (!pair?.accessToken) {
    // No session — long-poll will 401 anyway; fall back to poll
    startEventStream();
    return;
  }
  const url = wsUrl(pair.accessToken);
  if (!url) {
    startEventStream();
    return;
  }
  try {
    ws = new WebSocket(url);
  } catch {
    // WebSocket ctor failed (e.g. node tests without ws polyfill) — fall back
    startEventStream();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    stopEventStream();
    // Ask server for events since lastSeq (0 = full catch-up)
    try {
      ws?.send(JSON.stringify({ type: 'sync', after: 0 }));
    } catch {}
  };

  ws.onmessage = (ev: MessageEvent) => {
    try {
      const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      // Hub pushes {"type":"event","event":{id,type,payload,at}}
      if (data?.type === 'event' && data.event) {
        eventBus.publish(data.event.type as RiderEventType, data.event.payload as Record<string, unknown>);
        return;
      }
      if (data?.type === 'sync' && Array.isArray(data.events)) {
        for (const e of data.events) eventBus.publish(e.type as RiderEventType, e.payload as Record<string, unknown>);
        return;
      }
      if (data?.type === 'pong') return;
    } catch {
      /* ignore malformed frame */
    }
  };

  const handleClose = () => {
    ws = null;
    if (stopped) return;
    // Fall back to polling while reconnecting; on next WS success we stop poll.
    startEventStream();
    const backoff = Math.min(15000, 1000 * 2 ** reconnectAttempt) + Math.random() * 500;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => void connectWs(), backoff);
  };

  ws.onclose = handleClose;
  ws.onerror = handleClose;
}

export function getRealtimeState(): { connected: boolean; transport: 'ws' | 'poll' | 'off' } {
  if (ws && ws.readyState === 1) return { connected: true, transport: 'ws' };
  if (!stopped) return { connected: false, transport: 'poll' };
  return { connected: false, transport: 'off' };
}
