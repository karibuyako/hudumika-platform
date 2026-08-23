/* Push registration — enterprise P6 deepLink wiring.
 *
 * Expo Push Service token is registered at login and synced to
 * POST /notifications/me/push-token (API-CONTRACT.yaml: registerPushToken).
 * DeepLink routing is handled in notifications.tsx openDeepLink() — all
 * Notification.deepLink values are whitelisted and router.push() with fallback.
 * In-app polling (useFocusEffect every 15s in jobs/*) keeps the center live
 * when push is unavailable (web / permissions denied).
 */

let pushToken: string | null = null;

const loadNotifications = new Function('id', 'return import(id)') as (id: string) => Promise<unknown>;

export async function registerPushToken(): Promise<string | null> {
  try {
    const Notifications = await loadNotifications('expo-notifications');
    const mod = Notifications as {
      getPermissionsAsync: () => Promise<{ status: string }>;
      requestPermissionsAsync: () => Promise<{ status: string }>;
      getExpoPushTokenAsync: () => Promise<{ data: string }>;
    };
    const { status } = await mod.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await mod.requestPermissionsAsync();
      if (req.status !== 'granted') return null;
    }
    const token = await mod.getExpoPushTokenAsync();
    pushToken = token.data;
    // Sync to backend (best-effort) — enables server push via FCM/APNs
    try {
      const { api } = await import('@/api/client');
      await api.post<void>('/notifications/me/push-token', { token: pushToken, platform: 'expo' });
    } catch {
      /* backend sync best-effort — token still usable client-side */
    }
    return pushToken;
  } catch {
    pushToken = null;
    return null;
  }
}

export function getPushToken(): string | null {
  return pushToken;
}
