import { getCachedTokenPair, getTokenPair, setTokenPair } from '@/api/tokenStore';
import type { TokenPair } from '@/api/tokenStore';
import type { ApiErrorBody } from '@/api/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retriable = false,
    public details?: Record<string, unknown>,
    /** Contract ErrorResponse.requestId — surfaced for support tickets. */
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT = 15000;

/* Mutations carry an idempotency key so retries never double-post a status
 * advance (contract: payments, order creation, bookings require keys; the
 * same discipline is applied to every rider mutation). */
function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* Diagnostic surface: every failure logs code + message + requestId (no
 * bodies, no tokens). Screens still render their own inline messages. */
function logFailure(context: string, e: ApiError): void {
  if (e.code === 'OFFLINE_QUEUED') return;
  const reqId = e.requestId ? ` requestId=${e.requestId}` : '';
  console.warn(`[${context}] ${e.code}: ${e.message}${reqId}`);
}

// Web: empty base → same-origin, MSW intercepts. Native/device: point at the
// mock gateway (e.g. EXPO_PUBLIC_API_URL=http://192.168.1.20:3001) or a live backend.
const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- Token refresh (POST /auth/refresh, single-flight) ---------- */

let refreshing: Promise<TokenPair | null> | null = null;

/** Rotate the access token. Concurrent 401s share one refresh; failure wipes tokens. */
async function refreshTokenPair(): Promise<TokenPair | null> {
  if (!refreshing) {
    refreshing = (async () => {
      const pair = await getTokenPair();
      if (!pair?.refreshToken) return null;
      try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: pair.refreshToken }),
        });
        if (!res.ok) throw new Error(`refresh failed (${res.status})`);
        const data = (await res.json()) as { accessToken: string; refreshToken?: string };
        const next: TokenPair = { accessToken: data.accessToken, refreshToken: data.refreshToken ?? pair.refreshToken };
        await setTokenPair(next);
        return next;
      } catch {
        await setTokenPair(null);
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let attempt = 0;
  let refreshedOnce = false;

  // Offline-first: mutations are queued and replayed on reconnect.
  const isMutation = method === 'POST' || method === 'PATCH';
  if (isMutation && typeof navigator !== 'undefined' && !navigator.onLine) {
    const { enqueue } = await import('@/api/queue');
    enqueue({ method: method as 'POST' | 'PATCH', path, body: opts.body });
    throw new ApiError(0, 'OFFLINE_QUEUED', 'Queued — will sync when back online', true);
  }
  // Generated once per request, reused verbatim across retry attempts.
  const idempotencyKey = opts.idempotencyKey ?? (isMutation ? newIdempotencyKey() : undefined);

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...opts.headers,
      };
      const pair = getCachedTokenPair() ?? (await getTokenPair());
      if (pair?.accessToken) headers.authorization = `Bearer ${pair.accessToken}`;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

      const res = await fetch(`${API_BASE}/api${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ?? controller.signal,
      });

      if (res.status === 204) return undefined as T;

      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON */
      }

      if (!res.ok) {
        const err = (data as ApiErrorBody | null)?.error;
        const status = res.status;
        const retriable =
          err?.retriable === true ||
          status === 408 ||
          status === 429 ||
          (status >= 500 && status <= 599);
        if (retriable && attempt < retries) {
          attempt += 1;
          const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 300;
          await sleep(backoff);
          continue;
        }
        if (status === 401 && path !== '/auth/refresh') {
          // Session expired: rotate once via the refresh token, then retry.
          if (!refreshedOnce) {
            refreshedOnce = true;
            const next = await refreshTokenPair();
            if (next) {
              attempt += 1;
              await sleep(50);
              continue;
            }
          }
          // Refresh failed (or the rotated token was rejected) — the session is gone.
          onUnauthorized?.();
        }
        const errBody = new ApiError(
          status,
          err?.code ?? 'HTTP_ERROR',
          err?.message ?? `Request failed (${status})`,
          retriable,
          err?.details,
          err?.requestId ?? (err?.details?.requestId as string | undefined),
        );
        logFailure(path, errBody);
        throw errBody;
      }

      return data as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const aborted = (e as Error)?.name === 'AbortError';
      const retriable = aborted || (typeof navigator !== 'undefined' && !navigator.onLine);
      if (retriable && attempt < retries) {
        attempt += 1;
        await sleep(600 * 2 ** (attempt - 1));
        continue;
      }
      if (aborted) {
        const err = new ApiError(0, 'TIMEOUT', 'Request timed out', true);
        logFailure(path, err);
        throw err;
      }
      const err = new ApiError(0, 'NETWORK_ERROR', typeof navigator !== 'undefined' && !navigator.onLine ? 'You are offline' : 'Network error', true);
      logFailure(path, err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}
