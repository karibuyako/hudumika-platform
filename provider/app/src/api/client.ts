import type { ApiErrorBody } from '@/api/types';
import { clearStoredTokens, loadStoredRefreshToken, loadStoredToken, setStoredRefreshToken, setStoredToken } from '@/lib/tokenStore';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retriable = false,
    public details?: Record<string, unknown>,
    public retryAfterSeconds?: number,
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

// Base URL only — never a /api/v1 suffix in app code (docs/API-BASE-CONVENTION.md).
const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

export function getToken(): string | null {
  return loadStoredToken();
}

/** Persist the session token (expo-secure-store on native, sessionStorage on web). */
export function setToken(token: string | null) {
  void setStoredToken(token);
}

export function setRefreshToken(token: string | null) {
  void setStoredRefreshToken(token);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Refresh-once interceptor: POST /auth/refresh with the stored refresh token,
 * swap in the rotated pair, and let the original request retry. Any failure
 * wipes tokens and notifies the app (force logout). Never recurses into the
 * main request pipeline.
 */
async function tryRefresh(): Promise<boolean> {
  const refreshToken = loadStoredRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const session = (await res.json()) as { accessToken?: string; refreshToken?: string } | null;
    if (!session?.accessToken) return false;
    setToken(session.accessToken);
    setRefreshToken(session.refreshToken ?? null);
    return true;
  } catch {
    return false;
  }
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let attempt = 0;
  let refreshed = false;

  // Offline-first: mutations are queued and replayed on reconnect.
  const isMutation = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  if (isMutation && typeof navigator !== 'undefined' && !navigator.onLine) {
    const { enqueue } = await import('@/api/queue');
    enqueue({ method: method as 'POST' | 'PATCH' | 'PUT' | 'DELETE', path, body: opts.body });
    throw new ApiError(0, 'OFFLINE_QUEUED', 'Queued — will sync when back online', true);
  }

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...opts.headers,
      };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

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
        if (status === 403) {
          // Role/capability mismatch: surface a capability refresh; the UI
          // shows the error and role-switch prompt — never downgrade silently.
          onForbidden?.();
        }
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
        if (status === 401) {
          // Session expired: refresh once, retry the request; else force logout.
          if (!refreshed && (await tryRefresh())) {
            refreshed = true;
            continue;
          }
          await forceLogout();
          onUnauthorized?.();
        }
        throw new ApiError(status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${status})`, retriable, err?.details, err?.retryAfterSeconds, err?.requestId);
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
        throw new ApiError(0, 'TIMEOUT', 'Request timed out', true);
      }
      throw new ApiError(0, 'NETWORK_ERROR', typeof navigator !== 'undefined' && !navigator.onLine ? 'You are offline' : 'Network error', true);
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

/** 403 FORBIDDEN / CAPABILITY_FORBIDDEN — refetch capabilities, never downgrade silently. */
let onForbidden: (() => void) | null = null;
export function setForbiddenHandler(fn: () => void) {
  onForbidden = fn;
}

/** Force-logout path used by the 401 handler — wipes tokens and clears session. */
export async function forceLogout() {
  await clearStoredTokens();
  setToken(null);
  setRefreshToken(null);
  onUnauthorized?.();
}
