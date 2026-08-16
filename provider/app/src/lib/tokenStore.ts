/* Token storage for the provider app.
 *
 * Security rule (INSTRUCTIONS.md section 4, #6): tokens NEVER live in
 * localStorage on native — they live in expo-secure-store. Web keeps
 * sessionStorage (browser-safe). A sync in-memory cache backs the request
 * path; persistence is async and best-effort.
 *
 * Access + refresh tokens (refresh rotates via POST /auth/refresh — 401 →
 * refresh once → retry → force logout). Node (tests) falls back to the
 * in-memory cache — nothing crashes when storage is unavailable.
 */

const ACCESS_KEY = 'provider.accessToken';
const REFRESH_KEY = 'provider.refreshToken';

/** True on native runtimes (React Native); web and node get the storage path. */
const IS_NATIVE = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

let memoryAccess: string | null = null;
let memoryRefresh: string | null = null;

function webStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function loadStoredToken(): string | null {
  const cached = memoryAccess;
  if (cached) return cached;
  try {
    const web = webStorage();
    if (web) return web.getItem(ACCESS_KEY);
  } catch {
    /* ignore */
  }
  return null;
}

export function loadStoredRefreshToken(): string | null {
  const cached = memoryRefresh;
  if (cached) return cached;
  try {
    const web = webStorage();
    if (web) return web.getItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
  return null;
}

async function persist(key: string, value: string | null): Promise<void> {
  if (IS_NATIVE) {
    try {
      const SecureStore = await import('expo-secure-store');
      if (value) await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
      else await SecureStore.deleteItemAsync(key);
      return;
    } catch {
      /* secure store unavailable — memory cache still serves this session */
    }
  }
  try {
    const web = webStorage();
    if (web) {
      if (value) web.setItem(key, value);
      else web.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

export async function setStoredToken(token: string | null): Promise<void> {
  memoryAccess = token;
  await persist(ACCESS_KEY, token);
}

export async function setStoredRefreshToken(token: string | null): Promise<void> {
  memoryRefresh = token;
  await persist(REFRESH_KEY, token);
}

/** Restore persisted tokens into the memory cache at session boot. */
export async function restoreStoredTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  let access = loadStoredToken();
  let refresh = loadStoredRefreshToken();
  if (IS_NATIVE && (!access || !refresh)) {
    try {
      const SecureStore = await import('expo-secure-store');
      if (!access) {
        access = await SecureStore.getItemAsync(ACCESS_KEY);
        if (access) memoryAccess = access;
      }
      if (!refresh) {
        refresh = await SecureStore.getItemAsync(REFRESH_KEY);
        if (refresh) memoryRefresh = refresh;
      }
    } catch {
      /* fall through */
    }
  }
  if (!access || !refresh) {
    const web = webStorage();
    if (web) {
      if (!access) {
        access = web.getItem(ACCESS_KEY);
        if (access) memoryAccess = access;
      }
      if (!refresh) {
        refresh = web.getItem(REFRESH_KEY);
        if (refresh) memoryRefresh = refresh;
      }
    }
  }
  return { accessToken: access, refreshToken: refresh };
}

/** Wipe everything (logout). */
export async function clearStoredTokens(): Promise<void> {
  memoryAccess = null;
  memoryRefresh = null;
  try {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.deleteItemAsync(ACCESS_KEY);
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  } catch {
    /* ignore */
  }
  try {
    const web = webStorage();
    web?.removeItem(ACCESS_KEY);
    web?.removeItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
}
