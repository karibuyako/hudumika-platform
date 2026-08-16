import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { ApiError, api, getRefreshToken, parseRetryAfter, resolveApiUrl, setRefreshToken, setToken, setUnauthorizedHandler } from '@/api/client';

/* The client persists tokens in sessionStorage/localStorage and Node has
 * neither — provide in-memory shims (same file-level stub approach as the
 * queue suite). EXPO_PUBLIC_API_URL is unset in the test runner → mock mode
 * (empty base → same-origin /api paths, absolutized by wrapFetch below). */
const memory = new Map<string, string>();
const shim = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
};
Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: shim, configurable: true });
if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'undefined') {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
}

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));
const base = 'http://localhost';

/* Client emits same-origin paths in mock mode (/api/...) — MSW only intercepts
 * absolute URLs in Node, so wrap fetch after server.listen() (same trick as
 * the queue suite). */
function wrapFetch() {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)) as typeof fetch;
}

let ownerTokA = '';
let ownerTokB = '';
let ownerRefreshB = '';

async function loginFull(phone: string): Promise<{ accessToken: string; refreshToken: string }> {
  const req = await fetch(`${base}/api/auth/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'phone', destination: phone, purpose: 'login' }),
  });
  const reqBody = (await req.json()) as { requestId: string; debugCode: string };
  const ok = await fetch(`${base}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: reqBody.requestId, code: reqBody.debugCode, purpose: 'login' }),
  });
  const body = (await ok.json()) as { accessToken: string; refreshToken: string };
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/** Poll until fn stops throwing (default ~1.5s, 25ms intervals). */
async function waitFor(fn: () => void, ms = 1500): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < ms) {
    try {
      fn();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw lastErr;
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  wrapFetch();
  db.reset();
  seedDatabase();
  const a = await loginFull('+255700000000');
  const b = await loginFull('+255700000000');
  ownerTokA = a.accessToken;
  ownerTokB = b.accessToken;
  ownerRefreshB = b.refreshToken;
  setToken(ownerTokA);
  // Revoke session A (via B) so the refresh/retry tests have a deterministic
  // 401 source. B stays valid — its refresh token powers the positive test.
  await fetch(`${base}/api/sessions/${ownerTokA}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerTokB}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
});

beforeEach(() => {
  setToken(ownerTokA);
});

after(() => {
  setUnauthorizedHandler(null);
  server.close();
});

/* ================= Monitoring reporter (first — it consumes the 10s rate slot) ================= */

test('unhandled API error is reported to POST /monitoring/errors (fire-and-forget)', async () => {
  setToken(ownerTokB); // the reporting endpoint requires a valid session
  await assert.rejects(
    api.post('/orders/o_client_1/accept', { expectedVersion: 1 }, { retries: 0 }),
    (e) => e instanceof ApiError && e.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
  await waitFor(() => {
    const reports = db.table('errorReports').all() as { message?: string; route?: string }[];
    const hit = reports.find((r) => r.message === 'Idempotency-Key header is required for this mutation');
    assert.ok(hit, `error report persisted (got ${reports.length} report(s))`);
    assert.equal(hit.route, '/orders/o_client_1/accept', 'route captured');
  });
});

/* ================= Error envelope: both shapes + requestId ================= */

test('mock error responses carry BOTH legacy {error:{...}} and contract top-level fields', async () => {
  // Feature-handler error path (missing idempotency key → 400).
  const res = await fetch(`${base}/api/orders/o_client_2/accept`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerTokB}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(body.error.message, 'Idempotency-Key header is required for this mutation');
  assert.equal(body.code, 'IDEMPOTENCY_KEY_REQUIRED', 'top-level code mirrors error.code');
  assert.equal(body.message, body.error.message, 'top-level message mirrors error.message');
  assert.equal(typeof body.requestId, 'string');
  assert.ok(String(body.requestId).length > 4, 'requestId generated');
  assert.equal(body.error.retriable, false);
});

test('429 responses carry retryAfterSeconds + Retry-After header; client surfaces them on ApiError', async () => {
  // Deterministic 429: the OTP endpoint rate-limits the 6th request for a phone.
  let last: Response | null = null;
  for (let i = 0; i < 6; i++) {
    last = await fetch(`${base}/api/auth/request-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'phone', destination: '+255700000001', purpose: 'login' }),
    });
    if (last.status === 429) break;
  }
  assert.equal(last!.status, 429);
  const body = (await last!.json()) as Record<string, any>;
  assert.equal(body.code, 'RATE_LIMITED');
  assert.ok(typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds >= 1, 'top-level retryAfterSeconds present');
  assert.ok(Number(last!.headers.get('retry-after')) >= 1, 'Retry-After header set');

  // Client surfaces retryAfterSeconds on the thrown ApiError (retries: 0 → no sleep).
  let calls = 0;
  server.use(
    rawHttp.post('http://localhost/api/orders/always-429/accept', () => {
      calls += 1;
      return Response.json(
        { error: { code: 'RATE_LIMITED', message: 'slow down', retriable: true }, retryAfterSeconds: 2 },
        { status: 429 },
      );
    }),
  );
  try {
    await assert.rejects(
      api.post('/orders/always-429/accept', {}, { idempotencyKey: 'a429', retries: 0 }),
      (e) => {
        assert.ok(e instanceof ApiError);
        const err = e as ApiError;
        assert.equal(err.status, 429);
        assert.equal(err.code, 'RATE_LIMITED');
        assert.equal(err.retryAfterSeconds, 2);
        assert.equal(err.retriable, true);
        return true;
      },
    );
    assert.equal(calls, 1, 'retries: 0 → single attempt');
  } finally {
    server.resetHandlers();
  }
});

test('client parses the contract ValidationResponse shape (top-level errors[]) into fieldErrors', async () => {
  server.use(
    rawHttp.post('http://localhost/api/orders/validate-me', () =>
      Response.json(
        {
          code: 'VALIDATION_FAILED',
          message: 'Items invalid',
          requestId: 'req-validate-1',
          errors: [{ field: 'items[0].price', message: 'too low' }, { field: 'items[1].qty', message: 'must be positive' }],
        },
        { status: 422 },
      ),
    ),
  );
  try {
    await assert.rejects(
      api.post('/orders/validate-me', { items: [] }, { retries: 0 }),
      (e) => {
        assert.ok(e instanceof ApiError);
        const err = e as ApiError;
        assert.equal(err.status, 422);
        assert.equal(err.code, 'VALIDATION_FAILED', 'code parsed from top-level, no error: wrapper');
        assert.equal(err.message, 'Items invalid');
        assert.equal(err.requestId, 'req-validate-1');
        assert.deepEqual(err.fieldErrors, [
          { field: 'items[0].price', message: 'too low' },
          { field: 'items[1].qty', message: 'must be positive' },
        ]);
        return true;
      },
    );
  } finally {
    server.resetHandlers();
  }
});

test('client surfaces requestId from the mock envelope on ApiError', async () => {
  setToken(ownerTokB); // beforeEach sets the revoked A — the accept flow needs a valid session
  await assert.rejects(
    api.post('/orders/o_client_3/accept', { expectedVersion: 1 }, { retries: 0 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, 'IDEMPOTENCY_KEY_REQUIRED');
      assert.ok(typeof e.requestId === 'string' && e.requestId.length > 4, 'requestId exposed on ApiError');
      return true;
    },
  );
});

/* ================= 401 → refresh → retry once ================= */

test('401 with a valid refresh token: refreshes, retries once, never fires unauthorized', async () => {
  setToken(ownerTokA); // revoked in before()
  setRefreshToken(ownerRefreshB); // B is still valid
  let unauthorized = 0;
  setUnauthorizedHandler(() => {
    unauthorized += 1;
  });

  const before = getRefreshToken();
  const { me } = await api.get<{ me: { merchant: { phone: string } } }>('/merchants/me', { retries: 0 });
  assert.ok(me.merchant, 'original request retried with the refreshed session');
  assert.equal(unauthorized, 0, 'session recovered — unauthorized handler never fired');
  assert.notEqual(getRefreshToken(), before, 'refresh token rotated by the refresh response');
});

test('401 without a refresh token: unauthorized handler fires, request throws 401', async () => {
  setToken(ownerTokA); // revoked in before()
  setRefreshToken(null);
  let unauthorized = 0;
  setUnauthorizedHandler(() => {
    unauthorized += 1;
  });

  await assert.rejects(
    api.get('/merchants/me', { retries: 0 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 401);
      assert.equal(e.code, 'UNAUTHORIZED');
      return true;
    },
  );
  assert.equal(unauthorized, 1, 'unauthorized handler fired once');
});

test('a repeated 401 after refresh is not refreshed again (loop guard)', async () => {
  // Fresh session: the earlier positive test already rotated/revoked B.
  const fresh = await loginFull('+255700000000');
  setToken(fresh.accessToken);
  setRefreshToken(fresh.refreshToken);
  let unauthorized = 0;
  setUnauthorizedHandler(() => {
    unauthorized += 1;
  });

  let hits = 0;
  const before = getRefreshToken();
  server.use(
    rawHttp.get('http://localhost/api/orders/loop-me', () => {
      hits += 1;
      return Response.json({ error: { code: 'UNAUTHORIZED', message: 'nope', retriable: true } }, { status: 401 });
    }),
  );
  try {
    await assert.rejects(
      api.get('/orders/loop-me', { retries: 0 }),
      (e) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 401);
        return true;
      },
    );
    assert.equal(hits, 2, 'original request + exactly one refreshed retry');
    assert.equal(unauthorized, 1, 'second 401 fell through to unauthorized instead of refreshing again');
    assert.notEqual(getRefreshToken(), before, 'refresh happened once (token rotated)');
  } finally {
    server.resetHandlers();
  }
});

/* ================= 429 honors Retry-After / retryAfterSeconds ================= */

test('429 body retryAfterSeconds: 0 → immediate retry, then success', async () => {
  let calls = 0;
  server.use(
    rawHttp.post('http://localhost/api/orders/rate-1/accept', () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { error: { code: 'RATE_LIMITED', message: 'slow', retriable: true }, retryAfterSeconds: 0 },
          { status: 429 },
        );
      }
      return Response.json({ accepted: true });
    }),
  );
  try {
    const res = await api.post<{ accepted: boolean }>('/orders/rate-1/accept', {}, { idempotencyKey: 'r1', retries: 1 });
    assert.equal(res.accepted, true);
    assert.equal(calls, 2, 'retried after the server-provided retryAfterSeconds');
  } finally {
    server.resetHandlers();
  }
});

test('429 Retry-After header (seconds) is honored over the client backoff', async () => {
  let calls = 0;
  server.use(
    rawHttp.post('http://localhost/api/orders/rate-2/accept', () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ error: { code: 'RATE_LIMITED', message: 'slow', retriable: true } }, { status: 429, headers: { 'retry-after': '1' } });
      }
      return Response.json({ accepted: true });
    }),
  );
  try {
    const start = Date.now();
    const res = await api.post<{ accepted: boolean }>('/orders/rate-2/accept', {}, { idempotencyKey: 'r2', retries: 1 });
    const elapsed = Date.now() - start;
    assert.equal(res.accepted, true);
    assert.equal(calls, 2, 'retried after honoring Retry-After');
    assert.ok(elapsed >= 900, `waited for the Retry-After window (elapsed ${elapsed}ms)`);
  } finally {
    server.resetHandlers();
  }
});

/* ================= Base path resolution (unit) ================= */

test('resolveApiUrl: mock mode (/api), mock gateway (host/api), live (/api/v1) — never double-prefixes', () => {
  assert.equal(resolveApiUrl('/orders/me', ''), '/api/orders/me', 'empty base → same-origin /api (MSW)');
  assert.equal(resolveApiUrl('/orders/me', 'http://localhost'), 'http://localhost/api/orders/me', 'bare host → /api (dev mock gateway)');
  assert.equal(resolveApiUrl('/orders/me', 'http://10.0.2.2:3001/'), 'http://10.0.2.2:3001/api/orders/me', 'trailing slash stripped');
  assert.equal(resolveApiUrl('/orders/me', 'https://api.hudumika.co.tz/api/v1'), 'https://api.hudumika.co.tz/api/v1/orders/me', 'live base used verbatim');
  assert.equal(resolveApiUrl('/orders/me', 'https://staging-api.hudumika.co.tz/api/v1/'), 'https://staging-api.hudumika.co.tz/api/v1/orders/me', 'live base + trailing slash');
  assert.equal(resolveApiUrl('/orders/me', 'https://host/api'), 'https://host/api/orders/me', 'explicit /api base used verbatim');
  assert.ok(!resolveApiUrl('/orders/me', 'https://api.hudumika.co.tz/api/v1').includes('/api/v1/api'), 'never double-prefixes /api/v1/api');
});

test('resolveApiUrl: client harness resolves mock-mode paths end-to-end', async () => {
  server.use(
    rawHttp.get('http://localhost/api/orders/me', () => Response.json({ ok: true })),
    rawHttp.get('http://localhost/api/v1/orders/me', () => Response.json({ ok: 'v1' })),
  );
  try {
    const res = await api.get<{ ok: boolean }>('/orders/me', { retries: 0 });
    assert.equal(res.ok, true, 'mock mode hit /api/orders/me');
  } finally {
    server.resetHandlers();
  }
});

/* ================= Retry-After parsing (unit) ================= */

test('parseRetryAfter: seconds, HTTP-date, garbage, and the 30s cap', () => {
  assert.equal(parseRetryAfter('5'), 5);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('120'), 30, 'capped at 30s');
  assert.equal(parseRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT'), 30, 'HTTP-date capped at 30s');
  assert.equal(parseRetryAfter('Wed, 01 Jan 2020 00:00:00 GMT'), 0, 'past HTTP-date → immediate retry');
  assert.equal(parseRetryAfter('garbage'), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});
