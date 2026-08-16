import { getToken, resolveApiUrl } from '@/api/client';

/**
 * Client-side error reporter for the monitoring endpoint (POST /monitoring/errors).
 *
 * - Fired on unhandled API errors (retries exhausted) — never on queued
 *   mutations (OFFLINE_QUEUED), never inside retry loops.
 * - Fire-and-forget: failures are swallowed, never throw into app code.
 * - Rate-limited to one report per 10s regardless of how many errors throw.
 * - Always on (mock and live): in mock/dev mode the mock handler accepts the
 *   report; in production the request targets the real monitoring backend and
 *   silently no-ops if it is unreachable. The volume bound (1/10s) keeps the
 *   worst case at ~8,640 reports/day/client.
 */

const REPORT_INTERVAL_MS = 10_000;
let lastReportAt = 0;

export interface ErrorReportInput {
  message: string;
  code?: string;
  url?: string;
  stack?: string;
}

export function reportError(input: ErrorReportInput): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;

  const error: Record<string, unknown> = { message: input.message };
  if (input.code) error.code = input.code;
  if (input.url) error.url = input.url;
  if (input.stack) error.stack = input.stack;

  void (async () => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      await fetch(resolveApiUrl('/monitoring/errors'), {
        method: 'POST',
        headers,
        // Contract `{error: {...}}` plus the mock handler's flat fields
        // (src/mock/handlers/ops.ts reads body.message/stack/route).
        body: JSON.stringify({
          error,
          message: input.message,
          stack: input.stack,
          route: input.url,
        }),
      });
    } catch {
      /* fire-and-forget — never throw */
    }
  })();
}
