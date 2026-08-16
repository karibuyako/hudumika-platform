/* Secure token persistence.
 *
 * SECURITY.md: tokens live in expo-secure-store (never AsyncStorage). On web
 * (and under node tests) SecureStore is unavailable — fall back to localStorage.
 * The SecureStore import is lazy so the node test bundle stays importable.
 */
import type { Locale } from '@/i18n';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  phone: string;
  locale: Locale;
  savedAt: string;
}

const SS_KEY = 'customer.session';
const TOKEN_KEY = 'customer.token';
const PUSH_TOKEN_KEY = 'customer.pushToken';

async function loadSecure(): Promise<typeof import('expo-secure-store') | null> {
  try {
    return await import('expo-secure-store');
  } catch {
    return null;
  }
}

export async function getStoredSession(): Promise<StoredSession | null> {
  const secure = await loadSecure();
  if (secure) {
    try {
      const raw = await secure.getItemAsync(SS_KEY);
      if (raw) return JSON.parse(raw) as StoredSession;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    const raw = localStorage.getItem(SS_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export async function setStoredSession(session: StoredSession | null): Promise<void> {
  const secure = await loadSecure();
  const raw = session ? JSON.stringify(session) : null;
  if (secure) {
    try {
      if (raw) await secure.setItemAsync(SS_KEY, raw);
      else await secure.deleteItemAsync(SS_KEY);
      return;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    if (raw) localStorage.setItem(SS_KEY, raw);
    else localStorage.removeItem(SS_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Token-only persistence (access token): SecureStore on native, localStorage
 * on web — same key as the client's web fallback so the demo keeps working. */
export async function getStoredTokenAsync(): Promise<string | null> {
  const secure = await loadSecure();
  if (secure) {
    try {
      return await secure.getItemAsync(TOKEN_KEY);
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setStoredTokenAsync(token: string | null): Promise<void> {
  const secure = await loadSecure();
  if (secure) {
    try {
      if (token) await secure.setItemAsync(TOKEN_KEY, token);
      else await secure.deleteItemAsync(TOKEN_KEY);
      return;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Push token persistence (lib/push.ts): SecureStore on native, localStorage
 * on web — same split as the access token. The consumer contract exposes no
 * push-token endpoint yet, so the Expo push token lives device-locally until
 * the notifications repo gains a registration call (NOTIFICATIONS.md steps
 * 2–4). */
export async function getStoredPushTokenAsync(): Promise<string | null> {
  const secure = await loadSecure();
  if (secure) {
    try {
      return await secure.getItemAsync(PUSH_TOKEN_KEY);
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    return localStorage.getItem(PUSH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setStoredPushTokenAsync(token: string | null): Promise<void> {
  const secure = await loadSecure();
  if (secure) {
    try {
      if (token) await secure.setItemAsync(PUSH_TOKEN_KEY, token);
      else await secure.deleteItemAsync(PUSH_TOKEN_KEY);
      return;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    if (token) localStorage.setItem(PUSH_TOKEN_KEY, token);
    else localStorage.removeItem(PUSH_TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}
