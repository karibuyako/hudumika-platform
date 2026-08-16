import { Alert, Platform } from 'react-native';
import Constants from 'expo-constants';

/* Expo push (NOTIFICATIONS.md §Push setup) — native only.
 * Web has no OS push; every function here is a graceful no-op on web and the
 * notification center + polling is the equivalent surface. The module is
 * imported lazily by screens so the web bundle never pulls the native code
 * path in at load time. */

type Permission = 'granted' | 'denied' | 'undetermined';

let foregroundHandlerSet = false;

export async function getPushPermission(): Promise<Permission> {
  if (Platform.OS === 'web') return 'denied';
  try {
    const mod = await import('expo-notifications');
    if (!foregroundHandlerSet) {
      foregroundHandlerSet = true;
      mod.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });
    }
    const perm = await mod.getPermissionsAsync();
    if (perm.granted) return 'granted';
    return perm.status === 'undetermined' ? 'undetermined' : 'denied';
  } catch {
    return 'undetermined';
  }
}

/** Explain-before-ask: the reason is shown in an alert, then the OS prompt. */
export async function requestPushPermission(reason: string): Promise<Permission> {
  if (Platform.OS === 'web') return 'denied';
  const grant = await new Promise<boolean>((resolve) => {
    Alert.alert('Hudumika Merchant', reason, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Allow', onPress: () => resolve(true) },
    ]);
  });
  if (!grant) return 'denied';
  try {
    const mod = await import('expo-notifications');
    const perm = await mod.requestPermissionsAsync();
    return perm.granted ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Register/refresh the per-device Expo push token (server-side per user).
 * The contract has no push-token endpoint yet, so this posts to the
 * mock-only POST /devices/push-token (tracked contract-additions proposal).
 * Returns the registered token, or null when unavailable (web / no EAS
 * project / permission denied). */
export async function registerPushToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    const mod = await import('expo-notifications');
    const perm = await mod.getPermissionsAsync();
    if (!perm.granted) return null;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.expoConfig?.extra?.projectId ?? Constants.expoConfig?.slug ?? 'merchant-app';
    const { data } = await mod.getExpoPushTokenAsync({ projectId });
    if (!data) return null;
    const res = await fetch(`/api/devices/push-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: data, platform: Platform.OS }),
    });
    if (!res.ok) return null;
    return data;
  } catch {
    return null;
  }
}

export interface PushTap {
  deepLink: string | null;
  data?: Record<string, unknown>;
}

/** Push taps route via the notification payload's deepLink; on a cold start
 * the response is delivered via getLastNotificationResponse. Web: no-op. */
export async function currentPushTap(): Promise<PushTap | null> {
  if (Platform.OS === 'web') return null;
  try {
    const mod = await import('expo-notifications');
    const res = await mod.getLastNotificationResponse();
    return tapOf(res);
  } catch {
    return null;
  }
}

export function subscribePushTaps(fn: (tap: PushTap) => void): () => void {
  if (Platform.OS === 'web') return () => undefined;
  let sub: { remove: () => void } | null = null;
  import('expo-notifications')
    .then((mod) => {
      sub = mod.addNotificationResponseReceivedListener((response) => {
        const tap = tapOf(response);
        if (tap) fn(tap);
      });
    })
    .catch(() => undefined);
  return () => sub?.remove();
}

function tapOf(response: { notification: { request: { content: { data?: Record<string, unknown> } } } } | null): PushTap | null {
  if (!response) return null;
  const data = response.notification.request.content.data ?? {};
  const deepLink = typeof data.deepLink === 'string' && data.deepLink ? data.deepLink : null;
  return { deepLink, data };
}
