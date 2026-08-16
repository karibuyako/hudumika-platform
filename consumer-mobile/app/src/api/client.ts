import type { ApiErrorBody } from '@/api/types';
import { getStoredTokenAsync, setStoredTokenAsync } from '@/lib/secureStorage';
import { uid } from '@/lib/format';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retriable = false,
    public details?: Record<string, unknown>,
    /** requestId from the server envelope — passed to support, never logged with bodies. */
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    // Error shape is always {code, message, requestId} (mock + live).
    this.requestId = requestId ?? `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Internal: the refresh call itself must never recurse into refresh. */
  skipAuthRefresh?: boolean;
  /** Internal: queue replay must never re-enqueue itself while offline. */
  skipOfflineQueue?: boolean;
}

/* Sensitive actions (MASTER-BLUEPRINT §26): payment, cancellation, quote
 * approval and address changes always require fresh server confirmation —
 * they are never queued offline. Failing fast keeps the user's money and
 * account state safe; everything else (chats, reviews, support, …) queues
 * and replays when connectivity returns.
 *
 * NOTE: the consumer contract exposes no address-mutation endpoint today
 * (addresses are app-local); the moment POST/PATCH /addresses* lands in the
 * contract it must be added here before it can ever be queued. */
const SENSITIVE_PATHS: RegExp[] = [
  /^\/payments\/intent(?:s)?(?:\/|$)/, // create + confirm (POST /payments/{id}/confirm)
  /^\/payments\/[^/]+\/confirm/,
  /^\/orders\/[^/]+\/cancel/,
  /^\/bookings\/[^/]+\/(cancel|complete|quote)/,
  /^\/reservations\/[^/]+\/cancel/,
  /^\/group-buys\/[^/]+\/purchase/, // direct charge
  /^\/wallet\/me\/top-up/, // money in
  /^\/wallet\/withdrawals/, // money out — requestWithdrawal (contract)
  /^\/privacy\/(delete|export)/,
  /^\/auth\/change-password/,
];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path));
}

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT = 15000;

// Web: empty base → same-origin. Native/device: EXPO_PUBLIC_API_URL (live
// backend includes /api/v1; dev mock gateway is the bare host — API-BASE-CONVENTION.md).
const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

// In-memory token for the request hot-path (sync, no storage I/O). Hydrated
// at boot from SecureStore (native) / localStorage (web) — see hydrateToken
// and session restore. setToken write-throughs to the same stores.
let memToken: string | null = null;

function getToken(): string | null {
  if (memToken) return memToken;
  try {
    return sessionStorage.getItem('customer.token') ?? localStorage.getItem('customer.token');
  } catch {
    try {
      return localStorage.getItem('customer.token');
    } catch {
      return null;
    }
  }
}

export function setToken(token: string | null) {
  memToken = token;
  try {
    if (token) {
      sessionStorage.setItem('customer.token', token);
      localStorage.setItem('customer.token', token);
    } else {
      sessionStorage.removeItem('customer.token');
      localStorage.removeItem('customer.token');
    }
  } catch {
    try {
      if (token) localStorage.setItem('customer.token', token);
      else localStorage.removeItem('customer.token');
    } catch {
      /* storage unavailable */
    }
  }
  // Native persistence: SecureStore write-through (best-effort, async).
  void setStoredTokenAsync(token);
}

/** Hydrate the in-memory token from the persistent token store (native cold
 * start — SecureStore; web falls back to localStorage). Call at boot before
 * the first request so Authorization is always attached. */
export async function hydrateToken(): Promise<void> {
  try {
    const token = await getStoredTokenAsync();
    if (token) memToken = token;
  } catch {
    /* storage unavailable */
  }
}

/* ---------- Proactive refresh check (app-lifecycle) ----------
 * Access tokens are 15-minute JWTs. On foreground the app may want to refresh
 * BEFORE the 401 path — this helper reads the stored JWT `exp` claim and
 * reports whether it expires within `withinMs` (default 5 min). Mock tokens
 * carry no exp claim and are never reported near-expiry. NOTE: the actual
 * refresh still happens on the 401 single-flight path (tryRefreshToken below);
 * the client exposes no public proactive-refresh entry today, so foreground
 * handling refetches unread counts and relies on the 401 path for tokens. */
export function isAccessTokenNearExpiry(withinMs = 5 * 60_000): boolean {
  const token = getToken();
  if (!token) return false;
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) return false;
    return decoded.exp * 1000 - Date.now() < withinMs;
  } catch {
    return false;
  }
}

/* ---------- Single-flight token refresh (SECURITY.md) ----------
 * On 401 the FIRST caller triggers one POST /auth/refresh; everyone else
 * awaits the same promise. Success rotates the pair and the request retries
 * once. Refresh failure → force logout (tokens cleared, app returns to auth).
 */
let refreshing: Promise<boolean> | null = null;

/** Public best-effort proactive refresh (app-lifecycle; SECURITY.md
 * background refresh). Shares the single-flight promise with the 401 path,
 * so a concurrent failure cannot double-fire. Safe to call on foreground
 * resume on web AND native: no stored session / no refresh token → false
 * with zero side effects — never force-logs-out (that stays on the 401
 * path only). */
export async function safeRefresh(): Promise<boolean> {
  if (!getToken()) return false;
  return tryRefreshToken();
}

async function tryRefreshToken(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const stored = await getStoredSessionSafe();
      if (!stored?.refreshToken) return false;
      const session = await api.post<SessionLike>('/auth/refresh', { refreshToken: stored.refreshToken }, { skipAuthRefresh: true });
      setToken(session.accessToken);
      await setStoredSessionSafe({
        ...stored,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let attempt = 0;

  // Trace id (ARCHITECTURE.md): one X-Request-ID per logical request — retries
  // and the auth-refresh replay share it so support can correlate the whole
  // attempt chain (the server mirrors it back in ApiError.requestId).
  const requestId = uid('req');

  // Offline-first: non-sensitive mutations are queued and replayed on
  // reconnect; sensitive ones (payment, cancellation, quote approval,
  // address change, privacy ops) fail fast — never queued (blueprint §26).
  const isMutation = method === 'POST' || method === 'PATCH' || method === 'DELETE';
  if (isMutation && !opts.skipOfflineQueue && typeof navigator !== 'undefined' && !navigator.onLine) {
    if (isSensitivePath(path)) {
      throw new ApiError(0, 'OFFLINE', 'You are offline — this action needs a connection and fresh server confirmation. Nothing was changed.', true);
    }
    const { enqueue } = await import('@/api/queue');
    enqueue({ method: method as 'POST' | 'PATCH' | 'DELETE', path, body: opts.body, idempotencyKey: opts.idempotencyKey });
    throw new ApiError(0, 'OFFLINE_QUEUED', 'Queued — will sync when back online', true);
  }

  let didRefresh = false;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-request-id': requestId,
        ...opts.headers,
      };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

      const res = await fetch(`${API_BASE}${path}`, {
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
        if (status === 401 && !opts.skipAuthRefresh && !didRefresh) {
          // Single-flight refresh once; replay the request with the new token.
          const ok = await tryRefreshToken();
          if (ok) {
            didRefresh = true;
            continue;
          }
          // Refresh failure → force logout (SECURITY.md).
          forceLogout();
        }
        throw new ApiError(status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${status})`, retriable, err?.details, err?.requestId);
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

/** Force logout: clear tokens and return the app to auth. */
function forceLogout() {
  try {
    setToken(null);
    localStorage.removeItem('customer.session');
  } catch {
    /* storage unavailable */
  }
  onUnauthorized?.();
}

/* Lazy imports keep the node test bundle free of native modules. */
async function getStoredSessionSafe() {
  const { getStoredSession } = await import('@/lib/secureStorage');
  return getStoredSession();
}

async function setStoredSessionSafe(session: unknown) {
  const { setStoredSession } = await import('@/lib/secureStorage');
  return setStoredSession(session as Parameters<typeof setStoredSession>[0]);
}

interface SessionLike {
  accessToken: string;
  refreshToken: string;
}
