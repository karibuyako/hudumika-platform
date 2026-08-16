/* Mock API gateway for native development.
 * Bundled with esbuild (see scripts/mock-gateway.sh) and run as a plain Node
 * HTTP server on :3001. Requests from a device land here and are answered by
 * the same MSW handlers the web app uses in-browser, so native dev and web
 * dev share one mock backend. The sweeper runs on a timer, same as web.
 *
 * Start it with: npm run mock:gateway
 * Then point the app at it: EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3001
 */
import http from 'node:http';

import { setupServer } from 'msw/node';
import { runSweeperJobs } from '@/mock/sweeper';
import { MOCK_ENABLED, mockHttpHandlers } from '@/mock/switches';
import { seedDatabase } from '@/mock/seed';

const PORT = Number(process.env.MOCK_PORT ?? 3001);

if (!MOCK_ENABLED) {
  console.log('[mock-gateway] mocks are disabled (EXPO_PUBLIC_ENVIRONMENT=production or all EXPO_PUBLIC_MOCK_* switches off) — exiting');
  process.exit(0);
}

const server = setupServer(...(mockHttpHandlers() as never[]));
server.listen({ onUnhandledRequest: 'bypass' });
seedDatabase();
console.log('[mock-gateway] mock database seeded');

runSweeperJobs();
console.log('[mock-gateway] sweeper started');

http
  .createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      // In-process fetch is intercepted by MSW node — the handler answers.
      // Handlers are registered against http://localhost in node (see mock/handlers/common.ts).
      const inner = await fetch('http://localhost' + (req.url ?? '/'), {
        method: req.method ?? 'GET',
        headers: { ...(req.headers as Record<string, string>) },
        body: req.method === 'GET' || req.method === 'HEAD' || body.length === 0 ? undefined : body,
      });
      const payload = Buffer.from(await inner.arrayBuffer());
      const headers: Record<string, string> = {};
      inner.headers.forEach((v, k) => {
        headers[k] = v;
      });
      res.writeHead(inner.status, headers);
      res.end(payload);
    } catch (e) {
      console.error('[mock-gateway] error:', e);
      const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now().toString(36)}`;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'GATEWAY_ERROR', message: 'Mock gateway failed to answer' },
          code: 'GATEWAY_ERROR',
          message: 'Mock gateway failed to answer',
          requestId: id,
        }),
      );
    }
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`[mock-gateway] listening on 0.0.0.0:${PORT}`);
    console.log('[mock-gateway] set EXPO_PUBLIC_API_URL=http://<lan-ip>:' + PORT + ' to use it from a device');
  });
