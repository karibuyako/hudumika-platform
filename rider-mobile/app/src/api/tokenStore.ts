/* Token storage — the ONLY place tokens live.
 *
 * Native: expo-secure-store (Keychain / Android Keystore). Web: sessionStorage
 * with a rider-scoped key. Never AsyncStorage/localStorage on native.
 *
 * expo-secure-store is loaded lazily so the node test runner (and web) can
 * import this module without a native module registry. A small in-memory
 * cache keeps the request hot path synchronous.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const ACCESS_KEY = 'rider.accessToken';
const REFRESH_KEY = 'rider.refreshToken';

interface NativeStore {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

let nativeStore: NativeStore | null | undefined;
async function getNativeStore(): Promise<NativeStore | null> {
  if (nativeStore !== undefined) return nativeStore;
  try {
    const mod = (await import('expo-secure-store')) as Partial<NativeStore>;
    nativeStore =
      typeof mod.getItemAsync === 'function' && typeof mod.setItemAsync === 'function' && typeof mod.deleteItemAsync === 'function'
        ? (mod as NativeStore)
        : null;
  } catch {
    nativeStore = null;
  }
  return nativeStore;
}

function webStore(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** In-memory cache — hot path for the request client. */
let cache: TokenPair | null = null;

export function getCachedTokenPair(): TokenPair | null {
  return cache;
}

export async function getTokenPair(): Promise<TokenPair | null> {
  if (cache) return cache;
  // Web: prefer sessionStorage — SecureStore web impl is not available in Expo web dev (throws getValueWithKeyAsync).
  const ws = webStore();
  if (ws) {
    const accessToken = ws.getItem(ACCESS_KEY);
    const refreshToken = ws.getItem(REFRESH_KEY);
    if (accessToken && refreshToken) {
      cache = { accessToken, refreshToken };
      return cache;
    }
    // No tokens in web storage — skip native attempt on web (would throw).
    if (typeof window !== 'undefined') return null;
  }
  const store = await getNativeStore();
  if (store) {
    try {
      const [accessToken, refreshToken] = await Promise.all([store.getItemAsync(ACCESS_KEY), store.getItemAsync(REFRESH_KEY)]);
      if (accessToken && refreshToken) cache = { accessToken, refreshToken };
      return cache;
    } catch {
      return cache;
    }
  }
  return null;
}

/** Persist a rotated token pair atomically. `null` wipes every store. */
export async function setTokenPair(pair: TokenPair | null): Promise<void> {
  cache = pair;
  const ws = webStore();
  if (ws) {
    if (pair) {
      ws.setItem(ACCESS_KEY, pair.accessToken);
      ws.setItem(REFRESH_KEY, pair.refreshToken);
    } else {
      ws.removeItem(ACCESS_KEY);
      ws.removeItem(REFRESH_KEY);
    }
    if (typeof window !== 'undefined') return;
  }
  const store = await getNativeStore();
  if (store) {
    try {
      if (pair) {
        await Promise.all([store.setItemAsync(ACCESS_KEY, pair.accessToken), store.setItemAsync(REFRESH_KEY, pair.refreshToken)]);
      } else {
        await Promise.all([store.deleteItemAsync(ACCESS_KEY), store.deleteItemAsync(REFRESH_KEY)]);
      }
    } catch {
      /* web fallback already handled */
    }
  }
}

export async function clearTokens(): Promise<void> {
  await setTokenPair(null);
}
