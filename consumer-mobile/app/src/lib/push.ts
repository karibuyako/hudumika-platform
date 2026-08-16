/* Push-notification wrapper — the single seam between the app and
 * expo-notifications. Native-only: on web (the demo) and under node tests
 * every function is a documented no-op that never throws or blocks. The
 * expo-notifications import is lazy and wrapped, so this module is safe to
 * import from anywhere (session store, layout, screens).
 *
 * CONTRACT SEAM (push-token registration, NOTIFICATIONS.md steps 2–4): the
 * consumer contract exposes NO push-token endpoint today — grep
 * packages/contract/src/generated/endpoints/ for 'push'/'token' finds only
 * merchant printer/terminal devices under /devices (no POST /push/tokens,
 * no /users/me/push-token). Until the contract ships one, the Expo push
 * token persists device-locally via src/lib/secureStorage.ts
 * (getStoredPushTokenAsync / setStoredPushTokenAsync — SecureStore on
 * native, localStorage fallback) so a future notifications repo can read it.
 * registerTokenForUser / unregisterTokenForUser are the seams to swap for an
 * AuthRepository.registerPushToken call the moment the endpoint lands.
 *
 * Deep-link validation: push payload deepLinks navigate through the same
 * allow-list as cold-start links (src/lib/deep-link.ts, SECURITY.md) —
 * unknown payloads are ignored.
 */
import type { Voucher } from '@hudumika/contract';

import { t } from '@/i18n';
import { parseAndValidateDeepLink } from '@/lib/deep-link';
import { getStoredPushTokenAsync, setStoredPushTokenAsync } from '@/lib/secureStorage';
import { getAuthRepository } from '@/repos';
import { idempotencyKey } from '@/lib/idempotency';

/** Typed push failure for logging (never thrown — callers get null + error). */
export interface PushError {
  code: 'PERMISSION_DENIED' | 'TOKEN_FAILED' | 'SCHEDULE_FAILED';
  message: string;
}

export type PushTokenResult = { token: string; error: null } | { token: null; error: PushError | null };

/** ~48 h before expiry — the voucher reminder window (NOTIFICATIONS.md). */
export const VOUCHER_REMINDER_MS = 48 * 3600_000;

/** Notification identifier scheme for one voucher's expiry reminder. The
 * contract Voucher has no id field — code is its stable key (the app's
 * voucher identity everywhere, e.g. vouchers.tsx keyExtractor). */
export function voucherReminderId(voucherId: string): string {
  return `voucher-expiry-${voucherId}`;
}

/** True on iOS/Android (Hermes). False in the browser (web demo — push is
 * native-only) and under node tests. The lazy import below is the ultimate
 * safety net: a mis-detection still resolves to a no-op. */
function isNative(): boolean {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' && navigator.userAgent.includes('Node.js')) {
      return false;
    }
    return typeof document === 'undefined';
  } catch {
    return false;
  }
}

async function loadNotifications(): Promise<typeof import('expo-notifications') | null> {
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

/** Pure decision helper (unit-tested): an UNUSED voucher still expiring in
 * the future but inside the reminder window should get a local reminder.
 * Expired/void/refunded/redeemed vouchers never do. */
export function shouldScheduleReminder(voucher: Pick<Voucher, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  if (voucher.status !== 'unused' || !voucher.expiresAt) return false;
  const expiresAt = Date.parse(voucher.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  const remaining = expiresAt - now;
  return remaining > 0 && remaining <= VOUCHER_REMINDER_MS;
}

/** Request the OS push permission (after the explanatory copy — the caller
 * shows it first, see NotificationPermissionSheet) and return the Expo push
 * token, or null + a typed error for logging. Never throws. Web/node return
 * a null no-op result. */
export async function getExpoPushToken(): Promise<PushTokenResult> {
  if (!isNative()) return { token: null, error: null };
  const notifications = await loadNotifications();
  if (!notifications) {
    return { token: null, error: { code: 'TOKEN_FAILED', message: 'expo-notifications unavailable' } };
  }
  try {
    const current = await notifications.getPermissionsAsync();
    if (!current.granted) {
      const next = await notifications.requestPermissionsAsync();
      if (!next.granted) {
        return { token: null, error: { code: 'PERMISSION_DENIED', message: 'push permission denied' } };
      }
    }
    const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    const token = await notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return { token: token.data, error: null };
  } catch (e) {
    return { token: null, error: { code: 'TOKEN_FAILED', message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Register the device push token with the server (mock-first, docs/
 * CONTRACT-ADDITIONS.md #2): AuthRepository.registerPushToken is mock-only
 * until the contract ships POST /push/tokens — a live backend 404s it, and
 * the mock validates + stores it. NEVER throws: a failure only logs, and the
 * caller keeps the device-local SecureStore write as the fallback/audit —
 * the session flow is never blocked (same fire-and-forget rule as the
 * session wiring in src/store/session.ts). */
export async function registerTokenOnServer(token: string): Promise<void> {
  try {
    await getAuthRepository().registerPushToken(token, idempotencyKey('customer', 'push-register'));
  } catch (e) {
    console.warn(`[push] server push-token registration failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Unregister the device push token server-side (mock-first, same seam as
 * registerTokenOnServer). Never throws — logout must never fail because the
 * push registry is unreachable. */
export async function unregisterTokenOnServer(token: string): Promise<void> {
  try {
    await getAuthRepository().unregisterPushToken(token, idempotencyKey('customer', 'push-unregister'));
  } catch (e) {
    console.warn(`[push] server push-token unregister failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Register the device push token for the current user. Contract seam: no
 * push-token endpoint exists in the consumer contract (see header) — the
 * token is persisted device-locally through secureStorage.ts. The server
 * registration is mock-first (CONTRACT-ADDITIONS.md #2) and fire-and-forget:
 * a repo failure (live backend that has not shipped POST /push/tokens) only
 * warns and the device-local write still succeeds. Returns whether the token
 * was accepted; never throws. */
export async function registerTokenForUser(token: string): Promise<boolean> {
  if (!isNative() || !token) return false;
  await registerTokenOnServer(token);
  try {
    await setStoredPushTokenAsync(token);
    return true;
  } catch {
    return false;
  }
}

/** Clear the stored push token (logout / revoke). Same contract seam as
 * registerTokenForUser. Safe everywhere — never throws. */
export async function unregisterTokenForUser(): Promise<boolean> {
  try {
    const stored = await getStoredPushTokenAsync();
    if (stored) await unregisterTokenOnServer(stored);
    await setStoredPushTokenAsync(null);
    return true;
  } catch {
    return false;
  }
}

/** Full registration pipeline for the session lifecycle: permission (the OS
 * prompt fires only after the app's explanatory sheet — NOTIFICATIONS.md
 * step 1) → Expo token → persist. Fire-and-forget friendly: never throws,
 * never blocks the session transition, web/node resolve immediately. */
export async function registerPushForUser(): Promise<PushTokenResult> {
  const result = await getExpoPushToken();
  if (result.token) {
    const persisted = await registerTokenForUser(result.token);
    if (!persisted) {
      return { token: null, error: { code: 'TOKEN_FAILED', message: 'push token persistence failed' } };
    }
  }
  return result;
}

/** Schedule (or refresh) the local notification ~48 h before the voucher
 * expires (NOTIFICATIONS.md voucher expiry reminder). Content comes from the
 * i18n keys notifications.voucherExpiring.*. Native-only no-op otherwise —
 * never throws. */
export async function scheduleVoucherExpiryReminder(voucher: Voucher): Promise<boolean> {
  if (!isNative() || !shouldScheduleReminder(voucher)) return false;
  const notifications = await loadNotifications();
  if (!notifications) return false;
  try {
    const expiresAt = Date.parse(voucher.expiresAt ?? '');
    if (Number.isNaN(expiresAt)) return false;
    const identifier = voucherReminderId(voucher.code);
    // Re-schedule replaces any previous reminder for the same voucher.
    await notifications.cancelScheduledNotificationAsync(identifier);
    await notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: t('notifications.voucherExpiring.title'),
        body: t('notifications.voucherExpiring.body', { title: voucher.title ?? voucher.code }),
      },
      trigger: {
        type: notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(expiresAt - VOUCHER_REMINDER_MS),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel a previously scheduled expiry reminder (e.g. the voucher was
 * redeemed). Native-only no-op otherwise — never throws. */
export async function cancelExistingReminder(voucherId: string): Promise<boolean> {
  if (!isNative()) return false;
  const notifications = await loadNotifications();
  if (!notifications) return false;
  try {
    await notifications.cancelScheduledNotificationAsync(voucherReminderId(voucherId));
    return true;
  } catch {
    return false;
  }
}

/** Validate the deepLink carried by a push notification response against the
 * allow-list (SECURITY.md / NOTIFICATIONS.md step 5). Unknown payloads and
 * malformed responses return null — the caller then does nothing. Accepts the
 * expo-notifications NotificationResponse shape structurally. */
export function pushResponseDeepLink(response: unknown): string | null {
  try {
    const data = (response as {
      notification?: { request?: { content?: { data?: Record<string, unknown> } } };
    })?.notification?.request?.content?.data;
    const raw = data?.deepLink;
    return typeof raw === 'string' ? parseAndValidateDeepLink(raw) : null;
  } catch {
    return null;
  }
}

/** The stored device push token (used by the notifications repo seam and the
 * Settings status row). Never throws — null when unset. */
export function getStoredPushToken(): Promise<string | null> {
  return getStoredPushTokenAsync();
}
