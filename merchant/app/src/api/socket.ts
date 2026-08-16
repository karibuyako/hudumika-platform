import type { ServerEvent } from '@/api/types';

/**
 * WebSocket push channel (upgrade path over long-polling).
 * - Connects to ws://<host>/api/ws, sends {type:'sync', merchantId, after}
 * - Applies pushed events immediately (idempotent upserts, same as polling)
 * - On failure: reconnects with backoff; the long-poll keeps running as a
 *   fallback so delivery never depends on the socket.
 */

type Listener = (event: ServerEvent) => void;

let socket: WebSocket | null = null;
let started = false;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string {
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
  const host = typeof location !== 'undefined' ? location.host : 'localhost';
  return `${proto}://${host}/api/ws`;
}

function connect() {
  if (!started) return;
  try {
    const ws = new WebSocket(wsUrl());
    socket = ws;
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'sync', merchantId: 'm_demo', after: 0 }));
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as { event?: ServerEvent };
        if (data.event) listeners.forEach((l) => l(data.event!));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!started) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(15000, reconnectDelay * 2);
    connect();
  }, reconnectDelay);
}

const listeners = new Set<Listener>();

export function startEventSocket() {
  if (started) return;
  started = true;
  try {
    connect();
  } catch {
    /* no WebSocket support — long-poll covers delivery */
  }
}

export function stopEventSocket() {
  started = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
}

/** Route socket-pushed events into the same dispatcher the poll uses. */
export function wireSocketTo(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
