import { Platform } from 'react-native';

import { db } from '@/mock/db';
import { eventsAfter, latestSeq, replayFromStorage, subscribe } from '@/mock/events';
import { seedDatabase } from '@/mock/seed';
import { runSweeperJobs } from '@/mock/sweeper';
import { MOCK_ENABLED, mockHttpHandlers } from '@/mock/switches';
import { wsBroadcast } from '@/mock/ws';

type MockHandle = unknown;

let mockHandle: MockHandle | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;

/* Push every emitted event to connected WebSocket clients of that merchant. */
function merchantOf(event: Parameters<typeof wsBroadcast>[1]): string | undefined {
  const e = event as Record<string, unknown>;
  for (const key of ['notification', 'order', 'thread', 'campaign', 'store', 'task', 'settlement', 'entry', 'payment']) {
    const payload = e[key] as Record<string, unknown> | undefined;
    if (payload?.merchantId) return String(payload.merchantId);
  }
  return undefined;
}
subscribe((event) => {
  const m = merchantOf(event);
  if (m) wsBroadcast(m, event);
});

/** Periodic jobs (rush detection, auto-cancel, risk, …) — see src/mock/sweeper.ts. */
function startSweeper() {
  sweeper = setInterval(() => {
    runSweeperJobs();
  }, 15000);
}

export async function startMockApi(): Promise<void> {
  if (mockHandle) return;
  if (!MOCK_ENABLED) return; // production builds and all-off switches never start the mock backend

  const handlers = mockHttpHandlers();

  if (!db.load()) {
    seedDatabase();
    db.persist();
  }
  replayFromStorage();

  if (Platform.OS === 'web') {
    const { setupWorker } = await import('msw/browser');
    const { wsLink } = await import('@/mock/ws');
    const worker = setupWorker(...(handlers as never[]), wsLink as never);
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
    mockHandle = worker;
  } else {
    const { setupServer } = await import('msw/native');
    const server = setupServer(...(handlers as never[]));
    server.listen();
    mockHandle = server;
  }

  startSweeper();
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key?.startsWith('mockdb.')) replayFromStorage();
    });
  }
}

export function stopMockApi() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  mockHandle = null;
}

export { eventsAfter, latestSeq };
