import { ws } from 'msw';
import type { ServerEvent } from '@/api/types';
import { eventsAfter, latestSeq } from '@/mock/events';

/* Real-time push channel (WebSocket) served by MSW.
 * - A merchant client connects to ws://<host>/api/ws and receives every
 *   event for its merchant the moment it is emitted.
 * - On connect the server replays events after the client's last seen seq.
 * - The long-poll endpoint remains as a fallback (also covers cross-tab).
 */

const WS_URL = '/api/ws';
const channel = ws.link(WS_URL);

interface WsClient {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: 'message' | 'close', cb: (e: unknown) => void) => void;
}

const connections = new Map<string, WsClient[]>();

channel.addEventListener('connection', (connection) => {
  const client = connection.client as unknown as WsClient;
  let merchantId = 'm_demo';
  let lastSeq = 0;

  client.addEventListener('message', (ev) => {
    const raw = (ev as { data?: string }).data;
    if (!raw) return;
    try {
      const msg = JSON.parse(raw) as { type?: string; merchantId?: string; after?: number };
      if (msg.type === 'sync') {
        merchantId = msg.merchantId ?? merchantId;
        lastSeq = msg.after ?? 0;
        const tail = eventsAfter(lastSeq);
        for (const e of tail) {
          client.send(JSON.stringify({ event: e.event, at: Date.now() }));
        }
        lastSeq = latestSeq();
        const list = connections.get(merchantId) ?? [];
        connections.set(merchantId, [...list, client]);
      }
    } catch {
      /* non-JSON control frame — ignore */
    }
  });

  client.addEventListener('close', () => {
    const list = connections.get(merchantId) ?? [];
    connections.set(
      merchantId,
      list.filter((c) => c !== client),
    );
  });
});

/** Push an event to all live WebSocket clients of a merchant. */
export function wsBroadcast(merchantId: string, event: ServerEvent) {
  const list = connections.get(merchantId) ?? [];
  const payload = JSON.stringify({ event, at: Date.now() });
  for (const c of list) {
    try {
      c.send(payload);
    } catch {
      /* client gone */
    }
  }
}

export const wsLink = channel;
