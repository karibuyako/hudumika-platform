/* Test-environment shims. Import FIRST in any store-level test file.
 * - The api client captures EXPO_PUBLIC_API_URL at module load (an empty base
 *   means "browser origin", which Node's fetch cannot resolve), so it must be
 *   set before '@/api/client' evaluates.
 * - Node 21+ ships a global `navigator` without `onLine`; the client would
 *   read that as offline and queue mutations instead of sending them.
 * - The client persists the session token in localStorage/sessionStorage,
 *   which Node does not provide. */

process.env.EXPO_PUBLIC_API_URL = 'http://localhost';

if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'undefined') {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
}

const memory = new Map<string, string>();
const shim = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, String(value));
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
};

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true });
}
if (typeof globalThis.sessionStorage === 'undefined') {
  Object.defineProperty(globalThis, 'sessionStorage', { value: shim, configurable: true });
}
