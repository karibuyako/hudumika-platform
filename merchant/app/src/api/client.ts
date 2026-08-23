import { reportError } from '@/api/monitor';
import type { ApiErrorBody, ApiErrorFieldError } from '@/api/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retriable = false,
    public details?: Record<string, unknown>,
    public requestId?: string,
    public retryAfterSeconds?: number,
    public fieldErrors?: ApiErrorFieldError[],
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

/* Sensitive actions (MASTER-BLUEPRINT §26): payment, cancellation, wallet
 * withdrawal/payout and privacy ops always require fresh server confirmation —
 * they are never queued offline. Failing fast keeps the user's money and
 * account state safe; everything else queues and replays when connectivity
 * returns. Mirrors consumer-mobile/src/api/client.ts:44 */
const SENSITIVE_PATHS: RegExp[] = [
  /^\/payments\/intent(?:s)?(?:\/|$)/,
  /^\/payments\/[^/]+\/confirm/,
  /^\/payments\/[^/]+\/reverse/,
  /^\/payments\/qr(?:\/|$)/,
  /^\/orders\/[^/]+\/cancel/,
  /^\/bookings\/[^/]+\/(cancel|complete|quote)/,
  /^\/reservations\/[^/]+\/cancel/,
  /^\/group-buys\/[^/]+\/purchase/,
  /^\/wallet\/me\/top-up/,
  /^\/wallet\/withdrawals/,
  /^\/payouts\//,
  /^\/finance\/settlements\//,
  /^\/privacy\/(delete|export)/,
  /^\/auth\/change-password/,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path));
}

// Web: empty base → same-origin, MSW intercepts. Native/device: point at the
// mock gateway (e.g. EXPO_PUBLIC_API_URL=http://192.168.1.20:3001) or a live
// backend (which includes /api/v1 per docs/API-BASE-CONVENTION.md).
export const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

export function isValidApiBase(): boolean {
  if (!API_BASE) return false;
  try {
    const u = new URL(API_BASE);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}

export function getApiBasePath(): string {
  if (!API_BASE) return '/api';
  try {
    const u = new URL(API_BASE);
    const path = u.pathname.replace(/\/$/, '');
    if (path === '/api/v1' || path === '/api') return path;
    return '/api';
  } catch {
    return '/api';
  }
}

export function buildApiUrl(path: string): string {
  const basePath = getApiBasePath();
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  if (!API_BASE) {
    return basePath + cleanPath;
  }
  try {
    const u = new URL(API_BASE);
    const origin = u.origin;
    const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    const hasApiV1Prefix = u.pathname === '/api/v1' || u.pathname === '/api';
    if (isLocalhost && hasApiV1Prefix) {
      return origin + cleanPath;
    }
    if (hasApiV1Prefix) {
      return origin + u.pathname + cleanPath;
    }
    return origin + basePath + cleanPath;
  } catch {
    return basePath + cleanPath;
  }
}

// Enterprise guard: native production must have an HTTPS API base.
// Supports both EXPO_PUBLIC_ENV and EXPO_PUBLIC_ENVIRONMENT for production gate (consumer vs merchant naming).
const ENV_FOR_API_CHECK = (process.env.EXPO_PUBLIC_ENV ?? process.env.EXPO_PUBLIC_ENVIRONMENT ?? 'development') as string;
export const forceMockForMissingUrl = !isValidApiBase() && (ENV_FOR_API_CHECK === 'staging' || ENV_FOR_API_CHECK === 'production');
if (!API_BASE) {
  const isProdLike = ENV_FOR_API_CHECK === 'production' || ENV_FOR_API_CHECK === 'staging';
  const isNativeLike = typeof window === 'undefined' || typeof (globalThis as unknown as { expo?: unknown }).expo !== 'undefined';
  if (isProdLike && isNativeLike) {
    console.warn('[api] EXPO_PUBLIC_API_URL is empty — app will run in mock/offline mode until a valid URL is configured. Set https://api.hudumika.co.tz/api/v1 via `eas update` when DNS is ready');
  } else if (isProdLike && !isNativeLike) {
    console.warn('[api] EXPO_PUBLIC_API_URL empty with EXPO_PUBLIC_ENV=' + ENV_FOR_API_CHECK + ' (web); requests use /api same-origin');
  }
} else if (!isValidApiBase()) {
  console.warn('[api] EXPO_PUBLIC_API_URL is not a valid http(s) URL — falling back to mock mode: ' + API_BASE);
} else if (!API_BASE.startsWith('https://') && ENV_FOR_API_CHECK === 'production' && !API_BASE.includes('localhost')) {
  console.error('[api] EXPO_PUBLIC_API_URL must be https in production: ' + API_BASE);
}

/** Base-path resolution (docs/API-BASE-CONVENTION.md, rule 4).
 * - empty base (mock mode, MSW intercepts): '/api' + path
 * - base already carrying the API prefix (/api or /api/v1): used verbatim
 * - bare host:port (dev mock gateway): '/api' appended
 * The app never double-prefixes: `${API_BASE}/api/v1/api/…` is impossible. */
export function resolveApiUrl(path: string, base: string = API_BASE): string {
  const b = base.replace(/\/$/, '');
  if (!b) return `/api${path}`;
  if (/\/api\/v1$/.test(b) || /\/api$/.test(b)) return `${b}${path}`;
  return `${b}/api${path}`;
}

const TOKEN_KEY = 'merchant.token';
const REFRESH_KEY = 'merchant.refreshToken';

// In-memory cache so the sync request loop never blocks on async storage.
// Native: hydrated once via restoreToken() from expo-secure-store at boot
// through the persister registered by the app shell. Web: mirrors
// sessionStorage/localStorage (queue.ts replay + image uploads read
// localStorage directly, so web keeps writing both).
let cachedToken: string | null = null;
let cachedRefreshToken: string | null = null;

/** Platform-backed token storage. The app shell registers a SecureStore
 * persister on native; web and Node tests use the storage fallback. */
export interface TokenPersister {
  get: () => Promise<string | null>;
  set: (token: string | null) => Promise<void>;
}

let persister: TokenPersister | null = null;

export function setTokenPersister(p: TokenPersister | null) {
  persister = p;
}

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }
}

function readStoredRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY) ?? localStorage.getItem(REFRESH_KEY);
  } catch {
    try {
      return localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  }
}

export function getToken(): string | null {
  if (cachedToken !== null) return cachedToken;
  cachedToken = readStoredToken();
  return cachedToken;
}

export function getRefreshToken(): string | null {
  if (cachedRefreshToken !== null) return cachedRefreshToken;
  cachedRefreshToken = readStoredRefreshToken();
  return cachedRefreshToken;
}

export function setToken(token: string | null) {
  cachedToken = token;
  if (!token) {
    // A cleared access token makes the refresh token useless — drop it too.
    setRefreshToken(null);
  }
  if (persister) {
    void persister.set(token).catch(() => {
      /* SecureStore unavailable — the in-memory cache still serves this session */
    });
    return;
  }
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

export function setRefreshToken(token: string | null) {
  cachedRefreshToken = token;
  try {
    if (token) {
      sessionStorage.setItem(REFRESH_KEY, token);
      localStorage.setItem(REFRESH_KEY, token);
    } else {
      sessionStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(REFRESH_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

/** Hydrate the token cache before any request fires. Call once at boot,
 * before session.restore(). Web reads storage lazily; native reads SecureStore. */
export async function restoreToken(): Promise<void> {
  if (persister) {
    try {
      cachedToken = await persister.get();
    } catch {
      cachedToken = null;
    }
    return;
  }
  cachedToken = readStoredToken();
  cachedRefreshToken = readStoredRefreshToken();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Platform check without importing react-native (the esbuild test runner
// cannot bundle its flow entry). babel-preset-expo inlines EXPO_OS to
// 'ios'|'android'|'web' in app bundles; it is undefined under Node tests.
const IS_NATIVE = process.env.EXPO_OS === 'ios' || process.env.EXPO_OS === 'android';

/** Offline detection: native has no navigator.onLine — treat as always online. */
const isOffline = () => !IS_NATIVE && typeof navigator !== 'undefined' && navigator.onLine === false;

/** Contract `Retry-After` (seconds or HTTP-date), capped at 30s. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30, Math.ceil(seconds));
  const ts = Date.parse(value);
  if (!Number.isNaN(ts)) return Math.min(30, Math.max(0, Math.ceil((ts - Date.now()) / 1000)));
  return undefined;
}

/* ---------------- Session refresh (401 → refresh → retry once) ---------------- */

let refreshInFlight: Promise<boolean> | null = null;

/** POST /auth/refresh with the stored refresh token (single-flight; never throws). */
async function tryRefreshSession(): Promise<boolean> {
  const token = getRefreshToken();
  if (!token) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(resolveApiUrl('/auth/refresh'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: token }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
        if (data.accessToken) setToken(data.accessToken);
        if (data.refreshToken) setRefreshToken(data.refreshToken);
        return Boolean(data.accessToken);
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** Capture the refresh token from any auth response that carries one. */
function captureRefreshToken(data: unknown): void {
  if (data && typeof data === 'object' && typeof (data as { refreshToken?: unknown }).refreshToken === 'string') {
    setRefreshToken((data as { refreshToken: string }).refreshToken);
  }
}

interface ParsedError {
  code: string;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
  requestId?: string;
  retryAfterSeconds?: number;
  fieldErrors?: ApiErrorFieldError[];
}

function parseError(data: unknown, res: Response, status: number): ParsedError {
  const raw = (data ?? null) as {
    error?: { code?: unknown; message?: unknown; retriable?: unknown; details?: Record<string, unknown> };
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    retryAfterSeconds?: unknown;
    errors?: unknown;
  } | null;
  const errCode = typeof raw?.error?.code === 'string' ? raw.error.code : undefined;
  const errMessage = typeof raw?.error?.message === 'string' ? raw.error.message : undefined;
  const retriable = raw?.error?.retriable === true || status === 408 || status === 429 || (status >= 500 && status <= 599);
  const fieldErrors = Array.isArray(raw?.errors)
    ? (raw.errors as unknown[]).filter(
        (e): e is ApiErrorFieldError =>
          !!e && typeof e === 'object' && typeof (e as { field?: unknown }).field === 'string' && typeof (e as { message?: unknown }).message === 'string',
      )
    : undefined;
  return {
    code: errCode ?? (typeof raw?.code === 'string' ? raw.code : undefined) ?? 'HTTP_ERROR',
    message: errMessage ?? (typeof raw?.message === 'string' ? raw.message : undefined) ?? `Request failed (${status})`,
    retriable,
    details: raw?.error?.details,
    requestId: typeof raw?.requestId === 'string' ? raw.requestId : undefined,
    retryAfterSeconds:
      typeof raw?.retryAfterSeconds === 'number'
        ? raw.retryAfterSeconds
        : status === 429
          ? parseRetryAfter(res.headers.get('retry-after'))
          : undefined,
    fieldErrors,
  };
}

function makeApiError(status: number, parsed: ParsedError): ApiError {
  return new ApiError(status, parsed.code, parsed.message, parsed.retriable, parsed.details, parsed.requestId, parsed.retryAfterSeconds, parsed.fieldErrors);
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let attempt = 0;
  let refreshed = false;

  // Offline-first: non-sensitive mutations are queued and replayed on
  // reconnect; sensitive ones (payment, cancellation, wallet withdrawal,
  // payout, privacy ops) fail fast — never queued (blueprint §26).
  const isMutation = method === 'POST' || method === 'PATCH';
  if (isMutation && isOffline()) {
    if (isSensitivePath(path)) {
      throw new ApiError(0, 'OFFLINE', 'You are offline — this action needs a connection and fresh server confirmation. Nothing was changed.', true);
    }
    const { enqueue } = await import('@/api/queue');
    enqueue({ method: method as 'POST' | 'PATCH', path, body: opts.body });
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

      const res = await fetch(resolveApiUrl(path), {
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
        const parsed = parseError(data, res, res.status);

        if (res.status === 401) {
          // Session expired: refresh once, then retry the original request
          // with the fresh token; only then notify listeners (app shows login).
          if (!refreshed && path !== '/auth/refresh' && (await tryRefreshSession())) {
            refreshed = true;
            continue;
          }
          onUnauthorized?.();
          throw makeApiError(res.status, parsed);
        }

        if (parsed.retriable && attempt < retries) {
          attempt += 1;
          // 429: honor the server's retryAfterSeconds / Retry-After (cap 30s);
          // otherwise exponential backoff with jitter.
          const waitMs =
            res.status === 429 && parsed.retryAfterSeconds != null
              ? Math.min(30, parsed.retryAfterSeconds) * 1000
              : Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 300;
          await sleep(waitMs);
          continue;
        }
        throw makeApiError(res.status, parsed);
      }

      captureRefreshToken(data);
      return data as T;
    } catch (e) {
      if (e instanceof ApiError) {
        // Unhandled API error — report to the monitoring endpoint (rate-limited).
        reportError({ message: e.message, code: e.code, url: path });
        throw e;
      }
      const aborted = (e as Error)?.name === 'AbortError';
      const offline = isOffline();
      const retriable = aborted || offline;
      if (retriable && attempt < retries) {
        attempt += 1;
        await sleep(600 * 2 ** (attempt - 1));
        continue;
      }
      if (aborted) {
        throw new ApiError(0, 'TIMEOUT', 'Request timed out', true);
      }
      const netErr = new ApiError(0, 'NETWORK_ERROR', offline ? 'You are offline' : 'Network error', true);
      reportError({ message: netErr.message, code: netErr.code, url: path });
      throw netErr;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export type { ApiErrorBody };
